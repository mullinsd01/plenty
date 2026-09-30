import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { CATALOG } from "@/lib/catalog/products";
import type { CatalogProduct, ProductInfo, ProductMatch } from "@/lib/catalog/types";
import type { Aisle, ContainsFlag, StorageLocation } from "@/lib/domain";
import { matchProduct, matchProductCandidates, sentenceCase } from "@/lib/normalize";
import type { Unit } from "@/lib/units";
import { systemDb, type Queryable } from "@/server/db/client";
import { productAliases, products, type DbProduct } from "@/server/db/schema";

export function productRowToInfo(row: DbProduct): ProductInfo {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    aisle: row.aisle as Aisle,
    location: row.location as StorageLocation,
    unit: row.unit as Unit,
    packageQuantity: row.packageQuantity,
    eachWeightG: row.eachWeightG,
    eachVolumeMl: row.eachVolumeMl,
    densityGPerMl: row.densityGPerMl,
    shelfLifeDays: row.shelfLifeDays,
    freezerShelfLifeDays: row.freezerShelfLifeDays,
    perishable: row.perishable,
    dailyUsePerPerson: row.dailyUsePerPerson,
    group: row.productGroup,
    contains: row.contains as ContainsFlag[],
    pantryBasic: row.pantryBasic,
    commonStaple: row.commonStaple,
    nonFood: row.nonFood,
  };
}

/** Household custom products in the catalog shape the matcher understands. */
function productRowToCatalog(row: DbProduct): CatalogProduct {
  return {
    slug: row.slug,
    name: row.name,
    aisle: row.aisle as Aisle,
    location: row.location as StorageLocation,
    unit: row.unit as Unit,
    packageQuantity: row.packageQuantity,
    eachWeightG: row.eachWeightG ?? undefined,
    eachVolumeMl: row.eachVolumeMl ?? undefined,
    densityGPerMl: row.densityGPerMl ?? undefined,
    shelfLifeDays: row.shelfLifeDays ?? undefined,
    freezerShelfLifeDays: row.freezerShelfLifeDays ?? undefined,
    perishable: row.perishable,
    dailyUsePerPerson: row.dailyUsePerPerson ?? undefined,
    group: row.productGroup ?? undefined,
    aliases: row.aliases,
    contains: row.contains as ContainsFlag[],
    pantryBasic: row.pantryBasic,
    commonStaple: row.commonStaple,
    nonFood: row.nonFood,
  };
}

function catalogValues(p: CatalogProduct) {
  return {
    householdId: null,
    slug: p.slug,
    name: p.name,
    aisle: p.aisle,
    location: p.location,
    unit: p.unit,
    packageQuantity: p.packageQuantity,
    eachWeightG: p.eachWeightG ?? null,
    eachVolumeMl: p.eachVolumeMl ?? null,
    densityGPerMl: p.densityGPerMl ?? null,
    shelfLifeDays: p.shelfLifeDays ?? null,
    freezerShelfLifeDays: p.freezerShelfLifeDays ?? null,
    perishable: p.perishable,
    dailyUsePerPerson: p.dailyUsePerPerson ?? null,
    productGroup: p.group ?? null,
    aliases: p.aliases,
    contains: p.contains ?? [],
    pantryBasic: p.pantryBasic ?? false,
    commonStaple: p.commonStaple ?? false,
    nonFood: p.nonFood ?? false,
  };
}

/**
 * Upsert the built-in catalog into `products` (global rows). Idempotent;
 * run by `npm run setup` / `db:seed` and whenever the catalog changes.
 */
export async function syncCatalog(db: Queryable = systemDb): Promise<number> {
  const BATCH = 100;
  for (let i = 0; i < CATALOG.length; i += BATCH) {
    const chunk = CATALOG.slice(i, i + BATCH).map(catalogValues);
    await db
      .insert(products)
      .values(chunk)
      .onConflictDoUpdate({
        target: products.slug,
        targetWhere: sql`${products.householdId} is null`,
        set: {
          name: sql`excluded.name`,
          aisle: sql`excluded.aisle`,
          location: sql`excluded.location`,
          unit: sql`excluded.unit`,
          packageQuantity: sql`excluded.package_quantity`,
          eachWeightG: sql`excluded.each_weight_g`,
          eachVolumeMl: sql`excluded.each_volume_ml`,
          densityGPerMl: sql`excluded.density_g_per_ml`,
          shelfLifeDays: sql`excluded.shelf_life_days`,
          freezerShelfLifeDays: sql`excluded.freezer_shelf_life_days`,
          perishable: sql`excluded.perishable`,
          dailyUsePerPerson: sql`excluded.daily_use_per_person`,
          productGroup: sql`excluded.product_group`,
          aliases: sql`excluded.aliases`,
          contains: sql`excluded.contains`,
          pantryBasic: sql`excluded.pantry_basic`,
          commonStaple: sql`excluded.common_staple`,
          nonFood: sql`excluded.non_food`,
          updatedAt: sql`now()`,
        },
      });
  }
  globalCache = null;
  return CATALOG.length;
}

