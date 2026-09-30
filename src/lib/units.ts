/**
 * Units and quantity conversion.
 *
 * Every quantity can be expressed in one of three base units:
 *   g (mass), ml (volume), each (count).
 *
 * Container units (pack, can, bottle, …) are counts; converting them to mass or
 * volume needs product knowledge (e.g. one can of tomatoes ≈ 400 g). That
 * knowledge is supplied through `ProductUnitInfo`.
 */

export const UNITS = [
  "each",
  "g",
  "kg",
  "ml",
  "l",
  "pack",
  "bunch",
  "can",
  "bottle",
  "jar",
  "loaf",
  "dozen",
  "tbsp",
  "tsp",
  "cup",
  "clove",
  "slice",
  "pinch",
] as const;
export type Unit = (typeof UNITS)[number];

export type BaseUnit = "g" | "ml" | "each";
export type Dimension = "mass" | "volume" | "count";

interface UnitDef {
  dimension: Dimension;
  /** Multiplier into the base unit of its dimension. */
  toBase: number;
  singular: string;
  plural: string;
  /** Short display form, e.g. "kg". Empty for plain counts. */
  short: string;
  /** Whether the unit is a container/portion whose base amount depends on the product. */
  container?: boolean;
}

const UNIT_DEFS: Record<Unit, UnitDef> = {
  each: { dimension: "count", toBase: 1, singular: "", plural: "", short: "" },
  g: { dimension: "mass", toBase: 1, singular: "g", plural: "g", short: "g" },
  kg: { dimension: "mass", toBase: 1000, singular: "kg", plural: "kg", short: "kg" },
  ml: { dimension: "volume", toBase: 1, singular: "ml", plural: "ml", short: "ml" },
  l: { dimension: "volume", toBase: 1000, singular: "L", plural: "L", short: "L" },
  pack: { dimension: "count", toBase: 1, singular: "pack", plural: "packs", short: "pk", container: true },
  bunch: { dimension: "count", toBase: 1, singular: "bunch", plural: "bunches", short: "bunch", container: true },
  can: { dimension: "count", toBase: 1, singular: "can", plural: "cans", short: "can", container: true },
  bottle: { dimension: "count", toBase: 1, singular: "bottle", plural: "bottles", short: "btl", container: true },
  jar: { dimension: "count", toBase: 1, singular: "jar", plural: "jars", short: "jar", container: true },
  loaf: { dimension: "count", toBase: 1, singular: "loaf", plural: "loaves", short: "loaf", container: true },
  dozen: { dimension: "count", toBase: 12, singular: "dozen", plural: "dozen", short: "doz" },
  tbsp: { dimension: "volume", toBase: 15, singular: "tbsp", plural: "tbsp", short: "tbsp" },
  tsp: { dimension: "volume", toBase: 5, singular: "tsp", plural: "tsp", short: "tsp" },
  cup: { dimension: "volume", toBase: 250, singular: "cup", plural: "cups", short: "cup" },
  clove: { dimension: "count", toBase: 1, singular: "clove", plural: "cloves", short: "clove", container: true },
  slice: { dimension: "count", toBase: 1, singular: "slice", plural: "slices", short: "slice", container: true },
  pinch: { dimension: "mass", toBase: 0.3, singular: "pinch", plural: "pinches", short: "pinch" },
};

export function isUnit(value: unknown): value is Unit {
  return typeof value === "string" && (UNITS as readonly string[]).includes(value);
}

export function unitDimension(unit: Unit): Dimension {
  return UNIT_DEFS[unit].dimension;
}

export function baseUnitFor(dimension: Dimension): BaseUnit {
  return dimension === "mass" ? "g" : dimension === "volume" ? "ml" : "each";
}

export function isContainerUnit(unit: Unit): boolean {
  return UNIT_DEFS[unit].container === true;
}

/**
 * Product knowledge needed to convert between dimensions.
 * All fields optional; conversions that need missing info return null.
 */
