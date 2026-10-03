"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Camera, CameraOff, ImageUp, Keyboard, ScanBarcode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { UpgradeNote } from "@/components/ui/upgrade-note";
import { trackClient } from "@/lib/analytics-client";
import { parseBarcode } from "@/lib/barcode";
import type { BarcodeProposal, ScanAccess } from "@/lib/scan/types";
import { lookupBarcodeAction, scanAccessAction } from "./actions";
import { loadBarcodeReader, readBarcodeFromFile } from "./barcode-decoder";
import { BarcodeReview } from "./barcode-review";
import { useCameraScanner, type CameraState } from "./use-camera-scanner";

type Phase = "loading" | "plan" | "intro" | "camera" | "manual" | "looking" | "review";

const CAMERA_PROBLEMS: Partial<Record<CameraState, string>> = {
  denied:
    "Plenty can't use the camera. You can allow it in your browser's site settings, or type the numbers or choose a photo of the barcode instead.",
  no_camera: "No camera was found on this device. You can type the numbers or choose a photo of the barcode instead.",
  busy: "The camera is being used by another app. Close it and try again, or type the numbers instead.",
  insecure: "The camera needs a secure (https) connection. You can type the numbers or choose a photo of the barcode instead.",
  error: "The scanner couldn't start. You can type the numbers or choose a photo of the barcode instead.",
  paused: "The camera was turned off while Plenty was in the background.",
};

/**
 * Add something by its barcode. The camera is only asked for when the person taps
 * "Turn on camera"; pictures are read on the device and never sent anywhere. A
 * lookup only ever proposes: the person checks and confirms before anything is added.
 */
export function BarcodeSheet({ open, onOpenChange, onBack }: { open: boolean; onOpenChange: (open: boolean) => void; onBack: () => void }) {
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Scan a barcode"
      description="Point your camera at a barcode, or type the numbers under it."
    >
      {/* Mounted only while the sheet is open, so every visit starts fresh and the camera is released when it closes. */}
      <BarcodeFlow onOpenChange={onOpenChange} onBack={onBack} />
    </Sheet>
  );
}

