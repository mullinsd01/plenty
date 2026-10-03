import { formatHintFrom, parseBarcode, SCANNABLE_FORMATS, type Barcode, type BarcodeRejection } from "@/lib/barcode";

/**
 * Reading barcodes from camera frames and photos, entirely on the device.
 *
 * The browser's own BarcodeDetector is used where it exists. Where it doesn't
 * (Safari, Firefox, most desktops) a WebAssembly build of ZXing is loaded — only
 * when the scanner is opened, from Plenty's own server (never a CDN) — so
 * scanning needs no network and no picture ever leaves the device. Whatever
 * is read still has to pass `parseBarcode`'s check digit before it counts.
 */

export type ScanRead = { kind: "found"; barcode: Barcode; format: string | undefined } | { kind: "refused"; reason: BarcodeRejection; message: string };

export interface BarcodeReader {
  readonly kind: "native" | "wasm";
  /** Look for a barcode in the current video frame. */
  readVideo(video: HTMLVideoElement): Promise<ScanRead | null>;
  /** Look for a barcode in a still picture. */
  readImage(image: ImageBitmap): Promise<ScanRead | null>;
}

interface RawCode {
  text: string;
  format: string | undefined;
}

/** Of everything seen in one frame, the first that is a real product barcode; else a refusal worth telling the person about. */
function pick(codes: RawCode[]): ScanRead | null {
  let refused: ScanRead | null = null;
  for (const code of codes) {
    const parsed = parseBarcode(code.text, formatHintFrom(code.format));
    if (parsed.ok) return { kind: "found", barcode: parsed.barcode, format: code.format };
    // A bad check digit is just a misread frame: stay quiet and keep looking. The other refusals are real codes worth explaining.
    if (parsed.reason === "in_store" || parsed.reason === "coupon" || parsed.reason === "publication") {
      refused ??= { kind: "refused", reason: parsed.reason, message: parsed.message };
    }
  }
  return refused;
}

// ─── Native ─────────────────────────────────────────────────────────────────

interface NativeDetector {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string; format: string }>>;
}
interface NativeDetectorStatic {
  new (options?: { formats?: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}

async function nativeReader(): Promise<BarcodeReader | null> {
  const Detector = (globalThis as unknown as { BarcodeDetector?: NativeDetectorStatic }).BarcodeDetector;
  if (!Detector) return null;
  try {
    const supported = await Detector.getSupportedFormats();
    const formats = SCANNABLE_FORMATS.filter((f) => supported.includes(f));
    // Some platforms report the detector but can't read retail codes; use the fallback there.
    if (!formats.includes("ean_13")) return null;
    const detector = new Detector({ formats: [...formats] });
    const read = async (source: ImageBitmapSource) => pick((await detector.detect(source)).map((c) => ({ text: c.rawValue, format: c.format })));
    return { kind: "native", readVideo: (video) => read(video), readImage: (image) => read(image) };
  } catch {
    return null;
  }
}

// ─── WebAssembly fallback ───────────────────────────────────────────────────

const WASM_FORMATS = ["EAN13", "EAN8", "UPCA", "UPCE", "ITF", "ITF14"] as const;
/** Frames are shrunk to about this wide before decoding: plenty for a barcode held up to the camera, and quick. */
const FRAME_WIDTH = 960;

async function wasmReader(): Promise<BarcodeReader> {
  const zxing = await import("zxing-wasm/reader");
  // The WebAssembly file is bundled with the app and served from this site; the library's default is a CDN.
  const wasmUrl = new URL("zxing-wasm/reader/zxing_reader.wasm", import.meta.url).toString();
  zxing.setZXingModuleOverrides({ locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) });

  let canvas: HTMLCanvasElement | null = null;
  const decode = async (source: CanvasImageSource, width: number, height: number, targetWidth: number): Promise<ScanRead | null> => {
    const scale = Math.min(1, targetWidth / width);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    canvas ??= document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);
    const results = await zxing.readBarcodes(ctx.getImageData(0, 0, w, h), {
      formats: [...WASM_FORMATS],
      tryHarder: true,
      tryRotate: true,
      maxNumberOfSymbols: 3,
    });
    return pick(results.filter((r) => r.isValid).map((r) => ({ text: r.text, format: r.format })));
  };
  return {
    kind: "wasm",
    readVideo: (video) => (video.videoWidth ? decode(video, video.videoWidth, video.videoHeight, FRAME_WIDTH) : Promise.resolve(null)),
    readImage: async (image) => (await decode(image, image.width, image.height, 1600)) ?? (await decode(image, image.width, image.height, 800)),
  };
}

let loading: Promise<BarcodeReader> | null = null;

/** The best reader this browser can run. Loaded once, the first time the scanner opens. */
export function loadBarcodeReader(): Promise<BarcodeReader> {
  loading ??= (async () => (await nativeReader()) ?? (await wasmReader()))().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

/** Read a barcode from a photo file, on the device. Null when none was found; throws when the file can't be opened as a picture. */
export async function readBarcodeFromFile(reader: BarcodeReader, file: Blob): Promise<ScanRead | null> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    return await reader.readImage(bitmap);
  } finally {
    bitmap.close();
  }
}
