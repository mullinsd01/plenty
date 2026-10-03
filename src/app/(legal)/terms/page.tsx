import type { Metadata } from "next";
import Link from "next/link";
import { Bullets, ContactBlock, DevPlaceholderNote, LegalTitle, Section } from "@/features/legal/legal-ui";
import { formatPlanPrice, PLANS, PURCHASABLE_PLANS, TRIAL_DAYS } from "@/lib/billing/plans";
import { legalContact } from "@/server/legal";

export const metadata: Metadata = { title: "Terms of Service", description: "The terms for using Plenty." };

export default function TermsPage() {
  const contact = legalContact();
  const operator = contact.entityName ?? "the operator of this Plenty service";
  return (
    <>
      <DevPlaceholderNote contact={contact} />
      <LegalTitle
        title="Terms of Service"
        updated
        intro={<p>These are the terms for using Plenty. They&apos;re written to be read. If you don&apos;t agree with them, please don&apos;t use Plenty.</p>}
      />

      <Section id="who" title="Who these terms are between">
        <p>
          These terms are between you and {operator} (&ldquo;we&rdquo;, &ldquo;us&rdquo;), who run Plenty. By creating an account or using Plenty you agree to them and to our{" "}
          <Link href="/privacy" className="font-medium text-ink underline underline-offset-2">
            Privacy Policy
          </Link>
          .
        </p>
      </Section>

      <Section id="accounts" title="Accounts and households">
        <Bullets
          items={[
            "You must be 18 or over to create an account. Keep your sign-in details to yourself and tell us if you think someone else has them.",
            "A household can have several people. The people who own a household decide who is in it and what plan it is on, and are responsible for the people they add, including children (see the Privacy Policy for how children fit in).",
            "You're responsible for what you put into Plenty and for having the right to. Don't put in anything unlawful, or anything that belongs to someone else without their permission.",
            "You can delete your account, or your household, at any time in Settings → Privacy & data. That's permanent.",
          ]}
        />
      </Section>

      <Section id="aids" title="Plenty is a planning aid">
        <p>
          Plenty keeps lists, makes estimates and suggests meals. Its estimates (how much is left, when something will run out), expiry dates, storage suggestions, recipes and allergy and diet filters are
          aids to help you plan. They can be wrong or out of date. <strong className="font-semibold text-ink">Plenty doesn&apos;t give medical, dietary, nutritional or food-safety advice and doesn&apos;t guarantee any
          suggestion is safe or suitable.</strong> Always check labels and use your own judgement, especially for allergies, intolerances, medical diets, use-by dates and how food is stored and cooked.
        </p>
        <p>
          Reading receipts is automatic and can make mistakes, so Plenty asks you to check each receipt before anything is added to your kitchen. Prices and totals are kept for your own records; Plenty doesn&apos;t give
          financial, budgeting or tax advice.
        </p>
        <p>
          Some features can use an outside AI service, only if you turn it on (see the Privacy Policy). AI output can be wrong; Plenty checks it before it changes your kitchen, but you remain responsible for what you accept.
        </p>
      </Section>

      <Section id="acceptable-use" title="Using Plenty properly">
        <Bullets
          items={[
            "Don't try to access another household's data, break or overload Plenty, probe it for weaknesses without our permission, or use it to send spam or harmful content.",
            "Names and notes you enter are visible to the other people in your household. Keep them respectful and lawful.",
            "Don't use automated means to create accounts or collect data from Plenty.",
          ]}
        />
      </Section>

      <Section id="plans" title="Plans, prices and renewal">
        <p>Plenty has a free plan, and paid plans with more features. Prices are in US dollars as listed here; the App Store, Google Play or checkout shows the price in your currency before you buy.</p>
        <Bullets
          items={[
            <>
              <strong className="font-semibold text-ink">{PLANS.free.name}:</strong> free.
            </>,
            ...PURCHASABLE_PLANS.map((id) => (
              <span key={id}>
                <strong className="font-semibold text-ink">{PLANS[id].name}:</strong> {formatPlanPrice(id, "monthly")}, or {formatPlanPrice(id, "annual")}.
              </span>
            )),
          ]}
        />
        <p>
          {TRIAL_DAYS > 0
            ? `New subscriptions start with a ${TRIAL_DAYS}-day free trial, then renew at the price above unless cancelled before the trial ends.`
            : "No free trial is offered: a paid plan starts, and is charged, when you buy it."}{" "}
          A paid plan renews automatically at the end of each month or year until you cancel. You keep the paid features until the end of the period you&apos;ve paid for.
        </p>
        <p>
          A subscription belongs to the household, not to one person. Where you cancel depends on where you bought it: a subscription bought on the web is cancelled in Settings → Plan; one bought through the App Store is
          cancelled in your Apple ID subscription settings; one bought through Google Play is cancelled in Google Play under Payments &amp; subscriptions. Cancelling in one place doesn&apos;t cancel a subscription bought in another.
          Deleting a household cancels a web subscription for you; it can&apos;t cancel an App Store or Google Play one, which you must cancel in the store.
        </p>
        <p>
          Refunds for subscriptions bought through the App Store or Google Play are handled by Apple or Google under their policies. For subscriptions bought on the web, contact support. Nothing here limits any right you have under
          consumer law.
        </p>
        <p>If your household is over a plan&apos;s limits (for example after a downgrade), Plenty tells you what&apos;s affected and doesn&apos;t delete anything because of it.</p>
      </Section>

      <Section id="changes" title="Changes, availability and ending">
        <Bullets
          items={[
            "We can change Plenty and these terms. If a change matters, we'll tell you in the app, and the date at the top of the page changes.",
            "We try to keep Plenty available but can't promise it will always be, and we may remove or change features. We won't charge for a feature that's removed during a period you've paid for without making it right.",
            "We can suspend or close an account that breaks these terms or puts others at risk. You can stop using Plenty and delete your account whenever you like.",
          ]}
        />
      </Section>

      <Section id="liability" title="Our responsibility">
        <p>
          Plenty is provided &ldquo;as is&rdquo;. To the extent the law allows, we aren&apos;t liable for indirect or consequential loss, for food wasted, bought or eaten because of an estimate or suggestion, or for loss of data you
          haven&apos;t exported. Nothing in these terms excludes or limits any right or liability that can&apos;t be excluded or limited by law, including your rights as a consumer.
        </p>
      </Section>

      <Section id="contact" title="Contact">
        <ContactBlock contact={contact} kind="support" />
        <p>
          More help is on the{" "}
          <Link href="/support" className="font-medium text-ink underline underline-offset-2">
            Support page
          </Link>
          .
        </p>
      </Section>
    </>
  );
}
