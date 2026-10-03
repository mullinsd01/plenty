import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { ReceiptUploader } from "@/features/receipts/uploader";
import { AiConsentPrompt } from "@/features/privacy/ai-consent";
import { requireHousehold } from "@/server/auth/context";
import { getAiConsentView } from "@/server/services/privacy";

export const metadata: Metadata = { title: "Scan a receipt" };

export default async function NewReceiptPage() {
  const ctx = await requireHousehold();
  // Where a photo is about to be uploaded: say plainly whether it goes to an outside AI service, and ask first if it could.
  const ai = await getAiConsentView(ctx);
  return (
    <div className="mx-auto max-w-2xl animate-fade-in">
      <PageHeader back={{ href: "/receipts", label: "Receipts" }} title="Scan a receipt" subtitle="Nothing changes in your kitchen until you've checked it." />
      <ReceiptUploader notice={<AiConsentPrompt view={ai} />} />
    </div>
  );
}
