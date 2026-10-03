"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Barcode } from "@/lib/barcode";
import { loadBarcodeReader, type BarcodeReader, type ScanRead } from "./barcode-decoder";

export type CameraState =
  | "idle"
  | "starting"
  | "scanning"
  /** The person (or their browser settings) said no to the camera. */
  | "denied"
  | "no_camera"
  /** Another app is using it. */
  | "busy"
  /** The page isn't on https, so the browser won't offer the camera. */
  | "insecure"
  /** The scanner couldn't be loaded or started for another reason. */
  | "error"
  /** Stopped because the page went to the background. */
  | "paused";

/** The same number must be read twice within this long before it counts, so a one-frame misread can't slip through. */
const CONFIRM_WITHIN_MS = 2000;
const TICK_NATIVE_MS = 120;
const TICK_WASM_MS = 220;

function stateForError(err: unknown): CameraState {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "no_camera";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  return "error";
}

/**
 * Drives the camera for barcode scanning. The camera is only asked for when
 * `start()` is called (from a tap), frames are decoded on the device and
 * thrown away, and the stream is always stopped: on `stop()`, on unmount, and
 * when the page goes to the background.
 */
export function useCameraScanner({ onBarcode, onRefused }: { onBarcode: (barcode: Barcode, format: string | undefined) => void; onRefused: (message: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<CameraState>("idle");
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runRef = useRef(0);
  const candidate = useRef<{ gtin: string; at: number } | null>(null);
  const lastRefusal = useRef<string | null>(null);
  const callbacks = useRef({ onBarcode, onRefused });
  useEffect(() => {
    callbacks.current = { onBarcode, onRefused };
  });

  const release = useCallback(() => {
    runRef.current += 1; // ends any loop in flight
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    candidate.current = null;
  }, []);

  const stop = useCallback(() => {
    release();
    setState("idle");
  }, [release]);

  const start = useCallback(async () => {
    release();
    const run = runRef.current;
    lastRefusal.current = null;
    if (!navigator.mediaDevices?.getUserMedia) {
      setState(window.isSecureContext ? "no_camera" : "insecure");
      return;
    }
    setState("starting");
    let reader: BarcodeReader;
    let stream: MediaStream;
    try {
      const readerPromise = loadBarcodeReader();
      const constraints: MediaStreamConstraints = { audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } };
      stream = await navigator.mediaDevices.getUserMedia(constraints).catch((err: unknown) => {
        if ((err as { name?: string } | null)?.name === "OverconstrainedError") return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        throw err;
      });
      if (run !== runRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      try {
        reader = await readerPromise;
      } catch {
        stream.getTracks().forEach((t) => t.stop());
        setState("error");
        return;
      }
    } catch (err) {
      if (run === runRef.current) setState(stateForError(err));
      return;
    }
    const video = videoRef.current;
    if (run !== runRef.current || !video) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      release();
      setState("error");
      return;
    }
    if (run !== runRef.current) return;
    setState("scanning");

    const tick = async () => {
      if (run !== runRef.current) return;
      let read: ScanRead | null = null;
      try {
        if (video.readyState >= 2) read = await reader.readVideo(video);
      } catch {
        read = null;
      }
      if (run !== runRef.current) return;
      if (read?.kind === "found") {
        const now = Date.now();
        const seen = candidate.current;
        if (seen && seen.gtin === read.barcode.gtin && now - seen.at <= CONFIRM_WITHIN_MS) {
          release();
          setState("idle");
          navigator.vibrate?.(40);
          callbacks.current.onBarcode(read.barcode, read.format);
          return;
        }
        candidate.current = { gtin: read.barcode.gtin, at: now };
      } else if (read?.kind === "refused" && lastRefusal.current !== read.reason) {
        lastRefusal.current = read.reason;
        callbacks.current.onRefused(read.message);
      }
      timerRef.current = setTimeout(tick, reader.kind === "native" ? TICK_NATIVE_MS : TICK_WASM_MS);
    };
    void tick();
  }, [release]);

  // Never leave the camera on when the page is hidden or the component goes away.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden && streamRef.current) {
        release();
        setState("paused");
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      release();
    };
  }, [release]);

  return { videoRef, state, start, stop };
}
