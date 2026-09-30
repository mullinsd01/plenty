"use client";

import { useEffect } from "react";

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, sans-serif", background: "#faf8f5", color: "#1e2735" }}>
        <div style={{ maxWidth: 420, margin: "0 auto", padding: "96px 24px", textAlign: "center" }}>
          <h1 style={{ fontSize: 22, marginBottom: 8 }}>Plenty hit a snag</h1>
          <p style={{ color: "#7c8492", lineHeight: 1.6 }}>Something went wrong loading the app. Please try again.</p>
          <button
            onClick={() => retry()}
            style={{ marginTop: 20, background: "#1e2735", color: "#fff", border: 0, borderRadius: 10, padding: "10px 18px", fontWeight: 600 }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
