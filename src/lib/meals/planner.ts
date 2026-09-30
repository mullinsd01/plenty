/**
 * Meal planning: scoring meals, "What can I make right now?", and weekly plans.
 *
 * Everything here is deterministic arithmetic over the household's real
 * inventory, history and preferences — no model calls. Each meal gets a score
 * built from named, explainable parts (what's in the kitchen, what needs using
 * up, what the household likes, how long it takes, what it costs, what they
 * had recently) and warm, plain-language reasons drawn from the same numbers.
 *
 * Plans are built greedily day by day against a working copy of inventory, so
 * Monday's bolognese and Wednesday's tacos can't both count the one pack of
 * mince. Seeds vary the pick among near-equal meals for "regenerate" without
 * ever trading away a strong signal like food that's about to go off.
 *
 * Pure and deterministic.
 */

import type { ProductInfo } from "@/lib/catalog/types";
import { WEEKDAY_NAMES, addDays, daysBetween, daysBetweenDates, formatShortDate, weekdayOf } from "@/lib/dates";
import { CUISINE_LABELS, type Difficulty } from "@/lib/domain";
import { learnAversions, mainIngredientKey, mealAversion, type Aversions } from "@/lib/meals/aversions";
import { ingredientsToOmit, isMealAllowed, withoutOmittedIngredients, type OmittedIngredient } from "@/lib/meals/diet";
import { USE_SOON_DAYS, allocateMealIngredients, assessMealAvailability, summarizeAvailability, type LotBalances } from "@/lib/meals/matching";
import type { IngredientAvailability, InventoryLot, MealHistory, PlannableMeal, PlannerPreferences, ScoredMeal } from "@/lib/meals/types";
import { singularize } from "@/lib/normalize";

// ─── Score weights ──────────────────────────────────────────────────────────

/** Points for a meal whose required ingredients are all in the kitchen (scaled by coverage). */
export const AVAILABILITY_POINTS = 40;
/** Points per soon-expiring item a meal uses, before urgency weighting… */
export const USE_SOON_POINTS = 12;
/** …and the most a meal can earn for using things up. */
export const USE_SOON_CAP = 24;
/**
 * Urgency weight by whole days between the meal date and the item's expiry
 * (index 0 = expires that day). Items within `USE_SOON_DAYS` are flagged.
 */
export const USE_SOON_URGENCY: readonly number[] = [1, 1, 0.75, 0.5];
export const LIKED_POINTS = 12;
export const SAVED_POINTS = 6;
export const FAVOURITE_CUISINE_POINTS = 8;
/** A meal the household has cooked and never swapped out. */
export const COOKED_BEFORE_POINTS = 3;
export const REJECTION_PENALTY = 6;
export const REJECTION_PENALTY_CAP = 18;
/** Penalty at full (1.0) learned aversion to the meal's cuisine or main ingredient. */
export const AVERSION_PENALTY_MAX = 15;
/** Penalty for going over the household's weeknight time limit… */
export const OVER_WEEKNIGHT_TIME_PENALTY = 20;
/** …and meals longer than this multiple of the limit aren't offered on weeknights at all. */
export const WEEKNIGHT_EXCLUDE_FACTOR = 1.5;
export const DIFFICULTY_POINTS: Readonly<Record<Difficulty, number>> = { easy: 3, medium: 0, hard: -4 };
export const COOKED_LAST_WEEK_PENALTY = 15;
export const COOKED_LAST_WEEK_DAYS = 7;
export const COOKED_LAST_FORTNIGHT_PENALTY = 6;
export const COOKED_LAST_FORTNIGHT_DAYS = 14;
export const PLANNED_RECENTLY_PENALTY = 8;
export const PLANNED_RECENTLY_DAYS = 5;
/** Cost proxy: every ingredient still to buy. */
export const MISSING_INGREDIENT_PENALTY = 2;
/** Weekly budget per adult-equivalent below which buying extra counts double. */
export const TIGHT_BUDGET_PER_PERSON = 60;
export const TIGHT_BUDGET_MULTIPLIER = 2;
/** Deterministic tie-breaking noise, 0 to this many points, from hash(seed, meal id). */
export const JITTER_MAX = 3;

// ─── Reasons and planning ───────────────────────────────────────────────────

