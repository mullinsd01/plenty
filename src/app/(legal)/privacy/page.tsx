import type { Metadata } from "next";
import Link from "next/link";
import { Bullets, ContactBlock, DevPlaceholderNote, Email, LegalTitle, Section } from "@/features/legal/legal-ui";
import { ChildrenText, DataGroups, DeletionText, ProcessorList, VisibilityRules } from "@/features/privacy/policy-sections";
import { EXTERNAL_AI_PROVIDER } from "@/lib/ai/consent";
import { processorsFor } from "@/lib/privacy-content";
import { legalContact } from "@/server/legal";
import { processorConfig } from "@/server/services/privacy";

export const metadata: Metadata = { title: "Privacy Policy", description: "What Plenty collects, why, who handles it, and the choices you have." };

export default function PrivacyPolicyPage() {
  const contact = legalContact();
  const config = processorConfig();
  return (
    <>
      <DevPlaceholderNote contact={contact} />
      <LegalTitle
        title="Privacy Policy"
        updated
        intro={
          <p>
            Plenty helps a household keep track of what it has, what it needs and what to cook. This page explains what Plenty keeps about you and your household, why, who else handles it, and what you can do about it. It
            describes how Plenty works today, in plain language.
          </p>
        }
      />

      <Section id="who" title="Who is responsible">
        <ContactBlock contact={contact} kind="privacy" />
        <p>
          &ldquo;Plenty&rdquo; in this policy means the Plenty service run by the organisation above, in the web app and in the iPhone and Android apps.
        </p>
      </Section>

      <Section id="short" title="The short version">
        <Bullets
          items={[
            "Plenty keeps what it needs to run your kitchen, shopping list and meal plans, and nothing is sold or used for advertising.",
            "There are no advertising identifiers and no third-party analytics or tracking tools. Plenty doesn't track you across other apps or websites.",
            "Receipt photos are deleted once you've checked the receipt, unless you choose to keep them. Card, loyalty and phone numbers, emails, addresses and names are removed from receipt text before it's saved.",
            `Nothing is sent to an outside AI service (${EXTERNAL_AI_PROVIDER.name}) unless someone in your household turns that on, and only on a plan that includes it. It's off by default and you can turn it off any time.`,
            "Private items are visible only to the person they belong to. Households are completely separate from each other.",
            "You can download your data, and delete your household or your account, from Settings → Privacy & data.",
          ]}
        />
      </Section>

      <Section id="collected" title="What Plenty keeps, and why">
        <DataGroups openAll />
      </Section>

      <Section id="processors" title="Who else handles your data">
        <p>Plenty uses these companies to run. Only those this Plenty is set up to use are listed.</p>
        <ProcessorList processors={processorsFor(config)} />
        <p>Plenty doesn&apos;t sell your data, doesn&apos;t share it with advertisers or data brokers, and doesn&apos;t use it to train AI models.</p>
      </Section>

      <Section id="ai" title="AI features and your permission">
        <p>
          Some features can use an outside AI service ({EXTERNAL_AI_PROVIDER.name}) to read a messy receipt photo, write new recipe ideas or, when available, recognise groceries in a photo. They are{" "}
          <strong className="font-semibold text-ink">off until someone in your household with an owner or member role turns them on</strong>, they need a plan that includes them, and turning them on is recorded
          (who and when). When they&apos;re off, Plenty reads receipts on its own server and uses its built-in recipes, and nothing is sent anywhere.
        </p>
        <p>
          When they&apos;re on, only the following is sent, and only when you use the feature: the receipt photo you upload (with camera details removed) and your household&apos;s currency, shops and today&apos;s date; or, for recipe
          ideas, what&apos;s in your kitchen, your diets, allergies and dislikes and the names of meals you&apos;ve rejected; or the grocery photo you take. Your name, email, other household members&apos; details and the rest of your account
          are never sent. What {EXTERNAL_AI_PROVIDER.name} does with what it receives is covered by{" "}
          <a href={EXTERNAL_AI_PROVIDER.termsUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-ink underline underline-offset-2">
            its own terms and privacy policy
          </a>
          , which Plenty doesn&apos;t control. Anything the AI suggests is checked before it changes your kitchen: you review each receipt, and recipes are checked against your allergies and diets by Plenty.
        </p>
      </Section>

      <Section id="visibility" title="Who can see what in a household">
        <VisibilityRules />
      </Section>

      <Section id="children" title="Children">
        <ChildrenText />
      </Section>

      <Section id="legal-basis" title="Why Plenty is allowed to use your data">
        <Bullets
          items={[
            "To provide Plenty to you (including your account, kitchen, lists, receipts and predictions): it's necessary to run the service you asked for.",
            "To keep Plenty secure and prevent abuse, and to count how features are used so they can be improved: Plenty's legitimate interests, kept to the minimum above. You can turn analytics off.",
            "To send data to an outside AI service: only with your permission, which you can withdraw at any time.",
            "To keep payment records, and to respond to legal requirements: where the law requires it.",
          ]}
        />
      </Section>

      <Section id="rights" title="Your choices and rights">
        <Bullets
          items={[
            <>
              <strong className="font-semibold text-ink">See and take your data.</strong> Settings → Privacy &amp; data → Download my household&apos;s data.
            </>,
            <>
              <strong className="font-semibold text-ink">Correct it.</strong> Everything you entered can be edited in the app.
            </>,
            <>
              <strong className="font-semibold text-ink">Delete it.</strong> Delete a receipt, your household or your account in Settings. See{" "}
              <Link href="/delete-account" className="font-medium text-ink underline underline-offset-2">
                how to delete your account
              </Link>
              , including if you can&apos;t sign in.
            </>,
            <>
              <strong className="font-semibold text-ink">Withdraw consent and opt out.</strong> Turn AI features or analytics off in Settings → Privacy &amp; data.
            </>,
            <>
              <strong className="font-semibold text-ink">Ask us.</strong> For anything else, including a complaint, contact us below. Depending on where you live you may also have rights under local privacy law, including
              the right to complain to your privacy regulator.
            </>,
          ]}
        />
      </Section>

      <Section id="keeping" title="How long data is kept, and deletion">
        <DeletionText />
      </Section>

      <Section id="security" title="Security">
        <p>
          Passwords are stored only as salted hashes. Each household&apos;s data is separated at the database level, so one household can&apos;t see another&apos;s. Receipt photos are kept privately and are only shown to members of the household that
          owns them. Connections to Plenty are encrypted when it&apos;s served over HTTPS, and sign-in attempts are rate limited. No system is perfectly secure; if something goes wrong that affects you, we&apos;ll tell you as the law requires.
        </p>
      </Section>

      <Section id="transfers" title="Where data is stored">
        <p>
          Your data is stored where this Plenty&apos;s hosting provider&apos;s servers are, which depends on how the operator has set it up; ask us if you need to know. If you turn on AI features, the photos or details described above go to{" "}
          {EXTERNAL_AI_PROVIDER.name}, which may process them in other countries.
        </p>
      </Section>

      <Section id="changes" title="Changes to this policy">
        <p>When this policy changes in a way that matters, the date at the top changes and the app tells you. Earlier versions aren&apos;t kept in the app.</p>
      </Section>

      <Section id="contact" title="Contact">
        <ContactBlock contact={contact} kind="privacy" />
        {contact.supportEmail && contact.privacyEmail !== contact.supportEmail && (
          <p>
            General help: <Email address={contact.supportEmail} />
          </p>
        )}
      </Section>
    </>
  );
}