export interface ProductUnitInfo {
  /** The unit the product is normally tracked in (e.g. "l" for milk, "each" for eggs). */
  unit?: Unit;
  /** Mass of one item / container in grams (e.g. one egg ≈ 60 g, one can ≈ 400 g). */
  eachWeightG?: number | null;
  /** Volume of one container in ml, for liquids sold in containers (e.g. one bottle ≈ 750 ml). */
  eachVolumeMl?: number | null;
  /** Density in g/ml, for converting volume ↔ mass. Water ≈ 1. */
  densityGPerMl?: number | null;
}

export interface BaseQuantity {
  amount: number;
  unit: BaseUnit;
}

/** Convert a quantity into its natural base unit (no cross-dimension conversion). */
export function toBase(quantity: number, unit: Unit): BaseQuantity {
  const def = UNIT_DEFS[unit];
  return { amount: quantity * def.toBase, unit: baseUnitFor(def.dimension) };
}

/**
 * Convert an amount between base units using product knowledge.
 * Returns null when the conversion is not possible with the info available.
 */
export function convertBase(amount: number, from: BaseUnit, to: BaseUnit, info?: ProductUnitInfo | null): number | null {
  if (from === to) return amount;
  const density = info?.densityGPerMl ?? null;
  const eachG = info?.eachWeightG ?? null;
  const eachMl = info?.eachVolumeMl ?? (eachG && density ? eachG / density : null);
  const eachGEffective = eachG ?? (eachMl && density ? eachMl * density : null);

  if (from === "ml" && to === "g") return density ? amount * density : null;
  if (from === "g" && to === "ml") return density ? amount / density : null;
  if (from === "each" && to === "g") return eachGEffective ? amount * eachGEffective : null;
  if (from === "g" && to === "each") return eachGEffective ? amount / eachGEffective : null;
  if (from === "each" && to === "ml") return eachMl ? amount * eachMl : null;
  if (from === "ml" && to === "each") return eachMl ? amount / eachMl : null;
  return null;
}

/**
 * Convert `quantity` of `from` into `to`, using product knowledge where the
 * dimensions differ. Returns null if not convertible.
 */
export function convert(quantity: number, from: Unit, to: Unit, info?: ProductUnitInfo | null): number | null {
  if (from === to) return quantity;
  const src = toBase(quantity, from);
  const targetDef = UNIT_DEFS[to];
  const targetBase = baseUnitFor(targetDef.dimension);
  const inTargetBase = convertBase(src.amount, src.unit, targetBase, info);
  if (inTargetBase === null) return null;
  return inTargetBase / targetDef.toBase;
}

/** Convert a quantity to the given base unit, crossing dimensions if product info allows. */
export function toBaseUnit(quantity: number, unit: Unit, target: BaseUnit, info?: ProductUnitInfo | null): number | null {
  const b = toBase(quantity, unit);
  return convertBase(b.amount, b.unit, target, info);
}

/** The base unit a product should be tracked in, given its tracking unit. */
export function productBaseUnit(info: ProductUnitInfo | null | undefined, fallbackUnit: Unit): BaseUnit {
  return baseUnitFor(unitDimension(info?.unit ?? fallbackUnit));
}

// ─── Parsing ────────────────────────────────────────────────────────────────

