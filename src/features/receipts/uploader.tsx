"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Camera, CircleAlert, ImageUp, Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";

const MAX_EDGE = 2000;
const SAMPLES = [
  { file: "/demo/receipts/woolworths-weekly.png", label: "Woolworths weekly shop" },
  { file: "/demo/receipts/coles-topup.png", label: "Coles top-up" },
  { file: "/demo/receipts/aldi-shop.png", label: "Aldi shop" },
];

/** Shrink big phone photos before upload: faster on mobile data, same OCR quality. */
async function compress(file: Blob): Promise<Blob> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 2_500_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    return blob ?? file;
  } catch {
    return file; // e.g. HEIC in browsers that can't decode it — the server will handle it.
  }
}

function upload(blob: Blob, allowDuplicate: boolean, onProgress: (p: number) => void): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/receipts");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.response });
    xhr.onerror = () => reject(new Error("network"));
    const form = new FormData();
    form.append("file", blob, "receipt.jpg");
    if (allowDuplicate) form.append("allowDuplicate", "true");
    xhr.send(form);
  });
}

type Stage =
  | { kind: "idle" }
  | { kind: "uploading"; progress: number; preview: string }
  | { kind: "duplicate"; receiptId: string; date: string | null; added: boolean; blob: Blob; preview: string }
  | { kind: "error"; message: string };

export function ReceiptUploader({ notice }: { notice?: React.ReactNode }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  const send = useCallback(
    async (original: Blob, allowDuplicate = false) => {
      const preview = URL.createObjectURL(original);
      setStage({ kind: "uploading", progress: 0, preview });
      try {
        const blob = await compress(original);
        const res = await upload(blob, allowDuplicate, (p) => setStage({ kind: "uploading", progress: p, preview }));
        const body = (res.body ?? {}) as {
          receiptId?: string;
          duplicateOf?: { id: string; date: string | null; status?: string } | null;
          error?: string;
        };
        if (res.status === 401) {
          router.push("/login?next=/receipts/new");
          return;
        }
        if (res.status >= 400 || !body.receiptId) {
          setStage({ kind: "error", message: body.error ?? "That upload didn't work. Please try again." });
          return;
        }
        if (body.duplicateOf) {
          setStage({
            kind: "duplicate",
            receiptId: body.duplicateOf.id,
            date: body.duplicateOf.date,
            added: body.duplicateOf.status === "confirmed",
            blob: original,
            preview,
          });
          return;
        }
        router.push(`/receipts/${body.receiptId}`);
      } catch {
        setStage({ kind: "error", message: "Couldn't reach Plenty. Check your connection and try again." });
      }
    },
    [router],
  );

  const onFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/") && !/\.(heic|heif)$/i.test(file.name)) {
      setStage({ kind: "error", message: "That isn't a photo. Choose a JPEG, PNG or HEIC image of your receipt." });
      return;
    }
    void send(file);
  };

  const trySample = async (url: string) => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error();
      void send(await res.blob());
    } catch {
      setStage({ kind: "error", message: "Couldn't load the sample receipt." });
    }
  };

  if (stage.kind === "uploading") {
    return (
      <Card className="overflow-hidden">
        <div className="flex flex-col items-center px-6 py-12 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={stage.preview} alt="Your receipt" className="mb-6 h-40 w-auto rounded-lg object-contain shadow-raised" />
          <p className="text-[15px] font-semibold">Uploading…</p>
          <div className="mt-4 h-1.5 w-56 overflow-hidden rounded-full bg-sunken">
            <div className="h-full rounded-full bg-brand transition-[width] duration-200" style={{ width: `${Math.max(6, stage.progress * 100)}%` }} />
          </div>
        </div>
      </Card>
    );
  }

  if (stage.kind === "duplicate") {
    return (
      <Card className="p-6">
        <div className="flex gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={stage.preview} alt="" className="h-24 w-auto rounded-md object-contain shadow-card" />
          <div>
            {stage.added ? (
              <>
                <p className="text-[16px] font-semibold">You&apos;ve already added this receipt</p>
                <p className="mt-1 text-[14px] text-ink-3">
                  This exact photo was uploaded before{stage.date ? ` (shopping on ${stage.date})` : ""}. Adding it again would double up your kitchen.
                </p>
              </>
            ) : (
              <>
                <p className="text-[16px] font-semibold">You&apos;ve already uploaded this photo</p>
                <p className="mt-1 text-[14px] text-ink-3">
                  It hasn&apos;t gone into your kitchen yet{stage.date ? ` (shopping on ${stage.date})` : ""}. Open it to check it and add it from there.
                </p>
              </>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link href={`/receipts/${stage.receiptId}`}>View that receipt</Link>
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void send(stage.blob, true)}>
                Add it anyway
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setStage({ kind: "idle" })}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {notice}
      {stage.kind === "error" && (
        <div role="alert" className="flex gap-3 rounded-2xl bg-alert-soft px-4 py-3.5 text-[14px] text-alert">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {stage.message}
        </div>
      )}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFiles(e.dataTransfer.files);
        }}
        className={cn(
          "rounded-[22px] border-2 border-dashed bg-surface px-6 py-12 text-center transition sm:py-16",
          dragging ? "border-brand bg-brand-soft/40" : "border-line-strong",
        )}
      >
        <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-brand-soft text-brand-ink">
          <Camera className="size-7" />
        </div>
        <h2 className="text-[20px] font-semibold tracking-[-0.02em]">Snap your receipt</h2>
        <p className="mx-auto mt-2 max-w-sm text-[15px] text-ink-3">
          Plenty reads it, tidies up the names and gets everything ready for your kitchen. You&apos;ll check it before anything changes.
        </p>
        <div className="mt-7 flex flex-col items-center justify-center gap-2 sm:flex-row">
          <Button variant="brand" size="lg" onClick={() => cameraRef.current?.click()} className="w-full sm:w-auto">
            <Camera /> Take a photo
          </Button>
          <Button variant="secondary" size="lg" onClick={() => libraryRef.current?.click()} className="w-full sm:w-auto">
            <ImageUp /> Choose a photo
          </Button>
        </div>
        <p className="mt-4 hidden text-[13px] text-ink-4 sm:block">or drop an image here</p>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => onFiles(e.target.files)} />
        <input ref={libraryRef} type="file" accept="image/*,.heic,.heif" className="sr-only" onChange={(e) => onFiles(e.target.files)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-center gap-2 text-[14px] font-semibold">
            <Lightbulb className="size-4 text-soon" /> For the best read
          </div>
          <ul className="mt-2 space-y-1.5 text-[14px] text-ink-3">
            <li>Lay the receipt flat in good light</li>
            <li>Fit the whole receipt in the frame</li>
            <li>Long receipt? Fold it — just keep the item lines</li>
          </ul>
        </Card>
        <Card className="p-5">
          <p className="text-[14px] font-semibold">No receipt handy?</p>
          <p className="mt-1 text-[14px] text-ink-3">Try a sample to see how it works.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {SAMPLES.map((s) => (
              <button
                key={s.file}
                type="button"
                onClick={() => void trySample(s.file)}
                className="h-8 rounded-full border border-line-strong px-3 text-[13px] font-medium text-ink-2 transition hover:bg-subtle hover:text-ink"
              >
                {s.label}
              </button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
