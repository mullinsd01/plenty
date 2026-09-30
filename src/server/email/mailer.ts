import "server-only";
import { systemDb } from "@/server/db/client";
import { emailOutbox } from "@/server/db/schema";
import { env, isProduction } from "@/server/env";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

type Transport = { sendMail: (msg: { from: string; to: string; subject: string; text: string; html?: string }) => Promise<unknown> };
let transport: Transport | null = null;

async function getTransport(): Promise<Transport | null> {
  const url = env().SMTP_URL;
  if (!url) return null;
  if (!transport) {
    const nodemailer = await import("nodemailer");
    transport = nodemailer.createTransport(url) as Transport;
  }
  return transport;
}

/**
 * Send an email. With SMTP configured it is delivered for real; otherwise it
 * lands in the development outbox (visible at /dev/outbox outside production).
 * Delivery failures never break the calling flow — they're logged.
 */
export async function sendEmail(message: EmailMessage): Promise<{ delivered: boolean }> {
  const t = await getTransport();
  if (!t) {
    if (isProduction() && !env().EMAIL_OUTBOX) {
      console.warn(`[email] SMTP_URL not configured; dropping "${message.subject}" to ${message.to}`);
      return { delivered: false };
    }
    await systemDb.insert(emailOutbox).values({ ...message, sentAt: null });
    console.info(`[email] (dev outbox) "${message.subject}" → ${message.to}`);
    return { delivered: false };
  }
  try {
    await t.sendMail({ from: env().EMAIL_FROM, ...message });
    return { delivered: true };
  } catch (err) {
    console.error("[email] send failed:", err instanceof Error ? err.message : err);
    return { delivered: false };
  }
}

/** Escape text for safe interpolation into email HTML (text and attribute values). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Minimal, clean HTML wrapper for transactional email. `title` is plain text
 * and is escaped; `bodyHtml` must already be safe HTML (escape any user text).
 */
export function emailLayout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#faf8f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2a3a">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px">
    <div style="font-size:22px;font-weight:700;color:#f26b4f;letter-spacing:-0.02em;margin-bottom:28px">plenty</div>
    <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>
    <div style="font-size:15px;line-height:1.6;color:#3d4757">${bodyHtml}</div>
    <p style="font-size:12px;color:#8a919c;margin-top:40px">Plenty · Your household, figured out.</p>
  </div></body></html>`;
}

export function emailButton(href: string, label: string): string {
  return `<p style="margin:28px 0"><a href="${escapeHtml(href)}" style="background:#1f2a3a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;display:inline-block">${escapeHtml(label)}</a></p>`;
}
