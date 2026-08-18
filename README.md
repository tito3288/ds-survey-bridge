# Drive & Shine Survey Bridge

This Next.js service receives finalized oil-change orders, creates a survey
record, sends the existing survey link, and stores customer feedback. Customers
first provide an overall 1-5 rating. Ratings below the configured Google-review
minimum continue to a private six-question questionnaire; qualifying ratings
open the location's mapped Google review page. If a review link is unavailable,
the service finishes safely on the existing thank-you screen.

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

## Deployment boundary

Batch 2 changes the application and local automated tests only. It does not
deploy to Railway, migrate the hosted Supabase database, change webhook or SMS
delivery, or alter location mappings. A hosted database backup and schema
verification are required before the later controlled production migration.
