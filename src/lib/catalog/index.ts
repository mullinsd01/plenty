/**
 * Catalog lookups. The catalog itself is static data (`products.ts`); these
 * helpers index it once at module load.
 */

import { CATALOG } from "@/lib/catalog/products";
import type { CatalogProduct } from "@/lib/catalog/types";

export { CATALOG } from "@/lib/catalog/products";
export { productInfoFromCatalog } from "@/lib/catalog/types";
export type { CatalogProduct, ProductInfo, ProductMatch } from "@/lib/catalog/types";

/** Every catalog product keyed by slug. */
export const CATALOG_BY_SLUG: ReadonlyMap<string, CatalogProduct> = new Map(CATALOG.map((p) => [p.slug, p]));

const BY_GROUP: ReadonlyMap<string, readonly CatalogProduct[]> = (() => {
  const groups = new Map<string, CatalogProduct[]>();
  for (const product of CATALOG) {
    if (!product.group) continue;
    const members = groups.get(product.group);
    if (members) members.push(product);
    else groups.set(product.group, [product]);
  }
  return groups;
})();

/** The catalog product with this slug, or undefined. */
export function getCatalogProduct(slug: string): CatalogProduct | undefined {
  return CATALOG_BY_SLUG.get(slug);
}

/** Interchangeable products sharing `group` (e.g. "milk" → full cream, lite, skim…), in catalog order. */
export function catalogProductsInGroup(group: string): CatalogProduct[] {
  return [...(BY_GROUP.get(group) ?? [])];
}

/** All substitution group names in the catalog, sorted. */
export function catalogGroups(): string[] {
  return [...BY_GROUP.keys()].sort();
}
