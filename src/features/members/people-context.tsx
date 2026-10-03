"use client";

import { createContext, useContext, useMemo } from "react";
import { can, type Role } from "@/lib/members/permissions";
import type { MemberOption } from "@/lib/members/types";

export interface PeopleValue {
  members: MemberOption[];
  /** The signed-in person. */
  me: MemberOption | null;
  role: Role;
  /** The plan includes private items. */
  canPrivate: boolean;
  /** A child account: sees what's shared, changes only its own things. */
  restricted: boolean;
  /** May change anything the household shares (members and owners). */
  canEditHousehold: boolean;
}

const PeopleContext = createContext<PeopleValue>({
  members: [],
  me: null,
  role: "member",
  canPrivate: false,
  restricted: false,
  canEditHousehold: true,
});

/** Who's in the household and what the signed-in person may do, available to any screen without prop-drilling. */
export function PeopleProvider({
  members,
  role,
  canPrivate,
  children,
}: {
  members: MemberOption[];
  role: Role;
  canPrivate: boolean;
  children: React.ReactNode;
}) {
  const value = useMemo<PeopleValue>(
    () => ({
      members,
      me: members.find((m) => m.isYou) ?? null,
      role,
      canPrivate,
      restricted: role === "child",
      canEditHousehold: can(role, "edit_household_items"),
    }),
    [members, role, canPrivate],
  );
  return <PeopleContext.Provider value={value}>{children}</PeopleContext.Provider>;
}

export function usePeople(): PeopleValue {
  return useContext(PeopleContext);
}
