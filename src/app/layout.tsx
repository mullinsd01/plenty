import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Toaster } from "@/components/ui/toaster";
import "./globals.css";

const figtree = localFont({
  src: [
    { path: "./fonts/figtree-latin.woff2", weight: "300 900", style: "normal" },
    { path: "./fonts/figtree-latin-ext.woff2", weight: "300 900", style: "normal" },
  ],
  variable: "--font-figtree",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Plenty — Your household, figured out.",
    template: "%s · Plenty",
  },
  description:
    "Plenty learns what your household buys, has and uses — then tells you what's running low, what to cook tonight, and what to buy next.",
  applicationName: "Plenty",
  appleWebApp: { capable: true, title: "Plenty", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf8f5" },
    { media: "(prefers-color-scheme: dark)", color: "#111214" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-AU" className={`${figtree.variable} h-full antialiased`}>
      <body className="min-h-full bg-canvas font-sans text-ink">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
