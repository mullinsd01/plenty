"use client";

import { useState } from "react";
import { Check, Copy, Download, Link2, LogOut, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChipGroup, Segmented, Stepper, Switch } from "@/components/ui/controls";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Field, Input, NativeSelect } from "@/components/ui/field";
import { useAction } from "@/components/hooks/use-action";
import { Avatar } from "@/components/layout/user-menu";
import {
  ALLERGENS,
  ALLERGEN_LABELS,
  COOKING_FREQUENCIES,
  COOKING_FREQUENCY_LABELS,
  CUISINES,
  CUISINE_LABELS,
  CURRENCIES,
  DIETS,
  DIET_LABELS,
  SUPERMARKETS,
  type Allergen,
  type CookingFrequency,
  type Cuisine,
  type Diet,
} from "@/lib/domain";
import { WEEKDAY_NAMES } from "@/lib/dates";
import {
  changeEmailAction,
  changePasswordAction,
  createInviteAction,
  deleteAccountAction,
  deleteHouseholdAction,
  leaveHouseholdAction,
  removeMemberAction,
  revokeInvitesAction,
  signOutEverywhereAction,
  updateHouseholdAction,
  updateNotificationSettingsAction,
  updatePreferencesAction,
  updateProfileAction,
} from "./actions";

export function SettingsCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-[16px] font-semibold tracking-[-0.01em]">{title}</h2>
      {description && <p className="mt-1 text-[14px] text-ink-3">{description}</p>}
      <div className="mt-5">{children}</div>
    </Card>
  );
}

// ─── Account ────────────────────────────────────────────────────────────────

export function ProfileForm({ name, isDemo }: { name: string; isDemo: boolean }) {
  const [value, setValue] = useState(name);
  const { pending, run } = useAction();
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => updateProfileAction(value));
      }}
    >
      <Input aria-label="Your name" value={value} onChange={(e) => setValue(e.target.value)} maxLength={60} disabled={isDemo} />
      <Button type="submit" variant="secondary" loading={pending} disabled={!value.trim() || value === name || isDemo}>
        Save
      </Button>
    </form>
  );
}

export function EmailForm({ email, isDemo }: { email: string; isDemo: boolean }) {
  const [value, setValue] = useState(email);
  const [password, setPassword] = useState("");
  const { pending, run } = useAction();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => changeEmailAction({ email: value, password }), { onSuccess: () => setPassword("") });
      }}
    >
      <Field label="Email" htmlFor="acc-email">
        <Input id="acc-email" type="email" value={value} onChange={(e) => setValue(e.target.value)} disabled={isDemo} />
      </Field>
      {value.trim().toLowerCase() !== email.toLowerCase() && (
        <Field label="Your password" htmlFor="acc-email-pw" hint="To confirm it's you.">
          <Input id="acc-email-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      )}
      <Button type="submit" variant="secondary" loading={pending} disabled={isDemo || value.trim().toLowerCase() === email.toLowerCase() || !password}>
        Change email
      </Button>
    </form>
  );
}

export function PasswordForm({ isDemo }: { isDemo: boolean }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const { pending, run } = useAction();
  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => changePasswordAction({ current, password, confirm }), {
          onSuccess: () => {
            setCurrent("");
            setPassword("");
            setConfirm("");
          },
        });
      }}
    >
      <Field label="Current password" htmlFor="pw-current">
        <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} disabled={isDemo} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="New password" htmlFor="pw-new" hint="At least 8 characters.">
          <Input id="pw-new" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={isDemo} />
        </Field>
        <Field label="Confirm" htmlFor="pw-confirm" error={mismatch ? "Doesn't match" : null}>
          <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={isDemo} />
        </Field>
      </div>
      <Button type="submit" variant="secondary" loading={pending} disabled={isDemo || !current || password.length < 8 || mismatch}>
        Change password
      </Button>
    </form>
  );
}

export function SignOutEverywhere() {
  const { pending, run } = useAction();
  return (
    <Button variant="secondary" loading={pending} onClick={() => run(() => signOutEverywhereAction())}>
      <LogOut /> Sign out on all devices
    </Button>
  );
}

export function DeleteAccount({ isDemo }: { isDemo: boolean }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const { pending, run } = useAction();
  return (
    <>
      <Button variant="danger-subtle" onClick={() => setOpen(true)} disabled={isDemo}>
        <Trash2 /> Delete my account
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete your account?"
        description="This permanently deletes your account. Households where you're the only member are deleted with everything in them. This can't be undone."
        confirmLabel="Delete everything"
        destructive
        loading={pending}
        onConfirm={() => run(() => deleteAccountAction(password))}
      >
        <div className="mt-4">
          <Field label="Your password" htmlFor="del-pw">
            <Input id="del-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
        </div>
      </ConfirmDialog>
    </>
  );
}

