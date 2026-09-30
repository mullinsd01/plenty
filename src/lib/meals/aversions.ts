/**
 * Learning what a household tends to skip.
 *
 * Every time a planned meal is swapped out or marked as disliked, that's a
 * small signal about the meal — and, when it keeps happening across different
 * meals of the same cuisine or main ingredient, about the whole group. Likes,
 * saves and meals actually cooked pull the other way.
 *
 * Group weights run 0–1 and grow slowly: a group stays a mild signal (≤ 0.3)
 * until it has at least three rejections spread over at least two different
 * meals, so one unlucky week never writes off Thai food.
 *
 * Pure and deterministic.
 */

import { CUISINE_LABELS, type Cuisine } from "@/lib/domain";
import type { MealHistory, PlannableMeal } from "@/lib/meals/types";
import { normalizeText, singularize } from "@/lib/normalize";

// ─── Tunables ───────────────────────────────────────────────────────────────

/** A meal rated −1 counts as this many rejections of its groups. */
export const DISLIKE_REJECTION_EQUIVALENT = 1.5;
/** Each liked meal (rating +1) offsets this many rejections in its groups. */
export const LIKE_OFFSET = 2;
/** Each saved meal offsets this many rejections. */
export const SAVED_OFFSET = 1;
/** Each time a meal was actually cooked offsets this many rejections… */
export const COOK_OFFSET = 0.5;
/** …counting at most this many cooks per meal, so one staple can't mask a pattern. */
export const MAX_COOKS_COUNTED = 4;
/** Net rejections at which a group's weight reaches 0.5 (weight = net / (net + this)). */
export const AVERSION_HALF_SATURATION = 4;
/** Rejection events (rejections + dislikes) a group needs before its weight can exceed the weak cap. */
export const MIN_REJECTIONS_FOR_STRONG_AVERSION = 3;
/** Different meals those rejections must be spread across. */
export const MIN_MEALS_FOR_STRONG_AVERSION = 2;
/** Ceiling on a group's weight until the evidence above is in. */
export const WEAK_AVERSION_CAP = 0.3;
/** Weight at which a group earns a plain-language note. */
export const AVERSION_NOTE_THRESHOLD = 0.4;

export interface Aversions {
  /** 0–1 per cuisine; absent means no aversion. */
  cuisines: Map<Cuisine, number>;
  /** 0–1 per main-ingredient key (see `mainIngredientKey`). */
  mainIngredients: Map<string, number>;
  /** Plain language, strongest first: "You tend to skip fish dishes". */
  notes: string[];
}

/** Canonical key for a main ingredient: lower-case, singular ("Prawns" → "prawn", "Black beans" → "black bean"). */
export function mainIngredientKey(mainIngredient: string): string {
  return normalizeText(mainIngredient).split(" ").filter(Boolean).map(singularize).join(" ");
}

interface GroupEvidence {
  rejections: number;
  dislikes: number;
  offsets: number;
  rejectedMeals: Set<string>;
}

function emptyEvidence(): GroupEvidence {
  return { rejections: 0, dislikes: 0, offsets: 0, rejectedMeals: new Set() };
}

function addEvidence(groups: Map<string, GroupEvidence>, key: string, meal: PlannableMeal, entry: MealHistory): void {
  const group = groups.get(key) ?? emptyEvidence();
  const rejections = Math.max(0, entry.timesRejected);
  const disliked = entry.rating === -1;
  group.rejections += rejections;
  if (disliked) group.dislikes += 1;
  if (rejections > 0 || disliked) group.rejectedMeals.add(meal.id);
  if (entry.rating === 1) group.offsets += LIKE_OFFSET;
  if (entry.saved) group.offsets += SAVED_OFFSET;
  group.offsets += Math.min(Math.max(0, entry.timesCooked), MAX_COOKS_COUNTED) * COOK_OFFSET;
  groups.set(key, group);
}

/** 0–1 weight for a group's evidence (see module doc for the shape). */
function groupWeight(group: GroupEvidence): number {
  const negative = group.rejections + group.dislikes * DISLIKE_REJECTION_EQUIVALENT;
  const net = Math.max(0, negative - group.offsets);
  if (net <= 0) return 0;
  const raw = net / (net + AVERSION_HALF_SATURATION);
  const strongEvidence =
    group.rejections + group.dislikes >= MIN_REJECTIONS_FOR_STRONG_AVERSION && group.rejectedMeals.size >= MIN_MEALS_FOR_STRONG_AVERSION;
  const weight = strongEvidence ? raw : Math.min(raw, WEAK_AVERSION_CAP);
  return Math.round(weight * 1000) / 1000;
}

function weights<K extends string>(groups: Map<K, GroupEvidence>): Map<K, number> {
  const result = new Map<K, number>();
  for (const [key, group] of groups) {
    const weight = groupWeight(group);
    if (weight > 0) result.set(key, weight);
  }
  return result;
}

interface Note {
  weight: number;
  text: string;
}

function notesFor(cuisines: Map<Cuisine, number>, mains: Map<string, number>): string[] {
  const notes: Note[] = [];
  for (const [cuisine, weight] of cuisines) {
    if (weight >= AVERSION_NOTE_THRESHOLD && cuisine !== "other") notes.push({ weight, text: `You tend to skip ${CUISINE_LABELS[cuisine]} dishes` });
  }
  for (const [main, weight] of mains) {
    if (weight >= AVERSION_NOTE_THRESHOLD) notes.push({ weight, text: `You tend to skip ${main} dishes` });
  }
  return notes.sort((a, b) => b.weight - a.weight || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0)).map((n) => n.text);
}

/**
 * Learn cuisine and main-ingredient aversions from meal history.
 *
 * Each meal's rejections (and a −1 rating, worth 1.5 rejections) count
 * against its cuisine and main ingredient; likes (2), saves (1) and cooks
 * (0.5 each, up to 4 per meal) offset them. The net becomes a 0–1 weight that
 * saturates slowly, capped at 0.3 until a group has ≥ 3 rejection events
 * across ≥ 2 different meals. History for meals not in `meals` is ignored.
 * Notes are written for groups at ≥ 0.4, strongest first.
 */
export function learnAversions(meals: readonly PlannableMeal[], history: readonly MealHistory[]): Aversions {
  const byId = new Map(meals.map((meal) => [meal.id, meal]));
  const cuisineGroups = new Map<Cuisine, GroupEvidence>();
  const mainGroups = new Map<string, GroupEvidence>();
  for (const entry of history) {
    const meal = byId.get(entry.mealId);
    if (!meal) continue;
    addEvidence(cuisineGroups, meal.cuisine, meal, entry);
    const main = mainIngredientKey(meal.mainIngredient);
    if (main) addEvidence(mainGroups, main, meal, entry);
  }
  const cuisines = weights(cuisineGroups);
  const mainIngredients = weights(mainGroups);
  return { cuisines, mainIngredients, notes: notesFor(cuisines, mainIngredients) };
}

/** No learned aversions (for new households, or to switch learning off). */
export function noAversions(): Aversions {
  return { cuisines: new Map(), mainIngredients: new Map(), notes: [] };
}

/**
 * Combined aversion (0–1) for a meal: the chance either its cuisine or its
 * main ingredient puts the household off, treating the two as independent.
 */
export function mealAversion(meal: Pick<PlannableMeal, "cuisine" | "mainIngredient">, aversions: Aversions): number {
  const cuisine = aversions.cuisines.get(meal.cuisine) ?? 0;
  const main = aversions.mainIngredients.get(mainIngredientKey(meal.mainIngredient)) ?? 0;
  return 1 - (1 - cuisine) * (1 - main);
}
