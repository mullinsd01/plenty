import Link from "next/link";
import { PlentyLogo } from "@/components/brand/logo";
import { ProductGlimpse } from "@/features/auth/product-glimpse";
import { LegalFooterLinks } from "@/features/legal/legal-ui";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col px-6 pb-10 pt-8 sm:px-10">
        <Link href="/" className="w-fit" aria-label="Plenty home">
          <PlentyLogo className="h-7" />
        </Link>
        <main className="mx-auto flex w-full max-w-[380px] flex-1 flex-col justify-center py-10">{children}</main>
        <div className="flex flex-col items-center gap-2 text-xs text-ink-4 lg:items-start">
          <p>Your household, figured out.</p>
          <LegalFooterLinks />
        </div>
      </div>
      <aside className="relative hidden overflow-hidden bg-subtle lg:block">
        <ProductGlimpse />
      </aside>
    </div>
  );
}
