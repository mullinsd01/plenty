CREATE TYPE "public"."aisle" AS ENUM('produce', 'dairy', 'meat', 'seafood', 'bakery', 'deli', 'pantry', 'frozen', 'drinks', 'snacks', 'household', 'personal_care', 'baby', 'pet', 'other');--> statement-breakpoint
CREATE TYPE "public"."base_unit" AS ENUM('g', 'ml', 'each');--> statement-breakpoint
CREATE TYPE "public"."confidence_level" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."consumption_outcome" AS ENUM('consumed', 'wasted', 'expired');--> statement-breakpoint
CREATE TYPE "public"."cooking_frequency" AS ENUM('rarely', 'sometimes', 'most_nights', 'every_night');--> statement-breakpoint
CREATE TYPE "public"."difficulty" AS ENUM('easy', 'medium', 'hard');--> statement-breakpoint
CREATE TYPE "public"."event_actor" AS ENUM('user', 'receipt', 'meal', 'inference', 'system');--> statement-breakpoint
CREATE TYPE "public"."household_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."inventory_event_type" AS ENUM('added', 'adjusted', 'used', 'finished', 'wasted', 'expired', 'removed', 'restored', 'moved', 'edited');--> statement-breakpoint
CREATE TYPE "public"."inventory_source" AS ENUM('receipt', 'manual', 'shopping_list', 'demo');--> statement-breakpoint
CREATE TYPE "public"."inventory_status" AS ENUM('active', 'finished', 'wasted', 'expired', 'removed');--> statement-breakpoint
CREATE TYPE "public"."meal_plan_item_status" AS ENUM('planned', 'cooked', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."meal_plan_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."meal_slot" AS ENUM('breakfast', 'lunch', 'dinner');--> statement-breakpoint
CREATE TYPE "public"."meal_source" AS ENUM('library', 'ai', 'user');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('running_low', 'use_soon', 'meal_plan_ready', 'shopping_reminder', 'receipt_ready', 'check_in', 'insight', 'household');--> statement-breakpoint
CREATE TYPE "public"."prediction_basis" AS ENUM('estimate', 'history');--> statement-breakpoint
CREATE TYPE "public"."receipt_item_status" AS ENUM('pending', 'accepted', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."receipt_status" AS ENUM('uploaded', 'processing', 'needs_review', 'confirmed', 'failed', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."shopping_list_status" AS ENUM('active', 'completed');--> statement-breakpoint
CREATE TYPE "public"."shopping_source" AS ENUM('manual', 'predicted', 'meal_plan', 'staple');--> statement-breakpoint
CREATE TYPE "public"."storage_location" AS ENUM('fridge', 'freezer', 'pantry', 'produce', 'drinks', 'household', 'other');--> statement-breakpoint
CREATE TYPE "public"."unit" AS ENUM('each', 'g', 'kg', 'ml', 'l', 'pack', 'bunch', 'can', 'bottle', 'jar', 'loaf', 'dozen', 'tbsp', 'tsp', 'cup', 'clove', 'slice', 'pinch');--> statement-breakpoint
CREATE TABLE "consumption_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"product_id" uuid,
	"inventory_item_id" uuid,
	"outcome" "consumption_outcome" NOT NULL,
	"amount_used_base" double precision NOT NULL,
	"amount_wasted_base" double precision DEFAULT 0 NOT NULL,
	"base_unit" "base_unit" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"duration_days" double precision NOT NULL,
	"household_size" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumption_amounts_nonneg" CHECK ("consumption_events"."amount_used_base" >= 0 and "consumption_events"."amount_wasted_base" >= 0),
	CONSTRAINT "consumption_duration_positive" CHECK ("consumption_events"."duration_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "consumption_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"base_unit" "base_unit" NOT NULL,
	"observations" integer DEFAULT 0 NOT NULL,
	"outliers_excluded" integer DEFAULT 0 NOT NULL,
	"daily_rate" double precision,
	"history_median_rate" double precision,
	"history_mean_rate" double precision,
	"recent_rate" double precision,
	"prior_rate" double precision,
	"variability" double precision,
	"seasonal_factor" double precision DEFAULT 1 NOT NULL,
	"typical_purchase_amount" double precision,
	"typical_purchase_interval_days" double precision,
	"purchase_count" integer DEFAULT 0 NOT NULL,
	"waste_ratio" double precision DEFAULT 0 NOT NULL,
	"waste_events" integer DEFAULT 0 NOT NULL,
	"last_purchased_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"basis" "prediction_basis" DEFAULT 'estimate' NOT NULL,
	"confidence" "confidence_level" DEFAULT 'low' NOT NULL,
	"is_staple" boolean DEFAULT false NOT NULL,
	"staple_override" boolean,
	"predictions_paused" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to" text NOT NULL,
	"subject" text NOT NULL,
	"text" text NOT NULL,
	"html" text,
	"sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"code" text NOT NULL,
	"email" text,
	"role" "household_role" DEFAULT 'member' NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "household_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"adults" smallint DEFAULT 2 NOT NULL,
	"children" smallint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"timezone" text DEFAULT 'Australia/Sydney' NOT NULL,
	"onboarded_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "households_adults_range" CHECK ("households"."adults" between 0 and 20),
	CONSTRAINT "households_children_range" CHECK ("households"."children" between 0 and 20),
	CONSTRAINT "households_people" CHECK ("households"."adults" + "households"."children" >= 1),
	CONSTRAINT "households_name_len" CHECK (char_length("households"."name") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "inventory_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"inventory_item_id" uuid NOT NULL,
	"product_id" uuid,
	"type" "inventory_event_type" NOT NULL,
	"actor" "event_actor" DEFAULT 'user' NOT NULL,
	"actor_user_id" uuid,
	"fraction_before" double precision,
	"fraction_after" double precision,
	"note" text,
	"meal_plan_item_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"product_id" uuid,
	"name" text NOT NULL,
	"location" "storage_location" DEFAULT 'pantry' NOT NULL,
	"quantity" double precision NOT NULL,
	"unit" "unit" DEFAULT 'each' NOT NULL,
	"pack_count" integer DEFAULT 1 NOT NULL,
	"remaining_fraction" double precision DEFAULT 1 NOT NULL,
	"level_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purchased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"estimated_expiry" date,
	"actual_expiry" date,
	"status" "inventory_status" DEFAULT 'active' NOT NULL,
	"status_changed_at" timestamp with time zone,
	"source" "inventory_source" DEFAULT 'manual' NOT NULL,
	"receipt_item_id" uuid,
	"confidence" "confidence_level" DEFAULT 'high' NOT NULL,
	"price" numeric(10, 2),
	"notes" text,
	"check_in_snoozed_until" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "inventory_quantity_positive" CHECK ("inventory_items"."quantity" > 0),
	CONSTRAINT "inventory_fraction_range" CHECK ("inventory_items"."remaining_fraction" between 0 and 1),
	CONSTRAINT "inventory_pack_positive" CHECK ("inventory_items"."pack_count" >= 1),
	CONSTRAINT "inventory_name_len" CHECK (char_length("inventory_items"."name") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "meal_ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meal_id" uuid NOT NULL,
	"household_id" uuid,
	"position" smallint NOT NULL,
	"name" text NOT NULL,
	"product_id" uuid,
	"quantity" double precision,
	"unit" "unit",
	"optional" boolean DEFAULT false NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "meal_plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meal_plan_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"date" date NOT NULL,
	"slot" "meal_slot" DEFAULT 'dinner' NOT NULL,
	"meal_id" uuid NOT NULL,
	"servings" smallint NOT NULL,
	"status" "meal_plan_item_status" DEFAULT 'planned' NOT NULL,
	"reason" text,
	"cooked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_plan_items_servings" CHECK ("meal_plan_items"."servings" between 1 and 24)
);
--> statement-breakpoint
CREATE TABLE "meal_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "meal_plan_status" DEFAULT 'active' NOT NULL,
	"generated_by" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_plans_dates" CHECK ("meal_plans"."end_date" >= "meal_plans"."start_date")
);
--> statement-breakpoint
CREATE TABLE "meal_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"meal_id" uuid NOT NULL,
	"rating" smallint DEFAULT 0 NOT NULL,
	"saved" boolean DEFAULT false NOT NULL,
	"times_planned" integer DEFAULT 0 NOT NULL,
	"times_cooked" integer DEFAULT 0 NOT NULL,
	"times_rejected" integer DEFAULT 0 NOT NULL,
	"last_planned_at" timestamp with time zone,
	"last_cooked_at" timestamp with time zone,
	"last_rejected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_preferences_rating" CHECK ("meal_preferences"."rating" between -1 and 1)
);
--> statement-breakpoint
CREATE TABLE "meals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid,
	"source" "meal_source" DEFAULT 'library' NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"cuisine" text DEFAULT 'other' NOT NULL,
	"time_minutes" smallint NOT NULL,
	"difficulty" "difficulty" DEFAULT 'easy' NOT NULL,
	"servings" smallint DEFAULT 4 NOT NULL,
	"main_ingredient" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"contains" text[] DEFAULT '{}'::text[] NOT NULL,
	"steps" text[] DEFAULT '{}'::text[] NOT NULL,
	"based_on_meal_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "meals_time_range" CHECK ("meals"."time_minutes" between 1 and 600),
	CONSTRAINT "meals_servings_range" CHECK ("meals"."servings" between 1 and 24)
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"user_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"running_low" boolean DEFAULT true NOT NULL,
	"use_soon" boolean DEFAULT true NOT NULL,
	"meal_plan_ready" boolean DEFAULT true NOT NULL,
	"shopping_reminder" boolean DEFAULT true NOT NULL,
	"check_ins" boolean DEFAULT true NOT NULL,
	"insights" boolean DEFAULT true NOT NULL,
	"email_digest" boolean DEFAULT false NOT NULL,
	"daily_limit" smallint DEFAULT 3 NOT NULL,
	"quiet_start_hour" smallint DEFAULT 21,
	"quiet_end_hour" smallint DEFAULT 7,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_settings_user_id_household_id_pk" PRIMARY KEY("user_id","household_id"),
	CONSTRAINT "notification_settings_limit" CHECK ("notification_settings"."daily_limit" between 0 and 20)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"dedupe_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "predictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"product_id" uuid,
	"inventory_item_id" uuid,
	"name" text NOT NULL,
	"remaining_base" double precision NOT NULL,
	"base_unit" "base_unit" NOT NULL,
	"daily_rate" double precision NOT NULL,
	"days_remaining" double precision NOT NULL,
	"days_low" double precision NOT NULL,
	"days_high" double precision NOT NULL,
	"run_out_on" date NOT NULL,
	"confidence" "confidence_level" NOT NULL,
	"basis" "prediction_basis" NOT NULL,
	"reason" text NOT NULL,
	"needs_check_in" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"household_id" uuid PRIMARY KEY NOT NULL,
	"diets" text[] DEFAULT '{}'::text[] NOT NULL,
	"allergies" text[] DEFAULT '{}'::text[] NOT NULL,
	"disliked_ingredients" text[] DEFAULT '{}'::text[] NOT NULL,
	"favourite_cuisines" text[] DEFAULT '{}'::text[] NOT NULL,
	"cooking_frequency" "cooking_frequency",
	"weeknight_max_minutes" smallint,
	"weekly_budget" numeric(10, 2),
	"preferred_stores" text[] DEFAULT '{}'::text[] NOT NULL,
	"takeaway_per_week" smallint,
	"usual_shop_day" smallint,
	"shop_interval_days" smallint,
	"allow_ai_processing" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preferences_shop_day" CHECK ("preferences"."usual_shop_day" is null or "preferences"."usual_shop_day" between 0 and 6),
	CONSTRAINT "preferences_budget" CHECK ("preferences"."weekly_budget" is null or "preferences"."weekly_budget" >= 0),
	CONSTRAINT "preferences_interval" CHECK ("preferences"."shop_interval_days" is null or "preferences"."shop_interval_days" between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "product_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"alias_key" text NOT NULL,
	"product_id" uuid NOT NULL,
	"times_seen" integer DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"aisle" "aisle" DEFAULT 'other' NOT NULL,
	"location" "storage_location" DEFAULT 'pantry' NOT NULL,
	"unit" "unit" DEFAULT 'each' NOT NULL,
	"package_quantity" double precision DEFAULT 1 NOT NULL,
	"each_weight_g" double precision,
	"each_volume_ml" double precision,
	"density_g_per_ml" double precision,
	"shelf_life_days" integer,
	"freezer_shelf_life_days" integer,
	"perishable" boolean DEFAULT false NOT NULL,
	"daily_use_per_person" double precision,
	"product_group" text,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"contains" text[] DEFAULT '{}'::text[] NOT NULL,
	"pantry_basic" boolean DEFAULT false NOT NULL,
	"common_staple" boolean DEFAULT false NOT NULL,
	"non_food" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_package_positive" CHECK ("products"."package_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"active_household_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipt_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"line_index" integer NOT NULL,
	"raw_text" text NOT NULL,
	"name" text NOT NULL,
	"product_id" uuid,
	"aisle" "aisle" DEFAULT 'other' NOT NULL,
	"location" "storage_location" DEFAULT 'pantry' NOT NULL,
	"quantity" double precision DEFAULT 1 NOT NULL,
	"unit" "unit" DEFAULT 'each' NOT NULL,
	"pack_count" integer DEFAULT 1 NOT NULL,
	"unit_price" numeric(10, 2),
	"total_price" numeric(10, 2),
	"match_confidence" double precision DEFAULT 0 NOT NULL,
	"is_food" boolean DEFAULT true NOT NULL,
	"estimated_expiry" date,
	"status" "receipt_item_status" DEFAULT 'pending' NOT NULL,
	"inventory_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_items_quantity_positive" CHECK ("receipt_items"."quantity" > 0),
	CONSTRAINT "receipt_items_pack_positive" CHECK ("receipt_items"."pack_count" >= 1),
	CONSTRAINT "receipt_items_confidence_range" CHECK ("receipt_items"."match_confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"uploaded_by" uuid,
	"status" "receipt_status" DEFAULT 'uploaded' NOT NULL,
	"image_path" text,
	"image_hash" text,
	"content_fingerprint" text,
	"duplicate_of_id" uuid,
	"store_name" text,
	"purchased_at" timestamp with time zone,
	"subtotal" numeric(10, 2),
	"total" numeric(10, 2),
	"currency" text,
	"raw_text" text,
	"provider" text,
	"quality_warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"error_code" text,
	"error_message" text,
	"processing_started_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopping_list_item_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"source" "shopping_source" NOT NULL,
	"meal_plan_item_id" uuid,
	"quantity" double precision,
	"unit" "unit",
	"note" text
);
--> statement-breakpoint
CREATE TABLE "shopping_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"product_id" uuid,
	"item_key" text NOT NULL,
	"name" text NOT NULL,
	"aisle" "aisle" DEFAULT 'other' NOT NULL,
	"quantity" double precision,
	"unit" "unit",
	"suggested_quantity" double precision,
	"suggested_unit" "unit",
	"source" "shopping_source" DEFAULT 'manual' NOT NULL,
	"reason" text,
	"advice" text,
	"position" integer DEFAULT 0 NOT NULL,
	"user_edited" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone,
	"checked_by" uuid,
	"dismissed_until" timestamp with time zone,
	"purchased_at" timestamp with time zone,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopping_items_quantity_positive" CHECK ("shopping_list_items"."quantity" is null or "shopping_list_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "shopping_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text DEFAULT 'Next shop' NOT NULL,
	"status" "shopping_list_status" DEFAULT 'active' NOT NULL,
	"completed_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_format" CHECK (position('@' in "users"."email") > 1)
);
--> statement-breakpoint
ALTER TABLE "consumption_events" ADD CONSTRAINT "consumption_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumption_events" ADD CONSTRAINT "consumption_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumption_events" ADD CONSTRAINT "consumption_events_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumption_stats" ADD CONSTRAINT "consumption_stats_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumption_stats" ADD CONSTRAINT "consumption_stats_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD CONSTRAINT "household_invitations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD CONSTRAINT "household_invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD CONSTRAINT "household_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "households" ADD CONSTRAINT "households_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_receipt_item_id_receipt_items_id_fk" FOREIGN KEY ("receipt_item_id") REFERENCES "public"."receipt_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_ingredients" ADD CONSTRAINT "meal_ingredients_meal_id_meals_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_ingredients" ADD CONSTRAINT "meal_ingredients_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_ingredients" ADD CONSTRAINT "meal_ingredients_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_items" ADD CONSTRAINT "meal_plan_items_meal_plan_id_meal_plans_id_fk" FOREIGN KEY ("meal_plan_id") REFERENCES "public"."meal_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_items" ADD CONSTRAINT "meal_plan_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_items" ADD CONSTRAINT "meal_plan_items_meal_id_meals_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plans" ADD CONSTRAINT "meal_plans_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plans" ADD CONSTRAINT "meal_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_preferences" ADD CONSTRAINT "meal_preferences_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_preferences" ADD CONSTRAINT "meal_preferences_meal_id_meals_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meals" ADD CONSTRAINT "meals_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meals" ADD CONSTRAINT "meals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_aliases" ADD CONSTRAINT "product_aliases_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_aliases" ADD CONSTRAINT "product_aliases_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_active_household_id_households_id_fk" FOREIGN KEY ("active_household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_list_item_sources" ADD CONSTRAINT "shopping_list_item_sources_item_id_shopping_list_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."shopping_list_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_list_item_sources" ADD CONSTRAINT "shopping_list_item_sources_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_list_item_sources" ADD CONSTRAINT "shopping_list_item_sources_meal_plan_item_id_meal_plan_items_id_fk" FOREIGN KEY ("meal_plan_item_id") REFERENCES "public"."meal_plan_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD CONSTRAINT "shopping_list_items_list_id_shopping_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."shopping_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD CONSTRAINT "shopping_list_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD CONSTRAINT "shopping_list_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD CONSTRAINT "shopping_list_items_checked_by_users_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD CONSTRAINT "shopping_list_items_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_lists" ADD CONSTRAINT "shopping_lists_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consumption_household_product_idx" ON "consumption_events" USING btree ("household_id","product_id","ended_at");--> statement-breakpoint
CREATE UNIQUE INDEX "consumption_stats_unique" ON "consumption_stats" USING btree ("household_id","product_id");--> statement-breakpoint
CREATE INDEX "email_outbox_created_idx" ON "email_outbox" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "household_invitations_code_unique" ON "household_invitations" USING btree ("code");--> statement-breakpoint
CREATE INDEX "household_invitations_household_idx" ON "household_invitations" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "household_members_unique" ON "household_members" USING btree ("household_id","user_id");--> statement-breakpoint
CREATE INDEX "household_members_user_idx" ON "household_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "inventory_events_household_time_idx" ON "inventory_events" USING btree ("household_id","occurred_at");--> statement-breakpoint
CREATE INDEX "inventory_events_item_idx" ON "inventory_events" USING btree ("inventory_item_id","occurred_at");--> statement-breakpoint
CREATE INDEX "inventory_household_status_idx" ON "inventory_items" USING btree ("household_id","status");--> statement-breakpoint
CREATE INDEX "inventory_household_product_idx" ON "inventory_items" USING btree ("household_id","product_id");--> statement-breakpoint
CREATE INDEX "inventory_household_expiry_idx" ON "inventory_items" USING btree ("household_id","estimated_expiry") WHERE "inventory_items"."status" = 'active';--> statement-breakpoint
CREATE INDEX "inventory_name_trgm" ON "inventory_items" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "meal_ingredients_meal_idx" ON "meal_ingredients" USING btree ("meal_id","position");--> statement-breakpoint
CREATE INDEX "meal_ingredients_product_idx" ON "meal_ingredients" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meal_plan_items_slot_unique" ON "meal_plan_items" USING btree ("meal_plan_id","date","slot");--> statement-breakpoint
CREATE INDEX "meal_plan_items_household_date_idx" ON "meal_plan_items" USING btree ("household_id","date");--> statement-breakpoint
CREATE INDEX "meal_plans_household_idx" ON "meal_plans" USING btree ("household_id","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "meal_preferences_unique" ON "meal_preferences" USING btree ("household_id","meal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meals_global_slug_unique" ON "meals" USING btree ("slug") WHERE "meals"."household_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "meals_household_slug_unique" ON "meals" USING btree ("household_id","slug") WHERE "meals"."household_id" is not null;--> statement-breakpoint
CREATE INDEX "meals_name_trgm" ON "meals" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_unique" ON "notifications" USING btree ("user_id","household_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","household_id","created_at");--> statement-breakpoint
CREATE INDEX "password_reset_user_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "predictions_product_unique" ON "predictions" USING btree ("household_id","product_id") WHERE "predictions"."product_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "predictions_item_unique" ON "predictions" USING btree ("household_id","inventory_item_id") WHERE "predictions"."product_id" is null;--> statement-breakpoint
CREATE INDEX "predictions_household_days_idx" ON "predictions" USING btree ("household_id","days_remaining");--> statement-breakpoint
CREATE UNIQUE INDEX "product_aliases_unique" ON "product_aliases" USING btree ("household_id","alias_key");--> statement-breakpoint
CREATE UNIQUE INDEX "products_global_slug_unique" ON "products" USING btree ("slug") WHERE "products"."household_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "products_household_slug_unique" ON "products" USING btree ("household_id","slug") WHERE "products"."household_id" is not null;--> statement-breakpoint
CREATE INDEX "products_name_trgm" ON "products" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "receipt_items_receipt_idx" ON "receipt_items" USING btree ("receipt_id","line_index");--> statement-breakpoint
CREATE INDEX "receipt_items_household_product_idx" ON "receipt_items" USING btree ("household_id","product_id");--> statement-breakpoint
CREATE INDEX "receipts_household_created_idx" ON "receipts" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE INDEX "receipts_household_purchased_idx" ON "receipts" USING btree ("household_id","purchased_at");--> statement-breakpoint
CREATE INDEX "receipts_image_hash_idx" ON "receipts" USING btree ("household_id","image_hash");--> statement-breakpoint
CREATE INDEX "receipts_fingerprint_idx" ON "receipts" USING btree ("household_id","content_fingerprint");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "shopping_item_sources_item_idx" ON "shopping_list_item_sources" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopping_items_key_unique" ON "shopping_list_items" USING btree ("list_id","item_key");--> statement-breakpoint
CREATE INDEX "shopping_items_household_idx" ON "shopping_list_items" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "shopping_items_name_trgm" ON "shopping_list_items" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "shopping_lists_one_active" ON "shopping_lists" USING btree ("household_id") WHERE "shopping_lists"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email")) WHERE "users"."deleted_at" is null;