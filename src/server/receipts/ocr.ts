import "server-only";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import Tesseract from "tesseract.js";
import { parseReceiptText, READING_SEPARATOR } from "@/lib/receipts/parse";
import { rescaledVariant } from "@/server/receipts/image";

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
 * - A clean receipt is read once. A photo whose first reading doesn't add up
 *   (no total, or items that disagree with it) is read again at other sizes,
 *   because Tesseract's mistakes on a small or soft photo change with the scale;
 *   the readings come back together, separated by form feeds, for the parser to
 *   merge by consensus (see `mergeReadings`).
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
/** Further readings of a photo that didn't add up the first time, as multiples of the first reading's width. */
export const OCR_EXTRA_READING_SCALES = [0.8, 1.25, 0.65, 1.5] as const;
/** No further reading starts once a read of one photo has taken this long (the job timeout still applies to each). */
export const OCR_EXTRA_READINGS_BUDGET_MS = 25_000;
/** Fewer item lines than this and a second look wouldn't help: the photo isn't of a receipt, or is hopeless. */
const MIN_LINES_FOR_EXTRA_READINGS = 3;
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

/** True when the text holds item lines that no total vouches for: worth reading the photo again. */
function needsAnotherReading(text: string): boolean {
  const parsed = parseReceiptText(text);
  const vouched = parsed.total !== null && !parsed.warnings.includes("total_mismatch");
  return parsed.lines.length >= MIN_LINES_FOR_EXTRA_READINGS && !vouched;
}

async function readWithExtraReadings(image: Buffer): Promise<OcrResult> {
  const started = Date.now();
  const first = await recognise(image);
  if (!needsAnotherReading(first.text)) return first;

  const texts = [first.text];
  let confidence = first.confidence;
  for (const scale of OCR_EXTRA_READING_SCALES) {
    if (Date.now() - started > OCR_EXTRA_READINGS_BUDGET_MS) break;
    try {
      const again = await recognise(await rescaledVariant(image, scale));
      texts.push(again.text);
      confidence = Math.max(confidence, again.confidence);
    } catch {
      break; // The first reading stands; a failed extra one must never lose it.
    }
    if (texts.length >= 3 && !needsAnotherReading(texts.join(`\n${READING_SEPARATOR}\n`))) break;
  }
  return { text: texts.join(`\n${READING_SEPARATOR}\n`), confidence };
}

/**
 * Read the text on a receipt image with local Tesseract OCR.
 *
 * Pass the output of `ocrVariant()` for best results (greyscale, normalised,
 * ≥ 1600 px wide). Jobs are serialised on one shared worker. A photo whose
 * first reading doesn't add up is read again at other sizes within a time
 * budget, and the result holds every reading separated by form feeds
 * (`parseReceiptText` merges them). Throws `OcrError`
 * ("unavailable" | "timeout" | "failed") when the first reading fails.
 */
export function ocrReceipt(image: Buffer): Promise<OcrResult> {
  pendingJobs += 1;
  clearIdleTimer();
  const job = queue.then(() => readWithExtraReadings(image));
  queue = job.then(
    () => undefined,
    () => undefined,
  );
  return job.finally(() => {
    pendingJobs -= 1;
    if (pendingJobs === 0) scheduleIdleShutdown();
  });
}