// ─── Household ──────────────────────────────────────────────────────────────

export function HouseholdForm({
  initial,
}: {
  initial: { name: string; adults: number; children: number; timezone: string; currency: string };
}) {
  const [name, setName] = useState(initial.name);
  const [adults, setAdults] = useState(initial.adults);
  const [children, setChildren] = useState(initial.children);
  const [currency, setCurrency] = useState(initial.currency);
  const [timezone, setTimezone] = useState(initial.timezone);
  const { pending, run } = useAction();
  const zones = (() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [initial.timezone];
    }
  })();
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => updateHouseholdAction({ name: name.trim(), adults, children, timezone, currency }));
      }}
    >
      <Field label="Household name" htmlFor="hh-name">
        <Input id="hh-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </Field>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[15px] font-medium">Adults</p>
          <p className="text-[13px] text-ink-3">13 and over</p>
        </div>
        <Stepper label="Adults" value={adults} onChange={setAdults} min={children > 0 ? 0 : 1} max={20} />
      </div>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[15px] font-medium">Children</p>
          <p className="text-[13px] text-ink-3">Plenty uses this to scale how fast things get used</p>
        </div>
        <Stepper label="Children" value={children} onChange={setChildren} min={adults > 0 ? 0 : 1} max={20} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Currency" htmlFor="hh-currency">
          <NativeSelect id="hh-currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Time zone" htmlFor="hh-tz">
          <NativeSelect id="hh-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Button type="submit" loading={pending} disabled={!name.trim()}>
        Save household
      </Button>
    </form>
  );
}

