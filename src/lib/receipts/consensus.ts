/**
 * Merging several readings of one receipt.
 *
 * OCR on a poor photo is chaotic: the same photo, re-encoded or rescaled a
 * little, reads a digit differently ("2.38" / "2.98"), loses a line, or invents
 * one. Each reading is wrong in different places, so reading the photo a few
 * ways and keeping what the readings agree on recovers far more of the receipt
 * than any single reading (measured on a phone photo of a Woolworths receipt:
 * 4–9 of 10 prices right per reading, 9–10 of 10 when a price needs two
 * readings to agree).
 *
 * Lines are aligned across readings by description (and price, weight), in
 * receipt order; a line is kept when two readings found it or when it comes from
 * the best reading; prices, weights and descriptions are decided by vote.
 * Pure and deterministic.
 */

import type { ParsedReceiptLine } from "@/lib/receipts/parse";

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Two lines are the same item when their descriptions are at least this alike (0–1). */
const SAME_LINE_SIMILARITY = 0.6;
/** Equal prices / weights make descriptions look more alike by this much. */
const PRICE_AGREEMENT_BONUS = 0.15;
const WEIGHT_AGREEMENT_BONUS = 0.1;
/** Descriptions shorter than this (letters and digits) are too short to align on. */
const MIN_ALIGNABLE_LENGTH = 4;
/** A total or subtotal read by one reading only is believed when the merged items add up to it this closely. */
const SUM_TOLERANCE = 0.05;
const SUM_TOLERANCE_MIN_ABS = 0.1;

// ─── Types ──────────────────────────────────────────────────────────────────

/** What one reading of the receipt text found. */
export interface Reading {
  store: string | null;
  purchasedOn: string | null;
  /** Why the best date candidate was rejected, when no date was accepted. */
  dateRejection: "date_in_future" | "date_too_old" | null;
  total: number | null;
  subtotal: number | null;
  taxes: number[];
  /** The receipt visibly continues below its last item. */
  footerSeen: boolean;
  lines: ParsedReceiptLine[];
}

interface Member {
  /** Index into the readings, best reading first. */
  reading: number;
  line: ParsedReceiptLine;
}

interface Cluster {
  members: Member[];
}

// ─── Similarity ─────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

function compact(description: string): string {
  return description.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row.push(Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    previous = row;
  }
  return previous[b.length];
}

/** 0–1: how alike two lines look, from their descriptions, nudged by agreeing prices and weights. */
function lineSimilarity(a: ParsedReceiptLine, b: ParsedReceiptLine): number {
  const x = compact(a.description);
  const y = compact(b.description);
  if (x.length < MIN_ALIGNABLE_LENGTH || y.length < MIN_ALIGNABLE_LENGTH) return 0;
  let similarity = 1 - editDistance(x, y) / Math.max(x.length, y.length);
  if (a.price !== null && a.price === b.price) similarity += PRICE_AGREEMENT_BONUS;
  if (a.weightKg !== null && a.weightKg === b.weightKg) similarity += WEIGHT_AGREEMENT_BONUS;
  return Math.min(1, similarity);
}

// ─── Voting ─────────────────────────────────────────────────────────────────

/** The most common value (the first seen wins ties); null when there are none. */
function mostCommon<T>(values: readonly T[]): { value: T; votes: number } | null {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: { value: T; votes: number } | null = null;
  for (const [value, votes] of counts) if (!best || votes > best.votes) best = { value, votes };
  return best;
}

