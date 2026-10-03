import type { Role } from "./permissions";

/** A person in the household as the UI needs them: for labels, chips and pickers. */
export interface MemberOption {
  id: string;
  name: string;
  /** The colour their chips are drawn in. */
  color: string;
  role: Role;
  /** The signed-in person. */
  isYou: boolean;
}
