import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";

/**
 * Receipt photo handling.
 *
 * `prepareReceiptImage` validates an upload by actually decoding it, then
 * produces the canonical stored copy: EXIF-rotated, at most 2000 px on the
 * long edge, JPEG q82, all metadata (EXIF/GPS, ICC, XMP) stripped. It also
 * measures sharpness (variance of the Laplacian) so blurry photos can be
 * flagged before any OCR or AI work is spent on them.
 *
 * `ocrVariant` turns a prepared photo into the high-contrast greyscale PNG
 * that Tesseract reads best.
 */

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Reject decoded images above this many pixels (≈ a 40 MP camera). */
export const MAX_INPUT_PIXELS = 40_000_000;
/** Reject images whose shorter edge is below this — nothing on them is legible. */
export const MIN_INPUT_EDGE_PX = 200;
/** Long edge of the stored copy. */
export const MAX_STORED_EDGE_PX = 2000;
export const STORED_JPEG_QUALITY = 82;
/** Long edge of the greyscale copy the blur score is measured on (keeps scores comparable across photo sizes). */
export const BLUR_SAMPLE_EDGE_PX = 1000;
/** OCR copies are upscaled to at least this width; Tesseract wants ~30 px tall glyphs. */
export const OCR_MIN_WIDTH_PX = 1600;

// ─── Errors ─────────────────────────────────────────────────────────────────

export type ReceiptImageErrorCode = "unsupported_format" | "too_large" | "too_small" | "corrupt";

/** A rejected upload. `message` is safe to show to the user. */
export class ReceiptImageError extends Error {
  constructor(
    public readonly code: ReceiptImageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReceiptImageError";
  }
}

const MESSAGES = {
  unsupported: "That file isn't a photo we can read. Please upload a JPEG, PNG or WebP image of your receipt.",
  heic: "This phone photo format (HEIC) isn't supported here yet. Please upload a JPEG or PNG, or set your camera to “Most Compatible”.",
  animated: "Animated images can't be used as receipts. Please upload a single photo of your receipt.",
  tooLarge: "That photo is too big to process (over 40 megapixels). Please upload a smaller photo.",
  tooSmall: "That image is too small to read. Please take a closer photo of the receipt.",
  corrupt: "That photo seems to be damaged or incomplete. Please take it again.",
} as const;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PreparedReceiptImage {
  /** JPEG, EXIF-rotated, ≤ 2000 px long edge, quality 82, metadata stripped. */
  buffer: Buffer;
  width: number;
  height: number;
  /** Hex SHA-256 of `buffer`; identical uploads produce identical hashes. */
  sha256: string;
  /** Variance of the Laplacian on a downscaled greyscale copy; higher = sharper. */
  blurScore: number;
}

type AcceptedFormat = "jpeg" | "png" | "webp" | "heif";
type SniffedFormat = AcceptedFormat | "avif" | "gif" | "tiff" | "bmp" | "pdf" | "svg";

// ─── Format detection ───────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

/** Identify a file from its magic bytes (never trust the extension or MIME type). */
function sniffFormat(input: Buffer): SniffedFormat | null {
  const ascii = (start: number, end: number) => (input.length >= end ? input.toString("latin1", start, end) : "");
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return "jpeg";
  if (input.length >= 8 && input.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (AVIF_BRANDS.has(brand)) return "avif";
    if (HEIC_BRANDS.has(brand)) return "heif";
  }
  if (ascii(0, 3) === "GIF") return "gif";
  if (ascii(0, 4) === "II*\0" || ascii(0, 4) === "MM\0*") return "tiff";
  if (ascii(0, 2) === "BM") return "bmp";
  if (ascii(0, 4) === "%PDF") return "pdf";
  if (/^\s*(?:<\?xml|<svg)/i.test(ascii(0, Math.min(input.length, 64)))) return "svg";
  return null;
}

/** HEIC needs libvips built with libde265; the prebuilt sharp binaries only decode AVIF. */
export function heicSupported(): boolean {
  const heif = sharp.format.heif;
  const suffixes = heif?.input.fileSuffix ?? [];
  return Boolean(heif?.input.buffer) && (suffixes.includes(".heic") || suffixes.includes(".heif"));
}

