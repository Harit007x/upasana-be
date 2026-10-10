# Backend Setup Guide

Welcome to the Node.js Express backend project. Follow these instructions to set up the repository for local development.

## Prerequisites

Before you begin, ensure you have the following installed on your machine:
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [pnpm](https://pnpm.io/) (used as the package manager in this project)
- [MongoDB](https://www.mongodb.com/try/download/community) (running locally or a MongoDB Atlas cluster URI)
- [Docker](https://www.docker.com/) (optional, for containerized deployment)

## 1. Installation

First, navigate to the project directory and install the dependencies using `pnpm`:

```bash
# Install all dependencies from package.json
pnpm install
```

## 2. Environment Variables

Create a `.env` file in the root directory for default values. This project supports hierarchical environment loading using `dotenv-flow`, similar to Next.js.

### Loading Order
Environment variables are loaded from multiple files with the following priority (later files override earlier ones):
1.  `.env` (Default values)
2.  `.env.local` (Local overrides for all environments - ignored by git)
3.  `.env.[mode]` (Environment specific, e.g., `.env.development`)
4.  `.env.[mode].local` (Local overrides for specific environment - ignored by git)

### Essential Variables
`.env.example` is the annotated template — copy it to `.env` and work through it. The minimum to boot:

```env
# The port your server will run on (defaults to 5000)
PORT=5000

# The URL of your frontend application
FRONTEND_URL=http://localhost:5173

# Your MongoDB connection string. The database name (`saas` here) must not be
# `local`, `admin` or `config` — those are reserved by MongoDB and cannot take
# part in transactions, which Prisma uses for every write.
DATABASE_URL="mongodb://localhost:27017/saas"
```

### Google sign-in (optional)

Email/password sign-in works with no extra setup. To also offer "Continue with
Google", create an OAuth client in the
[Google Cloud Console](https://console.cloud.google.com/apis/credentials):

1. **APIs & Services → OAuth consent screen** — pick *External*, fill in the app
   name and support email. While the app is in *Testing*, only the accounts you
   list under **Test users** can sign in; everyone else is rejected before the
   request ever reaches this server.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   type *Web application*.
3. Under **Authorised redirect URIs**, add this server's callback — origin +
   `/api/auth/callback/google`:

   ```
   http://localhost:5000/api/auth/callback/google
   ```

   It must match `BETTER_AUTH_URL` exactly, including scheme, port and the
   absence of a trailing slash. Google compares the string literally and fails
   the whole flow with `redirect_uri_mismatch` on any difference. Add one entry
   per deployed origin.
4. Copy the client ID and secret into `.env`:

   ```env
   BETTER_AUTH_URL=http://localhost:5000
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```

Leave either variable unset (or at its `replace-me` placeholder) and the provider
is simply not registered: the server logs the redirect URI to configure at boot,
`/api/auth/sign-in/social` answers `404 PROVIDER_NOT_FOUND`, and the frontend's
Google button reports that it is not configured rather than bouncing the user to
a Google error page.

> **Note on existing accounts.** A Google sign-in for an address that already has
> a password account is refused with `account_not_linked`, and the login screen
> tells the user to sign in with their password instead. This is deliberate —
> automatically merging the two would let anyone register an account under
> someone else's address and inherit it the moment that person used Google. The
> two can only be merged safely once the local account's email is verified.

### WhatsApp (MSG91, optional)

Team invites (admins and mandal sanchalaks) to a mobile number are sent on WhatsApp through
[MSG91](https://msg91.com). Until this is set up, mobile invites still work: the
admin gets the link on screen and sends it from their own phone with the
**Send on WhatsApp** / **Send SMS** buttons. All the MSG91 code is in
`src/lib/whatsapp.ts`.

**What you need first**

- A **new phone number** that is *not* registered on the WhatsApp or WhatsApp
  Business app. It becomes the number messages come from. It must be able to
  receive an OTP (SMS or call) once, during setup.
- A **Facebook account** to create the Meta business account with — MSG91's
  signup opens Meta's own screens for this part.
- The trust's / Mandir's **registration documents**, for business verification
  (step 5).

**Steps**

1. **Sign up at msg91.com** and pick the WhatsApp product. Top up the wallet
   (prepaid, in ₹) — messages are deducted from it.
2. **Connect WhatsApp** (MSG91 → WhatsApp → *Add number* / *Embedded signup*).
   This walks through Meta's screens: create or pick a Meta Business portfolio
   in the trust's name, set the **display name** people will see (e.g.
   "Youth Convention 2026"), add the new number and verify it by OTP.
3. **Create the invite template** (MSG91 → WhatsApp → Templates → *Create*),
   exactly as below, and submit it for approval. Approval usually takes minutes
   to a few hours.

   | Field | Value |
   | --- | --- |
   | Name | `team_invite` |
   | Category | **Utility** (not Marketing — Utility is ₹0.115/message, Marketing ~₹0.86) |
   | Language | English (`en`) |
   | Header | None |
   | Body | `Hello, {{1}} has invited you to join {{2}} as {{3}}. Tap the button below to sign in and accept. The link works once and expires in 7 days.` |
   | Body samples | `{{1}}` = `Harit Patel`, `{{2}}` = `Youth Convention 2026`, `{{3}}` = `Mandal sanchalak for Surat` |
   | Button | *Visit website* → **Dynamic** URL: `https://<your-frontend-domain>/invite/{{1}}`, button text `Accept invite` |
   | Button sample | `{{1}}` = `abc123` |

   The server fills `{{1}}` with the inviting admin's name, `{{2}}` with the
   event name, `{{3}}` with the role ("an admin" or "Mandal sanchalak for
   <mandal>"), and the button's `{{1}}` with the invite token. Meta rejects a
   body that *starts or ends* with a placeholder, which is why it opens with
   "Hello,".

   The button URL must be your **real, public frontend domain** — Meta does not
   accept `localhost`. It is fixed into the template, so if the domain changes
   the template has to be edited and re-approved. Until the app is deployed,
   invites sent this way will open the production domain, not your laptop.
   **Then the verification-code template**, used to verify the primary
   contact's mobile on the registration form:

   | Field | Value |
   | --- | --- |
   | Name | `registration_otp` |
   | Category | **Authentication** |
   | Language | English (`en`) |
   | Code delivery | **Copy code** button |
   | Options | Tick *Add security recommendation*; set *Expiration* to **10 minutes** |

   Meta writes the wording of authentication templates itself ("123456 is your
   verification code. For your security, do not share this code."), so there is
   no body to type. The server fills the code into the body and the button.

   Until this template is live, the form still works **in development**: the
   code is printed in the server log and shown on the form in a yellow
   "Dev mode" note. **In production** (`NODE_ENV=production`) the form cannot
   send codes until WhatsApp is configured, and registrations cannot be
   submitted.
   **Then the room-details template**, used by *Send room details* on the
   Accommodation screen to tell a registration's contact where everyone stays:

   | Field | Value |
   | --- | --- |
   | Name | `room_details` |
   | Category | **Utility** |
   | Language | English (`en`) |
   | Header | None |
   | Body | `Hello {{1}}, your stay for {{2}} is arranged. {{3}}. Please show this message at the guest house, and reply here if your plans change.` |
   | Body samples | `{{1}}` = `Harit Patel`, `{{2}}` = `Youth Convention 2026`, `{{3}}` = `Gurukul – Memnagar, Memnagar. Room 12: Harit Patel, Priya Patel. Map: https://maps.app.goo.gl/abc. Contact: Rameshbhai, +91 98765 43210` |

   The server fills `{{3}}` with every place, room and person on one line —
   WhatsApp does not allow line breaks inside a placeholder. Until this
   template is live, *Send room details* shows the message for a team member
   to send from their own WhatsApp (*Open WhatsApp* fills it in), then *Mark
   as sent*; *Send all* needs the template.
4. **Copy the settings into `.env`** and restart the server:

   ```env
   MSG91_AUTH_KEY=...                # MSG91 → Authkey
   MSG91_WHATSAPP_NUMBER=919XXXXXXXXX  # the connected number, country code, no +
   MSG91_WHATSAPP_NAMESPACE=          # only if MSG91 shows one on the template
   MSG91_WHATSAPP_LANGUAGE=en
   MSG91_TEMPLATE_INVITE=team_invite
   MSG91_TEMPLATE_OTP=registration_otp
   MSG91_TEMPLATE_STAY=room_details
   ```

   The Admins screen picks this up on its next load: the *Mobile* option then
   says "We send them the link on WhatsApp", and a sent invite shows
   *Sent on WhatsApp*.
5. **Start business verification early** (Meta Business Settings → Security
   Centre, or ask MSG91 support to help). Until the business is verified, Meta
   caps how many different people you can message per day (historically 250).
   Fine for team invites; not enough for thousands of registration
   confirmations in the week before the event.

**If a send fails**, the invite is still created and the admin sees the link
with a "could not be sent on WhatsApp" note. The server log has MSG91's reason
(`[WhatsApp] Admin invite to … failed:`) — usually an unapproved template name,
a template whose placeholders do not match, or an empty wallet.

## 3. Database Setup (Prisma)

This project uses [Prisma ORM](https://www.prisma.io/) to interact with the MongoDB database. To set up Prisma for local development:

### Generate Prisma Client
Generate the Prisma Client so you get correct TypeScript type definitions based on your `schema.prisma`. 
*Note: Run this command every time you pull changes or modify `schema.prisma`.*

```bash
npx prisma generate
```

### Push Schema to Database
Since this project uses MongoDB, Prisma does not use standard SQL migrations. To ensure your database collections and indices match your schema, simply push the schema:

```bash
npx prisma db push
```

### Create the partial indexes

**Run this after every `prisma db push`.** Push reconciles indexes against
`schema.prisma` and drops any it does not recognise — including the partial
unique index on `Registration.contactMobile`, which Prisma cannot express.
Without it, the database no longer enforces one registration per contact
number. `pnpm db:push` runs the push and this script together.

```bash
npx ts-node scripts/ensure-partial-indexes.ts
```

### Backfill new fields onto existing documents

**Also run this after a push that added a required field.** MongoDB stores no
schema, so adding `excluded Boolean @default(false)` leaves existing documents
without the key. Prisma hides that on reads — a `select` returns `false` — but
not on filters: `where: { excluded: false }` does not match a document that
lacks the field, so the rows read back fine one at a time and vanish from every
filtered query.

```bash
npx ts-node scripts/backfill-defaults.ts
```

Safe to re-run; it only touches documents still missing the field.

## 4. Running the Application

Now you're ready to start the server!

### Development Mode
To start the server with hot-reloading (using `nodemon`):

```bash
pnpm run dev
```
You should see a console message indicating the server is running on `http://localhost:5000` (or your configured `PORT`), followed by a successful database connection log.

### The Background Worker

Queued jobs run in a **separate process**, not inside the API. Start it alongside
the server:

```bash
pnpm run worker      # the worker alone
pnpm run dev:all     # API and worker together
```

An API running without a worker serves every screen correctly and silently never
does the work behind them — jobs pile up `pending` with no error anywhere. If
your product has no background work yet, you can skip it; add it back the moment
it does.

### Production Build
To compile the TypeScript code to JavaScript into a `dist/` directory:

```bash
pnpm run build
```

To start the compiled production build:

```bash
pnpm run start         # the API
pnpm run worker:start  # the worker, as its own service
```

## 5. Docker Setup (Recommended for Deployment)

You can also run the entire application in a containerized environment using Docker.

### Building the Image
To build the Docker image locally:

```bash
docker build -t upasana-be .
```

### Running with Docker Compose
The easiest way to start the application is using Docker Compose, which handles environment variables and container orchestration:

```bash
# Build and start the container in detached mode
docker compose up --build -d
```

The application will be accessible at `http://localhost:5000` (or your mapped port).

### Useful Docker Commands
- **Stop containers:** `docker compose down`
- **View logs:** `docker compose logs -f`
- **Restart app:** `docker compose restart app`
- **Worker logs only:** `docker compose logs -f worker`
