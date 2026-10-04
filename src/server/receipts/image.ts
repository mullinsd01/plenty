import "server-only";
import { createHash } from "node:crypto";
import sharp, { type Metadata, type Sharp } from "sharp";
import { findReceiptPaper, type PaperBox } from "@/lib/receipts/paper";

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
 * that Tesseract reads best, cropped to the receipt paper when the photo shows
 * the table or counter around it.
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
/**
 * Flat-field correction: the paper's brightness is estimated with a blur this
 * wide (σ as a fraction of image width — much wider than any glyph) and divided
 * out, which removes shadows and uneven phone-camera lighting.
 */
const FLAT_FIELD_SIGMA_FRACTION = 0.025;
/** The background is estimated at 1/8 scale: same result, a fraction of the cost. */
const FLAT_FIELD_DOWNSCALE = 8;
/** Contrast stretch after flattening (out = in × a + b): darkens faint strokes, whitens paper. */
const OCR_CONTRAST_MULTIPLIER = 1.4;
const OCR_CONTRAST_OFFSET = -60;
/** The paper is looked for on a copy this wide (see `findReceiptPaper`). */
const PAPER_PROBE_EDGE_PX = 200;

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
async function validateInput(input: Buffer): Promise<Metadata> {
  if (!Buffer.isBuffer(input) || input.length === 0) throw new ReceiptImageError("corrupt", MESSAGES.corrupt);
  const format = acceptedFormat(sniffFormat(input));

  let meta: Metadata;
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

async function measureBlur(pipeline: Sharp): Promise<number> {
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

// ─── OCR preparation ────────────────────────────────────────────────────────

/**
 * Divide each pixel by the local paper brightness so the page becomes evenly
 * white: `out = min(255, pixel × 255 / background)`. Both arrays are
 * single-channel and the same size.
 */
export function divideByBackground(pixels: Uint8Array, background: Uint8Array): Buffer {
  const out = Buffer.alloc(pixels.length);
  for (let i = 0; i < pixels.length; i += 1) {
    out[i] = Math.min(255, Math.round((pixels[i] * 255) / Math.max(background[i], 1)));
  }
  return out;
}

/** Heavily blurred copy of a greyscale image: the paper without the ink. */
async function estimateBackground(pixels: Buffer, width: number, height: number): Promise<Buffer> {
  const raw = (w: number, h: number) => ({ raw: { width: w, height: h, channels: 1 as const } });
  const smallWidth = Math.max(8, Math.round(width / FLAT_FIELD_DOWNSCALE));
  const smallHeight = Math.max(8, Math.round(height / FLAT_FIELD_DOWNSCALE));
  const small = await sharp(pixels, raw(width, height)).resize(smallWidth, smallHeight, { fit: "fill" }).raw().toBuffer();
  const sigma = Math.max(0.5, (width * FLAT_FIELD_SIGMA_FRACTION) / FLAT_FIELD_DOWNSCALE);
  const blurred = await sharp(small, raw(smallWidth, smallHeight)).blur(sigma).raw().toBuffer();
  return sharp(blurred, raw(smallWidth, smallHeight)).resize(width, height, { fit: "fill", kernel: "linear" }).raw().toBuffer();
}

export interface OcrVariantOptions {
  /** Crop to the receipt paper when it can be found (default true). False keeps the whole photo. */
  crop?: boolean;
}

/** Where the receipt paper is in a photo (as shares of its upright size), or null when it can't be told from its surroundings. */
export async function detectReceiptPaper(input: Buffer): Promise<PaperBox | null> {
  try {
    const { data, info } = await sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
      .autoOrient()
      .flatten({ background: "#ffffff" })
      .resize({ width: PAPER_PROBE_EDGE_PX, height: PAPER_PROBE_EDGE_PX, fit: "inside" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return findReceiptPaper(data, info.width, info.height, info.channels);
  } catch {
    return null;
  }
}

/**
 * An OCR-friendly copy of a (prepared) receipt photo, as PNG: cropped to the
 * receipt paper (with a margin) when the photo shows what is around it,
 * greyscale, upscaled to at least `OCR_MIN_WIDTH_PX` wide, illumination
 * flattened, contrast normalised and stretched.
 *
 * Cropping matters: on a photo of a receipt lying on a speckled bench top,
 * Tesseract read the speckle as text in the margins and mangled the lines next
 * to it (fake characters in front of items, extra "words" after prices). The
 * paper is only cropped to when it clearly stands out (see `findReceiptPaper`);
 * photos that are all paper, like scans, are read whole.
 *
 * No sharpening: measured on the sample receipts with simulated shadows and
 * soft focus, sharpening amplified noise and cost more words than it saved,
 * while flat-field correction recovered shadowed prices.
 * Throws `ReceiptImageError("corrupt")` if the image can't be decoded.
 */
export async function ocrVariant(input: Buffer, options: OcrVariantOptions = {}): Promise<Buffer> {
  try {
    const meta = await sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    const upright = { width: meta.autoOrient?.width ?? meta.width, height: meta.autoOrient?.height ?? meta.height };
    const box = options.crop === false ? null : await detectReceiptPaper(input);
    let pipeline = sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).autoOrient().flatten({ background: "#ffffff" });
    let width = upright.width;
    if (box && upright.width && upright.height) {
      const left = Math.floor(box.left * upright.width);
      const top = Math.floor(box.top * upright.height);
      const cropWidth = Math.min(upright.width - left, Math.ceil((box.right - box.left) * upright.width));
      const cropHeight = Math.min(upright.height - top, Math.ceil((box.bottom - box.top) * upright.height));
      pipeline = pipeline.extract({ left, top, width: cropWidth, height: cropHeight });
      width = cropWidth;
    }
    pipeline = pipeline.greyscale();
    if (width < OCR_MIN_WIDTH_PX) pipeline = pipeline.resize({ width: OCR_MIN_WIDTH_PX, kernel: "lanczos3" });
    const { data, info } = await pipeline.extractChannel(0).raw().toBuffer({ resolveWithObject: true });
    const background = await estimateBackground(data, info.width, info.height);
    return await sharp(divideByBackground(data, background), { raw: { width: info.width, height: info.height, channels: 1 } })
      .normalise()
      .linear(OCR_CONTRAST_MULTIPLIER, OCR_CONTRAST_OFFSET)
      .toColourspace("b-w")
      .png({ compressionLevel: 1 })
      .toBuffer();
  } catch {
    throw new ReceiptImageError("corrupt", MESSAGES.corrupt);
  }
}

/** Narrowest and widest an OCR copy may be made by `rescaledVariant`. */
const RESCALE_MIN_WIDTH_PX = 900;
const RESCALE_MAX_WIDTH_PX = 2400;

/**
 * The same OCR copy at another size (`factor` × its width, kept between 900 and
 * 2400 px). Tesseract's reading of a small, soft photo changes from size to
 * size, so a second look at a different scale makes different mistakes; see
 * `ocrReceipt`.
 */
export async function rescaledVariant(variant: Buffer, factor: number): Promise<Buffer> {
  try {
    const { width } = await sharp(variant).metadata();
    const target = Math.min(RESCALE_MAX_WIDTH_PX, Math.max(RESCALE_MIN_WIDTH_PX, Math.round((width ?? OCR_MIN_WIDTH_PX) * factor)));
    return await sharp(variant).resize({ width: target, kernel: "lanczos3" }).png({ compressionLevel: 1 }).toBuffer();
  } catch {
    throw new ReceiptImageError("corrupt", MESSAGES.corrupt);
  }
}