// ─── Product index (per household) ──────────────────────────────────────────

interface GlobalCache {
  loadedAt: number;
  byId: Map<string, ProductInfo>;
  bySlug: Map<string, ProductInfo>;
}
let globalCache: GlobalCache | null = null;
const GLOBAL_TTL_MS = 5 * 60_000;

async function loadGlobalProducts(db: Queryable): Promise<GlobalCache> {
  if (globalCache && Date.now() - globalCache.loadedAt < GLOBAL_TTL_MS) return globalCache;
  const rows = await db.select().from(products).where(isNull(products.householdId));
  const byId = new Map<string, ProductInfo>();
  const bySlug = new Map<string, ProductInfo>();
  for (const row of rows) {
    const info = productRowToInfo(row);
    byId.set(row.id, info);
    bySlug.set(row.slug, info);
  }
  globalCache = { loadedAt: Date.now(), byId, bySlug };
  return globalCache;
}

export interface ProductIndex {
  byId: ReadonlyMap<string, ProductInfo>;
  bySlug: ReadonlyMap<string, ProductInfo>;
  /** aliasKey → product slug, learned from this household's confirmed receipts. */
  householdAliases: ReadonlyMap<string, string>;
  customProducts: CatalogProduct[];
}

/** Everything needed to resolve product names for one household. */
export async function loadProductIndex(db: Queryable, householdId: string): Promise<ProductIndex> {
  const global = await loadGlobalProducts(db);
  const customRows = await db.select().from(products).where(eq(products.householdId, householdId));
  const aliasRows = await db
    .select({ aliasKey: productAliases.aliasKey, slug: products.slug })
    .from(productAliases)
    .innerJoin(products, eq(products.id, productAliases.productId))
    .where(eq(productAliases.householdId, householdId));

  const byId = new Map(global.byId);
  const bySlug = new Map(global.bySlug);
  for (const row of customRows) {
    const info = productRowToInfo(row);
    byId.set(row.id, info);
    bySlug.set(row.slug, info);
  }
  return {
    byId,
    bySlug,
    householdAliases: new Map(aliasRows.map((a) => [a.aliasKey, a.slug])),
    customProducts: customRows.map(productRowToCatalog),
  };
}

export function matchOptions(index: ProductIndex) {
  return { householdAliases: index.householdAliases, extraProducts: index.customProducts };
}

export interface ResolvedProduct {
  product: ProductInfo;
  score: number;
  method: ProductMatch["method"];
}

/** Resolve free text ("baby spinach", "W/M FULL CREAM 2L") to a known product. */
export function resolveProduct(index: ProductIndex, text: string, minScore = 0.75): ResolvedProduct | null {
  const match = matchProduct(text, matchOptions(index));
  if (!match || match.score < minScore) return null;
  const product = index.bySlug.get(match.product.slug);
  return product ? { product, score: match.score, method: match.method } : null;
}

export function productCandidates(index: ProductIndex, text: string, limit = 5): ResolvedProduct[] {
  return matchProductCandidates(text, matchOptions(index), limit)
    .map((m) => {
      const product = index.bySlug.get(m.product.slug);
      return product ? { product, score: m.score, method: m.method } : null;
    })
    .filter((m): m is ResolvedProduct => m !== null);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Create (or reuse) a household-specific product for something not in the catalog. */
export async function ensureCustomProduct(
  db: Queryable,
  householdId: string,
  input: { name: string; aisle: Aisle; location: StorageLocation; unit: Unit; packageQuantity: number },
): Promise<ProductInfo> {
  const name = sentenceCase(input.name.trim()).slice(0, 80);
  const slug = `custom-${slugify(name) || "item"}`;
  const [existing] = await db
    .select()
    .from(products)
    .where(and(eq(products.householdId, householdId), eq(products.slug, slug)))
    .limit(1);
  if (existing) return productRowToInfo(existing);
  const [row] = await db
    .insert(products)
    .values({
      householdId,
      slug,
      name,
      aisle: input.aisle,
      location: input.location,
      unit: input.unit,
      packageQuantity: input.packageQuantity > 0 ? input.packageQuantity : 1,
      perishable: input.location === "fridge" || input.location === "produce",
      shelfLifeDays: input.location === "fridge" || input.location === "produce" ? 7 : null,
      aliases: [name.toLowerCase()],
    })
    .onConflictDoNothing()
    .returning();
  if (row) return productRowToInfo(row);
  const [again] = await db
    .select()
    .from(products)
    .where(and(eq(products.householdId, householdId), eq(products.slug, slug)))
    .limit(1);
  return productRowToInfo(again);
}

/** Remember that this receipt text means this product, for this household. */
export async function rememberAlias(db: Queryable, householdId: string, aliasKey: string, productId: string): Promise<void> {
  if (!aliasKey) return;
  await db
    .insert(productAliases)
    .values({ householdId, aliasKey, productId })
    .onConflictDoUpdate({
      target: [productAliases.householdId, productAliases.aliasKey],
      set: { productId, timesSeen: sql`${productAliases.timesSeen} + 1`, lastSeenAt: sql`now()` },
    });
}
