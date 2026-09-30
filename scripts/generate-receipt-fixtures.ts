/**
 * Generates realistic sample receipt photos for tests and the in-app
 * "try a sample receipt" demo.
 *
 *   npx tsx scripts/generate-receipt-fixtures.ts
 *
 * Writes to tests/fixtures/receipts/:
 *   <name>.png      rendered receipt (DejaVu Sans Mono on off-white paper, 2x)
 *   <name>.txt      the exact text printed on it (ground truth for the parser)
 *   manifest.json   expected parse for every fixture
 * and copies the demo receipts to public/demo/receipts/.
 *
 * Output is deterministic: noise uses a seeded PRNG, and all receipt dates
 * are fixed (late September 2026).
 */

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// ─── Layout ─────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..");
const FIXTURE_DIR = path.join(ROOT, "tests/fixtures/receipts");
const DEMO_DIR = path.join(ROOT, "public/demo/receipts");

/** Characters per printed line (typical 80 mm thermal receipt). */
const COLUMNS = 40;
/** SVG canvas width in CSS px; rendered at 2x for legibility. */
const PAGE_WIDTH = 640;
const SCALE = 2;
const MARGIN_X = 40;
const MARGIN_TOP = 48;
const MARGIN_BOTTOM = 64;
const FONT_FAMILY = "DejaVu Sans Mono";
const FONT_SIZE = 22;
const TITLE_FONT_SIZE = 40;
const LINE_HEIGHT = 30;
const TITLE_LINE_HEIGHT = 56;
const PAPER = "#f6f3ea";
const INK = "#262421";
/** Gaussian blur for blurry.png — well past the point where OCR can read it. */
const BLURRY_SIGMA = 6;

// ─── Receipt model ──────────────────────────────────────────────────────────

type Row =
  | { kind: "title"; text: string }
  | { kind: "center"; text: string }
  | { kind: "left"; text: string }
  | { kind: "pair"; left: string; right: string }
  | { kind: "rule" }
  | { kind: "blank" };

type ItemSpec =
  | { kind: "simple"; desc: string; price: number; discount?: DiscountSpec }
  /** Description on its own line, then "2 @ $2.00 EACH  4.00". */
  | { kind: "multi"; desc: string; qty: number; each: number; qtyLine: (qty: number, each: string, total: string) => Row; discount?: DiscountSpec }
  /** Line total on the item line, "3 @ $1.90 each" underneath. */
  | { kind: "multi-below"; desc: string; qty: number; each: number; qtyLine: (qty: number, each: string) => Row }
  /** Description ("BANANAS KG") then "0.842 kg NET @ $3.90/kg  3.28". */
  | { kind: "weighed"; desc: string; expectedDesc: string; kg: number; perKg: number; weightLine: (kg: string, perKg: string, total: string) => Row };

interface DiscountSpec {
  label: string;
  amount: number;
}

interface ExpectedItem {
  description: string;
  price: number;
  quantity: number | null;
  weightKg: number | null;
  discount: number | null;
}

interface ReceiptSpec {
  name: string;
  store: string;
  purchasedOn: string;
  currency: "AUD" | "GBP";
  symbol: "$" | "£";
  /** Whether item prices carry the currency symbol ("$4.65") or not ("4.65"). */
  itemSymbol: boolean;
  /** Test-only fixtures are not copied to the public demo folder. */
  testOnly: boolean;
  header: Row[];
  items: ItemSpec[];
  footer: (totals: { subtotal: string; total: string; gst: string; count: number }) => Row[];
  gst: number;
  rotateDeg?: number;
  seed: number;
}

interface ManifestEntry {
  file: string;
  text: string | null;
  kind: "receipt" | "blurry" | "not_a_receipt";
  demo: boolean;
  width: number;
  height: number;
  expected: {
    store: string;
    purchasedOn: string;
    currency: string;
    subtotal: number | null;
    total: number;
    items: ExpectedItem[];
  } | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number, symbol = "") => `${n < 0 ? "-" : ""}${symbol}${Math.abs(n).toFixed(2)}`;

function pad(left: string, right: string, width = COLUMNS): string {
  const gap = Math.max(1, width - left.length - right.length);
  return `${left}${" ".repeat(gap)}${right}`;
}

function center(text: string, width = COLUMNS): string {
  const lead = Math.max(0, Math.floor((width - text.length) / 2));
  return `${" ".repeat(lead)}${text}`;
}