/** Meals this quick say so ("Ready in 20 minutes"). */
export const QUICK_REASON_MAX_MINUTES = 30;
/** "Uses 5 ingredients you already have" appears from this many. */
export const USES_HAVE_REASON_MIN = 3;
/** Weekdays (0 = Sunday) that count as weeknights: Monday to Thursday. */
export const WEEKNIGHT_DAYS: ReadonlySet<number> = new Set([1, 2, 3, 4]);
/** At most this many meals of one cuisine… */
export const MAX_SAME_CUISINE_PER_WINDOW = 2;
/** …in any run of this many consecutive days. */
export const CUISINE_WINDOW_DAYS = 7;
/** With a seed, any meal within this many points of the best may be picked. */
export const SEED_VARIETY_MARGIN = 8;
/** Default number of meals from `rankMealsForNow`. */
export const DEFAULT_RANK_LIMIT = 10;

const SCORE_DECIMALS = 2;
const EPSILON = 1e-9;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Everything the planner knows about the household at a point in time. */
export interface PlannerContext {
  meals: PlannableMeal[];
  lots: InventoryLot[];
  products: ReadonlyMap<string, ProductInfo>;
  prefs: PlannerPreferences;
  /** By meal id. */
  history: ReadonlyMap<string, MealHistory>;
  /** The household's calendar date, YYYY-MM-DD. */
  today: string;
  now: Date;
}

export interface ScoreMealOptions {
  /** Date the meal would be cooked, YYYY-MM-DD. */
  date: string;
  servings: number;
  isWeeknight: boolean;
  /** Varies the tie-breaking jitter; default 0. */
  seed?: number;
  /** Learned aversions; learned from `ctx` when omitted. */
  aversions?: Aversions;
}

export interface RankMealsOptions {
  /** Default `DEFAULT_RANK_LIMIT`. */
  limit?: number;
  /** Only meals ready in this many minutes or fewer. */
  maxMinutes?: number;
  /** Default: household size rounded up. */
  servings?: number;
}

export interface GeneratePlanOptions {
  /** YYYY-MM-DD dates to plan (duplicates ignored; planned in date order). */
  dates: string[];
  servings: number;
  /** Meals fixed on their date; their ingredients are claimed before anything else is planned. */
  keep?: Array<{ date: string; mealId: string }>;
  /** Meal ids never to pick for open dates. */
  exclude?: string[];
  /** Different seeds pick differently among near-equal meals ("regenerate"). */
  seed?: number;
}

export interface PlannedMeal {
  date: string;
  mealId: string;
  score: number;
  /** The meal's primary reason, for the plan card. */
  reason: string;
}

interface ScoreParts {
  availability: number;
  useSoon: number;
  preference: number;
  recency: number;
  time: number;
  difficulty: number;
  budget: number;
  jitter: number;
}

interface MealEvaluation {
  scored: ScoredMeal;
  parts: ScoreParts;
  /** The meal as it would be cooked: optional ingredients the household avoids left out. */
  cookMeal: PlannableMeal;
}

interface UseSoonItem {
  name: string;
  urgency: number;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

function roundScore(value: number): number {
  const factor = 10 ** SCORE_DECIMALS;
  return Math.round(value * factor) / factor;
}

/** 32-bit FNV-1a with a final avalanche, as a fraction in [0, 1). */
function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}

function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Whether a name reads as plural ("mushrooms", "cherry tomatoes"; not "spinach", "hummus"). */
function isPluralName(name: string): boolean {
  const last = name.trim().split(/\s+/).pop()?.toLowerCase() ?? "";
  return singularize(last) !== last;
}

/** Whether a calendar date is a weeknight (Monday to Thursday). */
export function isWeeknight(date: string): boolean {
  return WEEKNIGHT_DAYS.has(weekdayOf(date));
}

/** Servings for a household of `householdSize` adult-equivalents: rounded up, at least one. */
export function defaultServings(householdSize: number): number {
  return Math.max(1, Math.ceil(householdSize - EPSILON));
}

/** "tonight", "tomorrow", "on Tuesday", or "on Wed 14 Oct" for a date relative to today. */
export function whenPhrase(date: string, today: string): string {
  const diff = daysBetweenDates(today, date);
  if (diff === 0) return "tonight";
  if (diff === 1) return "tomorrow";
  if (diff > 1 && diff < 7) return `on ${WEEKDAY_NAMES[weekdayOf(date)]}`;
  return `on ${formatShortDate(date)}`;
}

