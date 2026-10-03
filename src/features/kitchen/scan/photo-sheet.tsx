"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Camera, ImageUp, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Stepper } from "@/components/ui/controls";
import { Input, NativeSelect } from "@/components/ui/field";
import { Pill } from "@/components/ui/pill";
import { Sheet } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { UpgradeNote } from "@/components/ui/upgrade-note";
import { useAction } from "@/components/hooks/use-action";
import { usePeople } from "@/features/members/people-context";
import { trackClient } from "@/lib/analytics-client";
import { STORAGE_LOCATIONS, STORAGE_LOCATION_LABELS, type StorageLocation } from "@/lib/domain";
import type { GuessConfidence, PhotoAvailability, PhotoGuess, PhotoProposal } from "@/lib/scan/types";
import { addPhotoItemsAction, scanAccessAction } from "./actions";
import { HOUSEHOLD_OWNER, OwnerField, ownershipFor, type OwnerValue } from "./owner-field";
import { PhotoOpenError, prepareUpload } from "./prepare-photo";

type Phase = "loading" | "blocked" | "capture" | "reading" | "review";

interface Draft {
  guess: PhotoGuess;
  include: boolean;
  name: string;
  quantity: number;
  location: StorageLocation;
}

const toDraft = (guess: PhotoGuess): Draft => ({
  guess,
  // Guesses Plenty is unsure about start unticked: adding them is the person's call.
  include: guess.confidence !== "low",
  name: guess.name,
  quantity: guess.quantity,
  location: guess.location,
});

const CONFIDENCE_LABEL: Record<GuessConfidence, { text: string; tone: "info" | "soon" } | null> = {
  high: null,
  medium: { text: "Probably", tone: "info" },
  low: { text: "Not sure", tone: "soon" },
};

/**
 * Add groceries from a photo. Plenty asks an AI reader what it can see, shows the
 * guesses for review (unsure ones unticked), and adds only what the person
 * ticks. The photo is shrunk and stripped of camera details on the device, read in
 * memory on the server, and not kept.
 */
