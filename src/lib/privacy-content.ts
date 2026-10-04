/**
 * What Plenty says about the data it handles, in one place, so the in-app
 * Privacy & data page and the public Privacy Policy tell the same story. Every
 * statement here describes what the code does today (see docs/compliance/data-map.md
 * for where each is enforced); when behaviour changes, change the sentence in the
 * same commit and bump LEGAL_LAST_UPDATED.
 */

export interface DataGroup {
  id: string;
  title: string;
  /** What is collected. */
  collects: string[];
  /** Why. */
  why: string;
  /** Who else handles it. */
  sharedWith: string;
  /** How long it's kept. */
  kept: string;
}

export const DATA_GROUPS: DataGroup[] = [
  {
    id: "account",
    title: "Your account",
    collects: [
      "Your email address and the name you choose",
      "Your password, kept only as a salted one-way hash. Plenty can't read it",
      "Your sign-in sessions: a hashed token, when you last used it and your browser's description",
      "Your notification settings, and your analytics choice (off until you turn it on)",
    ],
    why: "To sign you in, keep your account secure, and send the emails you ask for (password resets, and notification emails if you turn them on).",
    sharedWith: "The hosting and database provider; an email delivery provider, only to send you email.",
    kept: "Until you delete your account. A session ends after 30 days without use.",
  },
  {
    id: "household",
    title: "Your household and kitchen",
    collects: [
      "The household's name, size, time zone and currency",
      "The people in it: names, colours and roles, including profiles for people who don't have an account",
      "What's in your kitchen: item names, amounts, where they're kept, expiry dates, who an item belongs to, notes, and the price when it came from a receipt",
      "Shopping lists, requests, recurring items, meal plans, recipes you add, and ratings",
      "Food preferences: diets, allergies and dislikes (for the household and for each person), favourite cuisines, budget, preferred shops and shopping day",
    ],
    why: "To run your kitchen, list and meal plans, and to keep meal suggestions safe for the allergies and diets in your household. Diets and allergies can reveal health information, so Plenty uses them only to filter meals.",
    sharedWith: "The hosting and database provider. Nothing goes to anyone else, unless you allow AI features (then see below).",
    kept: "Until you delete the item, the household or your account.",
  },
  {
    id: "receipts",
    title: "Receipts",
    collects: [
      "The receipt photo you upload, stored privately on Plenty's server (resized, with camera and location details removed)",
      "What was read from it: the store, date, total, and each line's name, quantity and price",
      "The receipt's text, with card, loyalty and phone numbers, email addresses, street addresses and names removed before it's saved",
      "A fingerprint of the photo, and of the store, date and prices, so the same receipt isn't added twice",
    ],
    why: "To fill your kitchen from a receipt, learn what you buy, and spot duplicates. Receipts are for your records of groceries; Plenty doesn't give financial advice.",
    sharedWith: "The hosting and database provider. The photo goes to an outside AI service only if you've allowed it (see below).",
    kept: "The photo: as you choose below. The default is to delete it once you've checked the receipt; a photo you never check is deleted after 14 days. The items, store, date and total stay until you delete them or your household.",
  },
  {
    id: "learning",
    title: "What Plenty learns",
    collects: [
      "When things were bought, opened, finished, wasted or thrown out",
      "Usage rates it works out from that, for your household and (on the Family plan) for each person",
      "Run-out estimates and the reasons for them",
      "Receipt wording you've corrected, so it's recognised next time, and your meal likes and dislikes",
    ],
    why: "To estimate when you'll run out and what to buy. These are estimates from your own history, not guarantees.",
    sharedWith: "The hosting and database provider only.",
    kept: "Until you delete the household or your account. What Plenty learned from a person's private items is deleted when they leave.",
  },
  {
    id: "analytics",
    title: "Usage analytics",
    collects: [
      "A short event name (like “receipt confirmed”) and the time",
      "A pseudonymous household key: a scrambled code, not the household's id",
      "The plan, the platform (web, iPhone or Android) and a few fixed values like a count of lines",
    ],
    why: "To see which parts of Plenty are used so they can be improved. Analytics never includes names, emails, item names, receipt text or IP addresses, and uses no advertising identifiers or third-party analytics tools.",
    sharedWith: "Nobody. Analytics stays on Plenty's own server.",
    kept: "For up to 13 months, or until you delete the household. It's off until you turn it on for yourself in Privacy & data, and you can turn it off again at any time.",
  },
  {
    id: "security",
    title: "Security and abuse protection",
    collects: ["Counts of recent sign-in, sign-up and password-reset attempts, by email address and IP address"],
    why: "To slow down people guessing passwords or sending lots of requests.",
    sharedWith: "The hosting and database provider only.",
    kept: "These counters are deleted after a day.",
  },
];

