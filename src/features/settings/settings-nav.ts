import { Bell, CircleUser, Lock, ShoppingBasket, Users, UtensilsCrossed, type LucideIcon } from "lucide-react";

export const SETTINGS_SECTIONS: Array<{ href: string; label: string; description: string; icon: LucideIcon }> = [
  { href: "/settings/account", label: "Account", description: "Name, email, password", icon: CircleUser },
  { href: "/settings/household", label: "Household & sharing", description: "Who's in it, invites", icon: Users },
  { href: "/settings/food", label: "Food preferences", description: "Allergies, diets, dislikes, cuisines", icon: UtensilsCrossed },
  { href: "/settings/shopping", label: "Shopping & budget", description: "Stores, budget, shopping day", icon: ShoppingBasket },
  { href: "/settings/notifications", label: "Notifications", description: "What Plenty nudges you about", icon: Bell },
  { href: "/settings/privacy", label: "Privacy & data", description: "AI processing, export, delete", icon: Lock },
];
