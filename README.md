# upasana-be — Upasana

**Node.js + Express 5 + TypeScript + Prisma (MongoDB)** on the madmax SaaS
chassis — Better Auth sessions, Dodo Payments billing, a background job queue,
usage metering, Swagger docs and Docker packaging. No product code yet.

## Quick Start

```bash
pnpm install
cp .env.example .env     # then fill in your values
npx prisma generate
npx prisma db push
npx ts-node scripts/ensure-partial-indexes.ts   # required after every db push
npx ts-node scripts/backfill-defaults.ts        # ditto, when a required field was added
pnpm dev:all             # API and worker together
```

The server starts on `http://localhost:5000`. Interactive API docs are at
`http://localhost:5000/api-docs`.

## What's Included

- **Auth**: Better Auth — email/password and Google OAuth, session cookies, password reset, admin role gating.
- **Billing**: Dodo Payments subscriptions — checkout, customer portal, webhook-driven subscription mirror, a code-defined plan table.
- **Account lifecycle**: soft delete with a 30-day grace period, restore, and an audit log that survives the purge.
- **Admin**: a minimal read-only admin surface — the signed-in admin's own record, a paginated user list/detail, and the plan table.
- **Background jobs**: a MongoDB-backed queue with atomic claiming, exponential backoff, stuck-job reaping, and a separate worker process.
- **AI**: two metered clients with the same shape — Anthropic (`src/lib/ai/claude.ts`, per-call timeouts, JSON repair, refusal handling) and Google (`src/lib/ai/gemini.ts`, server-enforced response schemas). Both optional at boot; each fails at the point of use with a clear message.
- **Usage metering**: every paid third-party call is priced into `usage_event` at the moment it happens, so you learn what a user costs before the invoice does.
- **Email**: Resend, with table-based transactional templates that survive Outlook.
- **Docs**: Swagger UI generated from JSDoc annotations on routes.
- **Ops**: multi-stage Dockerfile and docker-compose for containerized deployment anywhere.

See [features.md](./features.md) for the full breakdown.

## API Endpoints

| Method | Endpoint                        | Description                                                |
| ------ | ------------------------------- | ---------------------------------------------------------- |
| GET    | `/api/health`                   | Health check (includes DB ping)                            |
| ALL    | `/api/auth/*`                   | Better Auth — signup, login, logout, OAuth, password reset  |
| GET    | `/api/billing/plans`            | The plans on sale (public)                                 |
| POST   | `/api/billing/checkout-session` | Start a subscription, get a hosted checkout URL            |
| POST   | `/api/billing/portal-session`   | Get a link to the hosted customer portal                   |
| GET    | `/api/billing/subscription`     | The signed-in user's subscription and plan                 |
| POST   | `/api/webhooks/dodo`            | Dodo Payments webhook receiver                             |
| POST   | `/api/users/onboarding`         | Mark onboarding complete                                   |
| POST   | `/api/users/delete`             | Schedule the signed-in account for deletion                |
| POST   | `/api/users/restore`            | Cancel a pending deletion                                  |
| GET    | `/api/admin/me`                 | The signed-in admin's own record                           |
| GET    | `/api/admin/users`              | List users, filterable and paginated                       |
| GET    | `/api/admin/users/:id`          | One user's profile, plan and activity                      |
| GET    | `/api/admin/plans`              | Every plan, with resolved Dodo product ids                 |

## Project Structure

```
src/
├── controllers/        # Request handlers
├── lib/
│   ├── ai/claude.ts    # The only place this codebase calls Anthropic
│   ├── billing/        # The plan table — pricing's single source of truth
│   ├── queue/          # Job queue
│   ├── auth.ts         # Better Auth config
│   ├── dodo.ts         # Dodo Payments client
│   ├── email.ts        # Resend client + transactional templates
│   └── usage.ts        # The spend ledger
├── middlewares/        # auth guard, validation, global error handler
├── routes/             # Route definitions + OpenAPI annotations
├── utils/              # Prisma client, Swagger config, CAS lock helpers
├── worker/             # The background worker process
└── index.ts            # App bootstrap
prisma/schema.prisma
scripts/                # Standalone maintenance scripts, run by external cron
```

## Making It Yours

1. Set `BRAND_NAME` and `SITE_URL` in `.env` — they drive the emails and the Swagger title.
2. Edit the plan table in `src/lib/billing/plans.ts`: rename the tiers, change the prices, delete one. Then create the matching products in Dodo and point the `DODO_PRODUCT_*` variables at them.
3. Drop your logo at `<SITE_URL>/email/mark.png` (or set `BRAND_MARK_URL`).
4. Add your models to `prisma/schema.prisma` below the marker, hanging them off `User` with `onDelete: Cascade` so the hard-delete script stays a one-liner. Then `npx prisma db push`.
5. Create a controller in `src/controllers/` and a matching router in `src/routes/`, and mount it in `src/routes/routes.ts`.
6. Protect routes with the `protect` middleware from `src/middlewares/authMiddleware.ts`; add `requireAdmin` for admin-only ones.

### Adding a background job

1. Add the kind to the `JobKind` union in `src/lib/queue/claim.ts`.
   It is `never` until the first kind is added.
2. Write a handler in `src/lib/queue/handlers/`. Make it idempotent: a job can run twice.
3. Route it in `dispatch` in `src/worker/index.ts`.
4. Enqueue it with `await enqueue("your_kind", { userId, ... })`.

## Things That Will Bite You

- **`ensure-partial-indexes.ts` must run after every `prisma db push`.** Push reconciles indexes against `schema.prisma` and drops the partial unique index on `dodoCustomerId` that it does not know about. Without it, two users can share a Dodo customer id and a webhook can credit the wrong account.
- **The Dodo webhook needs the raw body**, so it is mounted in `src/index.ts` ahead of `express.json()` — not in the router. Leave it there.
- **Deploy the worker as its own service.** An API deployed without it serves every screen correctly and silently never does the work behind them.
- **Prisma's Mongo connector needs a replica set for transactions.** Nothing in this template uses one, so a single-node local Mongo is fine — until you reach for `$transaction`.

## Documentation

- [setup.md](./setup.md) — local development and Docker setup
- [features.md](./features.md) — feature list
