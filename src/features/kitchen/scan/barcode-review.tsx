"use client";

import { useState } from "react";
import { Info, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Stepper } from "@/components/ui/controls";
import { Field, Input, NativeSelect } from "@/components/ui/field";
import { Pill } from "@/components/ui/pill";
import { useAction } from "@/components/hooks/use-action";
import { usePeople } from "@/features/members/people-context";
import { STORAGE_LOCATIONS, STORAGE_LOCATION_LABELS, type StorageLocation } from "@/lib/domain";
import type { BarcodeProposal } from "@/lib/scan/types";
import { addScannedItemAction } from "./actions";
import { HOUSEHOLD_OWNER, OwnerField, ownershipFor, type OwnerValue } from "./owner-field";

/**
 * Check what a scanned barcode is before it goes into the kitchen. Everything is
 * editable; nothing is added until "Add to kitchen" (or "Add and scan another").
 */
export function BarcodeReview({
  proposal,
  headingRef,
  onAdded,
  onRescan,
}: {
  proposal: BarcodeProposal;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  /** The item was added. `again`: scan the next one. */
  onAdded: (again: boolean) => void;
  onRescan: () => void;
}) {
  const people = usePeople();
  const [name, setName] = useState(proposal.name);
  const [packs, setPacks] = useState(1);
  const [location, setLocation] = useState<StorageLocation>(proposal.location);
  const [owner, setOwner] = useState<OwnerValue>(HOUSEHOLD_OWNER);
  const [remember, setRemember] = useState(true);
  const { pending, run } = useAction();

  const unchanged = name.trim() === proposal.name.trim();
  /** The catalogue product only applies while the name is the one Plenty matched. */
  const productId = unchanged ? proposal.productId : null;
  const canRemember = !people.restricted;

  const submit = (again: boolean) => {
    if (!name.trim()) return;
    run(
      () =>
        addScannedItemAction({
          barcode: proposal.barcode,
          name: name.trim(),
          productId,
          packCount: packs,
          location,
          brand: unchanged ? proposal.brand : null,
          sizeText: unchanged ? proposal.sizeText : null,
          quantity: !productId && proposal.size ? proposal.size.quantity : null,
          unit: !productId && proposal.size ? proposal.size.unit : null,
          remember: canRemember && remember,
          ...ownershipFor(people.restricted, owner),
        }),
      { onSuccess: () => onAdded(again) },
    );
  };

  const where =
    proposal.status === "remembered"
      ? "Your household told Plenty what this is."
      : proposal.status === "found"
        ? "Found in Open Food Facts, a public product database. It's a suggestion, so check it's right."
        : null;

  return (
    <div className="space-y-4">
      <div>
        <h3 ref={headingRef} tabIndex={-1} className="text-[17px] font-semibold tracking-[-0.015em] outline-none">
          {proposal.status === "remembered" ? "You've scanned this before" : proposal.name ? "Is this right?" : "What is this?"}
        </h3>
        <p className="tabular mt-0.5 text-[13px] text-ink-3">Barcode {proposal.barcodeDisplay}</p>
      </div>

      {where && (
        <p className="flex items-start gap-2 text-[13px] text-ink-3">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          {where}
        </p>
      )}
      {proposal.notice && (
        <p role="status" className="flex items-start gap-2 rounded-xl bg-subtle px-3.5 py-3 text-[14px] text-ink-2">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
          {proposal.notice}
        </p>
      )}
      {proposal.packaging && (
        <p className="rounded-xl bg-soon-soft px-3.5 py-3 text-[13px] text-soon">
          This looks like a case or multipack barcode, not a single item. Name what&apos;s inside.
        </p>
      )}

      <Field label="What is it?" htmlFor="scan-name">
        <Input id="scan-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Full cream milk" autoComplete="off" enterKeyHint="done" />
      </Field>

      {productId && proposal.productName && (
        <p className="text-[13px] text-ink-3">
          {proposal.match === "likely" ? (
            <>
              <Pill tone="soon" size="sm" className="mr-1.5">
                Check
              </Pill>
              Looks like {proposal.productName} in Plenty. Change the name above if that&apos;s not right.
            </>
          ) : (
            <>Plenty files this as {proposal.productName}.</>
          )}
          {proposal.packLabel ? ` ${proposal.packLabel}.` : ""}
        </p>
      )}
      {!productId && proposal.sizeText && <p className="text-[13px] text-ink-3">Pack size printed: {proposal.sizeText}.</p>}

      <div className="grid grid-cols-2 gap-3">
        <Field label="How many?">
          <Stepper value={packs} onChange={setPacks} min={1} max={99} label="how many" className="self-start" />
        </Field>
        <Field label="Where does it go?" htmlFor="scan-location">
          <NativeSelect id="scan-location" value={location} onChange={(e) => setLocation(e.target.value as StorageLocation)}>
            {STORAGE_LOCATIONS.map((l) => (
              <option key={l} value={l}>
                {STORAGE_LOCATION_LABELS[l]}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>

      <OwnerField id="scan-owner" value={owner} onChange={setOwner} />

      {canRemember && (
        <label className="flex items-start gap-2.5 text-[13px] text-ink-2">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-0.5 size-4 accent-[var(--brand)]" />
          <span>
            Remember this barcode for your household, so next time it&apos;s one tap.
            <span className="mt-0.5 flex items-center gap-1 text-ink-3">
              <Lock aria-hidden className="size-3" /> Only people in your household can see it.
            </span>
          </span>
        </label>
      )}

      <div className="flex flex-col gap-2 pt-1 sm:flex-row-reverse">
        <Button size="lg" block onClick={() => submit(false)} loading={pending} disabled={!name.trim()}>
          Add to kitchen
        </Button>
        <Button size="lg" block variant="secondary" onClick={() => submit(true)} disabled={pending || !name.trim()}>
          Add and scan another
        </Button>
      </div>
      <button type="button" onClick={onRescan} disabled={pending} className="block w-full text-center text-[13px] font-medium text-ink-3 underline underline-offset-2 hover:text-ink">
        Not the right one? Scan again
      </button>
    </div>
  );
}
