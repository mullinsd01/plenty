import { Bell, CircleUser, CreditCard, Lock, ShoppingBasket, Users, UtensilsCrossed, type LucideIcon } from "lucide-react";

export const SETTINGS_SECTIONS: Array<{
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Also shown to child accounts, which can't change household settings. */
  childSafe?: boolean;
}> = [
  { href: "/settings/account", label: "Account", description: "Name, email, password", icon: CircleUser, childSafe: true },
  { href: "/settings/household", label: "Household & sharing", description: "Who's in it, invites", icon: Users, childSafe: true },
  { href: "/settings/food", label: "Food preferences", description: "Allergies, diets, dislikes, cuisines", icon: UtensilsCrossed },
  { href: "/settings/shopping", label: "Shopping & budget", description: "Stores, budget, shopping day", icon: ShoppingBasket },
  { href: "/settings/notifications", label: "Notifications", description: "What Plenty nudges you about", icon: Bell, childSafe: true },
  { href: "/settings/plan", label: "Plan & billing", description: "Your plan, usage and billing", icon: CreditCard },
  { href: "/settings/privacy", label: "Privacy & data", description: "AI permission, photos, analytics, export, delete", icon: Lock },
];