/** The context with inventory balances from earlier planned meals applied. */
function withBalances(ctx: PlannerContext, balances: LotBalances): PlannerContext {
  if (balances.size === 0) return ctx;
  const lots = ctx.lots.map((lot) => {
    const balance = balances.get(lot.id);
    return balance === undefined ? lot : { ...lot, remainingFraction: balance };
  });
  return { ...ctx, lots };
}

// ─── Score parts ────────────────────────────────────────────────────────────

function urgencyFor(daysLeft: number): number {
  if (daysLeft < 0 || daysLeft > USE_SOON_DAYS) return 0;
  return USE_SOON_URGENCY[daysLeft] ?? 0;
}

/** Soon-expiring items the meal uses, most urgent first. */
function expiringItemsUsed(ingredients: readonly IngredientAvailability[], lots: readonly InventoryLot[], date: string): UseSoonItem[] {
  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  const items: UseSoonItem[] = [];
  for (const ingredient of ingredients) {
    if (!ingredient.usesSoonExpiring) continue;
    let urgency = 0;
    for (const id of ingredient.matchedLotIds) {
      const expiresOn = lotById.get(id)?.expiresOn;
      if (expiresOn) urgency = Math.max(urgency, urgencyFor(daysBetweenDates(date, expiresOn)));
    }
    if (urgency > 0) items.push({ name: ingredient.name, urgency });
  }
  return items.sort((a, b) => b.urgency - a.urgency);
}

function expiringFoodPoints(items: readonly UseSoonItem[]): number {
  const total = items.reduce((sum, item) => sum + USE_SOON_POINTS * item.urgency, 0);
  return Math.min(USE_SOON_CAP, total);
}

function preferencePoints(meal: PlannableMeal, history: MealHistory | undefined, prefs: PlannerPreferences, aversions: Aversions): number {
  let points = 0;
  if (history?.rating === 1) points += LIKED_POINTS;
  if (history?.saved) points += SAVED_POINTS;
  if (prefs.favouriteCuisines.includes(meal.cuisine)) points += FAVOURITE_CUISINE_POINTS;
  if (history && history.timesCooked > 0 && history.timesRejected === 0) points += COOKED_BEFORE_POINTS;
  if (history) points -= Math.min(REJECTION_PENALTY_CAP, REJECTION_PENALTY * Math.max(0, history.timesRejected));
  points -= AVERSION_PENALTY_MAX * mealAversion(meal, aversions);
  return points;
}

function recencyPoints(history: MealHistory | undefined, ctx: PlannerContext, date: string): number {
  if (!history) return 0;
  let points = 0;
  if (history.lastCookedAt) {
    const daysBeforeMeal = daysBetween(history.lastCookedAt, ctx.now) + daysBetweenDates(ctx.today, date);
    if (daysBeforeMeal <= COOKED_LAST_WEEK_DAYS) points -= COOKED_LAST_WEEK_PENALTY;
    else if (daysBeforeMeal <= COOKED_LAST_FORTNIGHT_DAYS) points -= COOKED_LAST_FORTNIGHT_PENALTY;
  }
  if (history.lastPlannedAt && daysBetween(history.lastPlannedAt, ctx.now) <= PLANNED_RECENTLY_DAYS) points -= PLANNED_RECENTLY_PENALTY;
  return points;
}

function timePoints(meal: PlannableMeal, prefs: PlannerPreferences, weeknight: boolean): number {
  const limit = prefs.weeknightMaxMinutes;
  return weeknight && limit !== null && meal.timeMinutes > limit ? -OVER_WEEKNIGHT_TIME_PENALTY : 0;
}

function isTooLongForWeeknight(meal: PlannableMeal, prefs: PlannerPreferences, weeknight: boolean): boolean {
  const limit = prefs.weeknightMaxMinutes;
  return weeknight && limit !== null && meal.timeMinutes > limit * WEEKNIGHT_EXCLUDE_FACTOR;
}

function isTightBudget(prefs: PlannerPreferences): boolean {
  return prefs.weeklyBudget !== null && prefs.weeklyBudget / Math.max(1, prefs.householdSize) < TIGHT_BUDGET_PER_PERSON;
}

