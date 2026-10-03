/**
 * Receipt minimisation: remove personal and financial details from receipt
 * text before Plenty stores it.
 *
 * What a grocery app needs from a receipt is the store, the date, what was
 * bought and what it cost. Everything else printed on the slip — card and
 * loyalty numbers, phone numbers, emails, street addresses, who served you,
 * terminal and approval codes — is not needed, so it is removed here, before
 * anything is written to the database.
 *
 * Rules this module keeps:
 *   - Item lines, quantities, weights, prices, totals, dates and times are
 *     never altered (there is a test over the catalog and every fixture).
 *   - Labels stay ("EVERYDAY REWARDS CARD", "VISA", "Served by") and only the
 *     identifying value is replaced, so the receipt is still readable and the
 *     parser classifies each line exactly as it did before.
 *   - In whole-receipt text the replacement is "▪▪▪": no letters or digits, so a
 *     line that was only a number stays a line the parser skips, and
 *     `parseReceiptText(redact(text))` gives the same result as
 *     `parseReceiptText(text)`. In an item line the value is simply removed,
 *     so the words that remain are exactly the words that were there.
 *   - The store name and its suburb/city stay (for the store label); the street
 *     and postcode go.
 *   - Idempotent: redacting already-redacted text changes nothing.
 *
 * Pure and deterministic; no I/O. Input is bounded (long lines are cut) so the
 * patterns below can never be made to run for long.
 */

/** What replaces a removed value. Small squares read as "something was here", and (unlike bullets or asterisks) are never mistaken for the mask of a card number. */
export const REDACTED = "▪▪▪";

/** Receipt lines are short; anything longer is cut before matching. */
export const MAX_REDACT_LINE = 400;
/** The most text that is processed (more is dropped, not stored). */
export const MAX_REDACT_TEXT = 40_000;

export type RedactionKind = "card" | "loyalty" | "phone" | "email" | "link" | "address" | "name" | "id";

export interface RedactionResult {
  text: string;
  /** How many values of each kind were removed. */
  removed: Record<RedactionKind, number>;
  /** Total values removed. */
  total: number;
}

type Counts = Record<RedactionKind, number>;

const emptyCounts = (): Counts => ({ card: 0, loyalty: 0, phone: 0, email: 0, link: 0, address: 0, name: 0, id: 0 });

// ─── Cleaning ───────────────────────────────────────────────────────────────

/** Fold look-alike characters and drop invisible ones, so "４１１１" or "4​1​1​1" can't hide a number. */
function cleanInput(text: string): string {
  return (
    text
      .normalize("NFKC")
      // Zero-width characters, soft hyphens, bidi controls and the BOM: invisible, used to split numbers.
      .replace(/[­​-‏‪-‮⁠-⁤﻿]/g, "")
      // Other control characters (keep tab and newlines, which are handled as line breaks).
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
      .replace(/[  -   　]/g, " ")
      .replace(/[‐-―−]/g, "-")
  );
}

// ─── Patterns ───────────────────────────────────────────────────────────────

const MASK = "[*•xX#]";

/** Email addresses, with the usual OCR spacing damage around "@" and "." tolerated when the local part has letters. */
const EMAIL = /[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}\b/g;
const EMAIL_SPACED =
  /\b[A-Za-z][A-Za-z0-9_%+'-]{0,63}(?:\s?\.\s?[A-Za-z0-9_%+'-]{1,30}){0,4}\s?@\s?[A-Za-z0-9-]{1,63}(?:\s?\.\s?[A-Za-z0-9-]{1,63}){0,4}\s?\.\s?(?:com|net|org|edu|gov|info|biz|io|co|au|nz|uk|us|ca|de|fr)\b/gi;

