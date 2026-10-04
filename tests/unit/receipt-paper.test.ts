import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { findReceiptPaper, type PaperBox } from "@/lib/receipts/paper";
import { detectReceiptPaper, ocrVariant, OCR_MIN_WIDTH_PX, prepareReceiptImage } from "@/server/receipts/image";

const FIXTURES = path.resolve(__dirname, "../fixtures/receipts");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));

interface Surface {
  r: number;
  g: number;
  b: number;
}

const BEIGE_COUNTER: Surface = { r: 200, g: 190, b: 172 };
const GREEN_BENCH: Surface = { r: 70, g: 120, b: 70 };
const DARK_TABLE: Surface = { r: 28, g: 28, b: 34 };
const WOOD: Surface = { r: 150, g: 105, b: 65 };

const PHOTO = { width: 900, height: 1300 };
const PAPER = { left: 230, top: 0, width: 440 };

/**
 * A receipt photographed on a surface: the fixture receipt scaled to `PAPER.width`, optionally turned a little, laid on a speckled
 * background that is the photo's width and height. Returns the photo and the paper's left/right edges as shares of the width.
 */
async function photoOnSurface(surface: Surface, options: { angle?: number; speckle?: number; paperTop?: number; paperHeight?: number } = {}) {
  const { speckle = 14, angle = 0, paperTop = PAPER.top } = options;
  const paperHeight = options.paperHeight ?? PHOTO.height - paperTop;
  const paper = await sharp(fixture("woolworths-weekly.png")).resize({ width: PAPER.width, height: paperHeight, fit: "cover", position: "top" }).png().toBuffer();
  const turned = angle === 0 ? paper : await sharp(paper).rotate(angle, { background: surface }).png().toBuffer();
  const meta = await sharp(turned).metadata();
  const background = await sharp({
    create: { width: PHOTO.width, height: PHOTO.height, channels: 3, background: surface, noise: { type: "gaussian", mean: 0, sigma: speckle } },
  })
    .png()
    .toBuffer();
  const photo = await sharp(background)
    .composite([{ input: turned, left: Math.round((PHOTO.width - (meta.width ?? PAPER.width)) / 2), top: paperTop }])
    .jpeg({ quality: 88 })
    .toBuffer();
  const left = Math.round((PHOTO.width - (meta.width ?? PAPER.width)) / 2) / PHOTO.width;
  return { photo, paperLeft: left, paperRight: left + (meta.width ?? PAPER.width) / PHOTO.width };
}

async function boxOf(photo: Buffer): Promise<PaperBox | null> {
  return detectReceiptPaper(photo);
}

describe("findReceiptPaper on photos of a receipt on a surface", () => {
  it.each([
    ["a speckled beige counter", BEIGE_COUNTER],
    ["a green bench top", GREEN_BENCH],
    ["a dark table", DARK_TABLE],
    ["a wooden table", WOOD],
  ])("finds the paper on %s, keeping all of it with a margin and dropping most of the surface", async (_name, surface) => {
    const { photo, paperLeft, paperRight } = await photoOnSurface(surface);
    const box = await boxOf(photo);
    expect(box).not.toBeNull();
    if (!box) return;
    // Nothing of the paper is cut off…
    expect(box.left).toBeLessThanOrEqual(paperLeft);
    expect(box.right).toBeGreaterThanOrEqual(paperRight);
    // …and a margin is kept, but the surface mostly goes.
    expect(box.left).toBeGreaterThan(paperLeft - 0.1);
    expect(box.right).toBeLessThan(paperRight + 0.1);
    expect(box.right - box.left).toBeLessThan(0.75);
  });

  it("finds a receipt that is turned a little, keeping all of it", async () => {
    const { photo, paperLeft, paperRight } = await photoOnSurface(BEIGE_COUNTER, { angle: 6, paperTop: 60, paperHeight: 1150 });
    const box = await boxOf(photo);
    expect(box).not.toBeNull();
    if (!box) return;
    // Turning widens the paper's footprint; the box must still hold it.
    expect(box.left).toBeLessThanOrEqual(paperLeft + 0.03);
    expect(box.right).toBeGreaterThanOrEqual(paperRight - 0.03);
    expect(box.right - box.left).toBeLessThan(0.85);
  });

  it("crops the table above and below a receipt that ends inside the frame, with a margin", async () => {
    const { photo } = await photoOnSurface(GREEN_BENCH, { paperTop: 200, paperHeight: 900 });
    const box = await boxOf(photo);
    expect(box).not.toBeNull();
    if (!box) return;
    expect(box.top).toBeGreaterThan(0.02);
    expect(box.top).toBeLessThan(200 / PHOTO.height);
    expect(box.bottom).toBeGreaterThan(1100 / PHOTO.height);
    expect(box.bottom).toBeLessThan(1);
  });

  it("does not crop a photo that is all paper", async () => {
    for (const name of ["woolworths-weekly.png", "coles-topup.png", "aldi-shop.png", "tesco-uk.png", "blurry.png"]) {
      expect(await boxOf(fixture(name)), name).toBeNull();
    }
  });

  it("does not crop when nothing stands out from its surroundings", async () => {
    const flat = await sharp({ create: { width: 600, height: 900, channels: 3, background: BEIGE_COUNTER } }).jpeg().toBuffer();
    expect(await boxOf(flat)).toBeNull();
    const grey = await sharp({ create: { width: 600, height: 900, channels: 3, background: { r: 120, g: 120, b: 120 }, noise: { type: "gaussian", mean: 0, sigma: 12 } } })
      .jpeg()
      .toBuffer();
    expect(await boxOf(grey)).toBeNull();
  });

  it("does not take a thin bright stripe for a receipt", () => {
    const width = 100;
    const height = 140;
    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const stripe = x >= 45 && x < 55;
        const [r, g, b] = stripe ? [235, 235, 235] : [190, 150, 110];
        rgb.set([r, g, b], (y * width + x) * 3);
      }
    }
    expect(findReceiptPaper(rgb, width, height)).toBeNull();
  });

  it("copes with tiny or malformed input", () => {
    expect(findReceiptPaper(new Uint8Array(0), 0, 0)).toBeNull();
    expect(findReceiptPaper(new Uint8Array(12), 2, 2)).toBeNull();
    expect(findReceiptPaper(new Uint8Array(100 * 100), 100, 100, 1)).toBeNull();
    expect(findReceiptPaper(new Uint8Array(100 * 100 * 3), 100, 100)).toBeNull();
  });
});