/** The member whose description is most like the others' (the first wins ties). */
function medoid(members: readonly Member[]): Member {
  let best = members[0];
  let bestScore = -1;
  for (const candidate of members) {
    const score = members.reduce((sum, other) => sum + (other === candidate ? 0 : lineSimilarity(candidate.line, other.line)), 0);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** One line from a cluster: the price before discounts by vote, then the rest. */
function decide(cluster: Cluster): ParsedReceiptLine {
  const { members } = cluster;
  const base = (line: ParsedReceiptLine) => (line.price === null ? null : round2(line.price + (line.discount ?? 0)));
  const winnerBase = mostCommon(members.map((m) => base(m.line)).filter((p): p is number => p !== null))?.value ?? null;
  const priced = winnerBase === null ? members : members.filter((m) => base(m.line) === winnerBase);
  const discount = mostCommon(priced.map((m) => m.line.discount))?.value ?? null;
  const described = medoid(members);
  const vote = (key: "weightKg" | "quantity" | "unitPrice"): number | null =>
    mostCommon(members.map((m) => m.line[key]).filter((v): v is number => v !== null))?.value ?? null;
  return {
    raw: described.line.raw,
    description: described.line.description,
    quantity: vote("quantity"),
    weightKg: vote("weightKg"),
    unitPrice: vote("unitPrice"),
    price: winnerBase === null ? null : round2(Math.max(0, winnerBase - (discount ?? 0))),
    discount,
  };
}

// ─── Alignment ──────────────────────────────────────────────────────────────

/**
 * Align every reading's lines to clusters of the same item, in receipt order.
 * The first reading's lines start the list; each later line joins the best
 * matching cluster after the previous match (at most one line per reading per
 * cluster), or starts a new cluster right after it.
 */
function alignLines(readings: readonly Reading[]): Cluster[] {
  const clusters: Cluster[] = [];
  readings.forEach((reading, r) => {
    let last = -1;
    for (const line of reading.lines) {
      let best = -1;
      let bestSimilarity = SAME_LINE_SIMILARITY;
      for (let j = last + 1; j < clusters.length; j += 1) {
        if (clusters[j].members.some((m) => m.reading === r)) continue;
        const similarity = Math.max(...clusters[j].members.map((m) => lineSimilarity(m.line, line)));
        if (similarity > bestSimilarity) {
          best = j;
          bestSimilarity = similarity;
        }
      }
      if (best >= 0) {
        clusters[best].members.push({ reading: r, line });
        last = best;
      } else {
        clusters.splice(last + 1, 0, { members: [{ reading: r, line }] });
        last += 1;
      }
    }
  });
  return clusters;
}

// ─── Public API ─────────────────────────────────────────────────────────────

function sumOf(lines: readonly ParsedReceiptLine[]): number {
  return round2(lines.reduce((acc, l) => acc + (l.price ?? 0), 0));
}

/** A printed amount is believed when two readings agree on it, or when the merged items add up to it. */
function decideAmount(candidates: ReadonlyArray<number | null>, lines: readonly ParsedReceiptLine[], taxes: readonly number[]): number | null {
  const read = candidates.filter((c): c is number => c !== null && c > 0);
  const winner = mostCommon(read);
  if (!winner) return null;
  if (winner.votes >= 2) return winner.value;
  const sum = sumOf(lines);
  const taxSum = taxes.reduce((acc, t) => acc + Math.max(0, t), 0);
  const close = (reference: number) => Math.abs(sum - reference) <= Math.max(reference * SUM_TOLERANCE, SUM_TOLERANCE_MIN_ABS);
  return read.find((value) => lines.length > 0 && (close(value) || (taxSum > 0 && close(value - taxSum)))) ?? null;
}

const EMPTY_READING: Reading = { store: null, purchasedOn: null, dateRejection: null, total: null, subtotal: null, taxes: [], footerSeen: false, lines: [] };

/**
 * Merge readings of the same receipt into one. The reading with the most item
 * lines is the best one (earlier readings win ties): a line needs a second
 * reading to enter the result unless the best reading has it.
 */
export function mergeReadings(readings: readonly Reading[]): Reading {
  if (readings.length === 0) return EMPTY_READING;
  if (readings.length === 1) return readings[0];

  const ordered = [...readings].sort((a, b) => b.lines.length - a.lines.length);
  const clusters = alignLines(ordered);
  const lines = clusters.filter((c) => new Set(c.members.map((m) => m.reading)).size >= 2 || c.members.some((m) => m.reading === 0)).map(decide);

  const taxes = ordered.find((r) => r.taxes.length > 0)?.taxes ?? [];
  const date = mostCommon(ordered.map((r) => r.purchasedOn).filter((d): d is string => d !== null))?.value ?? null;
  return {
    store: mostCommon(ordered.map((r) => r.store).filter((s): s is string => s !== null))?.value ?? null,
    purchasedOn: date,
    dateRejection: date ? null : (ordered.find((r) => r.dateRejection)?.dateRejection ?? null),
    total: decideAmount(ordered.map((r) => r.total), lines, taxes),
    subtotal: decideAmount(ordered.map((r) => r.subtotal), lines, taxes),
    taxes,
    footerSeen: ordered.some((r) => r.footerSeen),
    lines,
  };
}
