# Drive & Shine Survey Bridge

This Next.js service receives finalized oil-change orders, creates a survey
record, sends the existing survey link, and stores customer feedback. Customers
first provide an overall 1-5 rating. Ratings below the configured Google-review
minimum continue to a private six-question questionnaire; qualifying ratings
show a brief handoff before automatically opening the location's mapped Google
review page in the same tab. A visible link lets the customer continue manually
if automatic navigation does not complete. If a review link is unavailable or
unsafe, the service finishes safely without sending the customer to Google.
Customer links use random survey tokens instead of exposing DropTop order IDs.

## Requirements

- Node.js 22.22.2
- npm
- Docker Desktop for local Supabase checks

Install dependencies with `npm ci` and run the application with `npm run dev`.
Production provider credentials belong in `.env.local`; tests use mocks and
fake local data and never require live Supabase, Twilio, Resend, or DropTop
access.

## Application checks

```bash
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
```

## Local database checks

The Supabase configuration uses local ports in the `5532x` range and applies
the migrations plus `supabase/seed.sql`, which contains fictional data only.

```bash
npm run db:start
npm run test:db
npm run db:types:check
npm run db:stop
```

`db:reset` and `test:db` explicitly target the local database. Do not add
`--linked` to these commands. Applying migrations to the hosted Supabase
project requires a separate schema review, backup, and deployment step.

## Customer questionnaire

The version-one questionnaire requires scores for wait time, service speed,
vehicle cleanliness, additional-service recommendations, value, and team
friendliness. Every answer uses the same scale: 1 is poor and 5 is excellent.
The written improvement comment is optional and limited to 2,000 characters.
Each completed private questionnaire is stored before an email containing all
six scores is durably queued for the comma-separated addresses in
`SUPPORT_EMAIL`.

After private feedback is recorded, the customer sees a confirmation explaining
that the team will use it to improve future visits. A missing or unsafe Google
review link instead receives a neutral confirmation that the response was
recorded. Unknown or malformed survey links show a dedicated unavailable-link
page rather than encouraging repeated submissions. Retryable failures preserve
the customer's selections so they can try again.

`GOOGLE_REVIEW_MIN_RATING` controls the overall-rating threshold and defaults
to `4`, so the default routes ratings 1-3 to private feedback and ratings 4-5 to
the mapped Google review page. The questionnaire answers never change that
route. The setting accepts only whole numbers from 1 through 5 and remains
reversible rather than being embedded in the database.

