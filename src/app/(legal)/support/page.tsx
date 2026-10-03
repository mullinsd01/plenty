import type { Metadata } from "next";
import Link from "next/link";
import { Bullets, ContactBlock, DevPlaceholderNote, Email, LegalTitle, Section } from "@/features/legal/legal-ui";
import { APPLE_MANAGE_URL, googleManageUrl } from "@/lib/billing/management";
import { legalContact } from "@/server/legal";

export const metadata: Metadata = { title: "Support", description: "How to get help with Plenty." };

const link = "font-medium text-ink underline underline-offset-2";

export default function SupportPage() {
  const contact = legalContact();
  return (
    <>
      <DevPlaceholderNote contact={contact} />
      <LegalTitle title="Support" intro={<p>Most things can be sorted in the app. If you&apos;re stuck, here&apos;s where to look, and how to reach us.</p>} />

      <Section id="contact" title="Get in touch">
        <ContactBlock contact={contact} kind="support" />
        <p>When you write, tell us what you were doing and what you expected. Never send your password. We&apos;ll never ask for it.</p>
      </Section>

      <Section id="faq" title="Common questions">
        <div className="space-y-5">
          <div>
            <h3 className="font-semibold text-ink">I forgot my password</h3>
            <p>
              Use{" "}
              <Link href="/forgot-password" className={link}>
                Forgot your password
              </Link>{" "}
              on the sign-in page. We&apos;ll email a link that works for an hour.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-ink">A receipt was read wrongly, or won&apos;t read</h3>
            <p>
              Fix any line on the review screen before adding it: nothing reaches your kitchen until you confirm. For a receipt that failed, try again in good light with the whole receipt in the frame. Plenty remembers your corrections for
              next time.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-ink">How do I cancel my subscription?</h3>
            <Bullets
              items={[
                "Bought on the web: Settings → Plan, then manage your subscription.",
                <>
                  Bought in the iPhone app:{" "}
                  <a href={APPLE_MANAGE_URL} target="_blank" rel="noopener noreferrer" className={link}>
                    your Apple ID subscriptions
                  </a>{" "}
                  (Settings → your name → Subscriptions).
                </>,
                <>
                  Bought in the Android app:{" "}
                  <a href={googleManageUrl()} target="_blank" rel="noopener noreferrer" className={link}>
                    Google Play subscriptions
                  </a>{" "}
                  (Play Store → profile picture → Payments &amp; subscriptions).
                </>,
              ]}
            />
            <p className="mt-2">Cancelling stops the next renewal; you keep the paid features until the end of the period you&apos;ve paid for.</p>
          </div>
          <div>
            <h3 className="font-semibold text-ink">How do I get a copy of my data?</h3>
            <p>Settings → Privacy &amp; data → Download my household&apos;s data. It&apos;s a complete JSON file of what Plenty keeps for your household.</p>
          </div>
          <div id="delete-account">
            <h3 className="font-semibold text-ink">How do I delete my account?</h3>
            <p>
              In the app: Settings → Account → Delete my account. If you can&apos;t sign in, or you want to ask us to do it, see{" "}
              <Link href="/delete-account" className={link}>
                how to delete your account
              </Link>
              .
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-ink">Who can see my items?</h3>
            <p>
              Items marked private are visible only to you. Everything else in a household is visible to the people in it. The details are in{" "}
              <Link href="/privacy#visibility" className={link}>
                the Privacy Policy
              </Link>
              .
            </p>
          </div>
        </div>
      </Section>

      <Section id="report" title="Report a problem or a concern">
        <p>
          If something in Plenty is wrong, unsafe or abusive, or you think someone is misusing a household, write to us{contact.supportEmail ? <> at <Email address={contact.supportEmail} /></> : ""} and we&apos;ll look into it. Plenty has no
          public posts, comments or messaging: names and notes are only visible to the people in the same household.
        </p>
      </Section>

      <Section id="more" title="More">
        <Bullets
          items={[
            <>
              <Link href="/privacy" className={link}>
                Privacy Policy
              </Link>
            </>,
            <>
              <Link href="/terms" className={link}>
                Terms of Service
              </Link>
            </>,
          ]}
        />
      </Section>
    </>
  );
}
