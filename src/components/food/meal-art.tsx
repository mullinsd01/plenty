import { cn } from "@/lib/cn";

/**
 * A calm visual stand-in for recipe photography: a soft colour field keyed to
 * the hero ingredient, with the ingredient set in small type. Deliberately
 * not stock imagery. Replace with real photos by passing `src`.
 */
const PALETTES: Array<{ match: RegExp; bg: string; fg: string; accent: string }> = [
  { match: /spinach|kale|broccoli|zucchini|pea|green|herb|pesto|avocado|lettuce|cucumber|asparagus|bean/, bg: "#e6efe0", fg: "#40603a", accent: "#c9dcbf" },
  { match: /salmon|fish|tuna|prawn|shrimp|seafood|barramundi|cod|snapper|mussel/, bg: "#e3ecf1", fg: "#3b5a6d", accent: "#c6d8e2" },
  { match: /tomato|chilli|capsicum|pepper|beef|lamb|chorizo|beetroot|berry|red/, bg: "#f6e2dc", fg: "#8a3f2c", accent: "#ecc8bd" },
  { match: /chicken|egg|curry|corn|pumpkin|potato|sweet potato|lentil|chickpea|dal|turmeric|squash/, bg: "#f7ecd6", fg: "#80602a", accent: "#ecd9b0" },
  { match: /mushroom|pork|sausage|noodle|soy|miso|tofu|rice|bread|pasta|risotto/, bg: "#efe8e0", fg: "#6a5847", accent: "#ddd0c2" },
];
const DEFAULT = { bg: "#eeeae4", fg: "#5f5a52", accent: "#ddd6cc" };

export function mealPalette(mainIngredient: string, name = "") {
  const key = `${mainIngredient} ${name}`.toLowerCase();
  return PALETTES.find((p) => p.match.test(key)) ?? DEFAULT;
}

export function MealArt({
  mainIngredient,
  name,
  className,
  size = "md",
}: {
  mainIngredient: string;
  name: string;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const p = mealPalette(mainIngredient, name);
  const label = (mainIngredient || name).split(/\s+/).slice(0, 2).join(" ");
  return (
    <div
      aria-hidden
      className={cn(
        "relative flex shrink-0 items-end overflow-hidden",
        size === "sm" && "size-12 rounded-xl p-1.5",
        size === "md" && "size-16 rounded-2xl p-2",
        size === "lg" && "aspect-[16/9] w-full rounded-2xl p-4",
        className,
      )}
      style={{ background: p.bg }}
    >
      <svg viewBox="0 0 100 100" className="absolute -right-[18%] -top-[18%] h-[95%] w-auto opacity-90" aria-hidden>
        <circle cx="50" cy="50" r="46" fill={p.accent} />
        <circle cx="50" cy="50" r="30" fill="none" stroke={p.bg} strokeWidth="3" opacity="0.7" />
      </svg>
      <span
        className={cn(
          "relative font-semibold uppercase leading-none tracking-[0.08em]",
          size === "sm" && "hidden",
          size === "md" && "text-[8px]",
          size === "lg" && "text-[11px]",
        )}
        style={{ color: p.fg }}
      >
        {label}
      </span>
    </div>
  );
}
