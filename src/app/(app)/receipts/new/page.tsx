import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { ReceiptUploader } from "@/features/receipts/uploader";
import { requireHousehold } from "@/server/auth/context";

export const metadata: Metadata = { title: "Scan a receipt" };

export default async function NewReceiptPage() {
  await requireHousehold();
  return (
    <div className="mx-auto max-w-2xl animate-fade-in">
      <PageHeader back={{ href: "/receipts", label: "Receipts" }} title="Scan a receipt" subtitle="Nothing changes in your kitchen until you've checked it." />
      <ReceiptUploader />
    </div>
  );
}
