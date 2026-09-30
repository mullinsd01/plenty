/**
 * Plenty relational schema.
 *
 * Conventions
 * - Every household-owned table carries `household_id` so row-level security
 *   can be expressed with a single membership check (see the RLS migration).
 * - Timestamps are `timestamptz`; calendar dates (expiry, meal plan days) are
 *   `date` strings (YYYY-MM-DD) interpreted in the household's timezone.
 * - Soft deletion (`deleted_at`) is used where history matters (households,
 *   users, receipts, meals, inventory items). Event tables are append-only.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const deletedAt = () => timestamp("deleted_at", { withTimezone: true });
const money = (name: string) => numeric(name, { precision: 10, scale: 2, mode: "number" });

// ─── Enums ───────────────────────────────────────────────────────────────────

export const householdRole = pgEnum("household_role", ["owner", "member"]);
export const storageLocation = pgEnum("storage_location", [
  "fridge",
  "freezer",
  "pantry",
  "produce",
  "drinks",
  "household",
  "other",
]);
export const aisle = pgEnum("aisle", [
  "produce",
  "dairy",
  "meat",
  "seafood",
  "bakery",
  "deli",
  "pantry",
  "frozen",
  "drinks",
  "snacks",
  "household",
  "personal_care",
  "baby",
  "pet",
  "other",
]);
export const unit = pgEnum("unit", [
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
]);
export const baseUnit = pgEnum("base_unit", ["g", "ml", "each"]);
export const confidenceLevel = pgEnum("confidence_level", ["low", "medium", "high"]);
export const predictionBasis = pgEnum("prediction_basis", ["estimate", "history"]);
export const inventoryStatus = pgEnum("inventory_status", ["active", "finished", "wasted", "expired", "removed"]);
export const inventorySource = pgEnum("inventory_source", ["receipt", "manual", "shopping_list", "demo"]);
export const inventoryEventType = pgEnum("inventory_event_type", [
  "added",
  "adjusted",
  "used",
  "finished",
  "wasted",
  "expired",
  "removed",
  "restored",
  "moved",
  "edited",
]);
export const eventActor = pgEnum("event_actor", ["user", "receipt", "meal", "inference", "system"]);
export const consumptionOutcome = pgEnum("consumption_outcome", ["consumed", "wasted", "expired"]);
export const receiptStatus = pgEnum("receipt_status", [
  "uploaded",
  "processing",
  "needs_review",
  "confirmed",
  "failed",
  "discarded",
]);
export const receiptItemStatus = pgEnum("receipt_item_status", ["pending", "accepted", "ignored"]);
export const mealSource = pgEnum("meal_source", ["library", "ai", "user"]);
export const difficulty = pgEnum("difficulty", ["easy", "medium", "hard"]);
export const mealSlot = pgEnum("meal_slot", ["breakfast", "lunch", "dinner"]);
export const mealPlanStatus = pgEnum("meal_plan_status", ["active", "archived"]);
export const mealPlanItemStatus = pgEnum("meal_plan_item_status", ["planned", "cooked", "skipped"]);
export const shoppingListStatus = pgEnum("shopping_list_status", ["active", "completed"]);
export const shoppingSource = pgEnum("shopping_source", ["manual", "predicted", "meal_plan", "staple"]);
export const notificationType = pgEnum("notification_type", [
  "running_low",
  "use_soon",
  "meal_plan_ready",
  "shopping_reminder",
  "receipt_ready",
  "check_in",
  "insight",
  "household",
]);
export const cookingFrequency = pgEnum("cooking_frequency", ["rarely", "sometimes", "most_nights", "every_night"]);

// ─── Identity & auth ─────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(sql`lower(${t.email})`).where(sql`${t.deletedAt} is null`),
    check("users_email_format", sql`position('@' in ${t.email}) > 1`),
  ],
);

export const profiles = pgTable("profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  activeHouseholdId: uuid("active_household_id").references(() => households.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the session token; the raw token only ever lives in the cookie. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    /** SHA-256 of the reset token. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("password_reset_user_idx").on(t.userId)],
);

/** Fixed-window rate limiting counters. */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull().default(0),
});

