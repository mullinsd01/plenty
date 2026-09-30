import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { SETTINGS_SECTIONS } from "@/features/settings/settings-nav";
import { requireHousehold } from "@/server/auth/context";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await requireHousehold();
  return (
    <div className="mx-auto max-w-2xl animate-fade-in">
      <PageHeader title="Settings" subtitle={`${ctx.household.name} · signed in as ${ctx.user.email}`} />
      <Card className="divide-y divide-line">
        {SETTINGS_SECTIONS.map((s) => (
          <Link key={s.href} href={s.href} className="flex items-center gap-3 px-4 py-4 transition hover:bg-subtle/60">
            <span className="flex size-10 items-center justify-center rounded-xl bg-subtle text-ink-2">
              <s.icon className="size-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold">{s.label}</span>
              <span className="block truncate text-[13px] text-ink-3">{s.description}</span>
            </span>
            <ChevronRight className="size-4 text-ink-4" />
          </Link>
        ))}
      </Card>
    </div>
  );
}
