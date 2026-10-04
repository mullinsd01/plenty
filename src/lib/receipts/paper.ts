/**
 * Finding the receipt paper in a phone photo.
 *
 * Receipts are usually photographed on a table or counter: a tall, bright,
 * almost colourless strip of paper surrounded by something that is either
 * coloured (wood, a speckled beige bench top) or much darker. Feeding that
 * surround to OCR makes it invent "words" from the speckle at the margins, which
 * shifts and splits real lines. `findReceiptPaper` locates the paper from a
 * small RGB copy of the photo so the caller can crop to it.
 *
 * The signal is colourfulness (max − min over max of the RGB channels), which a
 * shadow across the paper barely changes (a grey shadow stays grey), summarised
 * as the median down each column and then along each row. The paper is the
 * stretch of columns (rows) that is clearly less colourful than the rest.
 * Pixels much darker than the page (print, a black table) count as "not paper".
 *
 * Conservative by design: a photo that is all paper (a scan, a screenshot, a
 * receipt filling the frame) or where no stretch stands out returns null and the
 * whole image is used. Pure and deterministic.
 */

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Pixels darker than this share of the 95th-percentile brightness are print or a dark surface. */
const DARK_SHARE = 0.3;
/** What a dark pixel counts as in the colourfulness signal (clearly "not paper"). */
const DARK_SIGNAL = 0.4;
/** The photo must have some bright pixels at all. */
const MIN_REFERENCE_BRIGHTNESS = 80;
/** The paper must be less colourful than its surround by at least this much (absolute)… */
const MIN_CONTRAST = 0.04;
/** …and by this factor. */
const MIN_CONTRAST_RATIO = 1.35;
/** A paper stretch narrower than this share of the photo is more likely a stripe than a receipt. */
const MIN_WIDTH_SHARE = 0.25;
const MIN_HEIGHT_SHARE = 0.3;
/** The surround must make up at least this share of the axis, or there is nothing to crop. */
const MIN_SURROUND_SHARE = 0.06;
/** Cropping must remove at least this share of the photo's area to be worth doing. */
const MIN_AREA_REMOVED = 0.06;
/** Safety margin kept around the paper, as a share of the photo's width/height. */
const MARGIN = 0.03;
/**
 * Rows are only cropped when the paper was also found between two side margins
 * and the rows above/below look like those margins, or when the contrast is
 * overwhelming: a coloured band printed on the paper itself must never be taken
 * for the table.
 */
const ROW_SURROUND_SIMILARITY = 0.7;
const ROW_STRONG_CONTRAST = 0.08;
/** Margin above and below the paper is more generous: cutting off a total costs more than keeping some table. */
const ROW_MARGIN = 0.05;
/** Smoothing window (in samples) for the profiles. */
const SMOOTHING = 3;

// ─── Types ──────────────────────────────────────────────────────────────────

/** A rectangle as shares of the photo: `left`/`top` inclusive, `right`/`bottom` exclusive, all within 0–1. */
export interface PaperBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// ─── Signal ─────────────────────────────────────────────────────────────────

function percentile(values: Uint8Array, share: number): number {
  const histogram = new Uint32Array(256);
  for (const v of values) histogram[v] += 1;
  const target = values.length * share;
  let seen = 0;
  for (let level = 0; level < 256; level += 1) {
    seen += histogram[level];
    if (seen >= target) return level;
  }
  return 255;
}

/** Colourfulness per pixel, 0 (grey/white) to 1; dark pixels are `DARK_SIGNAL`. Null when the photo is too dark to judge. */
function colourSignal(rgb: Uint8Array, width: number, height: number, channels: number): Float32Array | null {
  const pixels = width * height;
  const brightness = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const o = i * channels;
    brightness[i] = Math.max(rgb[o], rgb[o + 1], rgb[o + 2]);
  }
  const reference = percentile(brightness, 0.95);
  if (reference < MIN_REFERENCE_BRIGHTNESS) return null;
  const floor = reference * DARK_SHARE;
  const signal = new Float32Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const o = i * channels;
    const hi = brightness[i];
    const lo = Math.min(rgb[o], rgb[o + 1], rgb[o + 2]);
    signal[i] = hi < floor ? DARK_SIGNAL : (hi - lo) / hi;
  }
  return signal;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[values.length >> 1] ?? 0;
}

function smooth(profile: number[]): number[] {
  const half = SMOOTHING >> 1;
  return profile.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(profile.length - 1, i + half); k += 1) {
      sum += profile[k];
      count += 1;
    }
    return sum / count;
  });
}

