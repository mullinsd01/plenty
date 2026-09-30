import "server-only";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import Tesseract from "tesseract.js";

/**
 * Local, fully offline OCR with tesseract.js.
 *
 * - The English LSTM model is read from the `@tesseract.js-data/eng` package
 *   on disk (never the jsDelivr CDN), and the WASM core is `require`d from
 *   `tesseract.js-core` by the Node worker — no network access at all.
 * - One worker is created lazily and reused; jobs run one at a time, and the
 *   worker is terminated after a minute of inactivity to free ~100 MB.
 * - Language data caching is disabled (the data is already local), so nothing
 *   is written to the working directory.
 */

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Terminate the worker after this long without jobs. */
export const OCR_IDLE_TIMEOUT_MS = 60_000;
/** A single recognition taking longer than this is abandoned (and the worker recycled). */
export const OCR_JOB_TIMEOUT_MS = 90_000;
/**
 * Page segmentation: PSM 6 ("single uniform block of text"). With PSM 4
 * ("single column") Tesseract split right-aligned prices into a separate
 * column on receipts with long descriptions, detaching every price from its
 * item; PSM 6 keeps each printed line together.
 */
export const OCR_PAGE_SEG_MODE = Tesseract.PSM.SINGLE_BLOCK;
/** The integer-quantised "best" LSTM model: accurate and small (2.9 MB). */
const TRAINED_DATA_DIR = "4.0.0_best_int";
const LANGUAGE = "eng";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OcrResult {
  text: string;
  /** Mean word confidence, 0–100. */
  confidence: number;
}

export type OcrErrorCode = "unavailable" | "timeout" | "failed";

export class OcrError extends Error {
  constructor(
    public readonly code: OcrErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OcrError";
  }
}

// ─── Paths ──────────────────────────────────────────────────────────────────

/**
 * Locate the local English traineddata directory. Tries module resolution
 * from the project root first (works with hoisted and nested installs), then
 * `node_modules` under the working directory.
 */
export function resolveTesseractLangPath(): string {
  const candidates: string[] = [];
  try {
    const projectRequire = createRequire(path.join(process.cwd(), "package.json"));
    candidates.push(path.join(path.dirname(projectRequire.resolve("@tesseract.js-data/eng/package.json")), TRAINED_DATA_DIR));
  } catch {
    // Fall through to the conventional location.
  }
  candidates.push(path.join(process.cwd(), "node_modules", "@tesseract.js-data", LANGUAGE, TRAINED_DATA_DIR));
  const found = candidates.find((dir) => existsSync(path.join(dir, `${LANGUAGE}.traineddata.gz`)));
  if (!found) {
    throw new OcrError("unavailable", "On-device receipt reading isn't installed (missing @tesseract.js-data/eng).");
  }
  return found;
}

// ─── Worker lifecycle ───────────────────────────────────────────────────────

let workerPromise: Promise<Tesseract.Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let pendingJobs = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function createOcrWorker(): Promise<Tesseract.Worker> {
  const langPath = resolveTesseractLangPath();
  const worker = await Tesseract.createWorker(LANGUAGE, Tesseract.OEM.LSTM_ONLY, {
    langPath,
    gzip: true,
    cacheMethod: "none",
    logger: () => undefined,
    errorHandler: (err: unknown) => console.error("[ocr] worker error:", err),
  });
  await worker.setParameters({
    tessedit_pageseg_mode: OCR_PAGE_SEG_MODE,
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });
  return worker;
}

function getWorker(): Promise<Tesseract.Worker> {
  if (!workerPromise) {
    const created = createOcrWorker();
    workerPromise = created;
    created.catch(() => {
      if (workerPromise === created) workerPromise = null;
    });
  }
  return workerPromise;
}

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdleShutdown(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    if (pendingJobs === 0) void terminateOcrWorker();
  }, OCR_IDLE_TIMEOUT_MS);
  idleTimer.unref?.();
}

/** Stop the shared worker now (tests, graceful shutdown). Safe to call at any time. */
export async function terminateOcrWorker(): Promise<void> {
  clearIdleTimer();
  const current = workerPromise;
  workerPromise = null;
  if (!current) return;
  try {
    const worker = await current;
    await worker.terminate();
  } catch {
    // Creation failed or the worker already died; nothing to clean up.
  }
}

// ─── Recognition ────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OcrError("timeout", "Reading the receipt took too long.")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function recognise(image: Buffer): Promise<OcrResult> {
  try {
    const worker = await getWorker();
    const { data } = await withTimeout(worker.recognize(image), OCR_JOB_TIMEOUT_MS);
    const confidence = Number.isFinite(data.confidence) ? Math.min(100, Math.max(0, data.confidence)) : 0;
    return { text: data.text ?? "", confidence };
  } catch (err) {
    // A failed or hung job may leave the worker unusable; start fresh next time.
    await terminateOcrWorker();
    if (err instanceof OcrError) throw err;
    throw new OcrError("failed", `On-device receipt reading failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Read the text on a receipt image with local Tesseract OCR.
 *
 * Pass the output of `ocrVariant()` for best results (greyscale, normalised,
 * ≥ 1600 px wide). Jobs are serialised on one shared worker. Throws
 * `OcrError` ("unavailable" | "timeout" | "failed").
 */
export function ocrReceipt(image: Buffer): Promise<OcrResult> {
  pendingJobs += 1;
  clearIdleTimer();
  const job = queue.then(() => recognise(image));
  queue = job.then(
    () => undefined,
    () => undefined,
  );
  return job.finally(() => {
    pendingJobs -= 1;
    if (pendingJobs === 0) scheduleIdleShutdown();
  });
}
