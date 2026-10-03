import { CookingPot, House, ReceiptText, Refrigerator, ShoppingBasket, Sprout, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown in the mobile tab bar. */
  tab?: boolean;
  /** Also shown to child accounts, which see what the household shares and nothing about receipts or spending. */
  childSafe?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/home", label: "Home", icon: House, tab: true, childSafe: true },
  { href: "/kitchen", label: "Kitchen", icon: Refrigerator, tab: true, childSafe: true },
  { href: "/meals", label: "Meals", icon: CookingPot, tab: true },
  { href: "/list", label: "Shopping list", icon: ShoppingBasket, tab: true, childSafe: true },
  { href: "/receipts", label: "Receipts", icon: ReceiptText },
  { href: "/insights", label: "What Plenty knows", icon: Sprout },
];

export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