function columnProfile(signal: Float32Array, width: number, height: number, rows: [number, number]): number[] {
  const out: number[] = [];
  for (let x = 0; x < width; x += 1) {
    const column: number[] = [];
    for (let y = rows[0]; y < rows[1]; y += 1) column.push(signal[y * width + x]);
    out.push(median(column));
  }
  return smooth(out);
}

function rowProfile(signal: Float32Array, width: number, height: number, columns: [number, number]): number[] {
  const out: number[] = [];
  for (let y = 0; y < height; y += 1) {
    const row: number[] = [];
    for (let x = columns[0]; x < columns[1]; x += 1) row.push(signal[y * width + x]);
    out.push(median(row));
  }
  return smooth(out);
}

// ─── Interval search ────────────────────────────────────────────────────────

interface Stretch {
  start: number;
  /** Exclusive. */
  end: number;
  /** Mean colourfulness inside / outside the stretch. */
  inside: number;
  outside: number;
}

/**
 * The stretch of the profile that is clearly lower (less colourful) than the
 * rest: the interval with the greatest between-group variance (Otsu's
 * criterion, restricted to one contiguous group), accepted only when the
 * contrast is real and a surround exists. Edges are then pulled to where the
 * profile crosses the midpoint between the two groups.
 */
function paperStretch(profile: number[], minShare: number): Stretch | null {
  const n = profile.length;
  if (n < 8) return null;
  const prefix = [0];
  for (const v of profile) prefix.push(prefix[prefix.length - 1] + v);
  const total = prefix[n];
  const minLength = Math.max(2, Math.ceil(n * minShare));
  let best: { start: number; end: number; score: number; inside: number; outside: number } | null = null;
  for (let start = 0; start < n; start += 1) {
    for (let end = start + minLength; end <= n; end += 1) {
      const inside = (prefix[end] - prefix[start]) / (end - start);
      const outsideCount = n - (end - start);
      if (outsideCount < n * MIN_SURROUND_SHARE) continue;
      const outside = (total - (prefix[end] - prefix[start])) / outsideCount;
      if (outside <= inside) continue;
      const score = (end - start) * outsideCount * (outside - inside) ** 2;
      if (!best || score > best.score) best = { start, end, score, inside, outside };
    }
  }
  if (!best) return null;
  if (best.outside - best.inside < MIN_CONTRAST || best.outside < best.inside * MIN_CONTRAST_RATIO) return null;

  const midpoint = (best.inside + best.outside) / 2;
  let { start, end } = best;
  while (start > 0 && profile[start - 1] < midpoint) start -= 1;
  while (start < end - 1 && profile[start] >= midpoint) start += 1;
  while (end < n && profile[end] < midpoint) end += 1;
  while (end > start + 1 && profile[end - 1] >= midpoint) end -= 1;
  return end - start >= minLength ? { start, end, inside: best.inside, outside: best.outside } : null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Locate the receipt paper in a small RGB(A) copy of a photo (about 200 px
 * wide is plenty). Returns the paper's bounding box plus a safety margin, or
 * null when no paper stands out from its surroundings or cropping would
 * barely change anything.
 */
export function findReceiptPaper(rgb: Uint8Array, width: number, height: number, channels = 3): PaperBox | null {
  if (channels < 3 || width < 8 || height < 8 || rgb.length < width * height * channels) return null;
  const signal = colourSignal(rgb, width, height, channels);
  if (!signal) return null;

  const across = paperStretch(columnProfile(signal, width, height, [0, height]), MIN_WIDTH_SHARE);
  const columns: [number, number] = across ? [across.start, across.end] : [0, width];
  const rowStretch = paperStretch(rowProfile(signal, width, height, columns), MIN_HEIGHT_SHARE);
  const rowsLookLikeMargins = rowStretch !== null && across !== null && rowStretch.outside >= across.outside * ROW_SURROUND_SIMILARITY;
  const rowsAreOverwhelming = rowStretch !== null && rowStretch.outside - rowStretch.inside >= ROW_STRONG_CONTRAST;
  const down = rowStretch && (rowsLookLikeMargins || rowsAreOverwhelming) ? rowStretch : null;
  if (!across && !down) return null;

  const rows: [number, number] = down ? [down.start, down.end] : [0, height];
  const box: PaperBox = {
    left: Math.max(0, columns[0] / width - MARGIN),
    right: Math.min(1, columns[1] / width + MARGIN),
    top: Math.max(0, rows[0] / height - ROW_MARGIN),
    bottom: Math.min(1, rows[1] / height + ROW_MARGIN),
  };
  const area = (box.right - box.left) * (box.bottom - box.top);
  return area <= 1 - MIN_AREA_REMOVED ? box : null;
}
