import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { desc } from "drizzle-orm";
import { systemDb } from "@/server/db/client";
import { emailOutbox } from "@/server/db/schema";
import { env, isProduction } from "@/server/env";

export const metadata: Metadata = { title: "Dev outbox", robots: { index: false } };

/**
 * Development inbox: emails Plenty would have sent (password resets, invites)
 * when no SMTP server is configured. Disabled in production.
 */
export default async function OutboxPage() {
  if (isProduction() || env().SMTP_URL) notFound();
  const emails = await systemDb.select().from(emailOutbox).orderBy(desc(emailOutbox.createdAt)).limit(30);
  return (
    <div className="mx-auto max-w-2xl px-5 py-10">
      <h1 className="text-2xl font-semibold tracking-[-0.02em]">Dev outbox</h1>
      <p className="mt-1 text-[14px] text-ink-3">Emails Plenty would have sent. Configure SMTP_URL to deliver them for real.</p>
      <div className="mt-8 space-y-4">
        {emails.length === 0 && <p className="text-[14px] text-ink-3">No emails yet.</p>}
        {emails.map((e) => (
          <article key={e.id} className="rounded-2xl border border-line bg-surface p-5 shadow-card" data-testid="outbox-email">
            <p className="text-[12px] text-ink-4">
              To {e.to} · {e.createdAt.toLocaleString("en-AU")}
            </p>
            <h2 className="mt-1 text-[16px] font-semibold">{e.subject}</h2>
            <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-[14px] leading-relaxed text-ink-2">{e.text}</pre>
          </article>
        ))}
      </div>
    </div>
  );
}