function BarcodeFlow({ onOpenChange, onBack }: { onOpenChange: (open: boolean) => void; onBack: () => void }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [access, setAccess] = useState<ScanAccess | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [typed, setTyped] = useState("");
  const [proposal, setProposal] = useState<BarcodeProposal | null>(null);
  const [reviewKey, setReviewKey] = useState(0);
  const [, startLookup] = useTransition();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraAfterLookup = useRef(false);

  const lookup = useCallback((gtin: string, fromCamera: boolean) => {
    cameraAfterLookup.current = fromCamera;
    setProblem(null);
    setPhase("looking");
    setAnnounce("Looking that barcode up.");
    startLookup(async () => {
      try {
        const res = await lookupBarcodeAction(gtin);
        if (!res.ok) {
          setProblem(res.error);
          setPhase(res.code === "plan_limit" ? "plan" : fromCamera ? "intro" : "manual");
          setAnnounce(res.error);
          return;
        }
        setProposal(res.data);
        setReviewKey((k) => k + 1);
        setPhase("review");
        setAnnounce(
          res.data.name ? `Found ${res.data.name}. Check it and add it.` : "Plenty doesn't know this one yet. Name it to add it.",
        );
      } catch {
        const message = "Couldn't reach Plenty. Check your connection and try again.";
        setProblem(message);
        setPhase(fromCamera ? "intro" : "manual");
        setAnnounce(message);
      }
    });
  }, []);

  const camera = useCameraScanner({
    onBarcode: (barcode) => {
      setAnnounce(`Barcode ${barcode.display} found.`);
      lookup(barcode.gtin, true);
    },
    onRefused: (message) => {
      setHint(message);
      setAnnounce(message);
    },
  });
  const { videoRef, state: cameraState, start: startCamera, stop: stopCamera } = camera;

  // Find out what the household may do. (The camera is released when this unmounts.)
  useEffect(() => {
    let cancelled = false;
    void scanAccessAction().then(
      (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setProblem(res.error);
          setPhase("intro");
          return;
        }
        setAccess(res.data);
        setPhase(res.data.barcode.allowed ? "intro" : "plan");
        if (!res.data.barcode.allowed) trackClient("paywall_viewed", { feature: "barcode", plan: "plus" });
      },
      () => {
        if (!cancelled) {
          setProblem("Couldn't reach Plenty. Check your connection and try again.");
          setPhase("intro");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // If the camera can't run, the camera step gives way to the explanation on the first step.
  const view: Phase = phase === "camera" && CAMERA_PROBLEMS[cameraState] ? "intro" : phase;

  // Move focus to the new step's heading so screen reader users hear where they are. While scanning, focus stays on the buttons.
  useEffect(() => {
    if (view !== "camera") headingRef.current?.focus();
  }, [view]);

  const turnOnCamera = () => {
    setProblem(null);
    setHint(null);
    setPhase("camera");
    setAnnounce("Starting the camera. Point it at the barcode.");
    void startCamera();
  };
  const cameraProblem = view === "intro" || view === "manual" ? CAMERA_PROBLEMS[cameraState] : null;

  const submitTyped = () => {
    const parsed = parseBarcode(typed);
    if (!parsed.ok) {
      setProblem(parsed.message);
      setAnnounce(parsed.message);
      return;
    }
    lookup(parsed.barcode.gtin, false);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setProblem(null);
    setAnnounce("Reading the picture.");
    try {
      const read = await readBarcodeFromFile(await loadBarcodeReader(), file);
      if (read?.kind === "found") return lookup(read.barcode.gtin, false);
      const message =
        read?.kind === "refused"
          ? read.message
          : "Couldn't find a barcode in that picture. Try a closer, sharper photo, or type the numbers.";
      setProblem(message);
      setAnnounce(message);
    } catch {
      const message = "Couldn't open that picture. Try another, or type the numbers.";
      setProblem(message);
      setAnnounce(message);
    }
  };

  const rescan = () => {
    setProposal(null);
    turnOnCamera();
  };
  const finish = (again: boolean) => {
    if (again) {
      setAnnounce("Added. Ready for the next one.");
      turnOnCamera();
    } else {
      onOpenChange(false);
    }
  };

  return (
    <div className="space-y-4" data-vaul-no-drag>
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>

      {/* The camera view stays mounted so the stream can attach to it; it's only shown while scanning. */}
      <div className={view === "camera" ? "space-y-3" : "hidden"}>
        <div className="relative aspect-[4/3] overflow-hidden rounded-2xl bg-ink">
          <video ref={videoRef} playsInline muted autoPlay className="size-full object-cover" aria-label="Camera view" />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-[10%] inset-y-[28%] rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgb(0_0_0/0.35)]"
          />
          {cameraState === "starting" && (
            <div className="absolute inset-0 flex items-center justify-center bg-ink/60 text-white">
              <Spinner label="Starting the camera" />
            </div>
          )}
        </div>
        <p className="text-center text-[14px] text-ink-2">{hint ?? "Hold the barcode inside the box, steady and well lit."}</p>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            block
            onClick={() => {
              stopCamera();
              setPhase("manual");
            }}
          >
            <Keyboard /> Type the numbers
          </Button>
          <Button
            variant="ghost"
            block
            onClick={() => {
              stopCamera();
              setPhase("intro");
            }}
          >
            Stop
          </Button>
        </div>
      </div>

      {view === "loading" && (
        <div className="flex justify-center py-12">
          <Spinner label="Getting ready" />
        </div>
      )}

      {view === "plan" && (
        <div className="space-y-4">
          <h3 ref={headingRef} tabIndex={-1} className="text-[17px] font-semibold tracking-[-0.015em] outline-none">
            Barcode scanning is part of Plenty Plus
          </h3>
          <UpgradeNote plan="plus" feature="barcode">
            Scanning barcodes is included in Plenty Plus. Typing what you&apos;ve got, and scanning a receipt, work on every plan.
          </UpgradeNote>
          <Button block variant="secondary" onClick={onBack}>
            Back to typing
          </Button>
        </div>
      )}

      {(view === "intro" || view === "manual") && (
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-brand-soft text-brand-ink">
              {cameraProblem ? <CameraOff /> : <ScanBarcode />}
            </div>
            <div>
              <h3 ref={headingRef} tabIndex={-1} className="text-[17px] font-semibold tracking-[-0.015em] outline-none">
                {view === "manual" ? "Type the numbers" : "Scan a barcode"}
              </h3>
              <p className="mt-0.5 text-[14px] text-ink-3">
                {phase === "manual"
                  ? "They're printed under the barcode, usually 8 to 13 digits."
                  : "Plenty will ask to use your camera. It reads the barcode on your device and nothing is recorded or uploaded."}
              </p>
            </div>
          </div>

          {(problem || cameraProblem) && (
            <p role="alert" className="rounded-xl bg-alert-soft px-3.5 py-3 text-[14px] text-alert">
              {problem ?? cameraProblem}
            </p>
          )}

          {view === "intro" && (
            <>
              <Button size="lg" variant="brand" block onClick={turnOnCamera}>
                <Camera /> Turn on camera
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  block
                  onClick={() => {
                    setProblem(null);
                    setPhase("manual");
                  }}
                >
                  <Keyboard /> Type the numbers
                </Button>
                <Button variant="secondary" block onClick={() => fileRef.current?.click()}>
                  <ImageUp /> Choose a photo
                </Button>
              </div>
            </>
          )}

          {view === "manual" && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                submitTyped();
              }}
            >
              <Field label="Barcode number" htmlFor="scan-typed" error={problem}>
                <Input
                  id="scan-typed"
                  value={typed}
                  onChange={(e) => {
                    setTyped(e.target.value);
                    setProblem(null);
                  }}
                  inputMode="numeric"
                  autoComplete="off"
                  autoFocus
                  maxLength={40}
                  placeholder="e.g. 9300633603341"
                  aria-invalid={problem ? true : undefined}
                  enterKeyHint="search"
                />
              </Field>
              <Button size="lg" block type="submit" disabled={!typed.trim()}>
                Look it up
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" block onClick={turnOnCamera}>
                  <Camera /> Use the camera
                </Button>
                <Button type="button" variant="ghost" block onClick={() => fileRef.current?.click()}>
                  <ImageUp /> Choose a photo
                </Button>
              </div>
            </form>
          )}

          <p className="text-[12.5px] leading-relaxed text-ink-3">
            {access?.barcode.publicLookup
              ? "If Plenty doesn't already know a barcode, it asks Open Food Facts, a public product database, about that number. Only the number is sent, never a picture or anything about you."
              : "Plenty looks barcodes up in what your household has told it before. Nothing is sent anywhere."}
          </p>
        </div>
      )}

      {view === "looking" && (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <Spinner label="Looking it up" />
          <p className="text-[14px] text-ink-3">Looking that up…</p>
        </div>
      )}

      {view === "review" && proposal && (
        <BarcodeReview key={reviewKey} proposal={proposal} headingRef={headingRef} onAdded={finish} onRescan={rescan} />
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void onFile(file);
        }}
      />
    </div>
  );
}
