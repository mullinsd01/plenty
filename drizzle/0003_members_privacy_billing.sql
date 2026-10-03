CREATE TYPE "public"."billing_provider" AS ENUM('web', 'apple', 'google', 'manual');--> statement-breakpoint
CREATE TYPE "public"."item_visibility" AS ENUM('household', 'private');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'paused', 'canceled', 'expired', 'refunded');--> statement-breakpoint
ALTER TYPE "public"."household_role" ADD VALUE 'child';--> statement-breakpoint
ALTER TYPE "public"."inventory_source" ADD VALUE 'barcode';--> statement-breakpoint
ALTER TYPE "public"."inventory_source" ADD VALUE 'photo';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'request';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'billing';--> statement-breakpoint
ALTER TYPE "public"."shopping_source" ADD VALUE 'request';--> statement-breakpoint
ALTER TYPE "public"."shopping_source" ADD VALUE 'recurring';--> statement-breakpoint
ALTER TYPE "public"."storage_location" ADD VALUE 'cupboard' BEFORE 'produce';--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"subject" text NOT NULL,
	"plan" text,
	"platform" text,
	"props" text
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "billing_provider" NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"household_id" uuid,
	"summary" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "member_food_rules" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"diets" text[] DEFAULT '{}'::text[] NOT NULL,
	"allergies" text[] DEFAULT '{}'::text[] NOT NULL,
	"disliked_ingredients" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_barcodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barcode" text NOT NULL,
	"household_id" uuid,
	"product_id" uuid,
	"name" text NOT NULL,
	"brand" text,
	"size_text" text,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_barcodes_digits" CHECK ("product_barcodes"."barcode" ~ '^[0-9]{8,14}$')
);
--> statement-breakpoint
CREATE TABLE "recurring_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"product_id" uuid,
	"name" text NOT NULL,
	"aisle" "aisle" DEFAULT 'other' NOT NULL,
	"quantity" double precision,
	"unit" "unit",
	"owner_member_id" uuid,
	"visibility" "item_visibility" DEFAULT 'household' NOT NULL,
	"interval_days" smallint NOT NULL,
	"next_due_on" date NOT NULL,
	"last_added_at" timestamp with time zone,
	"note" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_interval_range" CHECK ("recurring_items"."interval_days" between 1 and 365),
	CONSTRAINT "recurring_quantity_positive" CHECK ("recurring_items"."quantity" is null or "recurring_items"."quantity" > 0),
	CONSTRAINT "recurring_private_has_owner" CHECK ("recurring_items"."visibility" = 'household' or "recurring_items"."owner_member_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"period" text,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"provider" "billing_provider" DEFAULT 'manual' NOT NULL,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"provider_product_id" text,
	"purchaser_user_id" uuid,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"pending_plan" text,
	"pending_period" text,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_plan" CHECK ("subscriptions"."plan" in ('free', 'plus', 'family', 'pro')),
	CONSTRAINT "subscriptions_period" CHECK ("subscriptions"."period" is null or "subscriptions"."period" in ('monthly', 'annual'))
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"household_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"period" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_household_id_metric_period_pk" PRIMARY KEY("household_id","metric","period"),
	CONSTRAINT "usage_count_nonneg" CHECK ("usage_counters"."count" >= 0)
);
--> statement-breakpoint
DROP INDEX "consumption_stats_unique";--> statement-breakpoint
DROP INDEX "predictions_product_unique";--> statement-breakpoint
ALTER TABLE "household_members" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "preferences" ALTER COLUMN "allow_ai_processing" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "consumption_events" ADD COLUMN "scope" text DEFAULT 'household' NOT NULL;--> statement-breakpoint
ALTER TABLE "consumption_events" ADD COLUMN "owner_member_id" uuid;--> statement-breakpoint
ALTER TABLE "consumption_stats" ADD COLUMN "scope" text DEFAULT 'household' NOT NULL;--> statement-breakpoint
ALTER TABLE "consumption_stats" ADD COLUMN "owner_member_id" uuid;--> statement-breakpoint
ALTER TABLE "household_members" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "household_members" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "household_members" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "owner_member_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "visibility" "item_visibility" DEFAULT 'household' NOT NULL;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "scope" text DEFAULT 'household' NOT NULL;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "owner_member_id" uuid;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "ai_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "ai_consent_by" uuid;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "receipt_image_retention" text DEFAULT 'after_review' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "analytics_opt_out" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "image_delete_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "image_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD COLUMN "owner_member_id" uuid;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD COLUMN "requested_by_member_id" uuid;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD COLUMN "visibility" "item_visibility" DEFAULT 'household' NOT NULL;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD COLUMN "recurring_item_id" uuid;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_food_rules" ADD CONSTRAINT "member_food_rules_member_id_household_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."household_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_food_rules" ADD CONSTRAINT "member_food_rules_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_owner_member_id_household_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."household_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_purchaser_user_id_users_id_fk" FOREIGN KEY ("purchaser_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_event_time_idx" ON "analytics_events" USING btree ("event","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_subject_idx" ON "analytics_events" USING btree ("subject");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_unique" ON "billing_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "billing_events_household_idx" ON "billing_events" USING btree ("household_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_barcodes_global_unique" ON "product_barcodes" USING btree ("barcode") WHERE "product_barcodes"."household_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_barcodes_household_unique" ON "product_barcodes" USING btree ("household_id","barcode") WHERE "product_barcodes"."household_id" is not null;--> statement-breakpoint
CREATE INDEX "recurring_household_due_idx" ON "recurring_items" USING btree ("household_id","next_due_on") WHERE "recurring_items"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_household_unique" ON "subscriptions" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_sub_unique" ON "subscriptions" USING btree ("provider","provider_subscription_id") WHERE "subscriptions"."provider_subscription_id" is not null;--> statement-breakpoint
CREATE INDEX "subscriptions_customer_idx" ON "subscriptions" USING btree ("provider","provider_customer_id");--> statement-breakpoint
ALTER TABLE "consumption_events" ADD CONSTRAINT "consumption_events_owner_member_id_household_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."household_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumption_stats" ADD CONSTRAINT "consumption_stats_owner_member_id_household_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."household_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_owner_member_id_household_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."household_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_owner_member_id_household_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."household_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_ai_consent_by_users_id_fk" FOREIGN KEY ("ai_consent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD CONSTRAINT "shopping_list_items_owner_member_id_household_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."household_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD CONSTRAINT "shopping_list_items_requested_by_member_id_household_members_id_fk" FOREIGN KEY ("requested_by_member_id") REFERENCES "public"."household_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consumption_scope_idx" ON "consumption_events" USING btree ("household_id","scope");--> statement-breakpoint
CREATE INDEX "inventory_owner_idx" ON "inventory_items" USING btree ("household_id","owner_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consumption_stats_unique" ON "consumption_stats" USING btree ("household_id","product_id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "predictions_product_unique" ON "predictions" USING btree ("household_id","product_id","scope") WHERE "predictions"."product_id" is not null;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_identity" CHECK ("household_members"."user_id" is not null or char_length(coalesce("household_members"."display_name", '')) between 1 and 40);--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_name_len" CHECK ("household_members"."display_name" is null or char_length("household_members"."display_name") between 1 and 40);--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_private_has_owner" CHECK ("inventory_items"."visibility" = 'household' or "inventory_items"."owner_member_id" is not null);--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_receipt_retention" CHECK ("preferences"."receipt_image_retention" in ('after_review', 'days_30', 'keep'));--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD CONSTRAINT "shopping_items_note_len" CHECK ("shopping_list_items"."note" is null or char_length("shopping_list_items"."note") <= 300);--> statement-breakpoint
ALTER TABLE "shopping_list_items" ADD CONSTRAINT "shopping_items_private_has_owner" CHECK ("shopping_list_items"."visibility" = 'household' or "shopping_list_items"."owner_member_id" is not null);