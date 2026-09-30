import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseReceiptText, type ParsedReceipt } from "@/lib/receipts/parse";
import { assessReceiptQuality, type ReceiptQualityAssessment } from "@/lib/receipts/quality";
import { ocrVariant, prepareReceiptImage } from "@/server/receipts/image";
import { ocrReceipt, resolveTesseractLangPath, terminateOcrWorker } from "@/server/receipts/ocr";

const ROOT = path.resolve(__dirname, "../..");
const FIXTURES = path.join(ROOT, "tests/fixtures/receipts");
const TODAY = "2026-09-30";
const OCR_TIMEOUT_MS = 90_000;

interface ExpectedReceipt {
  store: string;
  purchasedOn: string;
  total: number;
  items: Array<{ description: string; price: number }>;
}

const manifest = JSON.parse(readFileSync(path.join(FIXTURES, "manifest.json"), "utf8")) as Record<string, { file: string; kind: string; expected: ExpectedReceipt | null }>;
const CLEAN_RECEIPTS = ["woolworths-weekly", "coles-topup", "aldi-shop", "tesco-uk"];

interface Reading {
  text: string;
  confidence: number;
  parsed: ParsedReceipt;
  quality: ReceiptQualityAssessment;
}

/** The full local pipeline, as the app runs it: prepare → OCR variant → OCR → parse → quality. */
async function readFixture(name: string): Promise<Reading> {
  const prepared = await prepareReceiptImage(readFileSync(path.join(FIXTURES, manifest[name].file)));
  const { text, confidence } = await ocrReceipt(await ocrVariant(prepared.buffer));
  const parsed = parseReceiptText(text, { today: TODAY });
  const quality = assessReceiptQuality({ ocrConfidence: confidence, text, blurScore: prepared.blurScore, width: prepared.width, height: prepared.height, parsed });
  return { text, confidence, parsed, quality };
}

const normalise = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** Descriptions match if at most ~15% of characters differ (OCR may swap G/6, W/Ww…). */
function similar(a: string, b: string): boolean {
  const x = normalise(a);
  const y = normalise(b);
  return editDistance(x, y) <= Math.max(1, Math.floor(Math.max(x.length, y.length) * 0.15));
}

const readings = new Map<string, Reading>();

beforeAll(async () => {
  // All fixtures at once: jobs must queue on the single shared worker.
  const names = Object.keys(manifest);
  const results = await Promise.all(names.map(readFixture));
  names.forEach((name, i) => readings.set(name, results[i]));
}, 240_000);

afterAll(async () => {
  await terminateOcrWorker();
});

