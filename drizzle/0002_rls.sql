-- ════════════════════════════════════════════════════════════════════════════
-- Row-level security
--
-- The application runs every user-scoped transaction as the restricted role
-- `plenty_app` (SET LOCAL ROLE) with `app.user_id` set to the signed-in user.
-- Policies below guarantee a user can only ever touch rows belonging to a
-- household they are a member of — even if application code forgets a WHERE
-- clause. Trusted system operations (auth, invitations, scheduled jobs) run
-- as the table owner, which bypasses RLS (tables are not FORCEd).
-- ════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plenty_app') THEN
    CREATE ROLE plenty_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT plenty_app TO CURRENT_USER;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO plenty_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO plenty_app;
--> statement-breakpoint

-- ─── Helper functions ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.is_member(hid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.household_members m
    JOIN public.households h ON h.id = m.household_id
    WHERE m.household_id = hid
      AND m.user_id = app.current_user_id()
      AND h.deleted_at IS NULL
  )
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.is_owner(hid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.household_members m
    WHERE m.household_id = hid AND m.user_id = app.current_user_id() AND m.role = 'owner'
  )
$$;
--> statement-breakpoint

-- A user may add themselves as the first (owner) member of a household they just created.
CREATE OR REPLACE FUNCTION app.can_bootstrap_household(hid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.households h
    WHERE h.id = hid AND h.created_by = app.current_user_id() AND h.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.household_members m WHERE m.household_id = hid)
  )
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.shares_household(other_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.household_members mine
    JOIN public.household_members theirs ON theirs.household_id = mine.household_id
    WHERE mine.user_id = app.current_user_id() AND theirs.user_id = other_user
  )
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.is_member(uuid), app.is_owner(uuid), app.can_bootstrap_household(uuid), app.shares_household(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_user_id(), app.is_member(uuid), app.is_owner(uuid), app.can_bootstrap_household(uuid), app.shares_household(uuid) TO plenty_app;
--> statement-breakpoint

-- ─── Enable RLS everywhere ──────────────────────────────────────────────────
-- Tables without a policy for plenty_app (sessions, reset tokens, rate limits,
-- email outbox) are therefore completely inaccessible to the app role.

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\_\_%' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ─── Identity ───────────────────────────────────────────────────────────────

GRANT SELECT ON public.users TO plenty_app;
--> statement-breakpoint
CREATE POLICY users_self_or_housemates ON public.users FOR SELECT TO plenty_app
  USING (id = app.current_user_id() OR app.shares_household(id));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.profiles TO plenty_app;
--> statement-breakpoint
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO plenty_app
  USING (user_id = app.current_user_id() OR app.shares_household(user_id));
--> statement-breakpoint
CREATE POLICY profiles_insert ON public.profiles FOR INSERT TO plenty_app
  WITH CHECK (user_id = app.current_user_id());
--> statement-breakpoint
CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO plenty_app
  USING (user_id = app.current_user_id())
  WITH CHECK (
    user_id = app.current_user_id()
    AND (active_household_id IS NULL OR app.is_member(active_household_id))
  );
--> statement-breakpoint

-- ─── Households & membership ────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.households TO plenty_app;
--> statement-breakpoint
CREATE POLICY households_select ON public.households FOR SELECT TO plenty_app
  USING (app.is_member(id) OR (created_by = app.current_user_id() AND deleted_at IS NULL));
--> statement-breakpoint
CREATE POLICY households_insert ON public.households FOR INSERT TO plenty_app
  WITH CHECK (created_by = app.current_user_id());
--> statement-breakpoint
CREATE POLICY households_update ON public.households FOR UPDATE TO plenty_app
  USING (app.is_member(id)) WITH CHECK (app.is_member(id));
--> statement-breakpoint
CREATE POLICY households_delete ON public.households FOR DELETE TO plenty_app
  USING (app.is_owner(id));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.household_members TO plenty_app;
--> statement-breakpoint
CREATE POLICY members_select ON public.household_members FOR SELECT TO plenty_app
  USING (app.is_member(household_id));
--> statement-breakpoint
CREATE POLICY members_insert ON public.household_members FOR INSERT TO plenty_app
  WITH CHECK (
    app.is_owner(household_id)
    OR (user_id = app.current_user_id() AND role = 'owner' AND app.can_bootstrap_household(household_id))
  );
--> statement-breakpoint
CREATE POLICY members_update ON public.household_members FOR UPDATE TO plenty_app
  USING (app.is_owner(household_id)) WITH CHECK (app.is_owner(household_id));
--> statement-breakpoint
CREATE POLICY members_delete ON public.household_members FOR DELETE TO plenty_app
  USING (app.is_owner(household_id) OR user_id = app.current_user_id());
--> statement-breakpoint

-- Per-user notification settings: only your own row, only for your households.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_settings TO plenty_app;
--> statement-breakpoint
CREATE POLICY notification_settings_own ON public.notification_settings FOR ALL TO plenty_app
  USING (user_id = app.current_user_id() AND app.is_member(household_id))
  WITH CHECK (user_id = app.current_user_id() AND app.is_member(household_id));
--> statement-breakpoint

-- Notifications: members see only their own.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO plenty_app;
--> statement-breakpoint
CREATE POLICY notifications_own ON public.notifications FOR ALL TO plenty_app
  USING (user_id = app.current_user_id() AND app.is_member(household_id))
  WITH CHECK (app.is_member(household_id));
--> statement-breakpoint

-- ─── Shared catalogue tables: global rows readable, household rows private ──

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['products', 'meals', 'meal_ingredients'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO plenty_app', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO plenty_app USING (household_id IS NULL OR app.is_member(household_id))',
      t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO plenty_app WITH CHECK (household_id IS NOT NULL AND app.is_member(household_id))',
      t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO plenty_app USING (household_id IS NOT NULL AND app.is_member(household_id)) WITH CHECK (household_id IS NOT NULL AND app.is_member(household_id))',
      t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO plenty_app USING (household_id IS NOT NULL AND app.is_member(household_id))',
      t || '_delete', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ─── Household-owned tables: members only ───────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'household_invitations',
    'preferences',
    'product_aliases',
    'receipts',
    'receipt_items',
    'inventory_items',
    'inventory_events',
    'consumption_events',
    'consumption_stats',
    'predictions',
    'meal_preferences',
    'meal_plans',
    'meal_plan_items',
    'shopping_lists',
    'shopping_list_items',
    'shopping_list_item_sources'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO plenty_app', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO plenty_app USING (app.is_member(household_id)) WITH CHECK (app.is_member(household_id))',
      t || '_members', t);
  END LOOP;
END
$$;
