import { LegalFrame } from "@/features/legal/legal-ui";

// Public pages: no sign-in. They read the operator's details from the environment at request time.
export const dynamic = "force-dynamic";

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return <LegalFrame>{children}</LegalFrame>;
}