function budgetPoints(missingCount: number, prefs: PlannerPreferences): number {
  return -MISSING_INGREDIENT_PENALTY * missingCount * (isTightBudget(prefs) ? TIGHT_BUDGET_MULTIPLIER : 1);
}

function jitterPoints(seed: number, mealId: string): number {
  return JITTER_MAX * hash01(`${seed}:${mealId}`);
}

// ─── Reasons ────────────────────────────────────────────────────────────────

function expiringFoodReason(items: readonly UseSoonItem[], date: string, today: string): string {
  const names = items.map((item) => item.name.toLowerCase());
  const plural = names.length > 1 || isPluralName(names[0] ?? "");
  return `Your ${joinWithAnd(names)} ${plural ? "are" : "is"} likely to go off soon, so we've used ${plural ? "them" : "it"} ${whenPhrase(date, today)}.`;
}

function missingReason(missingNames: readonly string[]): string {
  if (missingNames.length === 1) return `You're only missing the ${(missingNames[0] ?? "").toLowerCase()}`;
  return `You're missing ${missingNames.length} ingredients`;
}

function omittedReason(omitted: readonly OmittedIngredient[]): string {
  return `Leave out the optional ${joinWithAnd(omitted.map((o) => o.name.toLowerCase()))}`;
}

interface ReasonInputs {
  meal: PlannableMeal;
  history: MealHistory | undefined;
  prefs: PlannerPreferences;
  useSoon: readonly UseSoonItem[];
  haveCount: number;
  missingNames: readonly string[];
  omitted: readonly OmittedIngredient[];
  date: string;
  today: string;
}

/** Reasons, most important first; always at least one. */
function buildReasons(input: ReasonInputs): string[] {
  const { meal, history, prefs, useSoon, haveCount, missingNames } = input;
  const reasons: string[] = [];
  if (useSoon.length > 0) reasons.push(expiringFoodReason(useSoon, input.date, input.today));
  if (missingNames.length === 0) reasons.push("You already have everything");
  else if (haveCount >= USES_HAVE_REASON_MIN) reasons.push(`Uses ${haveCount} ingredients you already have`);
  if (history?.rating === 1) reasons.push("A household favourite");
  else if (history?.saved) reasons.push("One you've saved");
  if (prefs.favouriteCuisines.includes(meal.cuisine) && meal.cuisine !== "other") reasons.push(`You love ${CUISINE_LABELS[meal.cuisine]} food`);
  if (meal.timeMinutes > 0 && meal.timeMinutes <= QUICK_REASON_MAX_MINUTES) reasons.push(`Ready in ${meal.timeMinutes} minutes`);
  if (missingNames.length > 0) reasons.push(missingReason(missingNames));
  // Safety first after the headline: what to leave out for allergies, diets or taste.
  if (input.omitted.length > 0) reasons.splice(1, 0, omittedReason(input.omitted));
  return reasons;
}

// ─── Evaluation ─────────────────────────────────────────────────────────────

/**
 * Score one meal with its breakdown. Null when it's off the table: not
 * allowed for the household, rated −1, or far too long for a weeknight —
 * unless `force` (kept plan items are honoured regardless).
 */
function evaluateMeal(meal: PlannableMeal, ctx: PlannerContext, opts: ScoreMealOptions, aversions: Aversions, force = false): MealEvaluation | null {
  const history = ctx.history.get(meal.id);
  if (!force) {
    if (!isMealAllowed(meal, ctx.prefs, ctx.products).allowed) return null;
    if (history?.rating === -1) return null;
    if (isTooLongForWeeknight(meal, ctx.prefs, opts.isWeeknight)) return null;
  }

  const omitted = ingredientsToOmit(meal, ctx.prefs, ctx.products);
  const cookMeal = withoutOmittedIngredients(meal, omitted);
  const ingredients = assessMealAvailability(cookMeal, ctx.lots, ctx.products, { servings: opts.servings, date: opts.date });
  const summary = summarizeAvailability(ingredients);
  const useSoon = expiringItemsUsed(ingredients, ctx.lots, opts.date);

  const parts: ScoreParts = {
    availability: AVAILABILITY_POINTS * summary.coverage,
    useSoon: expiringFoodPoints(useSoon),
    preference: preferencePoints(meal, history, ctx.prefs, aversions),
    recency: recencyPoints(history, ctx, opts.date),
    time: timePoints(meal, ctx.prefs, opts.isWeeknight),
    difficulty: DIFFICULTY_POINTS[meal.difficulty],
    budget: budgetPoints(summary.missingCount, ctx.prefs),
    jitter: jitterPoints(opts.seed ?? 0, meal.id),
  };
  const score = Object.values(parts).reduce((sum, value) => sum + value, 0);

  const reasons = buildReasons({
    meal,
    history,
    prefs: ctx.prefs,
    useSoon,
    haveCount: summary.haveCount,
    missingNames: summary.missingNames,
    omitted,
    date: opts.date,
    today: ctx.today,
  });

  return {
    parts,
    cookMeal,
    scored: {
      meal,
      score: roundScore(score),
      coverage: summary.coverage,
      haveCount: summary.haveCount,
      missingCount: summary.missingCount,
      missingNames: summary.missingNames,
      useSoonNames: useSoon.map((item) => item.name),
      ingredients,
      reasons,
      primaryReason: reasons[0] ?? "A good fit for your week",
    },
  };
}

