import Link from "next/link";
import { PlentyMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[70dvh] max-w-md flex-col items-center justify-center px-6 text-center">
      <PlentyMark className="mb-6 h-10 opacity-80" />
      <h1 className="text-2xl font-semibold tracking-[-0.02em]">We couldn&apos;t find that</h1>
      <p className="mt-2 text-[15px] text-ink-3">It may have been moved, used up or removed.</p>
      <Button asChild className="mt-6">
        <Link href="/home">Back to home</Link>
      </Button>
    </div>
  );
}