describe("ocrVariant cropping", () => {
  /** Mean absolute difference between neighbouring pixels in the outer `share` of the image width: speckle is busy, paper is flat. */
  async function marginBusyness(png: Buffer, share = 0.04): Promise<number> {
    const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
    const edge = Math.max(2, Math.floor(info.width * share));
    let sum = 0;
    let count = 0;
    for (let y = 0; y < info.height; y += 1) {
      for (const [from, to] of [[0, edge], [info.width - edge, info.width]]) {
        for (let x = from + 1; x < to; x += 1) {
          sum += Math.abs(data[y * info.width + x] - data[y * info.width + x - 1]);
          count += 1;
        }
      }
    }
    return sum / count;
  }

  it("crops to the paper, so the speckled surface doesn't reach OCR, and still scales to the OCR width", async () => {
    const { photo } = await photoOnSurface(BEIGE_COUNTER, { speckle: 20 });
    const prepared = await prepareReceiptImage(photo);
    const cropped = await ocrVariant(prepared.buffer);
    const whole = await ocrVariant(prepared.buffer, { crop: false });
    const [croppedMeta, wholeMeta] = await Promise.all([sharp(cropped).metadata(), sharp(whole).metadata()]);
    expect(croppedMeta.width).toBe(OCR_MIN_WIDTH_PX);
    expect(wholeMeta.width).toBe(OCR_MIN_WIDTH_PX);
    // The cropped copy is taller for its width because the sides are gone.
    expect((croppedMeta.height ?? 0) / (croppedMeta.width ?? 1)).toBeGreaterThan(((wholeMeta.height ?? 0) / (wholeMeta.width ?? 1)) * 1.3);
    expect(await marginBusyness(cropped)).toBeLessThan((await marginBusyness(whole)) * 0.6);
  });

  it("applies the crop in the photo's upright orientation", async () => {
    const { photo } = await photoOnSurface(BEIGE_COUNTER);
    // Store the upright portrait photo sideways with an EXIF "rotate 90° clockwise to display" tag.
    const sideways = await sharp(photo).rotate(-90).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer();
    const box = await detectReceiptPaper(sideways);
    const upright = await detectReceiptPaper(photo);
    expect(box).not.toBeNull();
    expect(upright).not.toBeNull();
    if (!box || !upright) return;
    expect(box.left).toBeCloseTo(upright.left, 1);
    expect(box.right).toBeCloseTo(upright.right, 1);
    const variant = await sharp(await ocrVariant(sideways)).metadata();
    expect((variant.height ?? 0) > (variant.width ?? 0)).toBe(true);
  });

  it("leaves photos that are all paper exactly as before", async () => {
    const png = fixture("coles-topup.png");
    const whole = await sharp(await ocrVariant(png, { crop: false })).metadata();
    const defaulted = await sharp(await ocrVariant(png)).metadata();
    expect([defaulted.width, defaulted.height]).toEqual([whole.width, whole.height]);
    expect(Buffer.compare(await ocrVariant(png), await ocrVariant(png, { crop: false }))).toBe(0);
  });
});
