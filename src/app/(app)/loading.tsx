import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="mb-8 pt-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-3 h-9 w-64" />
      </div>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="space-y-8">
          <div className="rounded-2xl border border-line bg-surface">
            <SkeletonRows rows={4} />
          </div>
          <div className="rounded-2xl border border-line bg-surface">
            <SkeletonRows rows={3} />
          </div>
        </div>
        <div className="space-y-4">
          <Skeleton className="h-20 w-full rounded-2xl" />
          <Skeleton className="h-20 w-full rounded-2xl" />
          <Skeleton className="h-24 w-full rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