export function PhotoSheet({ open, onOpenChange, onBack }: { open: boolean; onOpenChange: (open: boolean) => void; onBack: () => void }) {
  const router = useRouter();
  const people = usePeople();
  const [phase, setPhase] = useState<Phase>("loading");
  const [availability, setAvailability] = useState<PhotoAvailability | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<PhotoProposal | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [owner, setOwner] = useState<OwnerValue>(HOUSEHOLD_OWNER);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<string | null>(null);
  const { pending, run } = useAction();

  const clearPreview = () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreview(null);
  };

  useEffect(() => {
    if (!open) {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
      return;
    }
    let cancelled = false;
    setPhase("loading");
    setProblem(null);
    setResult(null);
    setPreview(null);
    void scanAccessAction().then(
      (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setProblem(res.error);
          setPhase("capture");
          return;
        }
        setAvailability(res.data.photo);
        setPhase(res.data.photo.state === "ready" ? "capture" : "blocked");
        if (res.data.photo.state === "needs_plan") trackClient("paywall_viewed", { feature: "photo", plan: "plus" });
      },
      () => {
        if (!cancelled) {
          setProblem("Couldn't reach Plenty. Check your connection and try again.");
          setPhase("capture");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [phase]);

  const send = async (file: File | undefined) => {
    if (!file) return;
    setProblem(null);
    setPhase("reading");
    setAnnounce("Looking at your photo.");
    try {
      const upload = await prepareUpload(file);
      clearPreview();
      const url = URL.createObjectURL(upload);
      previewRef.current = url;
      setPreview(url);
      const form = new FormData();
      form.append("file", upload, "groceries.jpg");
      const res = await fetch("/api/photo-recognition", { method: "POST", body: form });
      const body = (await res.json().catch(() => null)) as (PhotoProposal & { error?: string }) | null;
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok || !body || !Array.isArray(body.guesses)) {
        const message = body?.error ?? "That didn't work. Please try again.";
        setProblem(message);
        setAnnounce(message);
        setPhase("capture");
        return;
      }
      clearPreview();
      setResult(body);
      setDrafts(body.guesses.map(toDraft));
      setPhase("review");
      setAnnounce(body.guesses.length ? `Plenty thinks it can see ${body.guesses.length} things. Check them before adding.` : "Plenty couldn't make out any groceries.");
    } catch (err) {
      const message = err instanceof PhotoOpenError ? err.message : "Couldn't reach Plenty. Check your connection and try again.";
      setProblem(message);
      setAnnounce(message);
      setPhase("capture");
    }
  };

  const update = (id: string, patch: Partial<Draft>) => setDrafts((ds) => ds.map((d) => (d.guess.id === id ? { ...d, ...patch } : d)));
  const chosen = drafts.filter((d) => d.include);
  const ready = chosen.length > 0 && chosen.every((d) => d.name.trim());

  const submit = () =>
    run(
      () =>
        addPhotoItemsAction(
          chosen.map((d) => ({
            name: d.name.trim(),
            // The catalogue link only holds while the name is the one Plenty matched.
            productId: d.name.trim() === d.guess.name ? d.guess.productId : null,
            quantity: d.quantity,
            location: d.location,
            confidence: d.guess.confidence,
            ...ownershipFor(people.restricted, owner),
          })),
        ),
      { onSuccess: () => onOpenChange(false) },
    );

  const provider = availability && "providerName" in availability ? availability.providerName : null;
  const sample = availability?.state === "ready" && availability.sample;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add from a photo"
      description="Photograph your groceries and check what Plenty thinks it can see."
      size="lg"
      footer={
        phase === "review" && result && result.guesses.length > 0 ? (
          <Button block size="lg" onClick={submit} loading={pending} disabled={!ready}>
            {chosen.length === 0 ? "Tick what to add" : chosen.length === 1 ? "Add 1 selected" : `Add ${chosen.length} selected`}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <p role="status" aria-live="polite" className="sr-only">
          {announce}
        </p>

        {phase === "loading" && (
          <div className="flex justify-center py-12">
            <Spinner label="Getting ready" />
          </div>
        )}

        {phase === "blocked" && availability && availability.state !== "ready" && (
          <div className="space-y-4">
            <h3 ref={headingRef} tabIndex={-1} className="text-[17px] font-semibold tracking-[-0.015em] outline-none">
              {availability.state === "needs_plan" ? "Photo recognition is part of Plenty Plus" : availability.state === "needs_consent" ? "Plenty needs your household's OK first" : "Photo recognition isn't set up here"}
            </h3>
            {availability.state === "needs_plan" && (
              <UpgradeNote plan="plus" feature="photo">
                Recognising groceries from a photo is included in Plenty Plus. Typing what you&apos;ve got, scanning a receipt and everything else works on every plan.
              </UpgradeNote>
            )}
            {availability.state === "needs_consent" && (
              <>
                <p className="text-[14px] leading-relaxed text-ink-2">
                  To list what&apos;s in a photo, Plenty sends the photo to {availability.providerName ?? "an AI service"}. It only does that once someone in your household has agreed. You can turn that on, and off again, in Settings → Privacy &amp; data.
                </p>
                <Button asChild block variant="brand">
                  <Link href="/settings/privacy" onClick={() => onOpenChange(false)}>
                    Open Privacy &amp; data
                  </Link>
                </Button>
              </>
            )}
            {availability.state === "needs_provider" && (
              <p className="text-[14px] leading-relaxed text-ink-2">
                Reading a photo needs an AI service, and none is set up on this Plenty. You can still add things by typing, by scanning a barcode, or by scanning a receipt.
              </p>
            )}
            <Button block variant="secondary" onClick={onBack}>
              Back to typing
            </Button>
          </div>
        )}

        {phase === "capture" && (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-brand-soft text-brand-ink">
                <Camera />
              </div>
              <div>
                <h3 ref={headingRef} tabIndex={-1} className="text-[17px] font-semibold tracking-[-0.015em] outline-none">
                  Photograph your groceries
                </h3>
                <p className="mt-0.5 text-[14px] text-ink-3">
                  Unpacked shopping on the bench, or a shelf in the fridge or pantry. Plenty suggests what it can see and you choose what to add. It can get things wrong.
                </p>
              </div>
            </div>
            {problem && (
              <p role="alert" className="flex items-start gap-2 rounded-xl bg-alert-soft px-3.5 py-3 text-[14px] text-alert">
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                {problem}
              </p>
            )}
            {sample && (
              <p className="rounded-xl bg-soon-soft px-3.5 py-3 text-[13px] text-soon">
                No AI service is set up, so this will show a made-up sample list, not what&apos;s actually in your photo.
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button size="lg" variant="brand" block onClick={() => cameraRef.current?.click()}>
                <Camera /> Take a photo
              </Button>
              <Button size="lg" variant="secondary" block onClick={() => libraryRef.current?.click()}>
                <ImageUp /> Choose a photo
              </Button>
            </div>
            <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-3">
              <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>
                {sample
                  ? "Nothing leaves this server."
                  : `Your photo is shrunk on your device, with its location and camera details removed, then sent to ${provider ?? "an AI service"} to be read. Nothing else about you or your household goes with it, and Plenty doesn't keep the photo.`}
              </span>
            </p>
          </div>
        )}

        {phase === "reading" && (
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            {preview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="Your photo" className="max-h-40 w-auto rounded-lg object-contain shadow-raised" />
            )}
            <Spinner label="Looking at your photo" />
            <h3 ref={headingRef} tabIndex={-1} className="text-[15px] font-semibold outline-none">
              Looking at your photo…
            </h3>
          </div>
        )}

        {phase === "review" && result && (
          <div className="space-y-4">
            <div>
              <h3 ref={headingRef} tabIndex={-1} className="text-[17px] font-semibold tracking-[-0.015em] outline-none">
                {result.guesses.length > 0 ? "Plenty thinks it can see…" : "Nothing Plenty could make out"}
              </h3>
              <p className="mt-1 text-[13.5px] leading-relaxed text-ink-3">
                {result.guesses.length > 0
                  ? "These are guesses from a photo. Plenty can get names and counts wrong or miss things, so check each one. Nothing is added until you tap the button below. Your photo wasn't saved."
                  : "Plenty couldn't pick out any groceries in that photo. Try again closer and in better light, or add things by typing. Your photo wasn't saved."}
              </p>
            </div>
            {result.sample && (
              <p className="rounded-xl bg-soon-soft px-3.5 py-3 text-[13px] text-soon">
                Sample list. No AI service is set up here, so this is made up and has nothing to do with your photo.
              </p>
            )}
            {result.notes.map((note) => (
              <p key={note} className="flex items-start gap-2 text-[13px] text-ink-3">
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" /> {note}
              </p>
            ))}

            {result.guesses.length > 0 && (
              <ul className="divide-y divide-line" aria-label="What Plenty thinks it can see">
                {drafts.map((d) => {
                  const label = CONFIDENCE_LABEL[d.guess.confidence];
                  return (
                    <li key={d.guess.id} className="flex items-start gap-3 py-3">
                      <Checkbox checked={d.include} onCheckedChange={(v) => update(d.guess.id, { include: v === true })} aria-label={`Add ${d.name || "this"}`} className="mt-2.5" />
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <Input value={d.name} onChange={(e) => update(d.guess.id, { name: e.target.value })} maxLength={120} aria-label="Name" className="h-10" />
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-ink-3">
                          {label && (
                            <Pill tone={label.tone} size="sm">
                              {label.text}
                            </Pill>
                          )}
                          {!d.guess.quantityKnown && <span>Couldn&apos;t tell how many</span>}
                          <span className="inline-flex items-center gap-1.5">
                            Goes in
                            <span className="w-32">
                              <NativeSelect
                                value={d.location}
                                onChange={(e) => update(d.guess.id, { location: e.target.value as StorageLocation })}
                                aria-label={`Where ${d.name || "it"} goes`}
                                className="h-8 pl-2.5 text-[13px]"
                              >
                                {STORAGE_LOCATIONS.map((l) => (
                                  <option key={l} value={l}>
                                    {STORAGE_LOCATION_LABELS[l]}
                                  </option>
                                ))}
                              </NativeSelect>
                            </span>
                          </span>
                        </div>
                      </div>
                      <Stepper value={d.quantity} onChange={(q) => update(d.guess.id, { quantity: q })} min={1} max={24} label={`count of ${d.name || "item"}`} />
                    </li>
                  );
                })}
              </ul>
            )}

            {result.guesses.length > 0 && <OwnerField id="photo-owner" value={owner} onChange={setOwner} />}

            <Button
              variant="ghost"
              block
              onClick={() => {
                setResult(null);
                setPhase("capture");
              }}
              disabled={pending}
            >
              <Camera /> Try another photo
            </Button>
          </div>
        )}

        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            void send(file);
          }} />
        <input ref={libraryRef} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            void send(file);
          }} />
      </div>
    </Sheet>
  );
}