/** Who can see what inside a household. Matches the database's row-level security. */
export const VISIBILITY_RULES: string[] = [
  "Private items are visible only to the person they belong to. Not to other members, and not to household owners either. What Plenty learns from a private item stays private too.",
  "Items marked for the household are visible to everyone in it. Items assigned to a person (but not private) are visible to everyone, with their name on them.",
  "Each person's own food rules (diets, allergies, dislikes) are visible to that person, and to an owner for a profile without an account or a child. Meal suggestions use everyone's rules combined, without saying whose.",
  "Owners can add and remove people, send invitations and manage the plan. Members use everything day to day, including receipts and prices. Only owners see other people's email addresses.",
  "A Child account sees what the household shares and can ask for things. It can't see receipts or prices, or change settings.",
  "Households are completely separate from each other. A person only ever sees households they belong to.",
];

/** How children fit in. Plain and specific. */
export const CHILDREN_TEXT: string[] = [
  "Plenty is for adults running a household. It isn't directed at children, and it has no features aimed at attracting them.",
  "A child can be part of a household in two ways, both set up and managed by an adult: as a profile with no account (just a name, so food can be assigned to them and they can have requests made for them), or on a restricted Child account that an adult invites them to. Child accounts can't see receipts, prices or settings.",
  "You must be 18 or over to create an account. If you're a parent or guardian and think a child has an account you didn't set up, contact us and we'll delete it.",
];

export interface ProcessorConfig {
  email: boolean;
  stripe: boolean;
  apple: boolean;
  google: boolean;
  aiConfigured: boolean;
  aiProviderName: string;
  /** Unknown barcodes may be looked up in the public Open Food Facts database. */
  barcodeLookup: boolean;
}

export interface Processor {
  name: string;
  role: string;
  /** What they receive. */
  receives: string;
  /** When. */
  when: string;
}

/** The outside companies that handle data for this Plenty, as configured. Only what's actually set up is listed. */
export function processorsFor(cfg: ProcessorConfig): Processor[] {
  const list: Processor[] = [
    {
      name: "Hosting and database",
      role: "Runs Plenty and stores everything above.",
      receives: "All the data described above, encrypted in transit; stored on infrastructure chosen by whoever runs this Plenty.",
      when: "Always.",
    },
  ];
  if (cfg.email) {
    list.push({ name: "Email delivery", role: "Sends the emails Plenty sends you.", receives: "Your email address and the message (a password reset link, an invitation or a notification).", when: "Only when an email is sent." });
  }
  if (cfg.stripe) {
    list.push({ name: "Stripe", role: "Takes payment for subscriptions bought on the web.", receives: "Your email address and the plan you choose. Your card details go to Stripe's page; Plenty never sees or stores them.", when: "Only if you buy a plan on the web." });
  }
  if (cfg.apple) {
    list.push({ name: "Apple", role: "Takes payment for subscriptions bought in the iPhone app.", receives: "Plenty receives your subscription's status and an identifier from Apple. Apple has your payment details; Plenty never does.", when: "Only if you buy a plan in the iPhone app." });
  }
  if (cfg.google) {
    list.push({ name: "Google Play", role: "Takes payment for subscriptions bought in the Android app.", receives: "Plenty receives your subscription's status and an identifier from Google. Google has your payment details; Plenty never does.", when: "Only if you buy a plan in the Android app." });
  }
  if (cfg.barcodeLookup) {
    list.push({
      name: "Open Food Facts",
      role: "A public product database, used to name a barcode Plenty doesn't know yet.",
      receives: "The barcode number and nothing else — no account, household or location detail from Plenty.",
      when: "Only when you scan a barcode that isn't already known to your household (Plus).",
    });
  }
  if (cfg.aiConfigured) {
    list.push({
      name: cfg.aiProviderName,
      role: "An outside AI service that can read receipt photos, recognise groceries in a photo and write recipe ideas.",
      receives: "Only what you allowed: the receipt or grocery photo, or your kitchen and food preferences, when you use that feature. A grocery photo is not stored. Never your name, email or the rest of your account.",
      when: "Only after someone in your household turns it on, and only on a plan that includes it. Off by default.",
    });
  }
  return list;
}

/** What happens when you delete things. */
export const DELETION_TEXT = {
  household: "Deleting a household removes everything in it for everyone: people's profiles, kitchen, lists, meal plans, receipts and their photos, what Plenty learned, notifications, usage and subscription records and analytics.",
  account: "Deleting your account removes your sign-in and personal settings. A household where you're the only person with an account is deleted with everything in it. In a household others use, you leave: your private items and personal patterns are deleted and what you shared stays with the household. If you're its only owner, make someone else an owner first.",
  subscriptions: "A subscription bought on the web is cancelled for you when its household is deleted (and the deletion stops if that can't be done). One bought through the App Store or Google Play can only be cancelled there: Plenty can't do it for you, so cancel it in the store or it may keep renewing.",
  backups: "Deleted data is removed from the live database straight away. If the hosting provider keeps database backups, deleted data ages out of them on the provider's schedule.",
};
