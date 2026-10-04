# Brief for a lawyer: Plenty's Privacy Policy and Terms

For the person who will read Plenty's public legal text before it goes live in the App Store. Written 2026-10-04. It describes what the software does today, taken from the code, so you can check the text against reality. It is not legal advice and nothing in it has been reviewed by a lawyer.

## What Plenty is

A household grocery and meal-planning app. A household (one or more people) keeps a kitchen inventory, a shopping list and meal plans. People can photograph a shop receipt and the app reads it. Free plan, plus paid plans (Plus, Family) sold per household: on the web through Stripe, on iPhone through Apple in-app purchase. Operated from Australia. Customers are mainly Australian households. iPhone app first; web too.

## What to read

The live pages once deployed (`/privacy`, `/terms`, `/support`, `/delete-account`), and their source in the repository:

| Document | Source |
|---|---|
| Privacy Policy | `src/app/(legal)/privacy/page.tsx` and `src/lib/privacy-content.ts` |
| Terms of Service | `src/app/(legal)/terms/page.tsx` |
| Support and contact | `src/app/(legal)/support/page.tsx` |
| Account deletion page | `src/app/(legal)/delete-account/page.tsx` |
| What data is stored, who sees it, how long, how it is deleted | `docs/compliance/data-map.md` |
| Security measures | `docs/compliance/security-notes.md` |
| Audit against Apple and Google rules | `docs/compliance/app-store-and-play-audit.md` |

The public text was written from the code, by a developer. Please treat every sentence as a draft.

## Facts that matter

* **Operator.** Not yet fixed: it will be an individual (sole trader) unless advised otherwise. The name, support email and privacy email are set in the production settings (`LEGAL_ENTITY_NAME`, `SUPPORT_EMAIL`, `PRIVACY_CONTACT_EMAIL`) and printed on the pages. Apple shows an individual's legal name as the seller.
* **Health-adjacent data.** People can enter diets, allergies and dislikes, for themselves and for others in the household. Used only to filter meal suggestions; never sent to an AI service without the household's consent.
* **Children.** Sign-up says "18 or over" and there is no age check. An adult can add a child as a name-only profile with no account, or invite them to a restricted Child account (cannot see receipts, prices or settings). Child accounts hold an email and display name.
* **Receipts.** Photos are stored privately, text is stripped of card, loyalty, phone, email, address and name details before saving, and the photo is deleted after the person checks the receipt (default), after 30 days, or kept, as the household chooses. Unchecked photos go after 14 days.
* **AI service (Anthropic, USA).** Used only if an adult in the household turns it on (recorded with who and when, withdrawable) and the plan includes it. Receives a receipt or grocery photo, or kitchen item names, diets, allergies and dislikes, depending on the feature. Never names, emails or the rest of the account. Without consent, receipts are read on Plenty's own server.
* **Analytics.** First party, no third-party tools, no advertising identifiers. **Off until a person turns it on** (opt-in). Stored with a scrambled household key, kept up to 13 months.
* **Other recipients.** Hosting and database provider, object storage for photos, email delivery provider (password resets and invitations), Stripe (web payments), Apple (iPhone payments), and the Open Food Facts public database (barcode number only). Exact providers are not yet chosen; the recommended set is Fly.io, Neon, Cloudflare R2.
* **Deletion.** Account and household deletion are in the app and remove the live data straight away. Billing event records are kept with the household link removed (to stop a repeated payment notice being applied twice and for accounting). Provider backups age out on the provider's schedule. An Apple subscription can only be cancelled in the App Store; the app tells people so and does not pretend otherwise.
* **Prices.** The Terms list US dollars (Plus US$4.99 a month or US$49.99 a year; Family US$8.99 or US$89.99). No free trial. Apple and Stripe show the local price at checkout.
* **Content.** Names and short notes are visible only to the other members of the same private household. Recipes written by the AI can be reported inside the app; reports are stored and need a person to read them.

## Questions for the lawyer

**Who and where**
1. Is operating as an individual sensible for launch, or should a company or at least a registered business name come first? What changes in the Terms and Privacy Policy either way?
2. Which governing law and courts should the Terms name? (Currently none.)

**Privacy**
3. Does the Privacy Act 1988 and the Australian Privacy Principles apply to this operator (small business exemption, health information, anything else), and should the policy be written to that standard regardless?
4. Are diets and allergies "health information" or "sensitive information" here, and is the current consent and purpose wording enough?
5. Overseas disclosure (hosting, AI service, email, payments): what does the policy have to say and what do I have to arrange with those providers?
6. Data breach notification: what process should exist and what should be written down before launch?
7. Is the retention, backup and "deleted straight away from the live database" wording accurate and sufficient?

**Children**
8. Is "18 or over, no age check" acceptable, given that an adult can invite a child to a restricted account? Should child accounts be created only by an adult, or limited to name-only profiles? Is a Children's privacy code or similar a concern for an app not aimed at children?

**Selling**
9. The Terms quote US dollars. What must the Australian price display look like (AUD, GST inclusive) on the web and in the app listing?
10. Are the renewal, cancellation, refund and "we can change these terms" wording and the liability limit acceptable for a standard-form consumer contract in Australia, including the consumer guarantees and unfair contract terms rules?
11. Is the "planning aid, not medical, dietary or food-safety advice" wording enough given that the app filters meals by allergy? What else should the product say or not say (for example never calling anything "allergy-safe")?

**Marketing**
12. I intend to sign people up by talking to families at their door and by posting on Facebook. What rules apply to door-to-door selling of a subscription (including unsolicited consumer agreement rules, cooling-off, local council permits, "do not knock" signs), and does it matter whether the sign-up itself then happens later on the website?
13. What consent do I need before emailing anyone I meet this way (Spam Act)?
14. Is there any trade mark or naming risk in "Plenty", and should I register anything before launch? (The App Store also requires the app name to be unique.)

**Content**
15. Is the in-app "Report this recipe" flow, plus a named person reading reports, enough for the AI-written recipes? Is anything needed for household-visible names and notes?

## What the developer will do with the answers

Edit the text in the files above (every change also updates `LEGAL_LAST_UPDATED` in `src/lib/legal.ts`), run the checks, and redeploy. The text is plain data in the repository, so changes are quick.