function aversionsFor(ctx: PlannerContext): Aversions {
  return learnAversions(ctx.meals, [...ctx.history.values()]);
}

/**
 * Score a meal for a date. Null when it isn't allowed (allergy, diet,
 * dislike), the household rated it −1, or it's a weeknight and the meal takes
 * more than 1.5× their weeknight limit.
 *
 * The score adds: availability (coverage × 40); use-soon (+12 per item
 * expiring within 3 days of the date, weighted by urgency, max 24);
 * preferences (liked +12, saved +6, favourite cuisine +8, cooked and never
 * rejected +3, −6 per rejection to −18, learned aversion to −15); time (−20
 * over the weeknight limit); difficulty (easy +3, involved −4); recency
 * (cooked within 7 days −15, 14 days −6, planned within 5 days −8); budget
 * (−2 per missing ingredient, doubled under $60 a week per adult-equivalent);
 * and 0–3 points of jitter from hash(seed, meal id). Optional ingredients the
 * household avoids are left out before checking the kitchen.
 */
export function scoreMeal(meal: PlannableMeal, ctx: PlannerContext, opts: ScoreMealOptions): ScoredMeal | null {
  return evaluateMeal(meal, ctx, opts, opts.aversions ?? aversionsFor(ctx))?.scored ?? null;
}

// ─── What can I make right now? ─────────────────────────────────────────────

/** Missing 0, 1, 2 or 3+ ingredients. */
const MAX_AVAILABILITY_BUCKET = 3;

function availabilityBucket(missingCount: number): number {
  return Math.min(missingCount, MAX_AVAILABILITY_BUCKET);
}

const DIFFICULTY_ORDER: Readonly<Record<Difficulty, number>> = { easy: 0, medium: 1, hard: 2 };

function compareForNow(a: MealEvaluation, b: MealEvaluation): number {
  const bucketA = availabilityBucket(a.scored.missingCount);
  const bucketB = availabilityBucket(b.scored.missingCount);
  if (bucketA !== bucketB) return bucketA - bucketB;
  if (a.scored.useSoonNames.length !== b.scored.useSoonNames.length) return b.scored.useSoonNames.length - a.scored.useSoonNames.length;
  // Nothing in the 3+ bucket is makeable tonight; prefer what uses most of the kitchen.
  if (bucketA === MAX_AVAILABILITY_BUCKET && a.scored.haveCount !== b.scored.haveCount) return b.scored.haveCount - a.scored.haveCount;
  const preferenceA = a.parts.preference + a.parts.recency;
  const preferenceB = b.parts.preference + b.parts.recency;
  if (Math.abs(preferenceA - preferenceB) > EPSILON) return preferenceB - preferenceA;
  if (a.scored.meal.timeMinutes !== b.scored.meal.timeMinutes) return a.scored.meal.timeMinutes - b.scored.meal.timeMinutes;
  const difficulty = DIFFICULTY_ORDER[a.scored.meal.difficulty] - DIFFICULTY_ORDER[b.scored.meal.difficulty];
  if (difficulty !== 0) return difficulty;
  return a.scored.meal.id < b.scored.meal.id ? -1 : a.scored.meal.id > b.scored.meal.id ? 1 : 0;
}