const UNIT_ALIASES: Record<string, Unit> = {
  each: "each",
  ea: "each",
  x: "each",
  pc: "each",
  pcs: "each",
  piece: "each",
  pieces: "each",
  item: "each",
  items: "each",
  whole: "each",
  g: "g",
  gm: "g",
  gms: "g",
  gr: "g",
  gram: "g",
  grams: "g",
  kg: "kg",
  kgs: "kg",
  kilo: "kg",
  kilos: "kg",
  kilogram: "kg",
  kilograms: "kg",
  ml: "ml",
  millilitre: "ml",
  millilitres: "ml",
  milliliter: "ml",
  milliliters: "ml",
  l: "l",
  lt: "l",
  ltr: "l",
  litre: "l",
  litres: "l",
  liter: "l",
  liters: "l",
  pk: "pack",
  pkt: "pack",
  pack: "pack",
  packs: "pack",
  packet: "pack",
  packets: "pack",
  bag: "pack",
  bags: "pack",
  box: "pack",
  punnet: "pack",
  punnets: "pack",
  tub: "pack",
  tray: "pack",
  bunch: "bunch",
  bunches: "bunch",
  bn: "bunch",
  can: "can",
  cans: "can",
  tin: "can",
  tins: "can",
  bottle: "bottle",
  bottles: "bottle",
  btl: "bottle",
  jar: "jar",
  jars: "jar",
  loaf: "loaf",
  loaves: "loaf",
  dozen: "dozen",
  doz: "dozen",
  dz: "dozen",
  tbsp: "tbsp",
  tbs: "tbsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  tsp: "tsp",
  teaspoon: "tsp",
  teaspoons: "tsp",
  cup: "cup",
  cups: "cup",
  clove: "clove",
  cloves: "clove",
  slice: "slice",
  slices: "slice",
  pinch: "pinch",
  pinches: "pinch",
};

/** Parse a unit string ("Litres", "kg", "tins") into a Unit. */
export function parseUnit(raw: string | null | undefined): Unit | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/\.$/, "");
  return UNIT_ALIASES[key] ?? null;
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function trimNumber(n: number, maxDecimals = 2): string {
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 10 ** maxDecimals) / 10 ** maxDecimals;
  return String(rounded);
}

const FRACTIONS: Array<[number, string]> = [
  [0.25, "¼"],
  [0.33, "⅓"],
  [0.5, "½"],
  [0.67, "⅔"],
  [0.75, "¾"],
];

/** Render small quantities nicely: 0.5 → "½", 1.5 → "1½". */
export function formatAmount(n: number): string {
  if (n <= 0) return "0";
  const whole = Math.floor(n);
  const frac = n - whole;
  if (frac < 0.05) return String(whole);
  if (n < 10) {
    for (const [value, glyph] of FRACTIONS) {
      if (Math.abs(frac - value) < 0.04) return whole === 0 ? glyph : `${whole}${glyph}`;
    }
  }
  return trimNumber(n, n < 10 ? 2 : 1);
}

/**
 * Human-friendly quantity: "2 L", "500 g", "12", "3 cans", "1.2 kg".
 * Promotes g→kg and ml→L when large.
 */
export function formatQuantity(quantity: number | null | undefined, unit: Unit | null | undefined): string {
  if (quantity === null || quantity === undefined || !Number.isFinite(quantity)) return "";
  const u: Unit = unit ?? "each";
  if (u === "g" && quantity >= 1000) return `${trimNumber(quantity / 1000)} kg`;
  if (u === "ml" && quantity >= 1000) return `${trimNumber(quantity / 1000)} L`;
  if (u === "kg" && quantity < 1) return `${trimNumber(quantity * 1000, 0)} g`;
  if (u === "l" && quantity < 1) return `${trimNumber(quantity * 1000, 0)} ml`;
  const def = UNIT_DEFS[u];
  if (u === "each") return formatAmount(quantity);
  const amount =
    def.dimension === "count" || u === "tbsp" || u === "tsp" || u === "cup"
      ? formatAmount(quantity)
      : u === "g" || u === "ml"
        ? // Grams and millilitres converted from other units shouldn't read "679.61 ml".
          String(quantity >= 100 ? Number(Math.round(quantity).toPrecision(3)) : Math.round(quantity * 10) / 10)
        : trimNumber(quantity);
  const label = quantity > 1 && !["g", "kg", "ml", "l"].includes(u) ? def.plural : def.singular;
  return `${amount} ${label}`.trim();
}

/** Format a base-unit amount for display (e.g. 1500 ml → "1.5 L"). */
export function formatBase(amount: number, unit: BaseUnit): string {
  return formatQuantity(amount, unit);
}

/** Round a needed amount up to whole purchasable packages. */
export function packagesNeeded(neededBase: number, packageBase: number): number {
  if (packageBase <= 0) return 1;
  return Math.max(1, Math.ceil(neededBase / packageBase - 1e-9));
}
