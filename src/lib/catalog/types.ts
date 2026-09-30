import type { Aisle, ContainsFlag, StorageLocation } from "@/lib/domain";
import type { Unit } from "@/lib/units";

/**
 * A canonical grocery product in Plenty's built-in catalog.
 *
 * The catalog is the deterministic backbone for receipt normalisation,
 * shelf-life estimates, consumption priors and ingredient matching.
 */
export interface CatalogProduct {
  /** Stable identifier, kebab-case. e.g. "full-cream-milk". */
  slug: string;
  /** Canonical display name, sentence case. e.g. "Full cream milk". */
  name: string;
  aisle: Aisle;
  /** Where it's usually kept at home. */
  location: StorageLocation;
  /** Unit the product is tracked in: "l" for milk, "each" for eggs, "g" for mince, "loaf" for bread. */
  unit: Unit;
  /** Typical package size in `unit` (e.g. 2 for a 2 L milk, 12 for a dozen eggs, 500 for 500 g mince). */
  packageQuantity: number;
  /** Mass of one `each`/container in grams, when the product is counted (eggs 60, avocado 170, can 400). */
  eachWeightG?: number;
  /** Volume of one container in ml, for liquids tracked in containers (bottle of wine 750). */
  eachVolumeMl?: number;
  /** g per ml for liquids/semi-liquids (milk 1.03, oil 0.92). */
  densityGPerMl?: number;
  /** Days it stays good at `location` after purchase (unopened / as bought). */
  shelfLifeDays?: number;
  /** Days it lasts in the freezer, if freezable. */
  freezerShelfLifeDays?: number;
  /** Goes off within ~2 weeks without freezing. */
  perishable: boolean;
  /**
   * Prior consumption: amount in `unit` one adult-equivalent uses per day.
   * Omit for products that shouldn't get run-out predictions (spices, foil, etc.).
   * e.g. milk ≈ 0.2 (L/day/person), bread ≈ 0.12 (loaf/day/person), eggs ≈ 0.5 (each/day/person).
   */
  dailyUsePerPerson?: number;
  /**
   * Interchangeable products share a group, e.g. full cream / lite / skim milk
   * all have group "milk". Recipes can then be satisfied by any member.
   */
  group?: string;
  /** Lower-case alternative names and common receipt spellings/abbreviations. */
  aliases: string[];
  contains?: ContainsFlag[];
  /** Salt, pepper, water, etc. — assumed available unless the household tells us otherwise. */
  pantryBasic?: boolean;
  /** Bought regularly by most households; seeds the "staples" concept before history exists. */
  commonStaple?: boolean;
  /** Not food (bin bags, detergent). Excluded from meal matching. */
  nonFood?: boolean;
}

export interface ProductMatch {
  product: CatalogProduct;
  /** 0–1. ≥0.8 is confident; 0.5–0.8 plausible (ask the user); <0.5 weak. */
  score: number;
  /** How the match was made — useful for explaining and debugging. */
  method: "exact" | "alias" | "household_alias" | "fuzzy" | "keyword";
}

/**
 * Runtime product knowledge used by the engines. Built from a catalog entry
 * or a `products` database row; `id` is the database id at runtime (tests may
 * use the slug as id).
 */
export interface ProductInfo {
  id: string;
  slug: string;
  name: string;
  aisle: Aisle;
  location: StorageLocation;
  unit: Unit;
  packageQuantity: number;
  eachWeightG?: number | null;
  eachVolumeMl?: number | null;
  densityGPerMl?: number | null;
  shelfLifeDays?: number | null;
  freezerShelfLifeDays?: number | null;
  perishable: boolean;
  dailyUsePerPerson?: number | null;
  group?: string | null;
  contains: ContainsFlag[];
  pantryBasic: boolean;
  commonStaple: boolean;
  nonFood: boolean;
}

export function productInfoFromCatalog(p: CatalogProduct, id: string = p.slug): ProductInfo {
  return {
    id,
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
    group: p.group ?? null,
    contains: p.contains ?? [],
    pantryBasic: p.pantryBasic ?? false,
    commonStaple: p.commonStaple ?? false,
    nonFood: p.nonFood ?? false,
  };
}
