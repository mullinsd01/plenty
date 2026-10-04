import Link from "next/link";
import { redirect } from "next/navigation";
import { PlentyLogo, PlentyMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { ProductGlimpse } from "@/features/auth/product-glimpse";
import { LegalFooterLinks } from "@/features/legal/legal-ui";
import { getAuthUser } from "@/server/auth/context";

export default async function LandingPage() {
  if (await getAuthUser()) redirect("/home");

  return (
    <div className="pt-safe pb-safe min-h-dvh">
      <header className="mx-auto flex h-20 max-w-6xl items-center justify-between px-6">
        <PlentyLogo className="h-7" />
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/signup">Get started</Link>
          </Button>
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-10 lg:grid-cols-2 lg:pt-20">
          <div>
            <h1 className="text-balance text-[44px] font-semibold leading-[1.02] tracking-[-0.04em] sm:text-[60px]">
              Your household,
              <br />
              figured out.
            </h1>
            <p className="mt-6 max-w-md text-pretty text-[17px] leading-relaxed text-ink-2">
              Plenty learns what your household buys, has and actually uses. Then it tells you what&apos;s about to run out,
              what to cook tonight with what you&apos;ve got, and exactly what to buy next.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link href="/signup">Set up your household</Link>
              </Button>
              <Button asChild variant="secondary" size="lg">
                <Link href="/login">Sign in</Link>
              </Button>
            </div>
          </div>
          <div className="relative hidden h-[520px] overflow-hidden rounded-[28px] bg-subtle lg:block">
            <ProductGlimpse />
          </div>
        </section>

        <section className="border-t border-line bg-surface">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 py-16 md:grid-cols-3">
            <Pillar title="Scan a receipt, skip the typing">
              Snap your receipt. Plenty reads it, tidies the names and fills your kitchen — you just confirm.
            </Pillar>
            <Pillar title="It learns your pace">
              Every time something runs out, Plenty learns how fast your household gets through it — and warns you before
              it happens again.
            </Pillar>
            <Pillar title="Meals from what you have">
              Plans built around what&apos;s already in the fridge — especially the things that need using — and a list with
              only what&apos;s missing.
            </Pillar>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-10 text-sm text-ink-3">
        <span className="flex items-center gap-3">
          <PlentyMark className="h-5" />
          Plenty · Your household, figured out.
        </span>
        <LegalFooterLinks className="flex flex-wrap gap-x-4 gap-y-1 sm:ml-auto" />
      </footer>
    </div>
  );
}

function Pillar({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-3">{children}</p>
    </div>
  );
}