/** Outgoing email log. In development (no SMTP configured) this doubles as the dev inbox. */
export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: id(),
    to: text("to").notNull(),
    subject: text("subject").notNull(),
    text: text("text").notNull(),
    html: text("html"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("email_outbox_created_idx").on(t.createdAt)],
);

// ─── Households ──────────────────────────────────────────────────────────────

export const households = pgTable(
  "households",
  {
    id: id(),
    name: text("name").notNull(),
    adults: smallint("adults").notNull().default(2),
    children: smallint("children").notNull().default(0),
    currency: text("currency").notNull().default("AUD"),
    timezone: text("timezone").notNull().default("Australia/Sydney"),
    onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
    isDemo: boolean("is_demo").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    check("households_adults_range", sql`${t.adults} between 0 and 20`),
    check("households_children_range", sql`${t.children} between 0 and 20`),
    check("households_people", sql`${t.adults} + ${t.children} >= 1`),
    check("households_name_len", sql`char_length(${t.name}) between 1 and 80`),
  ],
);

export const householdMembers = pgTable(
  "household_members",
  {
    id: id(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: householdRole("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("household_members_unique").on(t.householdId, t.userId),
    index("household_members_user_idx").on(t.userId),
  ],
);

export const householdInvitations = pgTable(
  "household_invitations",
  {
    id: id(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    email: text("email"),
    role: householdRole("role").notNull().default("member"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("household_invitations_code_unique").on(t.code),
    index("household_invitations_household_idx").on(t.householdId),
  ],
);

/** Household-level preferences collected in onboarding and editable in settings. */
export const preferences = pgTable(
  "preferences",
  {
    householdId: uuid("household_id")
      .primaryKey()
      .references(() => households.id, { onDelete: "cascade" }),
    diets: text("diets").array().notNull().default(sql`'{}'::text[]`),
    allergies: text("allergies").array().notNull().default(sql`'{}'::text[]`),
    dislikedIngredients: text("disliked_ingredients").array().notNull().default(sql`'{}'::text[]`),
    favouriteCuisines: text("favourite_cuisines").array().notNull().default(sql`'{}'::text[]`),
    cookingFrequency: cookingFrequency("cooking_frequency"),
    weeknightMaxMinutes: smallint("weeknight_max_minutes"),
    weeklyBudget: money("weekly_budget"),
    preferredStores: text("preferred_stores").array().notNull().default(sql`'{}'::text[]`),
    takeawayPerWeek: smallint("takeaway_per_week"),
    /** 0 = Sunday … 6 = Saturday. Null = learn it from receipts. */
    usualShopDay: smallint("usual_shop_day"),
    /** Explicit shop cadence override in days. Null = learn it. */
    shopIntervalDays: smallint("shop_interval_days"),
    allowAiProcessing: boolean("allow_ai_processing").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("preferences_shop_day", sql`${t.usualShopDay} is null or ${t.usualShopDay} between 0 and 6`),
    check("preferences_budget", sql`${t.weeklyBudget} is null or ${t.weeklyBudget} >= 0`),
    check("preferences_interval", sql`${t.shopIntervalDays} is null or ${t.shopIntervalDays} between 1 and 60`),
  ],
);

/** Per-member notification preferences. */
export const notificationSettings = pgTable(
  "notification_settings",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    runningLow: boolean("running_low").notNull().default(true),
    useSoon: boolean("use_soon").notNull().default(true),
    mealPlanReady: boolean("meal_plan_ready").notNull().default(true),
    shoppingReminder: boolean("shopping_reminder").notNull().default(true),
    checkIns: boolean("check_ins").notNull().default(true),
    insights: boolean("insights").notNull().default(true),
    emailDigest: boolean("email_digest").notNull().default(false),
    /** At most this many notifications per day. */
    dailyLimit: smallint("daily_limit").notNull().default(3),
    quietStartHour: smallint("quiet_start_hour").default(21),
    quietEndHour: smallint("quiet_end_hour").default(7),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.householdId] }),
    check("notification_settings_limit", sql`${t.dailyLimit} between 0 and 20`),
  ],
);