function rowText(row: Row): string {
  switch (row.kind) {
    case "title":
    case "center":
      return center(row.text);
    case "left":
      return row.text;
    case "pair":
      return pad(row.left, row.right);
    case "rule":
      return "-".repeat(COLUMNS);
    case "blank":
      return "";
  }
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Mulberry32: tiny deterministic PRNG for paper noise. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Item expansion ─────────────────────────────────────────────────────────

function expandItems(spec: ReceiptSpec): { rows: Row[]; expected: ExpectedItem[] } {
  const rows: Row[] = [];
  const expected: ExpectedItem[] = [];
  const itemMoney = (n: number) => money(n, spec.itemSymbol ? spec.symbol : "");
  const discountRow = (discount: DiscountSpec): Row => ({ kind: "pair", left: `  ${discount.label}`, right: itemMoney(-discount.amount) });
  for (const item of spec.items) {
    switch (item.kind) {
      case "simple": {
        rows.push({ kind: "pair", left: item.desc, right: itemMoney(item.price) });
        if (item.discount) rows.push(discountRow(item.discount));
        const discount = item.discount?.amount ?? null;
        expected.push({ description: item.desc, price: round2(item.price - (discount ?? 0)), quantity: null, weightKg: null, discount });
        break;
      }
      case "multi": {
        const total = round2(item.qty * item.each);
        rows.push({ kind: "left", text: item.desc });
        rows.push(item.qtyLine(item.qty, money(item.each, spec.symbol), itemMoney(total)));
        if (item.discount) rows.push(discountRow(item.discount));
        const discount = item.discount?.amount ?? null;
        expected.push({ description: item.desc, price: round2(total - (discount ?? 0)), quantity: item.qty, weightKg: null, discount });
        break;
      }
      case "multi-below": {
        const total = round2(item.qty * item.each);
        rows.push({ kind: "pair", left: item.desc, right: itemMoney(total) });
        rows.push(item.qtyLine(item.qty, money(item.each, spec.symbol)));
        expected.push({ description: item.desc, price: total, quantity: item.qty, weightKg: null, discount: null });
        break;
      }
      case "weighed": {
        const total = round2(item.kg * item.perKg);
        rows.push({ kind: "left", text: item.desc });
        rows.push(item.weightLine(item.kg.toFixed(3), money(item.perKg, spec.symbol), itemMoney(total)));
        expected.push({ description: item.expectedDesc, price: total, quantity: null, weightKg: item.kg, discount: null });
        break;
      }
    }
  }
  return { rows, expected };
}

// ─── Receipts ───────────────────────────────────────────────────────────────

const RECEIPTS: ReceiptSpec[] = [
  {
    name: "woolworths-weekly",
    store: "Woolworths",
    purchasedOn: "2026-09-26",
    currency: "AUD",
    symbol: "$",
    itemSymbol: false,
    testOnly: false,
    seed: 11,
    gst: 0.01,
    header: [
      { kind: "title", text: "WOOLWORTHS" },
      { kind: "center", text: "Woolworths Metro Town Hall" },
      { kind: "center", text: "Shop 3, 480 Kent St" },
      { kind: "center", text: "Sydney NSW 2000" },
      { kind: "center", text: "Ph: (02) 9000 1234" },
      { kind: "center", text: "ABN 12 345 678 901" },
      { kind: "center", text: "TAX INVOICE" },
      { kind: "rule" },
    ],
    items: [
      { kind: "simple", desc: "W/M FULL CREAM 2L", price: 3.1 },
      {
        kind: "weighed",
        desc: "BANANAS KG",
        expectedDesc: "BANANAS",
        kg: 0.842,
        perKg: 3.9,
        weightLine: (kg, perKg, total) => ({ kind: "pair", left: `  ${kg} kg NET @ ${perKg}/kg`, right: total }),
      },
      { kind: "simple", desc: "WW WHITE BREAD 700G", price: 2.7 },
      { kind: "simple", desc: "WW FREE RANGE EGGS 12PK", price: 6.2 },
      { kind: "simple", desc: "WW CHICKEN BREAST FILLET 1KG", price: 12 },
      { kind: "simple", desc: "WW BABY SPINACH 120G", price: 3 },
      {
        kind: "multi",
        desc: "SAN REMO SPAGHETTI 500G",
        qty: 2,
        each: 2,
        qtyLine: (qty, each, total) => ({ kind: "pair", left: `  ${qty} @ ${each} EACH`, right: total }),
      },
      { kind: "simple", desc: "MUTTI PASSATA 700G", price: 3.5, discount: { label: "LESS SPECIAL", amount: 1 } },
      { kind: "simple", desc: "CAPSICUM RED EACH", price: 1.9 },
      {
        kind: "weighed",
        desc: "ZUCCHINI GREEN KG",
        expectedDesc: "ZUCCHINI GREEN",
        kg: 0.386,
        perKg: 5.9,
        weightLine: (kg, perKg, total) => ({ kind: "pair", left: `  ${kg} kg NET @ ${perKg}/kg`, right: total }),
      },
      { kind: "simple", desc: "WW BEEF MINCE 500G", price: 6.5 },
      { kind: "simple", desc: "CORIANDER BUNCH", price: 3 },
      { kind: "simple", desc: "SPRING ONION BUNCH", price: 2 },
      { kind: "simple", desc: "DAIRY FARMERS YOGHURT 1KG", price: 7 },
      { kind: "simple", desc: "BEGA TASTY CHEESE 500G", price: 9 },
      { kind: "simple", desc: "CARRY BAG", price: 0.15 },
    ],
    footer: ({ subtotal, total, gst, count }) => [
      { kind: "rule" },
      { kind: "pair", left: `${count} SUBTOTAL`, right: subtotal },
      { kind: "pair", left: "TOTAL", right: total },
      { kind: "pair", left: "EFTPOS", right: total },
      { kind: "pair", left: "Total includes GST", right: gst },
      { kind: "rule" },
      { kind: "pair", left: "YOU SAVED", right: "$1.00" },
      { kind: "left", text: "26/09/2026 17:42  STORE 1234  LANE 5" },
      { kind: "left", text: "EVERYDAY REWARDS CARD ****4821" },
      { kind: "pair", left: "POINTS EARNED THIS SHOP", right: "68" },
      { kind: "blank" },
      { kind: "center", text: "THANK YOU FOR SHOPPING WITH US" },
    ],
  },
  {
    name: "coles-topup",
    store: "Coles",
    purchasedOn: "2026-09-29",
    currency: "AUD",
    symbol: "$",
    itemSymbol: true,
    testOnly: false,
    seed: 23,
    gst: 0.36,
    header: [
      { kind: "title", text: "Coles" },
      { kind: "center", text: "Coles Newtown" },
      { kind: "center", text: "Newtown Central, King St" },
      { kind: "center", text: "Newtown NSW 2042" },
      { kind: "center", text: "Ph: (02) 9000 5678" },
      { kind: "center", text: "ABN 45 678 901 234" },
      { kind: "center", text: "Tax Invoice" },
      { kind: "blank" },
    ],
    items: [
      { kind: "simple", desc: "Coles Full Cream Milk 3L", price: 4.65 },
      { kind: "simple", desc: "Coles Bakery White Loaf 650g", price: 3 },
      {
        kind: "multi-below",
        desc: "Hass Avocado Each",
        qty: 3,
        each: 1.9,
        qtyLine: (qty, each) => ({ kind: "left", text: `  ${qty} @ ${each} each` }),
      },
      { kind: "simple", desc: "Coles Chicken Thigh Fillets 500g", price: 7.5 },
      { kind: "simple", desc: "Lebanese Cucumber Each", price: 1.2 },
      { kind: "simple", desc: "Coles Greek Yoghurt 1kg", price: 5.8, discount: { label: "Promotion", amount: 1 } },
      { kind: "simple", desc: "Coles Wild Rocket 120g", price: 3 },
      { kind: "simple", desc: "Arnott's Tim Tam Original 200g", price: 4 },
    ],
    footer: ({ total, gst, count }) => [
      { kind: "blank" },
      { kind: "pair", left: `Total for ${count} items:`, right: total },
      { kind: "pair", left: "Mastercard", right: total },
      { kind: "pair", left: "GST included in total", right: gst },
      { kind: "blank" },
      { kind: "left", text: "29/09/26 10:15  Store 812  Lane 3" },
      { kind: "left", text: "flybuys 6008 **** **** 1234" },
      { kind: "center", text: "Thank you for shopping at Coles" },
    ],
  },
  {
    name: "aldi-shop",
    store: "Aldi",
    purchasedOn: "2026-09-19",
    currency: "AUD",
    symbol: "$",
    itemSymbol: false,
    testOnly: false,
    seed: 37,
    gst: 0,
    rotateDeg: 0.8,
    header: [
      { kind: "title", text: "ALDI" },
      { kind: "center", text: "ALDI STORES" },
      { kind: "center", text: "A LIMITED PARTNERSHIP" },
      { kind: "center", text: "ABN 23 456 789 012" },
      { kind: "center", text: "12 Parramatta Rd, Auburn NSW 2144" },
      { kind: "center", text: "TAX INVOICE" },
      { kind: "blank" },
    ],
    items: [
      { kind: "simple", desc: "FARMDALE FULL CREAM MILK 2L", price: 3.19 },
      { kind: "simple", desc: "BAKERS LIFE WHOLEMEAL BREAD", price: 2.79 },
      { kind: "simple", desc: "LODGE FARMS FREE RANGE EGGS", price: 5.49 },
      {
        kind: "multi",
        desc: "REMANO PENNE PASTA 500G",
        qty: 2,
        each: 1.19,
        qtyLine: (qty, each, total) => ({ kind: "pair", left: `  ${qty} x ${each.replace("$", "")}`, right: total }),
      },
      {
        kind: "weighed",
        desc: "BROCCOLI KG",
        expectedDesc: "BROCCOLI",
        kg: 0.456,
        perKg: 4.99,
        weightLine: (kg, perKg, total) => ({ kind: "pair", left: `  ${kg} kg @ ${perKg}/kg`, right: total }),
      },
      { kind: "simple", desc: "CARROTS 1KG BAG", price: 1.79 },
      { kind: "simple", desc: "BROWN ONIONS 2KG", price: 3.49 },
      { kind: "simple", desc: "BEEF MINCE 500G", price: 6.99 },
      { kind: "simple", desc: "COOKED PRAWNS 500G", price: 12.99 },
      { kind: "simple", desc: "EMPORIUM TASTY CHEESE 500G", price: 5.99 },
      { kind: "simple", desc: "ZUCCHINI GREEN EACH", price: 0.89 },
      { kind: "simple", desc: "FARMDALE NATURAL YOGHURT 1KG", price: 3.99 },
    ],
    footer: ({ subtotal, total, gst }) => [
      { kind: "rule" },
      { kind: "pair", left: "SUBTOTAL", right: subtotal },
      { kind: "pair", left: "**** TOTAL", right: total },
      { kind: "pair", left: "EFTPOS", right: total },
      { kind: "pair", left: "GST INCLUDED IN TOTAL", right: gst },
      { kind: "blank" },
      { kind: "left", text: "19/09/2026  14:05  0123 04 5678" },
      { kind: "center", text: "THANK YOU FOR SHOPPING AT ALDI" },
    ],
  },
  {
    name: "tesco-uk",
    store: "Tesco",
    purchasedOn: "2026-09-22",
    currency: "GBP",
    symbol: "£",
    itemSymbol: true,
    testOnly: true,
    seed: 41,
    gst: 0.02,
    header: [
      { kind: "title", text: "TESCO" },
      { kind: "center", text: "Tesco Express" },
      { kind: "center", text: "123 High Street, London" },
      { kind: "center", text: "SE1 7AB" },
      { kind: "center", text: "VAT Number: GB 123 4567 89" },
      { kind: "blank" },
    ],
    items: [
      { kind: "simple", desc: "TESCO SEMI SKIMMED MILK 4PT", price: 1.45 },
      { kind: "simple", desc: "TESCO WHOLEMEAL BREAD 800G", price: 0.75 },
      {
        kind: "weighed",
        desc: "BANANAS LOOSE",
        expectedDesc: "BANANAS LOOSE",
        kg: 0.905,
        perKg: 0.94,
        weightLine: (kg, perKg, total) => ({ kind: "pair", left: `  ${kg} kg @ ${perKg}/kg`, right: total }),
      },
      { kind: "simple", desc: "TESCO FREE RANGE EGGS 6PK", price: 1.89 },
      { kind: "simple", desc: "TESCO CHICKEN BREAST 650G", price: 4.75, discount: { label: "Clubcard Price", amount: 0.75 } },
      {
        kind: "multi",
        desc: "HEINZ BAKED BEANS 415G",
        qty: 2,
        each: 1.4,
        qtyLine: (qty, each, total) => ({ kind: "pair", left: `  ${qty} @ ${each}`, right: total }),
      },
      { kind: "simple", desc: "CATHEDRAL CITY CHEDDAR 350G", price: 3.75 },
      { kind: "simple", desc: "CARRIER BAG", price: 0.1 },
    ],
    footer: ({ subtotal, total, gst }) => [
      { kind: "rule" },
      { kind: "pair", left: "SUBTOTAL", right: subtotal },
      { kind: "pair", left: "TOTAL TO PAY", right: total },
      { kind: "pair", left: "VISA DEBIT", right: total },
      { kind: "pair", left: "VAT INCLUDED", right: gst },
      { kind: "blank" },
      { kind: "left", text: "22/09/26 18:05  STORE 2045  OP 123" },
      { kind: "pair", left: "CLUBCARD POINTS THIS VISIT", right: "16" },
      { kind: "center", text: "Thank you for shopping at Tesco" },
    ],
  },
];

// ─── Rendering ──────────────────────────────────────────────────────────────

function receiptRows(spec: ReceiptSpec): { rows: Row[]; expected: ExpectedItem[]; subtotal: number; total: number } {
  const { rows: itemRows, expected } = expandItems(spec);
  const total = round2(expected.reduce((sum, item) => sum + item.price, 0));
  const count = spec.items.reduce((n, item) => n + (item.kind === "multi" || item.kind === "multi-below" ? item.qty : 1), 0);
  const footer = spec.footer({ subtotal: money(total, spec.symbol), total: money(total, spec.symbol), gst: money(spec.gst, spec.symbol), count });
  return { rows: [...spec.header, ...itemRows, ...footer], expected, subtotal: total, total };
}

function rowHeight(row: Row): number {
  return row.kind === "title" ? TITLE_LINE_HEIGHT : LINE_HEIGHT;
}

function svgForRows(rows: Row[], seed: number): { svg: string; width: number; height: number } {
  const height = MARGIN_TOP + rows.reduce((h, row) => h + rowHeight(row), 0) + MARGIN_BOTTOM;
  const random = prng(seed);
  const parts: string[] = [];
  let y = MARGIN_TOP;
  for (const row of rows) {
    y += rowHeight(row);
    const baseline = y - Math.round(rowHeight(row) * 0.28);
    const text = (value: string, x: number, anchor: "start" | "middle" | "end", size = FONT_SIZE, weight = "normal") =>
      `<text x="${x}" y="${baseline}" font-family="${FONT_FAMILY}" font-size="${size}" font-weight="${weight}" fill="${INK}" text-anchor="${anchor}" xml:space="preserve">${escapeXml(value)}</text>`;
    switch (row.kind) {
      case "title":
        parts.push(text(row.text, PAGE_WIDTH / 2, "middle", TITLE_FONT_SIZE, "bold"));
        break;
      case "center":
        parts.push(text(row.text, PAGE_WIDTH / 2, "middle"));
        break;
      case "left":
        parts.push(text(row.text, MARGIN_X, "start"));
        break;
      case "pair":
        parts.push(text(row.left, MARGIN_X, "start"), text(row.right, PAGE_WIDTH - MARGIN_X, "end"));
        break;
      case "rule":
        parts.push(text("-".repeat(COLUMNS), PAGE_WIDTH / 2, "middle"));
        break;
      case "blank":
        break;
    }
  }
  // Paper speckles: faint dots that make the image photo-like without hurting legibility.
  const speckles: string[] = [];
  for (let i = 0; i < 260; i += 1) {
    const cx = (random() * PAGE_WIDTH).toFixed(1);
    const cy = (random() * height).toFixed(1);
    const r = (0.4 + random() * 0.9).toFixed(2);
    const opacity = (0.05 + random() * 0.12).toFixed(2);
    speckles.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#6b645a" fill-opacity="${opacity}"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${height}" viewBox="0 0 ${PAGE_WIDTH} ${height}">
<defs><linearGradient id="paper" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${PAPER}"/><stop offset="1" stop-color="#efeadd"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#paper)"/>
${speckles.join("\n")}
${parts.join("\n")}
</svg>`;
  return { svg, width: PAGE_WIDTH, height };
}

async function renderReceipt(spec: ReceiptSpec): Promise<{ png: Buffer; text: string; entry: ManifestEntry }> {
  const { rows, expected, subtotal, total } = receiptRows(spec);
  const { svg } = svgForRows(rows, spec.seed);
  let image = sharp(Buffer.from(svg), { density: 72 * SCALE });
  if (spec.rotateDeg) image = sharp(await image.png().toBuffer()).rotate(spec.rotateDeg, { background: "#d9d4c7" });
  const png = await image.png({ compressionLevel: 9 }).toBuffer();
  const meta = await sharp(png).metadata();
  const text = `${rows.map(rowText).join("\n")}\n`;
  return {
    png,
    text,
    entry: {
      file: `${spec.name}.png`,
      text: `${spec.name}.txt`,
      kind: "receipt",
      demo: !spec.testOnly,
      width: meta.width,
      height: meta.height,
      expected: { store: spec.store, purchasedOn: spec.purchasedOn, currency: spec.currency, subtotal, total, items: expected },
    },
  };
}

/** A photo-like picture with no writing at all: sky, hills, sun, a house. */
function notAReceiptSvg(): string {
  const random = prng(99);
  const leaves: string[] = [];
  for (let i = 0; i < 90; i += 1) {
    const cx = (820 + random() * 260).toFixed(0);
    const cy = (420 + random() * 200).toFixed(0);
    leaves.push(`<circle cx="${cx}" cy="${cy}" r="${(14 + random() * 22).toFixed(0)}" fill="#2f6b3a" fill-opacity="${(0.35 + random() * 0.4).toFixed(2)}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6fa8dc"/><stop offset="1" stop-color="#dcecf7"/></linearGradient>
  <linearGradient id="hill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7cb36b"/><stop offset="1" stop-color="#3f7a3a"/></linearGradient>
  <radialGradient id="sun"><stop offset="0" stop-color="#fff6c8"/><stop offset="1" stop-color="#f7c948"/></radialGradient>
</defs>
<rect width="1200" height="900" fill="url(#sky)"/>
<circle cx="220" cy="180" r="90" fill="url(#sun)"/>
<ellipse cx="300" cy="820" rx="700" ry="300" fill="url(#hill)"/>
<ellipse cx="1000" cy="860" rx="650" ry="280" fill="#5d9950"/>
<rect x="500" y="470" width="260" height="190" fill="#c96f4a"/>
<polygon points="480,475 630,360 780,475" fill="#7a3b2e"/>
<rect x="600" y="560" width="60" height="100" fill="#4a2d22"/>
<rect x="530" y="510" width="50" height="45" fill="#e8f1f8"/>
<rect x="690" y="510" width="50" height="45" fill="#e8f1f8"/>
<rect x="930" y="520" width="26" height="160" fill="#5b3a29"/>
${leaves.join("\n")}
</svg>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await mkdir(FIXTURE_DIR, { recursive: true });
  await mkdir(DEMO_DIR, { recursive: true });
  const manifest: Record<string, ManifestEntry> = {};

  for (const spec of RECEIPTS) {
    const { png, text, entry } = await renderReceipt(spec);
    await writeFile(path.join(FIXTURE_DIR, `${spec.name}.png`), png);
    await writeFile(path.join(FIXTURE_DIR, `${spec.name}.txt`), text);
    manifest[spec.name] = entry;
    if (!spec.testOnly) await copyFile(path.join(FIXTURE_DIR, `${spec.name}.png`), path.join(DEMO_DIR, `${spec.name}.png`));
    console.log(`✓ ${spec.name}.png  ${entry.width}×${entry.height}  total ${entry.expected?.total.toFixed(2)}`);
  }

  // Blurry: the Woolworths receipt badly out of focus (OCR fails from σ≈5).
  // Palette-quantised to keep the smooth gradients from bloating the PNG.
  const clean = await sharp(path.join(FIXTURE_DIR, "woolworths-weekly.png")).toBuffer();
  const blurry = await sharp(clean).blur(BLURRY_SIGMA).png({ compressionLevel: 9, palette: true, colours: 64, dither: 0 }).toBuffer();
  await writeFile(path.join(FIXTURE_DIR, "blurry.png"), blurry);
  const blurryMeta = await sharp(blurry).metadata();
  manifest.blurry = { file: "blurry.png", text: "woolworths-weekly.txt", kind: "blurry", demo: false, width: blurryMeta.width, height: blurryMeta.height, expected: null };
  console.log("✓ blurry.png");

  const photo = await sharp(Buffer.from(notAReceiptSvg())).png({ compressionLevel: 9 }).toBuffer();
  await writeFile(path.join(FIXTURE_DIR, "not-a-receipt.png"), photo);
  manifest["not-a-receipt"] = { file: "not-a-receipt.png", text: null, kind: "not_a_receipt", demo: false, width: 1200, height: 900, expected: null };
  console.log("✓ not-a-receipt.png");

  await writeFile(path.join(FIXTURE_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`✓ manifest.json (${Object.keys(manifest).length} fixtures)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
