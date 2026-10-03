-- ════════════════════════════════════════════════════════════════════════════
-- Row-level security, round two: people, privacy and billing
--
-- What this adds on top of 0002:
--   * Roles. `child` is a restricted member: it can see what the household
--     shares and make requests, but can't see receipts or money, change
--     settings, or touch other people's items. Owners manage membership.
--   * Ownership and privacy. An item (or list line, or learned pattern) that
--     is `private` is visible only to the member who owns it — not to other
--     members, and not to an owner either.
--   * Each person's own food rules are readable only by that person (or an
--     owner, for a profile with no account). Meal suggestions use the
--     combined rules through `app.household_food_rules`, which never says
--     who needs what.
--   * Billing, usage and analytics tables are written only by trusted system
--     code; members can read their household's subscription.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Helper functions ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app.my_member_id(hid uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT m.id FROM public.household_members m
  WHERE m.household_id = hid AND m.user_id = app.current_user_id()
  LIMIT 1
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.is_restricted(hid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.household_members m
    WHERE m.household_id = hid AND m.user_id = app.current_user_id() AND m.role::text = 'child'
  )
$$;
--> statement-breakpoint

-- Household-wide rows are visible to every member; private rows only to their owner.
CREATE OR REPLACE FUNCTION app.can_see_owned(hid uuid, owner uuid, vis text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT vis <> 'private' OR (owner IS NOT NULL AND owner = app.my_member_id(hid))
$$;
--> statement-breakpoint

-- Learned patterns: `household`, `member:<id>` and `private:<id>`; only the last is hidden.
CREATE OR REPLACE FUNCTION app.can_see_scope(hid uuid, scope text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT scope NOT LIKE 'private:%'
      OR scope = 'private:' || coalesce(app.my_member_id(hid)::text, '-')
$$;
--> statement-breakpoint

-- A member reference must point at someone in the same household.
CREATE OR REPLACE FUNCTION app.member_in_household(mid uuid, hid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT mid IS NULL OR EXISTS (
    SELECT 1 FROM public.household_members m WHERE m.id = mid AND m.household_id = hid
  )
$$;
--> statement-breakpoint

-- You may write an owned row when it's yours or the household's, a child only for themselves,
-- and nobody can file something as private under someone else's name.
CREATE OR REPLACE FUNCTION app.can_write_owned(hid uuid, owner uuid, vis text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT app.is_member(hid)
     AND app.member_in_household(owner, hid)
     AND (vis <> 'private' OR (owner IS NOT NULL AND owner = app.my_member_id(hid)))
     AND (NOT app.is_restricted(hid) OR (owner IS NOT NULL AND owner = app.my_member_id(hid)))
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.can_manage_member_rules(mid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.household_members m
    WHERE m.id = mid
      AND (
        m.user_id = app.current_user_id()
        OR ((m.user_id IS NULL OR m.role::text = 'child') AND app.is_owner(m.household_id))
      )
  )
$$;
--> statement-breakpoint

-- The household's food rules combined across everyone, with no attribution.
CREATE OR REPLACE FUNCTION app.household_food_rules(hid uuid)
RETURNS TABLE (diets text[], allergies text[], disliked text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT
    coalesce((SELECT array_agg(DISTINCT x) FROM public.member_food_rules r, unnest(r.diets) x WHERE r.household_id = hid), '{}'::text[]),
    coalesce((SELECT array_agg(DISTINCT x) FROM public.member_food_rules r, unnest(r.allergies) x WHERE r.household_id = hid), '{}'::text[]),
    coalesce((SELECT array_agg(DISTINCT x) FROM public.member_food_rules r, unnest(r.disliked_ingredients) x WHERE r.household_id = hid), '{}'::text[])
  WHERE app.is_member(hid)
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
  app.my_member_id(uuid), app.is_restricted(uuid), app.can_see_owned(uuid, uuid, text), app.can_see_scope(uuid, text),
  app.member_in_household(uuid, uuid), app.can_write_owned(uuid, uuid, text), app.can_manage_member_rules(uuid),
  app.household_food_rules(uuid)
FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  app.my_member_id(uuid), app.is_restricted(uuid), app.can_see_owned(uuid, uuid, text), app.can_see_scope(uuid, text),
  app.member_in_household(uuid, uuid), app.can_write_owned(uuid, uuid, text), app.can_manage_member_rules(uuid),
  app.household_food_rules(uuid)
TO plenty_app;
--> statement-breakpoint

-- ─── Enable RLS on the new tables ───────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'member_food_rules', 'recurring_items', 'subscriptions', 'billing_events',
    'usage_counters', 'analytics_events', 'product_barcodes'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ─── Membership ─────────────────────────────────────────────────────────────

-- Only an owner can change who is in the household or what role they have; a member may
-- rename themselves. (The trigger below stops a self-update from touching roles or accounts.)
CREATE POLICY members_update_self ON public.household_members FOR UPDATE TO plenty_app
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.guard_member_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.household_id IS DISTINCT FROM OLD.household_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'A membership cannot move between households or accounts' USING ERRCODE = '42501';
  END IF;
  IF current_user = 'plenty_app' AND NEW.role IS DISTINCT FROM OLD.role AND NOT app.is_owner(OLD.household_id) THEN
    RAISE EXCEPTION 'Only an owner can change roles' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE TRIGGER household_members_guard BEFORE UPDATE ON public.household_members
  FOR EACH ROW EXECUTE FUNCTION app.guard_member_update();
--> statement-breakpoint

DROP POLICY households_update ON public.households;
--> statement-breakpoint
CREATE POLICY households_update ON public.households FOR UPDATE TO plenty_app
  USING (app.is_member(id) AND NOT app.is_restricted(id))
  WITH CHECK (app.is_member(id) AND NOT app.is_restricted(id));
--> statement-breakpoint

-- Invite codes are credentials: only owners can see or manage them.
DROP POLICY household_invitations_members ON public.household_invitations;
--> statement-breakpoint
CREATE POLICY household_invitations_owner ON public.household_invitations FOR ALL TO plenty_app
  USING (app.is_owner(household_id)) WITH CHECK (app.is_owner(household_id));
--> statement-breakpoint

-- ─── Each person's own food rules ───────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_food_rules TO plenty_app;
--> statement-breakpoint
CREATE POLICY member_food_rules_own ON public.member_food_rules FOR ALL TO plenty_app
  USING (app.can_manage_member_rules(member_id))
  WITH CHECK (app.can_manage_member_rules(member_id) AND app.member_in_household(member_id, household_id));
--> statement-breakpoint

-- ─── Household settings: restricted members can't change them ───────────────

DROP POLICY preferences_members ON public.preferences;
--> statement-breakpoint
CREATE POLICY preferences_select ON public.preferences FOR SELECT TO plenty_app USING (app.is_member(household_id));
--> statement-breakpoint
CREATE POLICY preferences_write ON public.preferences FOR ALL TO plenty_app
  USING (app.is_member(household_id) AND NOT app.is_restricted(household_id))
  WITH CHECK (app.is_member(household_id) AND NOT app.is_restricted(household_id));
--> statement-breakpoint

-- Receipts carry prices and store details: not for restricted members.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['receipts', 'receipt_items', 'product_aliases'] LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', t || '_members', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO plenty_app USING (app.is_member(household_id) AND NOT app.is_restricted(household_id)) WITH CHECK (app.is_member(household_id) AND NOT app.is_restricted(household_id))',
      t || '_adults', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ─── Inventory: ownership and privacy ───────────────────────────────────────

DROP POLICY inventory_items_members ON public.inventory_items;
--> statement-breakpoint
CREATE POLICY inventory_items_select ON public.inventory_items FOR SELECT TO plenty_app
  USING (app.is_member(household_id) AND app.can_see_owned(household_id, owner_member_id, visibility::text));
--> statement-breakpoint
CREATE POLICY inventory_items_insert ON public.inventory_items FOR INSERT TO plenty_app
  WITH CHECK (app.can_write_owned(household_id, owner_member_id, visibility::text));
--> statement-breakpoint
CREATE POLICY inventory_items_update ON public.inventory_items FOR UPDATE TO plenty_app
  USING (app.is_member(household_id) AND app.can_see_owned(household_id, owner_member_id, visibility::text)
         AND (NOT app.is_restricted(household_id) OR owner_member_id = app.my_member_id(household_id)))
  WITH CHECK (app.can_write_owned(household_id, owner_member_id, visibility::text));
--> statement-breakpoint
CREATE POLICY inventory_items_delete ON public.inventory_items FOR DELETE TO plenty_app
  USING (app.is_member(household_id) AND app.can_see_owned(household_id, owner_member_id, visibility::text)
         AND (NOT app.is_restricted(household_id) OR owner_member_id = app.my_member_id(household_id)));
--> statement-breakpoint

-- An item's history is visible exactly when the item is (the subquery is itself subject to RLS).
DROP POLICY inventory_events_members ON public.inventory_events;
--> statement-breakpoint
CREATE POLICY inventory_events_select ON public.inventory_events FOR SELECT TO plenty_app
  USING (app.is_member(household_id)
         AND EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.id = inventory_events.inventory_item_id));
--> statement-breakpoint
CREATE POLICY inventory_events_insert ON public.inventory_events FOR INSERT TO plenty_app
  WITH CHECK (app.is_member(household_id)
              AND EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.id = inventory_events.inventory_item_id));
--> statement-breakpoint
CREATE POLICY inventory_events_modify ON public.inventory_events FOR UPDATE TO plenty_app
  USING (app.is_member(household_id) AND NOT app.is_restricted(household_id)
         AND EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.id = inventory_events.inventory_item_id))
  WITH CHECK (app.is_member(household_id));
--> statement-breakpoint
CREATE POLICY inventory_events_remove ON public.inventory_events FOR DELETE TO plenty_app
  USING (app.is_member(household_id) AND NOT app.is_restricted(household_id)
         AND EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.id = inventory_events.inventory_item_id));
--> statement-breakpoint

-- ─── Learned patterns follow their scope ────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['consumption_events', 'consumption_stats', 'predictions'] LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', t || '_members', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO plenty_app USING (app.is_member(household_id) AND app.can_see_scope(household_id, scope)) WITH CHECK (app.is_member(household_id) AND app.can_see_scope(household_id, scope) AND app.member_in_household(owner_member_id, household_id))',
      t || '_scoped', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ─── Shopping list: owner, requester and privacy ────────────────────────────

DROP POLICY shopping_list_items_members ON public.shopping_list_items;
--> statement-breakpoint
CREATE POLICY shopping_list_items_select ON public.shopping_list_items FOR SELECT TO plenty_app
  USING (app.is_member(household_id) AND app.can_see_owned(household_id, owner_member_id, visibility::text));
--> statement-breakpoint
-- A restricted member may add their own requests; everyone else may add anything they can see.
CREATE POLICY shopping_list_items_insert ON public.shopping_list_items FOR INSERT TO plenty_app
  WITH CHECK (
    app.is_member(household_id)
    AND app.member_in_household(owner_member_id, household_id)
    AND app.member_in_household(requested_by_member_id, household_id)
    AND (visibility::text <> 'private' OR owner_member_id = app.my_member_id(household_id))
    AND (NOT app.is_restricted(household_id) OR requested_by_member_id = app.my_member_id(household_id))
  );
--> statement-breakpoint
CREATE POLICY shopping_list_items_update ON public.shopping_list_items FOR UPDATE TO plenty_app
  USING (
    app.is_member(household_id) AND app.can_see_owned(household_id, owner_member_id, visibility::text)
    AND (NOT app.is_restricted(household_id) OR requested_by_member_id = app.my_member_id(household_id))
  )
  WITH CHECK (
    app.is_member(household_id)
    AND app.member_in_household(owner_member_id, household_id)
    AND app.member_in_household(requested_by_member_id, household_id)
    AND (visibility::text <> 'private' OR owner_member_id = app.my_member_id(household_id))
  );
--> statement-breakpoint
CREATE POLICY shopping_list_items_delete ON public.shopping_list_items FOR DELETE TO plenty_app
  USING (
    app.is_member(household_id) AND app.can_see_owned(household_id, owner_member_id, visibility::text)
    AND (NOT app.is_restricted(household_id) OR requested_by_member_id = app.my_member_id(household_id))
  );
--> statement-breakpoint

DROP POLICY shopping_list_item_sources_members ON public.shopping_list_item_sources;
--> statement-breakpoint
CREATE POLICY shopping_list_item_sources_visible ON public.shopping_list_item_sources FOR ALL TO plenty_app
  USING (app.is_member(household_id)
         AND EXISTS (SELECT 1 FROM public.shopping_list_items i WHERE i.id = shopping_list_item_sources.item_id))
  WITH CHECK (app.is_member(household_id)
         AND EXISTS (SELECT 1 FROM public.shopping_list_items i WHERE i.id = shopping_list_item_sources.item_id));
--> statement-breakpoint

-- The list itself: restricted members can read it but not rename or complete it.
DROP POLICY shopping_lists_members ON public.shopping_lists;
--> statement-breakpoint
CREATE POLICY shopping_lists_select ON public.shopping_lists FOR SELECT TO plenty_app USING (app.is_member(household_id));
--> statement-breakpoint
CREATE POLICY shopping_lists_insert ON public.shopping_lists FOR INSERT TO plenty_app WITH CHECK (app.is_member(household_id));
--> statement-breakpoint
CREATE POLICY shopping_lists_change ON public.shopping_lists FOR UPDATE TO plenty_app
  USING (app.is_member(household_id) AND NOT app.is_restricted(household_id))
  WITH CHECK (app.is_member(household_id) AND NOT app.is_restricted(household_id));
--> statement-breakpoint
CREATE POLICY shopping_lists_remove ON public.shopping_lists FOR DELETE TO plenty_app
  USING (app.is_member(household_id) AND NOT app.is_restricted(household_id));
--> statement-breakpoint

-- ─── Recurring purchases ────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.recurring_items TO plenty_app;
--> statement-breakpoint
CREATE POLICY recurring_items_select ON public.recurring_items FOR SELECT TO plenty_app
  USING (app.is_member(household_id) AND app.can_see_owned(household_id, owner_member_id, visibility::text));
--> statement-breakpoint
CREATE POLICY recurring_items_write ON public.recurring_items FOR ALL TO plenty_app
  USING (app.is_member(household_id) AND NOT app.is_restricted(household_id)
         AND app.can_see_owned(household_id, owner_member_id, visibility::text))
  WITH CHECK (app.can_write_owned(household_id, owner_member_id, visibility::text) AND NOT app.is_restricted(household_id));
--> statement-breakpoint

-- ─── Billing, usage, analytics ──────────────────────────────────────────────
-- Members can read their household's subscription and usage; only trusted system
-- code (webhooks, the billing service) writes either. Billing events and analytics
-- have no policy for the app role at all.

GRANT SELECT ON public.subscriptions, public.usage_counters TO plenty_app;
--> statement-breakpoint
CREATE POLICY subscriptions_read ON public.subscriptions FOR SELECT TO plenty_app
  USING (app.is_member(household_id) AND NOT app.is_restricted(household_id));
--> statement-breakpoint
CREATE POLICY usage_counters_read ON public.usage_counters FOR SELECT TO plenty_app
  USING (app.is_member(household_id));
--> statement-breakpoint

-- ─── Barcodes ───────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_barcodes TO plenty_app;
--> statement-breakpoint
CREATE POLICY product_barcodes_select ON public.product_barcodes FOR SELECT TO plenty_app
  USING (household_id IS NULL OR app.is_member(household_id));
--> statement-breakpoint
CREATE POLICY product_barcodes_write ON public.product_barcodes FOR ALL TO plenty_app
  USING (household_id IS NOT NULL AND app.is_member(household_id) AND NOT app.is_restricted(household_id))
  WITH CHECK (household_id IS NOT NULL AND app.is_member(household_id) AND NOT app.is_restricted(household_id));
--> statement-breakpoint

-- ─── Data fix-ups for existing households ───────────────────────────────────

-- Nobody has agreed to AI processing of their photos yet: ask, don't assume.
UPDATE public.preferences SET allow_ai_processing = false WHERE ai_consent_at IS NULL;
--> statement-breakpoint

-- Receipt photos from before retention existed: remove checked ones now; give the rest two weeks.
UPDATE public.receipts SET image_delete_after = now()
  WHERE image_path IS NOT NULL AND image_deleted_at IS NULL AND status IN ('confirmed', 'discarded');
--> statement-breakpoint
UPDATE public.receipts SET image_delete_after = now() + interval '14 days'
  WHERE image_path IS NOT NULL AND image_deleted_at IS NULL AND status NOT IN ('confirmed', 'discarded');
