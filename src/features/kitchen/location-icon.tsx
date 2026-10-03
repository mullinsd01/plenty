import { Archive, Carrot, CupSoda, Package, Refrigerator, Snowflake, SprayCan, Warehouse, type LucideIcon } from "lucide-react";
import type { StorageLocation } from "@/lib/domain";
import { cn } from "@/lib/cn";

export const LOCATION_ICONS: Record<StorageLocation, LucideIcon> = {
  fridge: Refrigerator,
  freezer: Snowflake,
  pantry: Archive,
  cupboard: Warehouse,
  produce: Carrot,
  drinks: CupSoda,
  household: SprayCan,
  other: Package,
};

export function LocationIcon({ location, className }: { location: StorageLocation; className?: string }) {
  const Icon = LOCATION_ICONS[location];
  return (
    <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl bg-subtle text-ink-3", className)} aria-hidden>
      <Icon className="size-[18px]" strokeWidth={1.8} />
    </span>
  );
}
