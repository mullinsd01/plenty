"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { joinHouseholdAction } from "./join-actions";

export function JoinButton({ code }: { code: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="lg"
      block
      loading={pending}
      onClick={() =>
        start(async () => {
          const res = await joinHouseholdAction(code);
          if (res && !res.ok) toast.error(res.error);
        })
      }
    >
      Join household
    </Button>
  );
}