function acceptedFormat(sniffed: SniffedFormat | null): AcceptedFormat {
  switch (sniffed) {
    case "jpeg":
    case "png":
    case "webp":
      return sniffed;
    case "heif":
      if (heicSupported()) return "heif";
      throw new ReceiptImageError("unsupported_format", MESSAGES.heic);
    default:
      throw new ReceiptImageError("unsupported_format", MESSAGES.unsupported);
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

/** Read and sanity-check the header: format, animation, pixel count and size. */
async function validateInput(input: Buffer): Promise<sharp.Metadata> {
  if (!Buffer.isBuffer(input) || input.length === 0) throw new ReceiptImageError("corrupt", MESSAGES.corrupt);
  const format = acceptedFormat(sniffFormat(input));

  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { failOn: "error", limitInputPixels: false }).metadata();
  } catch {
    throw new ReceiptImageError("corrupt", MESSAGES.corrupt);
  }
  if (meta.format !== format) throw new ReceiptImageError("unsupported_format", MESSAGES.unsupported);
  if (format !== "heif" && (meta.pages ?? 1) > 1) throw new ReceiptImageError("unsupported_format", MESSAGES.animated);

  const { width, height } = meta;
  if (!width || !height) throw new ReceiptImageError("corrupt", MESSAGES.corrupt);
  if (width * height > MAX_INPUT_PIXELS) throw new ReceiptImageError("too_large", MESSAGES.tooLarge);
  if (Math.min(width, height) < MIN_INPUT_EDGE_PX) throw new ReceiptImageError("too_small", MESSAGES.tooSmall);
  return meta;
}

// ─── Sharpness ──────────────────────────────────────────────────────────────

/**
 * Variance of the 4-neighbour Laplacian over a single-channel image. Sharp
 * text produces strong second derivatives; blur flattens them. Returns 0 for
 * images too small to measure.
 */
export function laplacianVariance(pixels: Uint8Array, width: number, height: number, channels = 1): number {
  if (width < 3 || height < 3) return 0;
  const stride = width * channels;
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * stride + x * channels;
      const lap = pixels[i - channels] + pixels[i + channels] + pixels[i - stride] + pixels[i + stride] - 4 * pixels[i];
      sum += lap;
      sumSquares += lap * lap;
      count += 1;
    }
  }
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

async function measureBlur(pipeline: sharp.Sharp): Promise<number> {
  const { data, info } = await pipeline
    .greyscale()
    .resize({ width: BLUR_SAMPLE_EDGE_PX, height: BLUR_SAMPLE_EDGE_PX, fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return Math.round(laplacianVariance(data, info.width, info.height, info.channels) * 10) / 10;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Validate an uploaded receipt photo and produce the stored JPEG copy.
 *
 * Throws `ReceiptImageError` ("unsupported_format", "too_large", "too_small",
 * "corrupt") with a user-friendly message when the upload can't be used.
 * Accepts JPEG, PNG and WebP, plus HEIC/HEIF when this sharp build can
 * decode it; animated images are rejected.
 */
export async function prepareReceiptImage(input: Buffer): Promise<PreparedReceiptImage> {
  await validateInput(input);
  const base = sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
    .autoOrient()
    .resize({ width: MAX_STORED_EDGE_PX, height: MAX_STORED_EDGE_PX, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" });

  try {
    const [{ data, info }, blurScore] = await Promise.all([
      base.clone().jpeg({ quality: STORED_JPEG_QUALITY }).toBuffer({ resolveWithObject: true }),
      measureBlur(base.clone()),
    ]);
    return {
      buffer: data,
      width: info.width,
      height: info.height,
      sha256: createHash("sha256").update(data).digest("hex"),
      blurScore,
    };
  } catch (err) {
    if (err instanceof ReceiptImageError) throw err;
    throw new ReceiptImageError("corrupt", MESSAGES.corrupt);
  }
}

/**
 * An OCR-friendly copy of a (prepared) receipt photo: greyscale, contrast
 * normalised, upscaled to at least `OCR_MIN_WIDTH_PX` wide, lightly sharpened,
 * as PNG. Throws `ReceiptImageError("corrupt")` if the image can't be decoded.
 */
export async function ocrVariant(input: Buffer): Promise<Buffer> {
  try {
    const meta = await sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    const width = meta.autoOrient?.width ?? meta.width;
    let pipeline = sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
      .autoOrient()
      .flatten({ background: "#ffffff" })
      .greyscale();
    if (width < OCR_MIN_WIDTH_PX) pipeline = pipeline.resize({ width: OCR_MIN_WIDTH_PX, kernel: "lanczos3" });
    return await pipeline.normalise().sharpen({ sigma: 1 }).png({ compressionLevel: 1 }).toBuffer();
  } catch {
    throw new ReceiptImageError("corrupt", MESSAGES.corrupt);
  }
}
