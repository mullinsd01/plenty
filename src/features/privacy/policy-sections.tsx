import { ChevronDown } from "lucide-react";
import { CHILDREN_TEXT, DATA_GROUPS, DELETION_TEXT, VISIBILITY_RULES, type DataGroup, type Processor } from "@/lib/privacy-content";

/** One kind of data: what, why, who else, how long. Opens and closes with the keyboard. */
export function DataGroupDetails({ group, defaultOpen = false }: { group: DataGroup; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group rounded-xl border border-line bg-surface open:shadow-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3.5 text-[15px] font-semibold marker:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&::-webkit-details-marker]:hidden">
        {group.title}
        <ChevronDown className="size-4 shrink-0 text-ink-3 transition group-open:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-3 px-4 pb-4 text-[14px] leading-relaxed text-ink-2">
        <div>
          <p className="font-medium text-ink">What Plenty keeps</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-3">
            {group.collects.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
        <p>
          <span className="font-medium text-ink">Why: </span>
          {group.why}
        </p>
        <p>
          <span className="font-medium text-ink">Who else handles it: </span>
          {group.sharedWith}
        </p>
        <p>
          <span className="font-medium text-ink">How long it&apos;s kept: </span>
          {group.kept}
        </p>
      </div>
    </details>
  );
}

export function DataGroups({ openFirst = false }: { openFirst?: boolean }) {
  return (
    <div className="space-y-2.5">
      {DATA_GROUPS.map((g, i) => (
        <DataGroupDetails key={g.id} group={g} defaultOpen={openFirst && i === 0} />
      ))}
    </div>
  );
}

export function ProcessorList({ processors }: { processors: Processor[] }) {
  return (
    <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
      {processors.map((p) => (
        <li key={p.name} className="px-4 py-3.5 text-[14px] leading-relaxed">
          <p className="font-semibold text-ink">{p.name}</p>
          <p className="text-ink-3">{p.role}</p>
          <p className="mt-1 text-ink-2">
            <span className="font-medium text-ink">Receives: </span>
            {p.receives}
          </p>
          <p className="text-ink-2">
            <span className="font-medium text-ink">When: </span>
            {p.when}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function VisibilityRules() {
  return (
    <ul className="list-disc space-y-2 pl-5 text-[14px] leading-relaxed text-ink-2">
      {VISIBILITY_RULES.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}

export function ChildrenText() {
  return (
    <div className="space-y-2 text-[14px] leading-relaxed text-ink-2">
      {CHILDREN_TEXT.map((t) => (
        <p key={t}>{t}</p>
      ))}
    </div>
  );
}

export function DeletionText() {
  return (
    <ul className="list-disc space-y-2 pl-5 text-[14px] leading-relaxed text-ink-2">
      {Object.values(DELETION_TEXT).map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}
