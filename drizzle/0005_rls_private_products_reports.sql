CREATE TABLE "content_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"reporter_user_id" uuid,
	"meal_id" uuid,
	"meal_name" text NOT NULL,
	"meal_snapshot" text DEFAULT '' NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_reports_reason_check" CHECK ("content_reports"."reason" in ('unsafe', 'inaccurate', 'offensive', 'other')),
	CONSTRAINT "content_reports_note_length" CHECK ("content_reports"."note" is null or char_length("content_reports"."note") <= 1000)
);
--> statement-breakpoint
DROP INDEX "products_household_slug_unique";--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "analytics_opt_out" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "owner_member_id" uuid;--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_meal_id_meals_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_reports_household_idx" ON "content_reports" USING btree ("household_id","created_at");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_owner_member_id_household_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."household_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "products_household_slug_unique" ON "products" USING btree ("household_id","slug",coalesce("owner_member_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "products"."household_id" is not null;--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════════
-- Row-level security, round three
--   * A product created for one person's private item is that person's alone, so a private item's name can't
--     reach anyone else through search, suggestions or receipt matching.
--   * Reports about AI-written recipes: you can file one and read your own; nobody else can.
--   * Secrets the app role never needs to read: password hashes, and the billing provider's identifiers.
-- ════════════════════════════════════════════════════════════════════════════

DROP POLICY products_select ON public.products;
--> statement-breakpoint
DROP POLICY products_insert ON public.products;
--> statement-breakpoint
DROP POLICY products_update ON public.products;
--> statement-breakpoint
DROP POLICY products_delete ON public.products;
--> statement-breakpoint
CREATE POLICY products_select ON public.products FOR SELECT TO plenty_app
  USING (
    household_id IS NULL
    OR (app.is_member(household_id) AND (owner_member_id IS NULL OR owner_member_id = app.my_member_id(household_id)))
  );
--> statement-breakpoint
CREATE POLICY products_insert ON public.products FOR INSERT TO plenty_app
  WITH CHECK (
    household_id IS NOT NULL AND app.is_member(household_id)
    AND (owner_member_id IS NULL OR owner_member_id = app.my_member_id(household_id))
  );
--> statement-breakpoint
CREATE POLICY products_update ON public.products FOR UPDATE TO plenty_app
  USING (
    household_id IS NOT NULL AND app.is_member(household_id)
    AND (owner_member_id IS NULL OR owner_member_id = app.my_member_id(household_id))
  )
  WITH CHECK (
    household_id IS NOT NULL AND app.is_member(household_id)
    AND (owner_member_id IS NULL OR owner_member_id = app.my_member_id(household_id))
  );
--> statement-breakpoint
CREATE POLICY products_delete ON public.products FOR DELETE TO plenty_app
  USING (
    household_id IS NOT NULL AND app.is_member(household_id)
    AND (owner_member_id IS NULL OR owner_member_id = app.my_member_id(household_id))
  );
--> statement-breakpoint

-- ─── Content reports ────────────────────────────────────────────────────────

ALTER TABLE public.content_reports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.content_reports TO plenty_app;
--> statement-breakpoint
CREATE POLICY content_reports_select ON public.content_reports FOR SELECT TO plenty_app
  USING (reporter_user_id = app.current_user_id());
--> statement-breakpoint
CREATE POLICY content_reports_insert ON public.content_reports FOR INSERT TO plenty_app
  WITH CHECK (
    reporter_user_id = app.current_user_id()
    AND app.is_member(household_id)
    AND NOT app.is_restricted(household_id)
  );
--> statement-breakpoint

-- ─── Columns the app role never reads ───────────────────────────────────────

REVOKE SELECT ON public.users FROM plenty_app;
--> statement-breakpoint
GRANT SELECT (id, email, email_verified_at, is_demo, created_at, updated_at, deleted_at) ON public.users TO plenty_app;
--> statement-breakpoint
REVOKE SELECT ON public.subscriptions FROM plenty_app;
--> statement-breakpoint
GRANT SELECT (
  id, household_id, plan, period, status, provider, purchaser_user_id, auto_renew, current_period_start, current_period_end,
  trial_ends_at, grace_ends_at, canceled_at, ended_at, pending_plan, pending_period, last_event_at, created_at, updated_at
) ON public.subscriptions TO plenty_app;

--> statement-breakpoint

-- ─── Counting a household's kitchen under a lock ────────────────────────────
-- The kitchen's size limit has to count everyone's items, private ones included, inside the same
-- transaction that adds the new ones. The app role can't see other people's private items, so it
-- asks this function, which only answers for a household the caller belongs to and returns a number.

CREATE OR REPLACE FUNCTION app.household_item_count(hid uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN app.is_member(hid)
    THEN (SELECT count(*)::int FROM public.inventory_items i
          WHERE i.household_id = hid AND i.status::text = 'active' AND i.deleted_at IS NULL)
    ELSE 0 END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.household_item_count(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.household_item_count(uuid) TO plenty_app;
