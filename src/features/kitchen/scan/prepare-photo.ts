/** The long edge of a photo sent for recognition. Larger photos are shrunk here, on the device. */
export const UPLOAD_EDGE_PX = 1568;
const UPLOAD_QUALITY = 0.82;

export class PhotoOpenError extends Error {}

/**
 * Shrink a photo and re-encode it as a plain JPEG before it leaves the device.
 * Drawing it onto a canvas drops everything but the pixels: camera details,
 * location and any embedded thumbnails never get uploaded. If the browser can't
 * open the file (some HEIC photos), nothing is sent: the original is never uploaded as a fallback.
 */
export async function prepareUpload(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new PhotoOpenError("Plenty couldn't open that photo. Try a JPEG or PNG, or take a new photo.");
  }
  try {
    const scale = Math.min(1, UPLOAD_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PhotoOpenError("Plenty couldn't prepare that photo. Please try again.");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", UPLOAD_QUALITY));
    if (!blob) throw new PhotoOpenError("Plenty couldn't prepare that photo. Please try again.");
    return blob;
  } finally {
    bitmap.close();
  }
}