> **Policy warning:** Directing only selected ratings to Google while sending
> lower ratings to private feedback is review gating and conflicts with
> [Google Maps policies](https://support.google.com/contributionpolicy/answer/7400114?hl=en).
> Keep this behavior reversible and obtain approval before any production
> rollout.

## Private survey links

Every survey record receives a database-generated UUID token, and newly created
records use flow version 2. Only that token is accepted by the customer page
and submission API; DropTop order IDs remain internal for duplicate detection
and private-feedback emails.
Legacy order-ID test links are intentionally unsupported, and links do not
expire yet.

`APP_URL` must be an origin with no path, credentials, query, or fragment.
Production URLs must use HTTPS; local development may use HTTP only for
`localhost` or `127.0.0.1`. Survey pages are non-indexable and non-frameable;
survey pages and submission responses are non-cacheable and use a no-referrer
policy, including the handoff to Google.

The DropTop webhook payload and authentication contract are still unconfirmed.
Do not enable the public webhook for production traffic until DropTop supplies
its real payload documentation and supported signature or secret mechanism.

## Durable message delivery

New survey texts and private-feedback emails are recorded in the service-only
delivery queue in the same database transaction as the survey work that
creates them. Webhook and customer requests do not wait on Twilio or Resend.
Existing survey rows are intentionally not backfilled, preventing old tests or
stale customers from receiving messages after a later migration.

`SURVEY_SMS_DELAY_MINUTES` defaults to `0`, so a text is eligible for the next
worker run immediately. The run-to-exit worker is intended for a separate,
non-public Railway cron service with this configuration:

- Start command: `npm run worker:deliveries`
- Cron schedule: `*/5 * * * *` (UTC)
- Required worker-only flag: `DELIVERY_WORKER_ENABLED=true`

Railway cron jobs run no more frequently than every five minutes, may drift by
a few minutes, and must exit after completing their work. See the
[Railway cron documentation](https://docs.railway.com/cron-jobs).

Each run claims at most 20 jobs with leases, processes at most five provider
requests concurrently, and exits before the next scheduled run. Temporary
failures retry up to six total attempts. Permanent failures become `dead`.
An SMS with an uncertain provider outcome becomes `unknown` and is not retried,
avoiding a possible duplicate customer text. Private emails use a stable Resend
idempotency key so uncertain attempts can retry safely.

The queue's `sent` state means the provider accepted the request. It does not
mean that a text reached a handset or that an email reached an inbox.
Worker logs contain delivery identifiers and sanitized outcome codes only, not
customer contact details, answers, comments, or raw provider errors.

## Verified provider delivery tracking

Batch 6 adds signed provider callbacks without changing the customer flow or
automatically resending accepted messages:

- Twilio posts form-encoded message status updates to
  `/api/webhooks/twilio/message-status/{deliveryJobId}`. The service verifies
  `X-Twilio-Signature` against the exact public callback URL and parameters.
- Resend posts email events to `/api/webhooks/resend/delivery`. The service
  verifies the exact raw body with `svix-id`, `svix-timestamp`,
  `svix-signature`, and `RESEND_WEBHOOK_SECRET`.

Subscribe that Resend endpoint only to `email.sent`, `email.delivered`,
`email.delivery_delayed`, `email.complained`, `email.bounced`, `email.failed`,
and `email.suppressed`. Do not subscribe it to opened or clicked events. The
web app needs the Resend webhook signing secret, but the send-capable
`RESEND_API_KEY` remains isolated to the private delivery worker.

Only normalized provider evidence and sanitized error codes are retained.
Callback receipts never store raw payloads, message bodies, recipients,
customer data, survey answers, or comments. Twilio statuses are protected from
out-of-order regression. Resend emits one event per recipient; the system keeps
privacy-minimal job-level evidence, records success plus failure as `mixed`,
and treats complaints as authoritative. A Resend `delivered` event means the
recipient's mail server accepted the message, not that a person received or
read it.

Three disabled-by-default, run-to-exit commands provide private operational
checks without an admin dashboard or public endpoint:

```bash
npm run ops:delivery-health
npm run ops:twilio-reconcile
npm run ops:delivery-events-cleanup
```

Each command requires its matching environment flag. The health command prints
aggregate-only counts and exits nonzero when attention is needed. Twilio
reconciliation polls messages that were provider-accepted at least 12 hours
earlier but have no final callback; each poll is atomically watermarked so
concurrent runs cannot poll the same message and a nonterminal message is not
eligible again for 12 hours. It records the observed status and never resends a
text. Cleanup deletes only callback receipts older than 90 days in a bounded
batch. Survey records, delivery jobs, and their normalized final state are not
deleted.

Health counts are deliberately cumulative in this local foundation: a dead or
uncertain job, downstream failure, mixed recipient outcome, or complaint keeps
the command nonzero instead of silently clearing itself. Use the command as a
manual aggregate check in Batch 6. Before scheduling it in production, Batch 7
must define the responsible operator and a separate acknowledgement/remediation
policy that preserves the historical delivery evidence.

Production activation still requires the final HTTPS `APP_URL` so each outgoing
Twilio message receives the correct callback URL, registering the Resend
endpoint and signing secret, replacing the temporary `onboarding@resend.dev`
sender with an approved address on a verified Drive & Shine domain, and
enabling separately scheduled operational services. See Twilio's
[message-status](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status)
and [signature-verification](https://www.twilio.com/docs/usage/webhooks/webhooks-security)
guidance and Resend's
[webhook-verification](https://resend.com/docs/webhooks/verify-webhooks-requests)
documentation. None of those hosted-provider or Railway steps occur here.

## Deployment boundary

Batches 1-6 change the application, local database foundation, documentation,
and automated tests only. Batch 5 moves provider work into a durable queue;
Batch 6 adds signed callback and disabled operational commands. Neither batch
creates Railway services, registers live callbacks, deploys to Railway,
migrates hosted Supabase, changes SMS wording, alters the provisional DropTop
payload, changes recipients, location mappings, questionnaire routing, or
provider vendors. A hosted database backup and schema verification are required
before the later controlled production migration.