/** Web addresses, including bare ones with a common suffix ("survey.example.com/abc123"). */
const LINK =
  /\b(?:https?:\/\/|www\.)[^\s<>"']{1,200}|\b[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,4}\.(?:com|net|org|io|app)(?:\.[a-z]{2})?(?:\/[^\s<>"']{0,200})?(?![a-z0-9])|\b[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,4}\.(?:co|au|nz|uk|us|ca|de|fr)\/[^\s<>"']{0,200}/gi;

/** Digits with a little spacing or hyphens between them: 13 or more is a card number (or something just as unneeded). */
const LONG_DIGITS = /(?<![\d])(?:\d[ -]{0,3}){12,}\d(?!\d)/g;
/** Card-style groups joined by other separators: 4111.1111.1111.1111, 4111/1111/1111/1111. */
const GROUPED_DIGITS = /(?<![\d])\d{4}([./_\\])\d{4}\1\d{4}\1\d{1,7}(?!\d)/g;
/** A long digit run damaged by OCR (O for 0, l or I for 1). */
const LOOKALIKE_DIGITS = /(?<![A-Za-z\d])[0-9OoIl](?:[ -]{0,3}[0-9OoIl]){12,}(?![A-Za-z\d])/g;
/** ****1234, **** **** **** 1234, XXXX-XXXX-XXXX-1234, 411111******1111, 6008 **** **** 1234. */
// Written so a long run of mask characters can only be split one way (groups need a separator between them
// and a run can't start inside another run), which keeps matching linear however many asterisks or x's there are.
const MASKED_CARD = new RegExp(String.raw`(?<![A-Za-z\d*•xX#])(?:\d{2,8}[ -]?)?(?:${MASK}{2,}[ -]){0,4}${MASK}{2,}[ -]?\d{2,6}(?![.,]?\d)`, "g");
/** "ending 1234", "ends in 1234", "last 4 digits: 1234", "x-1234". */
const CARD_TAIL = /\b(?:(?:card\s+)?ending(?:\s+in)?|ends(?:\s+in)?|last\s+(?:4|four)(?:\s+digits)?(?:\s+of(?:\s+card)?)?)\s*[:#-]?\s*\d{2,4}\b/gi;
/** A card scheme followed by its tail: "VISA ending 1234", "Mastercard 1234". Replaces the scheme and the tail. */
const SCHEME_TAIL = /\b(?:visa|master\s?card|maestro|amex|american\s+express|diners(?:\s+club)?|discover|jcb|union\s?pay|eftpos)(?:\s+(?:debit|credit|card))?\s+(?:(?:card\s+)?ending(?:\s+in)?|ends(?:\s+in)?|no\.?|number|#)?\s*[:#-]?\s*(?:[*•xX#.]{0,16}\s?)?\d{4}\b(?![.,]?\d)/gi;

/** A phone number after a label ("Ph", "Tel", "Mobile", "Call us on", "Customer care"). */
const LABELLED_PHONE =
  /\b((?:ph(?:one)?|tel(?:ephone)?|mob(?:ile)?|cell|fax|call(?:\s+us)?(?:\s+on)?|contact(?:\s+us)?(?:\s+on)?|help\s?line|customer\s+(?:care|service)s?(?:\s+line)?|enquiries|inquiries)\b\.?\s*[:\-#]?\s*)(?:\+\s?)?\(?\d[\d\s().\-]{4,20}\d/gi;
/** Phone numbers recognisable by their shape alone. */
const PHONE_SHAPES: readonly RegExp[] = [
  // International: +61 2 9000 1234, +44 20 7946 0958, +1 555 123 4567.
  /(?<![\d])\+\s?\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?!\d)/g,
  // Area code in brackets: (02) 9000 1234, (555) 123-4567.
  /\(\s*\d{2,4}\s*\)\s*\d{3,4}\s?[.-]?\s?\d{3,4}(?!\d)/g,
  // Australian / UK national: 02 9000 1234, 0412 345 678, 020 7946 0958.
  /(?<![\d.,$£€-])0\d{1,3}[ -]\d{3,4}[ -]\d{3,4}(?![\d.,])/g,
  // 1800 / 1300 numbers.
  /(?<![\d])1[38]00[ -]?\d{3}[ -]?\d{3}(?!\d)/g,
  // North American: 555-123-4567, 555 123 4567, 555.123.4567.
  /(?<![\d.,$£€-])\d{3}[ .-]\d{3}[ .-]\d{4}(?![\d.,])/g,
];

/** Street part of an address. Compiled once; the suffix list covers AU, NZ, UK and US usage. */
const STREET_SUFFIX =
  "st|street|rd|road|ave|av|avenue|dr|drive|ln|lane|blvd|boulevard|hwy|highway|pde|parade|cres|crescent|ct|court|pl|place|way|tce|terrace|sq|square|cl|close|cir|circuit|esp|esplanade|gr|grove|row|walk|mall|arcade|plaza|promenade|bvd|pkwy|parkway|trl|trail|cct|rise|gdns|gardens|pk";
const UNIT_PREFIX = String.raw`(?:(?:shop|unit|level|lvl|suite|ste|lot|flat|apt|apartment|u|g|ground)\.?\s*[A-Za-z0-9-]{0,6}\s*[,/-]?\s*)?`;
/** "480 Kent St", "Shop 3, 480 Kent St", "12-14 Smith Rd", "5/22 High Street". */
const STREET_NUMBERED = new RegExp(
  String.raw`(?<![\d.,$£€-])${UNIT_PREFIX}\d{1,5}[A-Za-z]?(?:\s?[-/]\s?\d{1,5}[A-Za-z]?)?\s+(?:[A-Za-z][A-Za-z'.]{0,24}\s+){1,3}(?:${STREET_SUFFIX})\b\.?`,
  "gi",
);
/** "King St", "High Street": a name plus a clear street word, no number. Only trusted in the header block. */
const STREET_UNNUMBERED = new RegExp(
  String.raw`\b(?:[A-Za-z][A-Za-z']{1,24}\s+){1,2}(?:st|street|rd|road|ave|avenue|dr|drive|ln|lane|blvd|boulevard|hwy|highway|pde|parade|cres|crescent|tce)\b\.?`,
  "gi",
);
const PO_BOX = /\b(?:p\.?\s?o\.?\s*box|post\s+office\s+box|locked\s+bag|private\s+bag)\s*#?\s*\d{1,8}\b/gi;
/** The state/postcode ends of an address: the postcode goes, the suburb and state stay. */
const STATE_POSTCODE = /\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\s+\d{4}\b/g;
const US_ZIP = /\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/g;
const UK_POSTCODE = /(?<![A-Za-z\d])[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}(?![A-Za-z\d])/g;
const NZ_POSTCODE = /(?<=,\s?[A-Za-z' ]{2,30}\s)\d{4}\b/g;
/** Delivery and billing details: everything after the label is an address. */
const ADDRESS_LABEL = /^(\s*(?:deliver(?:y|ed)?\s+(?:to|address)|ship(?:ped)?\s+to|bill(?:ing)?\s+(?:to|address)|sold\s+to|address|addr|home\s+address|delivery\s+instructions)\s*[:\-]?\s*)(\S.*)$/i;

/** Labels whose value is a person's name. A value is required, and the label must start the line. */
const NAME_LABEL =
  /^(\s*(?:served\s+by|cashier|checkout\s+operator|till\s+operator|operator|(?:store\s+|duty\s+)?manager|supervisor|team\s+member|your\s+cashier|your\s+server|server|assisted\s+by|collected\s+by|picked\s+by|packed\s+by|delivered\s+by|bought\s+by|purchased\s+by|ordered\s+by|placed\s+by|account\s+holder|driver|(?:order|pick-?up|collection|delivery|prepared|packed|reserved|booked)\s+for|customer\s+name|cardholder(?:\s+name)?|card\s+holder|name\s+on\s+card|member\s+name|guest\s+name|name|customer|cust|guest|member)\s*(?:[:#\-]\s*|\s+))(?!(?:copy|receipt|service|services|care|support|enquiries|inquiries|complaints|information|feedback|survey|satisfaction|charter|rewards|number|no|id|card|account|points|price|savings?|saving|discount|offer|the|your|you|today|tomorrow|delivery|collection|pickup|pick-up|later|now|\d)\b)(\S.*)$/i;
/** A colon-less "name" or "customer" label is too common in prose; these need a separator. */
const NAME_NEEDS_SEPARATOR = /^\s*(?:name|customer|cust|guest|member|server|driver)\b/i;
/** "Hi Sarah," / "Dear Mr Jones". */
const GREETING =
  /^(\s*(?:hi|hello|hey|dear)[,\s]+)(?!(?:there|all|everyone|customer|valued|shopper|guest|team)\b)([A-Za-z][A-Za-z'-]{1,24}(?:\s+[A-Za-z][A-Za-z'-]{1,24}){0,2})(\s*[,!.]*\s*)$/i;

/** "You were served by Sam", "Served by Sam today": the label sits mid-line, so the line-start label above misses it. */
const SERVED_BY_MIDLINE = /\b([Ss]erved\s+by\s+)(?!(?:our|the|a|an|your)\b)([A-Z][A-Za-z'-]{1,24}(?:\s+[A-Z][A-Za-z'-]{1,24}){0,2})/g;
/** "Sam served you today": the name comes first. */
const NAME_SERVED_YOU = /\b(?!(?:Staff|Team|Cashier|Someone|Our|The|Your|We|They|Self)\b)([A-Z][A-Za-z'-]{1,24}(?:\s+[A-Z][A-Za-z'-]{1,24})?)(\s+(?:served|assisted|helped|looked\s+after)\s+you\b)/g;
/** "Thanks, Jane!" / "Thank you Jane" on a line of its own. */
const THANKS_NAME =
  /^(\s*[Tt]hank(?:s|\s+[Yy]ou)[,\s]+)(?!(?:for|again|so|very|you|and|from|come|shopping|visiting|choosing|with|at|today|us)\b)([A-Z][A-Za-z'-]{1,24}(?:\s+[A-Z][A-Za-z'-]{1,24}){0,2})(\s*[,!.]*\s*)$/;
/** "CITIZEN/JANE" or "Jane/Citizen" on a payment line: how card slips print the cardholder. */
const SURNAME_SLASH_GIVEN = /\b[A-Z][A-Za-z'-]{2,24}\/[A-Z][A-Za-z'-]{2,24}(?:\s+(?:MR|MRS|MS|MISS|DR|MX))?\b/g;

/** Words that mark a loyalty or membership number. */
const LOYALTY_LABEL =
  /\b(?:everyday\s+rewards?|rewards?|loyalty|member(?:ship)?|fly\s?buys|club\s?card|nectar|one\s?card|points?\s+card|card\s*(?:no|number|num|#)|account\s*(?:no|number|num|#)|acct|customer\s*(?:no|number|num|id|#)|cust\s*(?:no|number|id|#)|kroger\s+plus|store\s+card|shopper\s+card|rewards\s+card|scan\s+card|card\s+holder|cardholder)\b/i;
/** Words that mark a payment slip line. */
const PAYMENT_LABEL =
  /\b(?:visa|master\s?card|maestro|amex|american\s+express|diners|discover|jcb|union\s?pay|eftpos|eft|debit|credit|cheque|card(?:\s*(?:no|number|num|#|type|ending|payment|sale))?|a\/c|acct|account|pan|aid|tid|mid|rrn|stan|arqc|atc|tvr|tsi|iad|auth(?:ori[sz]ation|ori[sz]ed)?|approval|approved|terminal|term|merchant|merch|batch|trace|seq(?:uence)?|ref(?:erence)?|txn|trans(?:action)?|receipt\s*(?:no|number|num|#|id)|rcpt|invoice\s*(?:no|number|num|#)|order\s*(?:no|number|num|#|id)|docket|contactless|chip|pin|apple\s*pay|google\s*pay|samsung\s*pay|pay\s?wave|pay\s?pass|tap)\b/i;
/** A value after one of these labels is a code, whatever it looks like ("AUTH A1B2C3", "Terminal ID T0012345"). */
const CODE_AFTER_LABEL =
  /\b((?:approval(?:\s*(?:code|no|number|#))?|auth(?:ori[sz]ation)?(?:\s*(?:code|no|number|#|id))?|terminal(?:\s*(?:id|no|number|#))?|term(?:\s*(?:id|no|#))?|merchant(?:\s*(?:id|no|number|#))?|merch(?:\s*(?:id|no|#))?|mid|tid|rrn|stan|aid|arqc|batch(?:\s*(?:no|number|#))?|trace(?:\s*(?:no|number|#))?|seq(?:uence)?(?:\s*(?:no|number|#))?|ref(?:erence)?(?:\s*(?:no|number|#|id))?|txn(?:\s*(?:id|no|#))?|trans(?:action)?(?:\s*(?:id|no|number|#))?|receipt\s*(?:no|number|num|#|id)|rcpt\s*(?:no|#)?|invoice\s*(?:no|number|num|#)|order\s*(?:no|number|num|#|id)|docket\s*(?:no|#)?|pan|rcpt)\b\.?\s*[:#=-]?\s*)(?=[A-Za-z0-9*•xX]*\d)([A-Za-z0-9][A-Za-z0-9*•#-]{2,24})\b/gi;
/** Business registration numbers. Not personal for a supermarket, but not needed either. */
const BUSINESS_ID =
  /\b((?:abn|acn|nzbn|vat(?:\s*(?:no|number|reg(?:istration)?|#))?|gst\s*(?:no|number|reg(?:istration)?|#)|tax\s*id|ein|company\s*(?:no|number)|reg(?:istration)?\s*(?:no|number))\.?\s*[:#]?\s*)(?:[A-Z]{2}\s*)?\d[\d \-]{6,18}\d/gi;

const AMOUNT = /^[-($£€]*\d{1,6}[.,]\d{2}\)?-?[A-Za-z*#]{0,2}$/;
const DATE_OR_TIME = /^(?:\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}:\d{2}(?::\d{2})?(?:am|pm)?)$/i;
const PRICED_LINE_END = /(?:^|\s)[-$£€(]*\d{1,6}[.,]\d{2}\)?-?\s*[A-Za-z*#]{0,2}$/;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Replace every match of `pattern` with `replacement`, counting each as `kind`. */
function replaceAll(line: string, pattern: RegExp, kind: RedactionKind, counts: Counts, replacement: string | ((match: string, ...groups: string[]) => string) = REDACTED): string {
  return line.replace(pattern, (...args: unknown[]) => {
    const groups = args.slice(0, -2).filter((a): a is string => typeof a === "string");
    counts[kind] += 1;
    return typeof replacement === "function" ? replacement(...(groups as [string, ...string[]])) : replacement;
  });
}

/** How many real digits are in a string. */
const digitCount = (s: string): number => (s.match(/\d/g) ?? []).length;

/** True when the token is something that must stay: a price, a date or a time. */
function isKeepToken(token: string): boolean {
  return AMOUNT.test(token) || DATE_OR_TIME.test(token);
}

/** Replace id-like tokens (4+ digits, or masked) on a line, leaving prices, dates and times. */
function redactIdTokens(line: string, kind: RedactionKind, counts: Counts): string {
  return line
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s*$/.test(part) || part === REDACTED || isKeepToken(part)) return part;
      // Strip edge punctuation for the test, keep it in the output.
      const m = /^([^A-Za-z0-9*•#]*)(.*?)([^A-Za-z0-9*•#]*)$/.exec(part);
      if (!m) return part;
      const [, lead, core, trail] = m;
      if (!core || core === REDACTED || isKeepToken(core)) return part;
      const digits = digitCount(core);
      const idLike = (digits >= 4 && !/[.,]\d{2}$/.test(core)) || (/[*•#]{2,}/.test(core) && digits >= 2);
      if (!idLike) return part;
      counts[kind] += 1;
      return `${lead}${REDACTED}${trail}`;
    })
    .join("");
}

/** True when the line ends with a price: an item or total line. Item lines are protected from address patterns. */
const endsWithPrice = (line: string): boolean => PRICED_LINE_END.test(line.trim());

// ─── Redaction ──────────────────────────────────────────────────────────────

interface LineMode {
  /** Redact contact details, names, addresses and slip codes too, not just numbers. */
  full: boolean;
  /** The line is in the header block (before the first priced line), where bare street names are trusted. */
  header: boolean;
}

/** Numbers and contact details that must never survive, whatever the line is. `mark` replaces each one. */
function redactTokens(input: string, counts: Counts, mark: string): string {
  let line = input;
  line = replaceAll(line, EMAIL, "email", counts, mark);
  line = replaceAll(line, EMAIL_SPACED, "email", counts, mark);
  line = replaceAll(line, LINK, "link", counts, mark);
  // Whole card numbers first, then masked ones and tails, then phones — so a card number is never read as a phone.
  line = replaceAll(line, GROUPED_DIGITS, "card", counts, mark);
  line = replaceAll(line, LONG_DIGITS, "card", counts, mark);
  line = line.replace(LOOKALIKE_DIGITS, (match) => {
    if (digitCount(match) < 9) return match;
    counts.card += 1;
    return mark;
  });
  line = replaceAll(line, SCHEME_TAIL, "card", counts, mark);
  line = replaceAll(line, CARD_TAIL, "card", counts, mark);
  line = replaceAll(line, MASKED_CARD, "card", counts, mark);
  line = replaceAll(line, LABELLED_PHONE, "phone", counts, (_match, label) => `${label}${mark}`);
  for (const shape of PHONE_SHAPES) line = replaceAll(line, shape, "phone", counts, mark);
  return line;
}

/** Contact details, names, addresses and slip codes on a header, footer or payment line. */
function redactDetails(input: string, mode: LineMode, counts: Counts): string {
  let line = input;
  const priced = endsWithPrice(line);

  const address = ADDRESS_LABEL.exec(line);
  if (address && !/^[•\s]*$/.test(address[2])) {
    counts.address += 1;
    return `${address[1]}${REDACTED}`;
  }

  const name = NAME_LABEL.exec(line);
  if (name && !(NAME_NEEDS_SEPARATOR.test(line) && !/^\s*\w+(?:\s+\w+)?\s*[:#-]/.test(line))) {
    // Keep the label, drop the person. A price at the end (rare on these lines) stays.
    const value = name[2];
    if (!/^[•\s]*$/.test(value)) {
      const price = /(\s[-$£€(]*\d{1,6}[.,]\d{2}\)?-?)$/.exec(value);
      counts.name += 1;
      line = `${name[1]}${REDACTED}${price ? price[1] : ""}`;
    }
  }
  const greeting = GREETING.exec(line);
  if (greeting) {
    counts.name += 1;
    line = `${greeting[1]}${REDACTED}${greeting[3]}`;
  }
  const thanks = THANKS_NAME.exec(line);
  if (thanks) {
    counts.name += 1;
    line = `${thanks[1]}${REDACTED}${thanks[3]}`;
  }
  // Mid-line wording only on lines that aren't items: an item line never says who served you.
  if (!priced) {
    line = replaceAll(line, SERVED_BY_MIDLINE, "name", counts, (_match, label) => `${label}${REDACTED}`);
    line = replaceAll(line, NAME_SERVED_YOU, "name", counts, (_match, _name, rest) => `${REDACTED}${rest}`);
    if (PAYMENT_LABEL.test(line)) line = replaceAll(line, SURNAME_SLASH_GIVEN, "name", counts);
  }

  if (!priced) {
    const before = line;
    line = replaceAll(line, PO_BOX, "address", counts);
    line = replaceAll(line, STREET_NUMBERED, "address", counts, (match) => {
      // Away from the header, only an address that starts the line is trusted.
      return mode.header || line.trimStart().startsWith(match.trimStart()) ? REDACTED : match;
    });
    if (mode.header) line = replaceAll(line, STREET_UNNUMBERED, "address", counts);
    // The postcode goes; the suburb and state stay for the store label.
    line = line.replace(STATE_POSTCODE, "$1").replace(US_ZIP, "$1").replace(UK_POSTCODE, "").replace(NZ_POSTCODE, "");
    if (line !== before) line = line.replace(/\s+,/g, ",").replace(/[,\s]+$/, "");
  }

  line = line.replace(BUSINESS_ID, (_match, label: string) => {
    counts.id += 1;
    return `${label}${REDACTED}`;
  });
  line = line.replace(CODE_AFTER_LABEL, (match, label: string, code: string) => {
    if (code === REDACTED || isKeepToken(code) || digitCount(code) < 1) return match;
    counts.id += 1;
    return `${label}${REDACTED}`;
  });
  if (LOYALTY_LABEL.test(line)) line = redactIdTokens(line, "loyalty", counts);
  if (PAYMENT_LABEL.test(line)) line = redactIdTokens(line, "id", counts);
  return line;
}

function redactLineInternal(raw: string, mode: LineMode, counts: Counts): string {
  let line = raw.length > MAX_REDACT_LINE ? raw.slice(0, MAX_REDACT_LINE) : raw;
  line = redactTokens(line, counts, mode.full ? REDACTED : "");
  if (mode.full) line = redactDetails(line, mode, counts);
  return line;
}

/**
 * Redact one item line (as stored in `receipt_items.raw_text`). Only numbers
 * and contact details are removed: an item line never has a name, address or
 * slip code, and it must not change when it is an ordinary product.
 */
export function redactReceiptLine(line: string): string {
  if (typeof line !== "string") return "";
  const cleaned = cleanInput(line);
  const out = redactLineInternal(cleaned, { full: false, header: false }, emptyCounts());
  return out === cleaned ? line : out.replace(/ {2,}/g, " ").trim();
}

/** Redact a whole receipt's text and say what was removed. */
export function redactReceiptTextDetailed(text: string): RedactionResult {
  const counts = emptyCounts();
  const cleaned = cleanInput(text ?? "").slice(0, MAX_REDACT_TEXT);
  const lines = cleaned.split(/\r\n|\r|\n/);
  const firstPriced = lines.findIndex((l) => endsWithPrice(l.trim()));
  const headerEnd = firstPriced === -1 ? Math.min(lines.length, 12) : Math.min(firstPriced, 14);
  const out = lines.map((line, i) => redactLineInternal(line, { full: true, header: i < headerEnd }, counts));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text: out.join("\n"), removed: counts, total };
}

/** The text of a receipt with personal and financial details removed. Safe to store. */
export function redactReceiptText(text: string): string {
  return redactReceiptTextDetailed(text).text;
}

/**
 * A store name for display ("Woolworths Metro Town Hall"): the header
 * redaction with street and postcode removed and no leftover markers.
 * Null when nothing usable remains.
 */
export function redactStoreLabel(store: string | null | undefined): string | null {
  if (!store) return null;
  const out = redactReceiptText(store)
    .split(REDACTED)
    .join(" ")
    .replace(/\s*[,;-]\s*(?=[,;-]|$)/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;-]+|[\s,;-]+$/g, "");
  return out || null;
}