export function MembersList({
  members,
  canManage,
}: {
  members: Array<{ userId: string; displayName: string; email: string; role: string; isYou: boolean }>;
  canManage: boolean;
}) {
  const { pending, run } = useAction();
  return (
    <ul className="divide-y divide-line">
      {members.map((m) => (
        <li key={m.userId} className="flex items-center gap-3 py-3">
          <Avatar name={m.displayName} className="size-9" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-medium">
              {m.displayName} {m.isYou && <span className="text-ink-3">(you)</span>}
            </p>
            <p className="truncate text-[13px] text-ink-3">
              {m.email} · {m.role === "owner" ? "Owner" : "Member"}
            </p>
          </div>
          {canManage && !m.isYou && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => removeMemberAction(m.userId))}>
              Remove
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function InviteLink({ initial, appUrl, isDemo }: { initial: { code: string; expiresAt: string } | null; appUrl: string; isDemo: boolean }) {
  const [invite, setInvite] = useState(initial);
  const [copied, setCopied] = useState(false);
  const create = useAction();
  const revoke = useAction();
  const url = invite ? `${appUrl}/join/${invite.code}` : null;
  if (isDemo) return <p className="text-[14px] text-ink-3">Invites are turned off for the demo household.</p>;
  return (
    <div className="space-y-3">
      {url ? (
        <>
          <div className="flex gap-2">
            <Input readOnly value={url} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} className="font-mono text-[13px]" />
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                } catch {
                  toast.error("Couldn't copy — select the link and copy it manually.");
                }
              }}
            >
              {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-[13px] text-ink-3">
            Anyone with this link can join until {new Date(invite!.expiresAt).toLocaleDateString("en-AU", { day: "numeric", month: "long" })}.{" "}
            <button
              type="button"
              className="font-medium text-alert hover:underline"
              disabled={revoke.pending}
              onClick={() => revoke.run(() => revokeInvitesAction(), { onSuccess: () => setInvite(null) })}
            >
              Turn off link
            </button>
          </p>
        </>
      ) : (
        <Button
          variant="secondary"
          loading={create.pending}
          onClick={() =>
            create.run(() => createInviteAction(), {
              onSuccess: (data) => setInvite({ code: data.code, expiresAt: new Date(data.expiresAt).toISOString() }),
            })
          }
        >
          <Link2 /> Create invite link
        </Button>
      )}
    </div>
  );
}

export function DangerZone({ householdName, isOwner, memberCount, isDemo }: { householdName: string; isOwner: boolean; memberCount: number; isDemo: boolean }) {
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const leave = useAction();
  const del = useAction();
  return (
    <div className="flex flex-wrap gap-2">
      {memberCount > 1 && (
        <Button variant="secondary" onClick={() => setLeaveOpen(true)} disabled={isDemo}>
          Leave household
        </Button>
      )}
      {isOwner && (
        <Button variant="danger-subtle" onClick={() => setDeleteOpen(true)} disabled={isDemo}>
          <Trash2 /> Delete household
        </Button>
      )}
      <ConfirmDialog
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        title="Leave this household?"
        description="You'll lose access to its kitchen, list and meal plan. Someone can invite you back."
        confirmLabel="Leave"
        destructive
        loading={leave.pending}
        onConfirm={() => leave.run(() => leaveHouseholdAction())}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this household?"
        description="Everything in it — kitchen, receipts, what Plenty learned, meal plans and lists — is permanently deleted for every member."
        confirmLabel="Delete household"
        destructive
        loading={del.pending}
        onConfirm={() => del.run(() => deleteHouseholdAction(confirmName))}
      >
        <div className="mt-4">
          <Field label={`Type “${householdName}” to confirm`} htmlFor="del-hh">
            <Input id="del-hh" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
          </Field>
        </div>
      </ConfirmDialog>
    </div>
  );
}

// ─── Food ───────────────────────────────────────────────────────────────────

export function FoodPreferencesForm({
  initial,
}: {
  initial: {
    allergies: Allergen[];
    diets: Diet[];
    dislikedIngredients: string[];
    favouriteCuisines: Cuisine[];
    cookingFrequency: CookingFrequency | null;
    weeknightMaxMinutes: number | null;
  };
}) {
  const [allergies, setAllergies] = useState(initial.allergies);
  const [diets, setDiets] = useState(initial.diets);
  const [dislikes, setDislikes] = useState(initial.dislikedIngredients);
  const [draft, setDraft] = useState("");
  const [cuisines, setCuisines] = useState(initial.favouriteCuisines);
  const [frequency, setFrequency] = useState<CookingFrequency | "">(initial.cookingFrequency ?? "");
  const [weeknight, setWeeknight] = useState(initial.weeknightMaxMinutes ? String(initial.weeknightMaxMinutes) : "none");
  const { pending, run } = useAction();
  const addDislike = () => {
    const v = draft.trim().toLowerCase();
    if (v && !dislikes.includes(v)) setDislikes([...dislikes, v]);
    setDraft("");
  };
  return (
    <div className="space-y-6">
      <SettingsCard title="Allergies" description="Hard rules. Plenty never suggests meals containing these.">
        <ChipGroup ariaLabel="Allergies" value={allergies} onChange={setAllergies} options={ALLERGENS.map((a) => ({ value: a, label: ALLERGEN_LABELS[a] }))} />
      </SettingsCard>
      <SettingsCard title="Dietary requirements">
        <ChipGroup ariaLabel="Diets" value={diets} onChange={setDiets} options={DIETS.map((d) => ({ value: d, label: DIET_LABELS[d] }))} />
      </SettingsCard>
      <SettingsCard title="Foods you'd rather not see">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addDislike();
          }}
        >
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. mushrooms" aria-label="Add a food to avoid" maxLength={40} />
          <Button type="submit" variant="secondary" disabled={!draft.trim()}>
            Add
          </Button>
        </form>
        {dislikes.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {dislikes.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDislikes(dislikes.filter((x) => x !== d))}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-3 text-[13px] font-medium capitalize text-on-primary"
                aria-label={`Remove ${d}`}
              >
                {d} <span aria-hidden>×</span>
              </button>
            ))}
          </div>
        )}
      </SettingsCard>
      <SettingsCard title="Favourite cuisines">
        <ChipGroup
          ariaLabel="Favourite cuisines"
          value={cuisines}
          onChange={setCuisines}
          options={CUISINES.filter((c) => c !== "other").map((c) => ({ value: c, label: CUISINE_LABELS[c] }))}
        />
      </SettingsCard>
      <SettingsCard title="Cooking">
        <div className="space-y-5">
          <Field label="How often you cook at home" htmlFor="cook-freq">
            <NativeSelect id="cook-freq" value={frequency} onChange={(e) => setFrequency(e.target.value as CookingFrequency | "")}>
              <option value="">Not sure</option>
              {COOKING_FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {COOKING_FREQUENCY_LABELS[f]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div>
            <p className="mb-2 text-[13px] font-semibold text-ink-2">Weeknight dinners should take at most</p>
            <Segmented
              ariaLabel="Weeknight time limit"
              className="w-full"
              value={weeknight}
              onChange={setWeeknight}
              options={[
                { value: "20", label: "20 min" },
                { value: "30", label: "30 min" },
                { value: "45", label: "45 min" },
                { value: "60", label: "1 hour" },
                { value: "none", label: "No limit" },
              ]}
            />
          </div>
        </div>
      </SettingsCard>
      <div className="flex justify-end">
        <Button
          size="lg"
          loading={pending}
          onClick={() =>
            run(() =>
              updatePreferencesAction({
                allergies,
                diets,
                dislikedIngredients: dislikes,
                favouriteCuisines: cuisines,
                cookingFrequency: frequency || null,
                weeknightMaxMinutes: weeknight === "none" ? null : Number(weeknight),
              }),
            )
          }
        >
          Save food preferences
        </Button>
      </div>
    </div>
  );
}