/**
 * "What can I make right now?" — allowed meals for today, ranked by:
 * (1) how many ingredients are missing (0, 1, 2, 3+); (2) how many
 * soon-expiring items they use; (3) in the 3+ bucket only, how many
 * ingredients the kitchen already covers; (4) preference (likes, saves,
 * favourite cuisines, rejections, aversions and recency); (5) time,
 * quickest first; (6) difficulty, easiest first. Weeknight limits apply
 * when today is Monday–Thursday.
 */
export function rankMealsForNow(ctx: PlannerContext, opts: RankMealsOptions = {}): ScoredMeal[] {
  const limit = opts.limit ?? DEFAULT_RANK_LIMIT;
  if (limit <= 0) return [];
  const aversions = aversionsFor(ctx);
  const scoreOpts: ScoreMealOptions = {
    date: ctx.today,
    servings: opts.servings ?? defaultServings(ctx.prefs.householdSize),
    isWeeknight: isWeeknight(ctx.today),
    aversions,
  };
  const evaluations: MealEvaluation[] = [];
  for (const meal of ctx.meals) {
    if (opts.maxMinutes !== undefined && meal.timeMinutes > opts.maxMinutes) continue;
    const evaluation = evaluateMeal(meal, ctx, scoreOpts, aversions);
    if (evaluation) evaluations.push(evaluation);
  }
  return evaluations
    .sort(compareForNow)
    .slice(0, limit)
    .map((evaluation) => evaluation.scored);
}

// ─── Plan generation ────────────────────────────────────────────────────────

interface Assignment {
  date: string;
  meal: PlannableMeal;
  score: number;
  reason: string;
}

/** How far a candidate breaks the variety rules: 0 none, 1 cuisine cap only, 2 same main on a neighbouring day. */
function varietyViolation(meal: PlannableMeal, date: string, assigned: ReadonlyMap<string, Assignment>): number {
  const main = mainIngredientKey(meal.mainIngredient);
  for (const neighbour of [addDays(date, -1), addDays(date, 1)]) {
    const other = assigned.get(neighbour);
    if (other && main !== "" && mainIngredientKey(other.meal.mainIngredient) === main) return 2;
  }
  return exceedsCuisineCap(meal, date, assigned) ? 1 : 0;
}

/** Whether adding the meal on `date` puts more than the cap of its cuisine in any 7-day window. */
function exceedsCuisineCap(meal: PlannableMeal, date: string, assigned: ReadonlyMap<string, Assignment>): boolean {
  const sameCuisine = [...assigned.values()].filter((a) => a.meal.cuisine === meal.cuisine).map((a) => daysBetweenDates(date, a.date));
  for (let start = -(CUISINE_WINDOW_DAYS - 1); start <= 0; start++) {
    const inWindow = sameCuisine.filter((offset) => offset >= start && offset < start + CUISINE_WINDOW_DAYS).length;
    if (inWindow + 1 > MAX_SAME_CUISINE_PER_WINDOW) return true;
  }
  return false;
}