describe("ocrReceipt on the sample receipts", () => {
  it.each(CLEAN_RECEIPTS)("reads %s: store, date, total and nearly every item", (name) => {
    const reading = readings.get(name);
    const expected = manifest[name].expected;
    if (!reading || !expected) throw new Error(`missing reading for ${name}`);

    expect(reading.confidence).toBeGreaterThan(80);
    expect(reading.parsed.store).toBe(expected.store);
    expect(reading.parsed.purchasedOn).toBe(expected.purchasedOn);
    expect(reading.parsed.total).toBe(expected.total);

    const found = expected.items.filter((item) => reading.parsed.lines.some((line) => line.price === item.price && similar(line.description, item.description)));
    expect(found.length / expected.items.length).toBeGreaterThanOrEqual(0.9);
    expect(reading.parsed.lines.length).toBeLessThanOrEqual(expected.items.length + 1);
    expect(reading.quality.ok).toBe(true);
  });

  it("recalls the item descriptions in the raw text", () => {
    for (const name of CLEAN_RECEIPTS) {
      const reading = readings.get(name);
      const expected = manifest[name].expected;
      if (!reading || !expected) throw new Error(`missing reading for ${name}`);
      const words = expected.items.flatMap((item) => item.description.split(/\s+/)).filter((w) => w.length >= 3);
      const text = normalise(reading.text);
      const recalled = words.filter((word) => text.includes(normalise(word)));
      expect(recalled.length / words.length, name).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("asks for a retake of the blurry photo", () => {
    const reading = readings.get("blurry");
    if (!reading) throw new Error("missing reading");
    expect(reading.parsed.total).toBeNull();
    expect(reading.parsed.lines.length).toBeLessThan(4);
    expect(reading.quality.ok).toBe(false);
    expect(reading.quality.warnings).toContain("blurry");
    expect(reading.quality.message).toMatch(/blurry/);
  });

  it("finds nothing to read in a photo that isn't a receipt", () => {
    const reading = readings.get("not-a-receipt");
    if (!reading) throw new Error("missing reading");
    expect(reading.parsed.lines).toEqual([]);
    expect(reading.quality.ok).toBe(false);
    expect(reading.quality.warnings.some((w) => w === "empty" || w === "not_a_receipt")).toBe(true);
  });

  it(
    "starts a fresh worker after being shut down",
    async () => {
      await terminateOcrWorker();
      const again = await readFixture("coles-topup");
      expect(again.parsed.total).toBe(manifest["coles-topup"].expected?.total);
    },
    OCR_TIMEOUT_MS,
  );
});

describe("offline operation", () => {
  it("loads English traineddata from node_modules, not a URL", () => {
    const langPath = resolveTesseractLangPath();
    expect(path.isAbsolute(langPath)).toBe(true);
    expect(langPath).not.toMatch(/^[a-z]+:\/\//i);
    expect(langPath.split(path.sep).slice(-3)).toEqual(["@tesseract.js-data", "eng", "4.0.0_best_int"]);
    expect(existsSync(path.join(langPath, "eng.traineddata.gz"))).toBe(true);
  });

  it(
    "never touches the network, including inside Tesseract's worker thread",
    async () => {
      // A child process whose every thread (the preload also runs in worker
      // threads) has fetch, http(s), TCP, TLS and DNS replaced by tripwires.
      // Unix-domain sockets stay allowed: tsx's loader uses one for local IPC.
      const dir = await mkdtemp(path.join(tmpdir(), "plenty-ocr-offline-"));
      const log = path.join(dir, "network.log");
      const blocker = path.join(dir, "block-network.cjs");
      const script = path.join(dir, "run-ocr.mts");
      await writeFile(
        blocker,
        `const fs = require("node:fs");
const net = require("node:net");
const { isMainThread } = require("node:worker_threads");
const note = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
note("armed " + (isMainThread ? "main" : "worker"));
const trip = (what) => function () { note("BLOCKED " + what); throw new Error("network access blocked: " + what); };
const isUnixSocket = (target) => (typeof target === "string" && Number.isNaN(Number(target))) || (target !== null && typeof target === "object" && typeof target.path === "string");
const guardSockets = (original, what) => function (...args) {
  if (isUnixSocket(Array.isArray(args[0]) ? args[0][0] : args[0])) return original.apply(this, args);
  return trip(what)();
};
globalThis.fetch = trip("fetch");
for (const [mod, fns] of [["node:http", ["request", "get"]], ["node:https", ["request", "get"]], ["node:tls", ["connect"]], ["node:dns", ["lookup", "resolve", "resolve4", "resolve6"]]]) {
  const m = require(mod);
  for (const fn of fns) m[fn] = trip(mod + "." + fn);
}
require("node:dns").promises.lookup = trip("dns.promises.lookup");
net.connect = guardSockets(net.connect, "net.connect");
net.createConnection = guardSockets(net.createConnection, "net.createConnection");
net.Socket.prototype.connect = guardSockets(net.Socket.prototype.connect, "net.Socket.connect");`,
      );
      await writeFile(
        script,
        `import { readFileSync } from "node:fs";
import { ocrVariant, prepareReceiptImage } from ${JSON.stringify(path.join(ROOT, "src/server/receipts/image.ts"))};
import { ocrReceipt, terminateOcrWorker } from ${JSON.stringify(path.join(ROOT, "src/server/receipts/ocr.ts"))};
const prepared = await prepareReceiptImage(readFileSync(${JSON.stringify(path.join(FIXTURES, "coles-topup.png"))}));
const result = await ocrReceipt(await ocrVariant(prepared.buffer));
await terminateOcrWorker();
process.stdout.write(JSON.stringify(result));`,
      );
      try {
        const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=react-server", "-r", blocker, "--import", "tsx", script], {
          cwd: ROOT,
          timeout: OCR_TIMEOUT_MS - 5_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        const result = JSON.parse(stdout) as { text: string; confidence: number };
        expect(result.text).toMatch(/Coles Full Cream Milk/);
        const networkLog = await readFile(log, "utf8");
        expect(networkLog).toContain("armed main");
        expect(networkLog).toContain("armed worker");
        expect(networkLog).not.toContain("BLOCKED");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    OCR_TIMEOUT_MS,
  );
});
