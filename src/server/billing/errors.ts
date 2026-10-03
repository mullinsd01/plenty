import "server-only";
import { AppError } from "@/server/errors";

/**
 * A billing path that isn't set up on this server (no Stripe key, no Apple
 * certificates, ...). The message is safe to show: it says what isn't
 * available and that the free plan is unaffected. Routes answer 503.
 */
export class BillingUnavailableError extends AppError {
  constructor(message = "This way of paying isn't available right now. Everything on your current plan keeps working.") {
    super("internal", message);
    this.name = "BillingUnavailableError";
  }
}

/** A webhook that couldn't be proven to come from the provider. Routes answer 400 and apply nothing. */
export class WebhookAuthError extends Error {
  constructor(message = "The notification couldn't be verified.") {
    super(message);
    this.name = "WebhookAuthError";
  }
}

/**
 * Something outside our control failed while handling an authentic
 * notification (the provider's API, a certificate check). Routes answer 503 so
 * the provider delivers it again.
 */
export class WebhookRetryError extends Error {
  constructor(message = "Temporarily unable to process the notification.") {
    super(message);
    this.name = "WebhookRetryError";
  }
}
