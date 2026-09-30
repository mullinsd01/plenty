/**
 * The meals engine: ingredient matching, plan requirements, diet and allergy
 * filtering, learned aversions, scoring and planning, plus adapters from the
 * recipe library and catalog. Pure and deterministic throughout.
 */

export * from "@/lib/meals/types";
export * from "@/lib/meals/matching";
export * from "@/lib/meals/requirements";
export * from "@/lib/meals/adapters";
export * from "@/lib/meals/diet";
export * from "@/lib/meals/aversions";
export * from "@/lib/meals/planner";