// ─── Shopping ───────────────────────────────────────────────────────────────

export function ShoppingPreferencesForm({
  initial,
  currency,
  learnedLabel,
}: {
  initial: { preferredStores: string[]; weeklyBudget: number | null; usualShopDay: number | null; shopIntervalDays: number | null; takeawayPerWeek: number | null };
  currency: string;
  learnedLabel: string | null;
}) {
  const [stores, setStores] = useState(initial.preferredStores);
  const [budget, setBudget] = useState(initial.weeklyBudget ? String(initial.weeklyBudget) : "");
  const [day, setDay] = useState(initial.usualShopDay === null ? "auto" : String(initial.usualShopDay));
  const [interval, setInterval] = useState(initial.shopIntervalDays ? String(initial.shopIntervalDays) : "auto");
  const [takeaway, setTakeaway] = useState(initial.takeawayPerWeek ?? 0);
  const { pending, run } = useAction();
  const storeOptions = Array.from(new Set([...SUPERMARKETS, ...stores])).map((s) => ({ value: s, label: s }));
  return (
    <div className="space-y-6">
      <SettingsCard title="Where you shop">
        <ChipGroup ariaLabel="Supermarkets" value={stores} onChange={setStores} options={storeOptions} />
      </SettingsCard>
      <SettingsCard title="Budget" description="Plenty shows how your spending compares, and leans towards cheaper meals when budgets are tight.">
        <Field label={`Weekly grocery budget (${currency})`} htmlFor="budget" optional>
          <Input id="budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ""))} placeholder="No budget" />
        </Field>
      </SettingsCard>
      <SettingsCard title="Shopping rhythm" description={learnedLabel ? `Plenty has noticed: ${learnedLabel}. Leave these on automatic to keep learning.` : "Leave these on automatic and Plenty learns from your receipts."}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Usual shopping day" htmlFor="shop-day">
            <NativeSelect id="shop-day" value={day} onChange={(e) => setDay(e.target.value)}>
              <option value="auto">Learn it automatically</option>
              {WEEKDAY_NAMES.map((d, i) => (
                <option key={d} value={String(i)}>
                  {d}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="How often" htmlFor="shop-interval">
            <NativeSelect id="shop-interval" value={interval} onChange={(e) => setInterval(e.target.value)}>
              <option value="auto">Learn it automatically</option>
              <option value="3">Every few days</option>
              <option value="7">Weekly</option>
              <option value="14">Fortnightly</option>
            </NativeSelect>
          </Field>
        </div>
        <div className="mt-5 flex items-center justify-between">
          <div>
            <p className="text-[15px] font-medium">Takeaway nights</p>
            <p className="text-[13px] text-ink-3">In a typical week — Plenty plans fewer dinners</p>
          </div>
          <Stepper label="Takeaway nights" value={takeaway} onChange={setTakeaway} min={0} max={14} />
        </div>
      </SettingsCard>
      <div className="flex justify-end">
        <Button
          size="lg"
          loading={pending}
          onClick={() =>
            run(() =>
              updatePreferencesAction({
                preferredStores: stores,
                weeklyBudget: budget ? Number(budget) : null,
                usualShopDay: day === "auto" ? null : Number(day),
                shopIntervalDays: interval === "auto" ? null : Number(interval),
                takeawayPerWeek: takeaway,
              }),
            )
          }
        >
          Save
        </Button>
      </div>
    </div>
  );
}

// ─── Notifications ──────────────────────────────────────────────────────────

export interface NotificationPrefs {
  runningLow: boolean;
  useSoon: boolean;
  mealPlanReady: boolean;
  shoppingReminder: boolean;
  checkIns: boolean;
  insights: boolean;
  emailDigest: boolean;
  dailyLimit: number;
  quietStartHour: number | null;
  quietEndHour: number | null;
}

const NOTIFICATION_ROWS: Array<{ key: keyof NotificationPrefs; label: string; description: string }> = [
  { key: "runningLow", label: "Running low", description: "“You're probably running low on milk.”" },
  { key: "checkIns", label: "Quick check-ins", description: "“Did you finish the milk?” — keeps predictions accurate." },
  { key: "useSoon", label: "Use it soon", description: "“Don't forget to use your spinach.”" },
  { key: "mealPlanReady", label: "Meal plans", description: "When someone in your household plans the week." },
  { key: "shoppingReminder", label: "Shopping day", description: "A nudge on your usual shopping day, if there's a list." },
  { key: "insights", label: "Weekly insight", description: "One useful thing Plenty noticed, on Mondays." },
];

export function NotificationSettingsForm({ initial }: { initial: NotificationPrefs }) {
  const [prefs, setPrefs] = useState(initial);
  const { pending, run } = useAction();
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const fmt = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString("en-AU", { hour: "numeric" });
  return (
    <div className="space-y-6">
      <SettingsCard title="What Plenty tells you about">
        <ul className="divide-y divide-line">
          {NOTIFICATION_ROWS.map((row) => (
            <li key={row.key} className="flex items-center justify-between gap-4 py-3">
              <label htmlFor={`n-${row.key}`} className="min-w-0">
                <span className="block text-[15px] font-medium">{row.label}</span>
                <span className="block text-[13px] text-ink-3">{row.description}</span>
              </label>
              <Switch id={`n-${row.key}`} checked={Boolean(prefs[row.key])} onCheckedChange={(v) => setPrefs({ ...prefs, [row.key]: v })} />
            </li>
          ))}
        </ul>
      </SettingsCard>
      <SettingsCard title="Keeping it calm">
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[15px] font-medium">At most</p>
              <p className="text-[13px] text-ink-3">notifications a day</p>
            </div>
            <Stepper label="Daily limit" value={prefs.dailyLimit} onChange={(v) => setPrefs({ ...prefs, dailyLimit: v })} min={0} max={20} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quiet from" htmlFor="quiet-start">
              <NativeSelect id="quiet-start" value={prefs.quietStartHour ?? ""} onChange={(e) => setPrefs({ ...prefs, quietStartHour: e.target.value === "" ? null : Number(e.target.value) })}>
                <option value="">No quiet hours</option>
                {hours.map((h) => (
                  <option key={h} value={h}>
                    {fmt(h)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Until" htmlFor="quiet-end">
              <NativeSelect id="quiet-end" value={prefs.quietEndHour ?? ""} onChange={(e) => setPrefs({ ...prefs, quietEndHour: e.target.value === "" ? null : Number(e.target.value) })}>
                <option value="">—</option>
                {hours.map((h) => (
                  <option key={h} value={h}>
                    {fmt(h)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="flex items-center justify-between gap-4">
            <label htmlFor="n-email">
              <span className="block text-[15px] font-medium">Also send by email</span>
              <span className="block text-[13px] text-ink-3">Each notification is emailed to you as well.</span>
            </label>
            <Switch id="n-email" checked={prefs.emailDigest} onCheckedChange={(v) => setPrefs({ ...prefs, emailDigest: v })} />
          </div>
        </div>
      </SettingsCard>
      <div className="flex justify-end">
        <Button size="lg" loading={pending} onClick={() => run(() => updateNotificationSettingsAction(prefs))}>
          Save
        </Button>
      </div>
    </div>
  );
}

// ─── Privacy ────────────────────────────────────────────────────────────────

export function AiProcessingToggle({ allowed, externalConfigured }: { allowed: boolean; externalConfigured: boolean }) {
  const [value, setValue] = useState(allowed);
  const { pending, run } = useAction();
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor="ai-toggle" className="min-w-0">
        <span className="block text-[15px] font-medium">Use AI to read receipts and suggest recipes</span>
        <span className="mt-1 block text-[13px] leading-relaxed text-ink-3">
          {externalConfigured
            ? "Receipt photos and a summary of your kitchen are sent to Anthropic's Claude to read receipts and write recipes. Turn this off to keep everything on Plenty's server — receipts are then read with on-device OCR."
            : "No AI service is configured on this server, so receipts are already read on-device and nothing leaves Plenty's server."}
        </span>
      </label>
      <Switch
        id="ai-toggle"
        checked={value}
        disabled={pending}
        onCheckedChange={(v) => {
          setValue(v);
          run(() => updatePreferencesAction({ allowAiProcessing: v }), { onError: () => setValue(!v) });
        }}
      />
    </div>
  );
}

export function ExportButton() {
  return (
    <Button asChild variant="secondary">
      <a href="/api/export" download>
        <Download /> Download my household&apos;s data
      </a>
    </Button>
  );
}
