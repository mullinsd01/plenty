import { PlentyMark } from "@/components/brand/logo";

/**
 * A quiet, static glimpse of what Plenty does — real UI patterns, no stock
 * imagery. Shown beside the auth forms on large screens.
 */
export function ProductGlimpse() {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-12">
      <div className="absolute -right-24 -top-24 opacity-[0.07]">
        <PlentyMark className="h-[520px]" />
      </div>
      <div className="relative w-full max-w-[400px] space-y-4">
        <p className="text-[15px] font-medium text-ink-3">Good morning</p>
        <h2 className="text-balance text-[32px] font-semibold leading-[1.1] tracking-[-0.03em] text-ink">
          You&apos;re probably out of milk by tomorrow.
        </h2>
        <div className="space-y-3 pt-4">
          <GlimpseCard label="Running low">
            <GlimpseRow name="Milk" detail="about 1 day" tone="alert" />
            <GlimpseRow name="Bread" detail="about 2 days" tone="soon" />
            <GlimpseRow name="Eggs" detail="about 5 days" tone="neutral" />
          </GlimpseCard>
          <GlimpseCard label="Tonight">
            <div className="flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-xl bg-[#e8efe2] text-[11px] font-semibold uppercase tracking-wide text-[#4d6b3c]">
                Stir
              </div>
              <div>
                <p className="text-[15px] font-semibold text-ink">Chicken stir-fry</p>
                <p className="text-[13px] text-ink-3">24 min · uses 5 things you already have</p>
              </div>
            </div>
          </GlimpseCard>
        </div>
      </div>
    </div>
  );
}

function GlimpseCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-raised">
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{label}</p>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function GlimpseRow({ name, detail, tone }: { name: string; detail: string; tone: "alert" | "soon" | "neutral" }) {
  const dot = tone === "alert" ? "bg-alert" : tone === "soon" ? "bg-soon" : "bg-ink-4";
  return (
    <div className="flex items-center justify-between text-[15px]">
      <span className="flex items-center gap-2.5 font-medium text-ink">
        <span className={`size-2 rounded-full ${dot}`} />
        {name}
      </span>
      <span className="text-ink-3">{detail}</span>
    </div>
  );
}
