import "server-only";
import sharp, { type Metadata } from "sharp";

/**
 * Grocery photo handling. A photo is validated by decoding it (never by trusting
 * its name or type), then shrunk to a JPEG with all metadata removed (camera
 * details, location, thumbnails). It is held in memory for the length of one
 * request and is never written to disk or the database.
 */

/** Refuse uploads larger than this before decoding anything. The browser sends far less. */
export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
/** Reject decoded images above this many pixels (≈ a 40 MP camera). */
export const MAX_PHOTO_PIXELS = 40_000_000;
export const MIN_PHOTO_EDGE_PX = 120;
/** Long edge sent to the reader: enough to tell products apart, without paying for pixels it can't use. */
export const PHOTO_EDGE_PX = 1568;
const JPEG_QUALITY = 80;

export type PhotoImageErrorCode = "unsupported_format" | "too_large" | "too_small" | "corrupt";

/** A rejected upload. `message` is safe to show to the person. */
export class PhotoImageError extends Error {
  constructor(
    public readonly code: PhotoImageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PhotoImageError";
  }
}

const MESSAGES = {
  unsupported: "That file isn't a photo Plenty can read. Please use a JPEG, PNG or WebP image.",
  heic: "Plenty can't read that phone photo format (HEIC) here. Please choose a JPEG or PNG instead.",
  animated: "Animated images can't be used. Please choose a single photo.",
  tooLarge: "That photo is too big to process. Please take a smaller one.",
  tooSmall: "That photo is too small to make anything out. Please take a closer one.",
  corrupt: "That photo seems to be damaged or incomplete. Please take it again.",
} as const;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Identify a file from its first bytes. */
function sniff(input: Buffer): "jpeg" | "png" | "webp" | "heif" | null {
  const ascii = (start: number, end: number) => (input.length >= end ? input.toString("latin1", start, end) : "");
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return "jpeg";
  if (input.length >= 8 && input.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(ascii(8, 12))) return "heif";
  return null;
}

export interface PreparedGroceryPhoto {
  /** JPEG, EXIF-rotated, at most `PHOTO_EDGE_PX` on the long edge, metadata stripped. */
  buffer: Buffer;
  width: number;
  height: number;
}

/** Validate an uploaded grocery photo and produce the copy sent to the reader. Throws `PhotoImageError`. */
export async function prepareGroceryPhoto(input: Buffer): Promise<PreparedGroceryPhoto> {
  if (!Buffer.isBuffer(input) || input.length === 0) throw new PhotoImageError("corrupt", MESSAGES.corrupt);
  if (input.length > MAX_PHOTO_BYTES) throw new PhotoImageError("too_large", MESSAGES.tooLarge);
  const format = sniff(input);
  if (format === "heif") throw new PhotoImageError("unsupported_format", MESSAGES.heic);
  if (!format) throw new PhotoImageError("unsupported_format", MESSAGES.unsupported);

  let meta: Metadata;
  try {
    meta = await sharp(input, { failOn: "error", limitInputPixels: false }).metadata();
  } catch {
    throw new PhotoImageError("corrupt", MESSAGES.corrupt);
  }
  if (meta.format !== format) throw new PhotoImageError("unsupported_format", MESSAGES.unsupported);
  if ((meta.pages ?? 1) > 1) throw new PhotoImageError("unsupported_format", MESSAGES.animated);
  const { width, height } = meta;
  if (!width || !height) throw new PhotoImageError("corrupt", MESSAGES.corrupt);
  if (width * height > MAX_PHOTO_PIXELS) throw new PhotoImageError("too_large", MESSAGES.tooLarge);
  if (Math.min(width, height) < MIN_PHOTO_EDGE_PX) throw new PhotoImageError("too_small", MESSAGES.tooSmall);

  try {
    const { data, info } = await sharp(input, { failOn: "error", limitInputPixels: MAX_PHOTO_PIXELS })
      .autoOrient()
      .resize({ width: PHOTO_EDGE_PX, height: PHOTO_EDGE_PX, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      // No .withMetadata(): sharp drops EXIF, GPS, ICC and XMP unless asked to keep them.
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  } catch {
    throw new PhotoImageError("corrupt", MESSAGES.corrupt);
  }
}
