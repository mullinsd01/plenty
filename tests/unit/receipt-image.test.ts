import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp, { type Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import { BLURRY_BELOW } from "@/lib/receipts/quality";
import {
  divideByBackground,
  heicSupported,
  laplacianVariance,
  MAX_STORED_EDGE_PX,
  OCR_MIN_WIDTH_PX,
  ocrVariant,
  prepareReceiptImage,
  ReceiptImageError,
  rescaledVariant,
  type ReceiptImageErrorCode,
} from "@/server/receipts/image";

const FIXTURES = path.resolve(__dirname, "../fixtures/receipts");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));

/** A photo with a red left half and a blue right half. */
async function splitImage(width: number, height: number): Promise<Sharp> {
  const half = await sharp({ create: { width: Math.floor(width / 2), height, channels: 3, background: "#ff0000" } }).png().toBuffer();
  return sharp({ create: { width, height, channels: 3, background: "#0000ff" } }).composite([{ input: half, left: 0, top: 0 }]);
}

async function pixel(image: Buffer, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}

async function expectRejected(input: Buffer, code: ReceiptImageErrorCode): Promise<ReceiptImageError> {
  const error = await prepareReceiptImage(input).then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(ReceiptImageError);
  const typed = error as ReceiptImageError;
  expect(typed.code).toBe(code);
  expect(typed.message.length).toBeGreaterThan(20);
  expect(typed.message).not.toMatch(/vips|sharp|buffer|stack/i);
  return typed;
}

