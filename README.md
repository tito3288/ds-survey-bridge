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
six scores is sent to the comma-separated addresses in `SUPPORT_EMAIL`.

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

## Deployment boundary

Batches 1-4 change the application, local database foundation, documentation,
and automated tests only. Batch 4 changes the private link identifier and makes
survey creation conflict-safe, but does not deploy to Railway, migrate hosted
Supabase, change SMS wording or timing, alter the provisional DropTop payload,
change location mappings or questionnaire routing, or replace provider
integrations. A hosted database backup and schema verification are required
before the later controlled production migration.
