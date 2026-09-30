import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading your kitchen">
      <div className="mb-8 pt-2">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="mt-3 h-4 w-72" />
      </div>
      <Skeleton className="mb-3 h-11 w-full rounded-xl" />
      <div className="mb-5 flex gap-2">
        {[64, 72, 80, 70].map((w) => (
          <Skeleton key={w} className="h-9 rounded-full" style={{ width: w }} />
        ))}
      </div>
      <div className="rounded-2xl border border-line bg-surface">
        <SkeletonRows rows={7} />
      </div>
    </div>
  );
}
