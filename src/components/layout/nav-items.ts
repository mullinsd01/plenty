import { CookingPot, House, ReceiptText, Refrigerator, ShoppingBasket, Sprout, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown in the mobile tab bar. */
  tab?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/home", label: "Home", icon: House, tab: true },
  { href: "/kitchen", label: "Kitchen", icon: Refrigerator, tab: true },
  { href: "/meals", label: "Meals", icon: CookingPot, tab: true },
  { href: "/list", label: "Shopping list", icon: ShoppingBasket, tab: true },
  { href: "/receipts", label: "Receipts", icon: ReceiptText },
  { href: "/insights", label: "What Plenty knows", icon: Sprout },
];

export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
