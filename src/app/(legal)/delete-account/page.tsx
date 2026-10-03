import type { Metadata } from "next";
import Link from "next/link";
import { Bullets, ContactBlock, DevPlaceholderNote, Email, LegalTitle, Section } from "@/features/legal/legal-ui";
import { DELETION_TEXT } from "@/lib/privacy-content";
import { legalContact } from "@/server/legal";

export const metadata: Metadata = { title: "Delete your account", description: "How to delete your Plenty account and what is deleted." };

const link = "font-medium text-ink underline underline-offset-2";

export default function DeleteAccountInfoPage() {
  const contact = legalContact();
  return (
    <>
      <DevPlaceholderNote contact={contact} />
      <LegalTitle title="Delete your Plenty account" intro={<p>You can delete your account yourself, in the app or on the web, or ask us to do it. Deleting is permanent: Plenty can&apos;t bring anything back afterwards.</p>} />

      <Section id="in-app" title="Delete it yourself">
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>
            <Link href="/login?next=/settings/account" className={link}>
              Sign in
            </Link>{" "}
            on the web, or open the Plenty app.
          </li>
          <li>Go to Settings → Account → Delete my account.</li>
          <li>Read what will be deleted, type DELETE and enter your password to confirm.</li>
        </ol>
        <p>If you&apos;re the only owner of a household that other people use, Plenty asks you to make one of them an owner first, so a household is never left without one and nobody becomes an owner by surprise.</p>
      </Section>

      <Section id="request" title="Can't sign in? Ask us to delete it">
        <p>
          Email us from the address on the account, with the subject &ldquo;Delete my account&rdquo;. We&apos;ll check it&apos;s you (we may ask you to reply to a message we send to that address) and then delete the account and any household
          you&apos;re the only person with an account in.
        </p>
        {contact.privacyEmail ? (
          <p>
            Send it to <Email address={contact.privacyEmail} />.
          </p>
        ) : (
          <ContactBlock contact={contact} kind="privacy" />
        )}
      </Section>

      <Section id="what" title="What is deleted">
        <Bullets
          items={[
            "Your account: your email, password, name, settings and every signed-in device.",
            "A household where you're the only person with an account: everything in it, including profiles of people without accounts, the kitchen, lists, recurring items, meal plans and recipes, receipts and their photos, what Plenty learned, notifications, usage and subscription records, and analytics.",
            "A household others use: you leave it. Your private items, your own food rules and your personal patterns are deleted; what you shared stays with the household.",
          ]}
        />
        <p>{DELETION_TEXT.subscriptions}</p>
        <p>
          What stays: a minimal record of payment notifications from Stripe, Apple or Google, with the link to your household removed, is kept so the same notification can&apos;t be applied twice and for accounting. {DELETION_TEXT.backups}
        </p>
      </Section>

      <Section id="more" title="More">
        <p>
          See the{" "}
          <Link href="/privacy" className={link}>
            Privacy Policy
          </Link>{" "}
          for everything Plenty keeps and why, or the{" "}
          <Link href="/support" className={link}>
            Support page
          </Link>
          .
        </p>
      </Section>
    </>
  );
}
