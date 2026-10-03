/**
 * Household roles and what each may do.
 *
 * - owner: runs the household — members, invitations, plan, deletion.
 * - member: everyday use — inventory, lists, meals, receipts.
 * - child: restricted — sees what the household shares and can make requests,
 *   but doesn't see receipts, prices or settings and can't change other
 *   people's items.
 *
 * The database enforces the sensitive rules too (row-level security); this
 * module is what the app uses to decide what to show and to refuse early
 * with a clear message.
 */

export const ROLES = ["owner", "member", "child"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  member: "Member",
  child: "Child",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "Manages the household, its members and its plan.",
  member: "Uses everything day to day: kitchen, shopping list, meals and receipts.",
  child: "Sees what the household shares and can ask for things. Can't see receipts or prices, or change settings.",
};

export const CAPABILITIES = [
  "view_household_items",
  "edit_household_items",
  "edit_own_items",
  "make_requests",
  "edit_shopping_list",
  "complete_shop",
  "scan_receipts",
  "view_receipts_and_prices",
  "plan_meals",
  "change_settings",
  "manage_members",
  "manage_invitations",
  "manage_billing",
  "export_data",
  "delete_household",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const CHILD: ReadonlySet<Capability> = new Set(["view_household_items", "edit_own_items", "make_requests"]);

const MEMBER: ReadonlySet<Capability> = new Set([
  "view_household_items",
  "edit_household_items",
  "edit_own_items",
  "make_requests",
  "edit_shopping_list",
  "complete_shop",
  "scan_receipts",
  "view_receipts_and_prices",
  "plan_meals",
  "change_settings",
  "export_data",
]);

const OWNER: ReadonlySet<Capability> = new Set([...MEMBER, "manage_members", "manage_invitations", "manage_billing", "delete_household"]);

const BY_ROLE: Record<Role, ReadonlySet<Capability>> = { owner: OWNER, member: MEMBER, child: CHILD };

/** Whether a role may do something. */
export function can(role: Role, capability: Capability): boolean {
  return BY_ROLE[role].has(capability);
}

/** Whether a role is the restricted one. */
export function isRestricted(role: Role): boolean {
  return role === "child";
}

const CAPABILITY_REFUSALS: Partial<Record<Capability, string>> = {
  manage_members: "Only a household owner can add or remove people.",
  manage_invitations: "Only a household owner can invite people.",
  manage_billing: "Only a household owner can change the plan.",
  delete_household: "Only a household owner can delete the household.",
  view_receipts_and_prices: "Receipts and prices aren't available to this account.",
  scan_receipts: "Receipts aren't available to this account.",
  change_settings: "Settings can only be changed by an owner or a member.",
  edit_household_items: "This account can only change its own items. Ask an adult to change shared ones.",
  edit_shopping_list: "This account can add requests, but only an adult can change the shopping list.",
  complete_shop: "Only an adult can finish a shop.",
  plan_meals: "Meal planning isn't available to this account.",
};

/** A plain-language reason for refusing, suitable for showing to the person. */
export function refusalMessage(capability: Capability): string {
  return CAPABILITY_REFUSALS[capability] ?? "You don't have permission to do that.";
}