// ─── Products ────────────────────────────────────────────────────────────────

/**
 * Canonical products. Global catalog rows have `household_id` null and a
 * stable `slug`; households can add their own products.
 */
export const products = pgTable(
  "products",
  {
    id: id(),
    householdId: uuid("household_id").references(() => households.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    aisle: aisle("aisle").notNull().default("other"),
    location: storageLocation("location").notNull().default("pantry"),
    unit: unit("unit").notNull().default("each"),
    packageQuantity: doublePrecision("package_quantity").notNull().default(1),
    eachWeightG: doublePrecision("each_weight_g"),
    eachVolumeMl: doublePrecision("each_volume_ml"),
    densityGPerMl: doublePrecision("density_g_per_ml"),
    shelfLifeDays: integer("shelf_life_days"),
    freezerShelfLifeDays: integer("freezer_shelf_life_days"),
    perishable: boolean("perishable").notNull().default(false),
    dailyUsePerPerson: doublePrecision("daily_use_per_person"),
    productGroup: text("product_group"),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    contains: text("contains").array().notNull().default(sql`'{}'::text[]`),
    pantryBasic: boolean("pantry_basic").notNull().default(false),
    commonStaple: boolean("common_staple").notNull().default(false),
    nonFood: boolean("non_food").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("products_global_slug_unique").on(t.slug).where(sql`${t.householdId} is null`),
    uniqueIndex("products_household_slug_unique").on(t.householdId, t.slug).where(sql`${t.householdId} is not null`),
    index("products_name_trgm").using("gin", sql`${t.name} gin_trgm_ops`),
    check("products_package_positive", sql`${t.packageQuantity} > 0`),
  ],
);

/**
 * Learned receipt-text → product mappings per household. When a user confirms
 * "W/M FULL CREAM 2L" is full cream milk, the next receipt maps it instantly.
 */
export const productAliases = pgTable(
  "product_aliases",
  {
    id: id(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    aliasKey: text("alias_key").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    timesSeen: integer("times_seen").notNull().default(1),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("product_aliases_unique").on(t.householdId, t.aliasKey)],
);

// ─── Receipts ────────────────────────────────────────────────────────────────

export const receipts = pgTable(
  "receipts",
  {
    id: id(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    status: receiptStatus("status").notNull().default("uploaded"),
    imagePath: text("image_path"),
    imageHash: text("image_hash"),
    /** Hash of store + date + total + line prices; detects the same receipt photographed twice. */
    contentFingerprint: text("content_fingerprint"),
    duplicateOfId: uuid("duplicate_of_id"),
    storeName: text("store_name"),
    purchasedAt: timestamp("purchased_at", { withTimezone: true }),
    subtotal: money("subtotal"),
    total: money("total"),
    currency: text("currency"),
    rawText: text("raw_text"),
    provider: text("provider"),
    qualityWarnings: text("quality_warnings").array().notNull().default(sql`'{}'::text[]`),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: uuid("confirmed_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("receipts_household_created_idx").on(t.householdId, t.createdAt),
    index("receipts_household_purchased_idx").on(t.householdId, t.purchasedAt),
    index("receipts_image_hash_idx").on(t.householdId, t.imageHash),
    index("receipts_fingerprint_idx").on(t.householdId, t.contentFingerprint),
  ],
);

export const receiptItems = pgTable(
  "receipt_items",
  {
    id: id(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => receipts.id, { onDelete: "cascade" }),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    lineIndex: integer("line_index").notNull(),
    rawText: text("raw_text").notNull(),
    name: text("name").notNull(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    aisle: aisle("aisle").notNull().default("other"),
    location: storageLocation("location").notNull().default("pantry"),
    quantity: doublePrecision("quantity").notNull().default(1),
    unit: unit("unit").notNull().default("each"),
    packCount: integer("pack_count").notNull().default(1),
    unitPrice: money("unit_price"),
    totalPrice: money("total_price"),
    matchConfidence: doublePrecision("match_confidence").notNull().default(0),
    isFood: boolean("is_food").notNull().default(true),
    estimatedExpiry: date("estimated_expiry", { mode: "string" }),
    status: receiptItemStatus("status").notNull().default("pending"),
    inventoryItemId: uuid("inventory_item_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("receipt_items_receipt_idx").on(t.receiptId, t.lineIndex),
    index("receipt_items_household_product_idx").on(t.householdId, t.productId),
    check("receipt_items_quantity_positive", sql`${t.quantity} > 0`),
    check("receipt_items_pack_positive", sql`${t.packCount} >= 1`),
    check("receipt_items_confidence_range", sql`${t.matchConfidence} between 0 and 1`),
  ],
);

// ─── Inventory ───────────────────────────────────────────────────────────────

export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: id(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    location: storageLocation("location").notNull().default("pantry"),
    /** Total purchased amount in `unit` (e.g. 4 L for two 2 L bottles). */
    quantity: doublePrecision("quantity").notNull(),
    unit: unit("unit").notNull().default("each"),
    packCount: integer("pack_count").notNull().default(1),
    /** Last known fraction remaining (0–1). Estimated remaining is derived from this and the consumption rate. */
    remainingFraction: doublePrecision("remaining_fraction").notNull().default(1),
    levelUpdatedAt: timestamp("level_updated_at", { withTimezone: true }).notNull().defaultNow(),
    purchasedAt: timestamp("purchased_at", { withTimezone: true }).notNull().defaultNow(),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    estimatedExpiry: date("estimated_expiry", { mode: "string" }),
    actualExpiry: date("actual_expiry", { mode: "string" }),
    status: inventoryStatus("status").notNull().default("active"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    source: inventorySource("source").notNull().default("manual"),
    receiptItemId: uuid("receipt_item_id").references(() => receiptItems.id, { onDelete: "set null" }),
    /** How sure Plenty is about this item's identity and amount. */
    confidence: confidenceLevel("confidence").notNull().default("high"),
    price: money("price"),
    notes: text("notes"),
    /** Don't ask "did you finish this?" again before this time. */
    checkInSnoozedUntil: timestamp("check_in_snoozed_until", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index("inventory_household_status_idx").on(t.householdId, t.status),
    index("inventory_household_product_idx").on(t.householdId, t.productId),
    index("inventory_household_expiry_idx").on(t.householdId, t.estimatedExpiry).where(sql`${t.status} = 'active'`),
    index("inventory_name_trgm").using("gin", sql`${t.name} gin_trgm_ops`),
    check("inventory_quantity_positive", sql`${t.quantity} > 0`),
    check("inventory_fraction_range", sql`${t.remainingFraction} between 0 and 1`),
    check("inventory_pack_positive", sql`${t.packCount} >= 1`),
    check("inventory_name_len", sql`char_length(${t.name}) between 1 and 120`),
  ],
);

/** Append-only log of everything that happens to an inventory item. */
export const inventoryEvents = pgTable(
  "inventory_events",
  {
    id: id(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    inventoryItemId: uuid("inventory_item_id")
      .notNull()
      .references(() => inventoryItems.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    type: inventoryEventType("type").notNull(),
    actor: eventActor("actor").notNull().default("user"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    fractionBefore: doublePrecision("fraction_before"),
    fractionAfter: doublePrecision("fraction_after"),
    note: text("note"),
    mealPlanItemId: uuid("meal_plan_item_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index("inventory_events_household_time_idx").on(t.householdId, t.occurredAt),
    index("inventory_events_item_idx").on(t.inventoryItemId, t.occurredAt),
  ],
);

/**
 * One observation of the household using up a product: from purchase (or
 * opening) until it was finished, wasted or expired. This is the raw material
 * for learning consumption rates.
 */
export const consumptionEvents = pgTable(
  "consumption_events",
  {
    id: id(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    inventoryItemId: uuid("inventory_item_id").references(() => inventoryItems.id, { onDelete: "set null" }),
    outcome: consumptionOutcome("outcome").notNull(),
    /** Amount actually used (excludes the wasted portion), in base units. */
    amountUsedBase: doublePrecision("amount_used_base").notNull(),
    /** Amount thrown away, in base units. */
    amountWastedBase: doublePrecision("amount_wasted_base").notNull().default(0),
    baseUnit: baseUnit("base_unit").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    durationDays: doublePrecision("duration_days").notNull(),
    /** Adult-equivalents in the household when this happened (for scaling if the household changes). */
    householdSize: doublePrecision("household_size").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("consumption_household_product_idx").on(t.householdId, t.productId, t.endedAt),
    check("consumption_amounts_nonneg", sql`${t.amountUsedBase} >= 0 and ${t.amountWastedBase} >= 0`),
    check("consumption_duration_positive", sql`${t.durationDays} > 0`),
  ],
);

/** Learned per-product consumption statistics for a household. Recomputed deterministically. */
export const consumptionStats = pgTable(
  "consumption_stats",
  {
    id: id(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    baseUnit: baseUnit("base_unit").notNull(),
    observations: integer("observations").notNull().default(0),
    outliersExcluded: integer("outliers_excluded").notNull().default(0),
    /** Blended daily rate (base units/day) used for predictions. */
    dailyRate: doublePrecision("daily_rate"),
    historyMedianRate: doublePrecision("history_median_rate"),
    historyMeanRate: doublePrecision("history_mean_rate"),
    recentRate: doublePrecision("recent_rate"),
    priorRate: doublePrecision("prior_rate"),
    /** Coefficient of variation of observed rates. */
    variability: doublePrecision("variability"),
    seasonalFactor: doublePrecision("seasonal_factor").notNull().default(1),
    typicalPurchaseAmount: doublePrecision("typical_purchase_amount"),
    typicalPurchaseIntervalDays: doublePrecision("typical_purchase_interval_days"),
    purchaseCount: integer("purchase_count").notNull().default(0),
    wasteRatio: doublePrecision("waste_ratio").notNull().default(0),
    wasteEvents: integer("waste_events").notNull().default(0),
    lastPurchasedAt: timestamp("last_purchased_at", { withTimezone: true }),
    lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
    basis: predictionBasis("basis").notNull().default("estimate"),
    confidence: confidenceLevel("confidence").notNull().default("low"),
    isStaple: boolean("is_staple").notNull().default(false),
    /** User override: true/false forces staple status; null = learn it. */
    stapleOverride: boolean("staple_override"),
    /** User asked Plenty not to predict this product. */
    predictionsPaused: boolean("predictions_paused").notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("consumption_stats_unique").on(t.householdId, t.productId)],
);

/** Current run-out predictions (one per product, or per item for uncatalogued items). */
export const predictions = pgTable(
  "predictions",
  {
    id: id(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    inventoryItemId: uuid("inventory_item_id").references(() => inventoryItems.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    remainingBase: doublePrecision("remaining_base").notNull(),
    baseUnit: baseUnit("base_unit").notNull(),
    dailyRate: doublePrecision("daily_rate").notNull(),
    daysRemaining: doublePrecision("days_remaining").notNull(),
    daysLow: doublePrecision("days_low").notNull(),
    daysHigh: doublePrecision("days_high").notNull(),
    runOutOn: date("run_out_on", { mode: "string" }).notNull(),
    confidence: confidenceLevel("confidence").notNull(),
    basis: predictionBasis("basis").notNull(),
    reason: text("reason").notNull(),
    needsCheckIn: boolean("needs_check_in").notNull().default(false),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("predictions_product_unique")
      .on(t.householdId, t.productId)
      .where(sql`${t.productId} is not null`),
    uniqueIndex("predictions_item_unique")
      .on(t.householdId, t.inventoryItemId)
      .where(sql`${t.productId} is null`),
    index("predictions_household_days_idx").on(t.householdId, t.daysRemaining),
  ],
);

// ─── Meals ───────────────────────────────────────────────────────────────────

/** Recipes. Library rows are global (`household_id` null); AI and user recipes belong to a household. */
export const meals = pgTable(
  "meals",
  {
    id: id(),
    householdId: uuid("household_id").references(() => households.id, { onDelete: "cascade" }),
    source: mealSource("source").notNull().default("library"),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    cuisine: text("cuisine").notNull().default("other"),
    timeMinutes: smallint("time_minutes").notNull(),
    difficulty: difficulty("difficulty").notNull().default("easy"),
    servings: smallint("servings").notNull().default(4),
    mainIngredient: text("main_ingredient").notNull().default(""),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    /** Union of ingredient `contains` flags; drives allergy and diet filtering. */
    contains: text("contains").array().notNull().default(sql`'{}'::text[]`),
    steps: text("steps").array().notNull().default(sql`'{}'::text[]`),
    basedOnMealId: uuid("based_on_meal_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex("meals_global_slug_unique").on(t.slug).where(sql`${t.householdId} is null`),
    uniqueIndex("meals_household_slug_unique").on(t.householdId, t.slug).where(sql`${t.householdId} is not null`),
    index("meals_name_trgm").using("gin", sql`${t.name} gin_trgm_ops`),
    check("meals_time_range", sql`${t.timeMinutes} between 1 and 600`),
    check("meals_servings_range", sql`${t.servings} between 1 and 24`),
  ],
);

export const mealIngredients = pgTable(
  "meal_ingredients",
  {
    id: id(),
    mealId: uuid("meal_id")
      .notNull()
      .references(() => meals.id, { onDelete: "cascade" }),
    /** Denormalised from the meal for row-level security. */
    householdId: uuid("household_id").references(() => households.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(),
    name: text("name").notNull(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    quantity: doublePrecision("quantity"),
    unit: unit("unit"),
    optional: boolean("optional").notNull().default(false),
    note: text("note"),
  },
  (t) => [
    index("meal_ingredients_meal_idx").on(t.mealId, t.position),
    index("meal_ingredients_product_idx").on(t.productId),
  ],
);

/** How a household feels about a meal. Drives learning from likes, dislikes and rejections. */
export const mealPreferences = pgTable(
  "meal_preferences",
  {
    id: id(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    mealId: uuid("meal_id")
      .notNull()
      .references(() => meals.id, { onDelete: "cascade" }),
    /** -1 disliked, 0 neutral, 1 liked. */
    rating: smallint("rating").notNull().default(0),
    saved: boolean("saved").notNull().default(false),
    timesPlanned: integer("times_planned").notNull().default(0),
    timesCooked: integer("times_cooked").notNull().default(0),
    timesRejected: integer("times_rejected").notNull().default(0),
    lastPlannedAt: timestamp("last_planned_at", { withTimezone: true }),
    lastCookedAt: timestamp("last_cooked_at", { withTimezone: true }),
    lastRejectedAt: timestamp("last_rejected_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("meal_preferences_unique").on(t.householdId, t.mealId),
    check("meal_preferences_rating", sql`${t.rating} between -1 and 1`),
  ],
);

export const mealPlans = pgTable(
  "meal_plans",
  {
    id: id(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    status: mealPlanStatus("status").notNull().default("active"),
    generatedBy: text("generated_by"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("meal_plans_household_idx").on(t.householdId, t.startDate),
    check("meal_plans_dates", sql`${t.endDate} >= ${t.startDate}`),
  ],
);

export const mealPlanItems = pgTable(
  "meal_plan_items",
  {
    id: id(),
    mealPlanId: uuid("meal_plan_id")
      .notNull()
      .references(() => mealPlans.id, { onDelete: "cascade" }),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    slot: mealSlot("slot").notNull().default("dinner"),
    mealId: uuid("meal_id")
      .notNull()
      .references(() => meals.id, { onDelete: "restrict" }),
    servings: smallint("servings").notNull(),
    status: mealPlanItemStatus("status").notNull().default("planned"),
    /** Why Plenty chose this meal, in plain language. */
    reason: text("reason"),
    cookedAt: timestamp("cooked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("meal_plan_items_slot_unique").on(t.mealPlanId, t.date, t.slot),
    index("meal_plan_items_household_date_idx").on(t.householdId, t.date),
    check("meal_plan_items_servings", sql`${t.servings} between 1 and 24`),
  ],
);

// ─── Shopping ────────────────────────────────────────────────────────────────

export const shoppingLists = pgTable(
  "shopping_lists",
  {
    id: id(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Next shop"),
    status: shoppingListStatus("status").notNull().default("active"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("shopping_lists_one_active").on(t.householdId).where(sql`${t.status} = 'active'`),
  ],
);

export const shoppingListItems = pgTable(
  "shopping_list_items",
  {
    id: id(),
    listId: uuid("list_id")
      .notNull()
      .references(() => shoppingLists.id, { onDelete: "cascade" }),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    /** Normalised identity used to merge needs from different sources. */
    itemKey: text("item_key").notNull(),
    name: text("name").notNull(),
    aisle: aisle("aisle").notNull().default("other"),
    /** Quantity the user asked for; overrides the computed amount when set. */
    quantity: doublePrecision("quantity"),
    unit: unit("unit"),
    /** Amount computed from predictions / meal plans / staples. */
    suggestedQuantity: doublePrecision("suggested_quantity"),
    suggestedUnit: unit("suggested_unit"),
    /** Primary reason this item is on the list. */
    source: shoppingSource("source").notNull().default("manual"),
    /** Plain-language explanation, e.g. "For Tuesday's pasta · running low". */
    reason: text("reason"),
    /** Advice such as "You usually waste some of this — maybe buy less". */
    advice: text("advice"),
    position: integer("position").notNull().default(0),
    userEdited: boolean("user_edited").notNull().default(false),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    checkedBy: uuid("checked_by").references(() => users.id, { onDelete: "set null" }),
    /** Auto-added item the user removed; don't re-add it until this time. */
    dismissedUntil: timestamp("dismissed_until", { withTimezone: true }),
    purchasedAt: timestamp("purchased_at", { withTimezone: true }),
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("shopping_items_key_unique").on(t.listId, t.itemKey),
    index("shopping_items_household_idx").on(t.householdId),
    index("shopping_items_name_trgm").using("gin", sql`${t.name} gin_trgm_ops`),
    check("shopping_items_quantity_positive", sql`${t.quantity} is null or ${t.quantity} > 0`),
  ],
);

/** Breakdown of why an item is needed, one row per contributing source. */
export const shoppingListItemSources = pgTable(
  "shopping_list_item_sources",
  {
    id: id(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => shoppingListItems.id, { onDelete: "cascade" }),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    source: shoppingSource("source").notNull(),
    mealPlanItemId: uuid("meal_plan_item_id").references(() => mealPlanItems.id, { onDelete: "cascade" }),
    quantity: doublePrecision("quantity"),
    unit: unit("unit"),
    note: text("note"),
  },
  (t) => [index("shopping_item_sources_item_idx").on(t.itemId)],
);

// ─── Notifications ───────────────────────────────────────────────────────────

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: notificationType("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    link: text("link"),
    /** Prevents the same nudge being sent twice, e.g. "running_low:<product>:<date>". */
    dedupeKey: text("dedupe_key").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("notifications_dedupe_unique").on(t.userId, t.householdId, t.dedupeKey),
    index("notifications_user_created_idx").on(t.userId, t.householdId, t.createdAt),
  ],
);

export type DbUser = typeof users.$inferSelect;
export type DbHousehold = typeof households.$inferSelect;
export type DbPreferences = typeof preferences.$inferSelect;
export type DbProduct = typeof products.$inferSelect;
export type DbInventoryItem = typeof inventoryItems.$inferSelect;
export type DbReceipt = typeof receipts.$inferSelect;
export type DbReceiptItem = typeof receiptItems.$inferSelect;
export type DbMeal = typeof meals.$inferSelect;
export type DbMealIngredient = typeof mealIngredients.$inferSelect;
export type DbMealPlanItem = typeof mealPlanItems.$inferSelect;
export type DbShoppingListItem = typeof shoppingListItems.$inferSelect;
export type DbNotification = typeof notifications.$inferSelect;
export type DbConsumptionStats = typeof consumptionStats.$inferSelect;
export type DbPrediction = typeof predictions.$inferSelect;