describe("prepareReceiptImage", () => {
  it("applies the EXIF orientation so the receipt is upright", async () => {
    // Stored landscape with "rotate 90° clockwise to display" (a portrait phone photo).
    const photo = await (await splitImage(400, 300)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const prepared = await prepareReceiptImage(photo);
    expect([prepared.width, prepared.height]).toEqual([300, 400]);
    // After rotating clockwise, the left (red) half is at the top.
    expect((await pixel(prepared.buffer, 150, 20)).r).toBeGreaterThan(200);
    expect((await pixel(prepared.buffer, 150, 380)).b).toBeGreaterThan(200);
    expect((await sharp(prepared.buffer).metadata()).orientation).toBeUndefined();
  });

  it("shrinks large photos to 2000 px on the long edge and never enlarges small ones", async () => {
    const large = await prepareReceiptImage(await (await splitImage(4000, 3000)).jpeg().toBuffer());
    expect([large.width, large.height]).toEqual([MAX_STORED_EDGE_PX, 1500]);
    const small = await prepareReceiptImage(await (await splitImage(800, 600)).jpeg().toBuffer());
    expect([small.width, small.height]).toEqual([800, 600]);
  });

  it("outputs a JPEG with EXIF, GPS-style tags and colour profiles stripped", async () => {
    const photo = await (await splitImage(900, 1200))
      .jpeg()
      .withExif({ IFD0: { Copyright: "Plenty test", Make: "PhoneCo", Model: "Camera 12" } })
      .withIccProfile("p3")
      .toBuffer();
    const before = await sharp(photo).metadata();
    expect(before.exif).toBeDefined();
    expect(before.icc).toBeDefined();

    const prepared = await prepareReceiptImage(photo);
    const after = await sharp(prepared.buffer).metadata();
    expect(after.format).toBe("jpeg");
    expect(after.exif).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(prepared.buffer.includes(Buffer.from("PhoneCo"))).toBe(false);
  });

  it("accepts PNG (flattening transparency onto white) and WebP", async () => {
    const transparent = await sharp({ create: { width: 600, height: 800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const fromPng = await prepareReceiptImage(transparent);
    expect(await pixel(fromPng.buffer, 300, 400)).toEqual({ r: 255, g: 255, b: 255 });

    const webp = await (await splitImage(700, 900)).webp().toBuffer();
    const fromWebp = await prepareReceiptImage(webp);
    expect([fromWebp.width, fromWebp.height]).toEqual([700, 900]);
    expect((await sharp(fromWebp.buffer).metadata()).format).toBe("jpeg");
  });

  it("hashes the output deterministically", async () => {
    const input = fixture("coles-topup.png");
    const a = await prepareReceiptImage(input);
    const b = await prepareReceiptImage(input);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sha256).toBe(createHash("sha256").update(a.buffer).digest("hex"));
    expect(b.sha256).toBe(a.sha256);
    const other = await prepareReceiptImage(fixture("aldi-shop.png"));
    expect(other.sha256).not.toBe(a.sha256);
  });

  it("scores sharp receipts far above blurry ones", async () => {
    const sharpScores = await Promise.all(["woolworths-weekly.png", "coles-topup.png", "aldi-shop.png", "tesco-uk.png"].map(async (name) => (await prepareReceiptImage(fixture(name))).blurScore));
    const blurry = (await prepareReceiptImage(fixture("blurry.png"))).blurScore;
    for (const score of sharpScores) expect(score).toBeGreaterThan(1000);
    expect(blurry).toBeLessThan(BLURRY_BELOW);
    // Same receipt, before and after losing focus.
    expect(sharpScores[0] / blurry).toBeGreaterThan(100);
  });

  it("rejects files that aren't supported photos", async () => {
    await expectRejected(Buffer.from("this is a text file, not a photo of a receipt"), "unsupported_format");
    await expectRejected(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"></svg>'), "unsupported_format");
    await expectRejected(await sharp({ create: { width: 400, height: 400, channels: 3, background: "#fff" } }).gif().toBuffer(), "unsupported_format");
    await expectRejected(await sharp({ create: { width: 400, height: 400, channels: 3, background: "#fff" } }).tiff().toBuffer(), "unsupported_format");
    await expectRejected(Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n"), "unsupported_format");
  });

  it("rejects animated images", async () => {
    const frame = (colour: string) => sharp({ create: { width: 400, height: 400, channels: 3, background: colour } }).png().toBuffer();
    const animated = await sharp([await frame("#f00"), await frame("#00f")], { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    const error = await expectRejected(animated, "unsupported_format");
    expect(error.message).toMatch(/animated/i);
  });

  it("explains that HEIC photos need converting when this build can't decode them", async () => {
    // Minimal ISO-BMFF header with the "heic" brand: enough to identify the format.
    const heicHeader = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(4), Buffer.from("mif1heic")]);
    if (heicSupported()) {
      await expectRejected(heicHeader, "corrupt");
    } else {
      const error = await expectRejected(heicHeader, "unsupported_format");
      expect(error.message).toMatch(/HEIC/);
    }
  });

  it("rejects images that are too small or over 40 megapixels", async () => {
    await expectRejected(await sharp({ create: { width: 150, height: 150, channels: 3, background: "#fff" } }).png().toBuffer(), "too_small");
    await expectRejected(await sharp({ create: { width: 1200, height: 180, channels: 3, background: "#fff" } }).png().toBuffer(), "too_small");
    const huge = await sharp({ create: { width: 8000, height: 5100, channels: 3, background: "#fff" } }).jpeg({ quality: 50 }).toBuffer();
    await expectRejected(huge, "too_large");
  });

  it("rejects empty, truncated and garbled files as corrupt", async () => {
    await expectRejected(Buffer.alloc(0), "corrupt");
    const jpeg = await (await splitImage(800, 600)).jpeg().toBuffer();
    await expectRejected(jpeg.subarray(0, 120), "corrupt");
    await expectRejected(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 0x5a)]), "corrupt");
    const png = await sharp({ create: { width: 600, height: 600, channels: 3, background: "#fff" } }).png().toBuffer();
    await expectRejected(png.subarray(0, 40), "corrupt");
  });
});

describe("laplacianVariance", () => {
  it("is zero for a flat image and large for a fine checkerboard", () => {
    const flat = new Uint8Array(20 * 20).fill(200);
    expect(laplacianVariance(flat, 20, 20)).toBe(0);
    const checker = new Uint8Array(20 * 20).map((_, i) => ((i % 20) + Math.floor(i / 20)) % 2 === 0 ? 0 : 255);
    expect(laplacianVariance(checker, 20, 20)).toBeGreaterThan(100_000);
  });

  it("reads only the first channel of interleaved pixels and handles tiny images", () => {
    const grey = new Uint8Array(10 * 10).map((_, i) => (i % 3) * 60);
    const rgb = new Uint8Array(10 * 10 * 3).map((_, i) => (i % 3 === 0 ? grey[i / 3] : 17));
    expect(laplacianVariance(rgb, 10, 10, 3)).toBeCloseTo(laplacianVariance(grey, 10, 10));
    expect(laplacianVariance(new Uint8Array(4), 2, 2)).toBe(0);
  });
});

describe("ocrVariant", () => {
  it("produces a greyscale PNG at least 1600 px wide", async () => {
    const prepared = await prepareReceiptImage(fixture("coles-topup.png"));
    const variant = await ocrVariant(prepared.buffer);
    const meta = await sharp(variant).metadata();
    expect(meta.format).toBe("png");
    expect(meta.channels).toBe(1);
    expect(meta.width).toBeGreaterThanOrEqual(OCR_MIN_WIDTH_PX);
    // Aspect ratio is preserved when upscaling.
    expect((meta.height ?? 0) / (meta.width ?? 1)).toBeCloseTo(prepared.height / prepared.width, 2);
  });

  it("keeps wide photos at their size", async () => {
    const wide = await (await splitImage(1900, 1000)).jpeg().toBuffer();
    expect((await sharp(await ocrVariant(wide)).metadata()).width).toBe(1900);
  });

  it("evens out shadows so the paper is white edge to edge", async () => {
    // Paper fading from white to a heavy shadow, with dark "ink" strokes.
    const shadow = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f2f2f2"/><stop offset="1" stop-color="#6e6e6e"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${Array.from({ length: 12 }, (_, i) => `<rect x="80" y="${60 + i * 75}" width="600" height="14" fill="#202020"/>`).join("")}</svg>`,
    );
    const photo = await sharp(shadow).jpeg().toBuffer();
    const variant = await ocrVariant(photo);
    const { data, info } = await sharp(variant).raw().toBuffer({ resolveWithObject: true });
    const at = (fx: number, fy: number) => data[Math.floor(fy * info.height) * info.width + Math.floor(fx * info.width)];
    // Blank paper in the bright corner and in the shadowed corner both come out near white…
    expect(at(0.03, 0.02)).toBeGreaterThan(235);
    expect(at(0.97, 0.98)).toBeGreaterThan(235);
    // …while the ink in the shadow stays dark.
    const inkRow = (60 + 11 * 75 + 7) / 1000;
    expect(at(0.5, inkRow)).toBeLessThan(80);
  });

  it("rejects undecodable input", async () => {
    await expect(ocrVariant(Buffer.from("not an image"))).rejects.toBeInstanceOf(ReceiptImageError);
  });
});

describe("divideByBackground", () => {
  it("scales each pixel by its local paper brightness", () => {
    const pixels = new Uint8Array([100, 50, 200, 0]);
    const background = new Uint8Array([200, 100, 200, 0]);
    expect([...divideByBackground(pixels, background)]).toEqual([128, 128, 255, 0]);
  });
});

describe("rescaledVariant", () => {
  it("makes the OCR copy wider or narrower by the factor, keeping its proportions, within sane limits", async () => {
    const variant = await ocrVariant(await sharp(fixture("coles-topup.png")).resize({ width: 800 }).png().toBuffer());
    const original = await sharp(variant).metadata();
    expect(original.width).toBe(OCR_MIN_WIDTH_PX);
    const wider = await sharp(await rescaledVariant(variant, 1.25)).metadata();
    expect(wider.width).toBe(2000);
    expect(wider.height).toBe(Math.round(((original.height ?? 0) * 2000) / OCR_MIN_WIDTH_PX));
    expect((await sharp(await rescaledVariant(variant, 0.8)).metadata()).width).toBe(1280);
    // Never absurdly small or large, whatever the factor.
    expect((await sharp(await rescaledVariant(variant, 0.1)).metadata()).width).toBe(900);
    expect((await sharp(await rescaledVariant(variant, 9)).metadata()).width).toBe(2400);
  });

  it("returns a greyscale PNG and rejects undecodable input", async () => {
    const variant = await ocrVariant(fixture("coles-topup.png"));
    const out = await rescaledVariant(variant, 0.65);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("png");
    expect(meta.space).toBe("b-w");
    await expect(rescaledVariant(Buffer.from("not an image"), 1.25)).rejects.toBeInstanceOf(ReceiptImageError);
  });
});