function bestByScore(pool: readonly MealEvaluation[]): MealEvaluation | null {
  let best: MealEvaluation | null = null;
  for (const candidate of pool) {
    if (
      !best ||
      candidate.scored.score > best.scored.score + EPSILON ||
      (Math.abs(candidate.scored.score - best.scored.score) <= EPSILON && candidate.scored.meal.id < best.scored.meal.id)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Pick the meal for one date. Near-best meals (within `SEED_VARIETY_MARGIN`)
 * that use more soon-expiring food win over the rest. Among those, no seed
 * means the top score; a seed adds up to `SEED_VARIETY_MARGIN` points of
 * per-meal noise that holds for the whole plan, so a regenerated week swaps
 * in different meals rather than shuffling the same ones.
 */
function pickCandidate(candidates: readonly MealEvaluation[], seed: number | undefined): MealEvaluation | null {
  const best = bestByScore(candidates);
  if (!best) return null;
  const nearBest = candidates.filter((c) => c.scored.score >= best.scored.score - SEED_VARIETY_MARGIN - EPSILON);
  const mostUseSoon = Math.max(...nearBest.map((c) => c.parts.useSoon));
  const pool = nearBest.filter((c) => c.parts.useSoon >= mostUseSoon - EPSILON);
  if (seed === undefined) return bestByScore(pool);
  let pick: MealEvaluation | null = null;
  let pickValue = -Infinity;
  for (const candidate of pool) {
    const value = candidate.scored.score + SEED_VARIETY_MARGIN * hash01(`${seed}:pick:${candidate.scored.meal.id}`);
    if (value > pickValue) {
      pick = candidate;
      pickValue = value;
    }
  }
  return pick;
}

/** Candidates for an open date from the least-relaxed variety tier that has any. */
function candidatesForDate(
  meals: readonly PlannableMeal[],
  date: string,
  assigned: ReadonlyMap<string, Assignment>,
  unavailable: ReadonlySet<string>,
  evaluate: (meal: PlannableMeal) => MealEvaluation | null,
): MealEvaluation[] {
  const tiers: MealEvaluation[][] = [[], [], []];
  for (const meal of meals) {
    if (unavailable.has(meal.id)) continue;
    const evaluation = evaluate(meal);
    if (evaluation) tiers[varietyViolation(meal, date, assigned)]?.push(evaluation);
  }
  return tiers.find((tier) => tier.length > 0) ?? [];
}

function firstKeepPerDate(keep: GeneratePlanOptions["keep"], dates: ReadonlySet<string>, mealsById: ReadonlyMap<string, PlannableMeal>): Array<{ date: string; meal: PlannableMeal }> {
  const byDate = new Map<string, PlannableMeal>();
  for (const item of keep ?? []) {
    const meal = mealsById.get(item.mealId);
    if (meal && dates.has(item.date) && !byDate.has(item.date)) byDate.set(item.date, meal);
  }
  return [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, meal]) => ({ date, meal }));
}

/**
 * Build a meal plan for `opts.dates`, greedily in date order.
 *
 * Kept items stay on their dates and claim their ingredients first. Each open
 * date then gets the best allowed meal given what's left in the kitchen:
 * chosen meals claim their ingredients (soonest-expiring stock first) so
 * later days never double-count, and food about to go off earns the most on
 * the earliest days. Variety rules: no meal twice, not the same main
 * ingredient on consecutive days, at most 2 of one cuisine in any 7 days —
 * relaxed (cuisine first, then main ingredient) only when nothing else fits.
 * Monday–Thursday use the weeknight time limit. Excluded meal ids are never
 * picked for open dates.
 *
 * With a seed, any meal within a few points of the best may be chosen, so
 * regenerating gives a different week while strong signals (using the spinach
 * before it goes off) hold. Kept items for dates outside `dates` or with
 * unknown meal ids are ignored; a date with no possible meal is left out of
 * the result. Results are in date order.
 */
export function generatePlan(ctx: PlannerContext, opts: GeneratePlanOptions): PlannedMeal[] {
  const dates = [...new Set(opts.dates)].sort();
  const mealsById = new Map(ctx.meals.map((meal) => [meal.id, meal]));
  const aversions = aversionsFor(ctx);
  const balances: LotBalances = new Map();
  const assigned = new Map<string, Assignment>();
  const used = new Set<string>();

  const optionsFor = (date: string): ScoreMealOptions => ({ date, servings: opts.servings, isWeeknight: isWeeknight(date), seed: opts.seed, aversions });
  const claim = (evaluation: MealEvaluation, date: string): void => {
    allocateMealIngredients(evaluation.cookMeal, ctx.lots, ctx.products, { servings: opts.servings, date }, balances);
    const { meal, score, primaryReason } = evaluation.scored;
    assigned.set(date, { date, meal, score, reason: primaryReason });
    used.add(meal.id);
  };

  for (const { date, meal } of firstKeepPerDate(opts.keep, new Set(dates), mealsById)) {
    const evaluation = evaluateMeal(meal, withBalances(ctx, balances), optionsFor(date), aversions, true);
    if (evaluation) claim(evaluation, date);
  }

  const excluded = new Set(opts.exclude ?? []);
  for (const date of dates) {
    if (assigned.has(date)) continue;
    const working = withBalances(ctx, balances);
    const unavailable = new Set([...used, ...excluded]);
    const candidates = candidatesForDate(ctx.meals, date, assigned, unavailable, (meal) => evaluateMeal(meal, working, optionsFor(date), aversions));
    const pick = pickCandidate(candidates, opts.seed);
    if (pick) claim(pick, date);
  }

  return dates.flatMap((date) => {
    const item = assigned.get(date);
    return item ? [{ date, mealId: item.meal.id, score: item.score, reason: item.reason }] : [];
  });
}
