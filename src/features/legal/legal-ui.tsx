import Link from "next/link";
import { PlentyLogo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { formatLegalDate } from "@/lib/legal";
import type { LegalContact } from "@/server/legal";

/** Links to the public pages, used in footers and on sign-in and sign-up. */
export const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/support", label: "Support" },
] as const;

export function LegalFooterLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Legal and support" className={className ?? "flex flex-wrap gap-x-4 gap-y-1"}>
      {LEGAL_LINKS.map((l) => (
        <Link key={l.href} href={l.href} className="text-ink-3 underline-offset-2 hover:text-ink hover:underline">
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

/** The public pages' frame: no sign-in needed, readable on a phone, calm. */
export function LegalFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="mx-auto flex h-16 max-w-3xl items-center justify-between px-5">
        <Link href="/" aria-label="Plenty home">
          <PlentyLogo className="h-6" />
        </Link>
        <nav className="flex items-center gap-1" aria-label="Account">
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-5 pb-20 pt-6">{children}</main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-[13px] text-ink-3">
          <span>Plenty · Your household, figured out.</span>
          <LegalFooterLinks />
        </div>
      </footer>
    </div>
  );
}

export function LegalTitle({ title, updated, intro }: { title: string; updated?: boolean; intro?: React.ReactNode }) {
  return (
    <header className="mb-8">
      <h1 className="text-[32px] font-semibold tracking-[-0.03em] sm:text-[38px]">{title}</h1>
      {updated && <p className="mt-1.5 text-[13px] text-ink-3">Last updated {formatLegalDate()}</p>}
      {intro && <div className="mt-4 text-[16px] leading-relaxed text-ink-2">{intro}</div>}
    </header>
  );
}

export function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-h` : undefined} className="mt-10 scroll-mt-6">
      <h2 id={id ? `${id}-h` : undefined} className="text-[21px] font-semibold tracking-[-0.02em]">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-ink-2">{children}</div>
    </section>
  );
}

export function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** An email address as a link, or nothing when it isn't set (never a made-up one). */
export function Email({ address }: { address: string | null }) {
  if (!address) return null;
  if (address.startsWith("[")) return <span className="rounded bg-soon-soft px-1 font-mono text-[13px] text-ink-2">{address}</span>;
  return (
    <a href={`mailto:${address}`} className="font-medium text-ink underline underline-offset-2">
      {address}
    </a>
  );
}

/** Who runs this Plenty and how to reach them: what's set is shown, what isn't is left out. */
export function ContactBlock({ contact, kind }: { contact: LegalContact; kind: "support" | "privacy" }) {
  const address = kind === "privacy" ? contact.privacyEmail : contact.supportEmail;
  if (!contact.entityName && !address) {
    return <p>The operator of this Plenty hasn&apos;t published contact details yet. If you can sign in, you can do everything described here from Settings.</p>;
  }
  return (
    <p>
      {contact.entityName && (
        <>
          <strong className="font-semibold text-ink">{contact.entityName}</strong>
          <br />
        </>
      )}
      {address && (
        <>
          {kind === "privacy" ? "Privacy requests: " : "Support: "}
          <Email address={address} />
        </>
      )}
    </p>
  );
}

export function DevPlaceholderNote({ contact }: { contact: LegalContact }) {
  if (contact.missing.length === 0) return null;
  return (
    <p role="note" className="mb-6 rounded-xl bg-soon-soft px-4 py-3 text-[13px] text-ink-2">
      Development only: these details aren&apos;t set yet ({contact.missing.join(", ")}). In production an unset detail is left out of this page rather than invented.
    </p>
  );
}
