# Mailcheap

Mailcheap is a self-hosted newsletter app on Amazon SES. Write an issue, send it to your list, publish it on the web. About $0.10 per 1,000 emails.

![Mailcheap overview](docs/screenshots/overview.webp)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmarclou%2Fmailcheap&project-name=mailcheap&repository-name=mailcheap&env=DATABASE_URL,ADMIN_EMAIL,ADMIN_PASSWORD,SESSION_SECRET&envDescription=Database%2C%20login%20and%20signing%20secret.%20ADMIN_PASSWORD%20needs%2012%2B%20characters%2C%20SESSION_SECRET%2032%2B%20%28run%3A%20openssl%20rand%20-base64%2048%29.%20Add%20SES%20and%20QStash%20after%20the%20first%20deploy.&envLink=https%3A%2F%2Fgithub.com%2Fmarclou%2Fmailcheap%23environment-variables)

> [!IMPORTANT]
> **No support.** This is a one-time open-source release. Issues are off, and setup questions go unanswered. Fork it, deploy it, make it yours.

## Why

Newsletter platforms charge for every subscriber, every month. With your own SES account you pay for the emails you send: 10,000 readers and 4 issues a month is 40,000 emails, about $4.

Mailcheap is the rest of what a newsletter needs, in one small Next.js app: an editor, a list, signup forms, unsubscribe handling, bounce and complaint handling, stats and a public archive. One admin, no teams, no plans. Your list stays in your database.

## Features

**Write and send**

- Editor with a live email preview, slash commands, image uploads and boxes. Markdown and raw HTML work too.
- Checks before every send: subject, preview text, unsubscribe link, size under Gmail's 100 KB clip, postal address, verified domain.
- Test emails, scheduling, and sending in batches through QStash at the rate you set.
- Send in steps: start with your most engaged readers, then send to more.

**Grow the list**

- Several newsletters in one install, each with its own from address, reply-to and postal address.
- A signup form on each newsletter's archive, and a signup API with API keys.
- Confirmed opt-in per newsletter, off by default. Welcome email.
- Rate limits on signups, login, unsubscribes and the API, on by default.

**Keep it healthy**

- SES events (deliveries, bounces, complaints) and a suppression list shared by every newsletter.
- A send pauses itself when bounces pass 2% (at least 5) or complaints pass 0.08% (at least 2), so one complaint never stops it.
- One-click unsubscribe (RFC 8058 `List-Unsubscribe` headers) and an unsubscribe page, with signed links.
- List cleanup, off by default: readers who ignored several issues get one "do you still want this?" email, then stop getting issues.
- Open and click tracking on your own domain, with link scanners filtered out.

**Publish and measure**

- A public archive for each newsletter: issue pages, author page, share images, sitemap. Optional custom domain. Off for the whole install unless `ARCHIVE_ENABLED=true`.
- Overview with subscribers over time, emails per hour, and delivery, open, click, bounce and complaint rates.
- Campaign reports by mailbox provider (Gmail, Outlook, Yahoo, iCloud...).
- Contacts with search, status filters and CSV import from any platform.
- A domains page with each SES identity's DKIM, MAIL FROM and DMARC status (a parent domain's DMARC record counts) and the DNS records to add.

## Screenshots

| Editor | Campaign report |
| --- | --- |
| ![Editor](docs/screenshots/editor.webp) | ![Campaign report](docs/screenshots/report.webp) |
| **Contacts** | **Public archive** |
| ![Contacts](docs/screenshots/contacts.webp) | ![Public archive](docs/screenshots/archive.webp) |

<details>
<summary>Issue page</summary>

![Issue page](docs/screenshots/issue.webp)

</details>

All names and addresses in the screenshots are made up.

## What you need

| Service | For | Cost |
| --- | --- | --- |
| [Supabase](https://supabase.com) (Postgres) | Contacts, campaigns, stats | Free tier works |
| [Amazon SES](https://aws.amazon.com/ses/) | Sending | About $0.10 per 1,000 emails |
| [Upstash QStash](https://upstash.com/docs/qstash) | Background sending and scheduling | Free tier to start, then pay per message. One message sends 50 emails. |
| [Vercel](https://vercel.com) or any Node.js host | Hosting | Free tier works |
| [Upstash Redis](https://upstash.com/docs/redis) (optional) | Rate limits shared by every server instance | Free tier |
| Supabase Storage (optional) | Image uploads in the editor | Included |

Without Redis, Mailcheap counts the same rate limits in each server instance's memory. That still stops a script hammering a form, but on serverless hosts the limits aren't shared between instances and reset on each deploy. Add Redis before you put a signup form on a busy site.

Without Storage keys, image uploads in the editor are off. HTML and Markdown campaigns can still use images hosted anywhere.

## Setup

Plan for about an hour, most of it waiting for DNS and for AWS to approve production access.

### 1. Database

1. Create a project on [Supabase](https://supabase.com) with a strong database password.
2. **Connect**: on Vercel, copy the **Transaction pooler** string (port 6543) as `DATABASE_URL`. On a server that keeps running (Railway, a VPS), use the **Session pooler** string (port 5432) instead: through the transaction pooler, a long-lived connection pool's parallel queries can hang. Copy the **Direct connection** string (port 5432, or the session pooler if your network has no IPv6) as `DIRECT_URL`.
3. Create the tables: `DIRECT_URL=... npm run db:migrate`. Run it again after pulling changes that add migrations (`db/migrations`).
4. Optional, for image uploads: **Storage > New bucket**, name it `uploads`, make it public, and set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (Project Settings > API).

Mailcheap connects as the database owner and doesn't use Supabase's REST API. Every table has row level security on with no policies, so the public API keys can't read them.

### 2. Deploy

1. Click **Deploy** above.
2. Fill in `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (at least 12 characters) and `SESSION_SECRET` (at least 32; generate it with `openssl rand -base64 48`). With shorter ones, Mailcheap refuses to start and the logs say which one to fix.
3. Open `https://<your-project>.vercel.app/login` and log in.

Sending is off until you finish the next steps, so nothing can go out by mistake. On any other Node.js host: `npm ci && npm run build && npm start`, with the same variables, behind HTTPS.

If you plan to use your own domain for the dashboard (like `mailcheap.example.com`), add it in Vercel now and set `APP_URL` to it. Links in your emails use `APP_URL`, so it should be final before your first send.

### 3. Amazon SES

Use one AWS region for everything below (the examples use `us-east-1`).

1. **Verify a sending domain.** In the SES console, go to **Identities > Create identity > Domain**. Use a subdomain like `mail.example.com`, so your main domain's email is unaffected. Keep Easy DKIM with RSA 2048 and add the 3 CNAME records SES gives you at your DNS provider.
2. **Set a custom MAIL FROM domain.** On the identity, open **Custom MAIL FROM domain > Edit**, use `bounce.mail.example.com`, and add the MX and TXT records SES shows. This aligns SPF with your domain.
3. **Add DMARC** if your root domain doesn't have one: a TXT record at `_dmarc.example.com` with `v=DMARC1; p=none;` to start. Gmail and Yahoo require DMARC from bulk senders.
4. **Request production access.** New accounts are in the sandbox (200 emails a day, verified recipients only). In **Account dashboard > Request production access**, pick Marketing, and explain that readers opt in, that bounces and complaints are suppressed automatically, and that every email has one-click unsubscribe. AWS usually answers within a day.
5. **Create a configuration set**, named `mailcheap` for example, under **Configuration sets**. Leave SES open and click tracking off: Mailcheap tracks on your own domain. Then make SES suppress only bounces for it, since Mailcheap keeps spam complaints per newsletter (SES's default list would block a complainer from all of them): `aws sesv2 put-configuration-set-suppression-options --configuration-set-name mailcheap --suppressed-reasons BOUNCE`.
6. **Create an SNS topic.** In the SNS console, create a standard topic, like `mailcheap-ses-events`, and copy its ARN. Then switch it to signature version 2, which signs messages with SHA256 instead of SHA1: `aws sns set-topic-attributes --topic-arn <topic-arn> --attribute-name SignatureVersion --attribute-value 2`.
7. **Send SES events to the topic.** In the configuration set, open **Event destinations > Add destination**. Select hard bounces, complaints, deliveries, delivery delays, rejects and rendering failures, then pick Amazon SNS and your topic.
8. **Create an IAM user for Mailcheap** with this policy, then create an access key for it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": [
        "arn:aws:ses:us-east-1:<account-id>:identity/mail.example.com",
        "arn:aws:ses:us-east-1:<account-id>:configuration-set/mailcheap"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["ses:GetAccount", "ses:ListEmailIdentities", "ses:GetEmailIdentity", "ses:GetConfigurationSet"],
      "Resource": "*"
    }
  ]
}
```

9. **Add the variables in Vercel** and redeploy: `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_CONFIGURATION_SET` and `SES_SNS_TOPIC_ARN`.
10. **Subscribe Mailcheap to the topic.** In the SNS topic, **Create subscription** with protocol HTTPS and endpoint `https://<your-app>/api/webhooks/ses`. Leave raw message delivery off. Mailcheap confirms the subscription by itself; refresh and the status turns to Confirmed.

The **Domains** page in Mailcheap now shows your domain with its DKIM, MAIL FROM and DMARC status, and warns if SES would still block complainers from every newsletter.

### 4. QStash

1. In the [Upstash console](https://console.upstash.com/qstash), open QStash and copy `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` (and `QSTASH_URL` if you picked a region other than the default).
2. Add them in Vercel and redeploy.

3. For automations, add a schedule that moves runs whose wait is over, every 5 minutes: in **QStash > Schedules**, create one with destination `https://<your-app>/api/jobs/automations`, method POST and cron `*/5 * * * *`. Or: `curl -X POST "https://qstash.upstash.io/v2/schedules/https://<your-app>/api/jobs/automations" -H "Authorization: Bearer $QSTASH_TOKEN" -H "Upstash-Cron: */5 * * * *"`.

QStash calls `APP_URL/api/jobs/...` to send each batch, so the app has to be reachable on the internet. Mailcheap checks QStash's signature on every job.

### 5. Turn sending on

1. In Mailcheap, create a newsletter. The from address must be on your verified domain, and the postal address shows in every email's footer (anti-spam laws require one).
2. Set `SENDING_ENABLED=true` in Vercel and redeploy.
3. Write a campaign, send yourself a test, then send. For a new domain, set a limit to reach your most engaged readers first, and use **Send to more** on the report once the first step looks healthy.

### Optional

- **Public archive:** off by default. Set `ARCHIVE_ENABLED=true` to serve `/archive/<newsletter-slug>` and `/p/<issue>`, add "Read online" links to emails, and show each newsletter's archive switch.
- **Archive on its own domain:** add the domain to your Vercel project, then set `ARCHIVE_HOSTS=news.example.com=<newsletter-slug>` and redeploy. That domain serves only the archive and the unsubscribe page, never the dashboard, and the app domain's `/archive/<newsletter-slug>` pages redirect there.

  This is the safer setup: issue pages show HTML from your editor and from API keys, and on their own domain that HTML never shares the dashboard's origin. Without one, the archive stays on the app domain, where the sanitizer, the sandboxed frame and the Content Security Policy protect it.
- **Image uploads:** create a public `uploads` bucket in Supabase Storage and set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- **Cloudflare Access:** to sign in through Cloudflare Access instead of the password, proxy the app's domain through Cloudflare and protect it with an Access application. Add a second application with a **Bypass** policy (everyone) for the paths recipients, AWS, QStash and API clients reach without a login: `/unsubscribe`, `/confirm`, `/keep`, `/o/*`, `/c/*`, `/api/unsubscribe`, `/api/views`, `/api/v1/*`, `/api/webhooks/*`, `/api/jobs/*` and `/api/health`. Then set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` (the protected application's audience tag). Mailcheap checks the token Access adds to every request, so the origin's own URL stays closed, and `ADMIN_PASSWORD` is no longer needed. Turn off Cloudflare's Email Address Obfuscation and Rocket Loader for the domain: their scripts break under Mailcheap's Content Security Policy.
- **Transactional email:** to see the email your other apps send through SES (login links, notifications over SES SMTP) on the **Transactional** page, give those domains their own configuration set. Create one named `transactional` with open and click tracking off (click tracking would rewrite login links), add an event destination to the same SNS topic with sends, deliveries, bounces, complaints, delivery delays, rejects and rendering failures, then make it each domain's default: `aws sesv2 put-email-identity-configuration-set-attributes --email-identity notifications.example.com --configuration-set-name transactional`. The apps need no change. Mailcheap stores one row per email; a hard bounce suppresses the address for newsletters too, a complaint changes no contact. Set `SES_TRANSACTIONAL_CONFIGURATION_SET` if you name the set differently.
- **Shared rate limits:** create a Redis database in the [Upstash console](https://console.upstash.com/redis) and add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
- **Alerts:** set `ALERT_FROM` (like `Mailcheap <alerts@mail.example.com>`) to get alerts by email at `ADMIN_EMAIL`: spam complaints, paused sends and automations, signup floods and rate limiter outages. Add `ALERT_ACTIVITY=true` to also get every login, new API key and send. Otherwise they only show in the logs.

## Local development

```bash
git clone https://github.com/<you>/mailcheap.git && cd mailcheap
npm install
cp .env.example .env.local   # set DATABASE_URL, DIRECT_URL, ADMIN_EMAIL, ADMIN_PASSWORD, SESSION_SECRET
npm run db:migrate
npm run dev
```

A local Postgres works too (`supabase start`, or `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17` with `DATABASE_URL=DIRECT_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres`).

- Sending stays off locally unless you set `SENDING_ENABLED=true`. When the SES keys are empty, the AWS SDK falls back to your default AWS credentials (`~/.aws`), so the domains page can show real data.
- QStash can't reach `localhost`. To try a full send locally, run the QStash dev server (`npx @upstash/qstash-cli dev`) and use the URL, token and signing keys it prints.
- `npm test` runs the unit tests, then the database tests against an in-memory Postgres ([PGlite](https://pglite.dev), no setup needed). `npm run lint` runs ESLint.
- Schema changes: edit `db/schema.js`, run `npm run db:generate`, and commit the new file in `db/migrations`.

## Automations

Drip sequences per newsletter, started by a signup, an app event or a property change, written as a small graph of nodes (the **Automations** page edits them as a list or as JSON):

```json
{
  "trigger": { "type": "event", "name": "api_key_created" },
  "exitWhen": { "has_event": "first_api_call" },
  "nodes": {
    "start": { "type": "wait_until", "condition": { "has_event": "first_api_call" }, "timeout": "7d", "met": "end", "timeout_next": "help" },
    "help": { "type": "send", "subject": "Need a hand getting started?", "markdown": "Hi! ...", "next": "wait2" },
    "wait2": { "type": "wait", "duration": "4d", "next": "check" },
    "check": { "type": "branch", "condition": { "not_has_event": "first_api_call" }, "yes": "help2", "no": "end" },
    "help2": { "type": "send", "subject": "Quick question", "markdown": "...", "next": "end" },
    "end": { "type": "exit" }
  }
}
```

- **Triggers:** `contact_added` (a new active contact, or a confirmation), `event` (`name`), `property_changed` (`property`, optional `to`). Any trigger takes a `condition`.
- **Nodes:** `send` (Markdown or HTML), `wait` (`30m`, `12h`, `4d`, `2w`), `wait_until` (a condition, or a timeout), `branch`, `exit`.
- **Conditions:** `{ "property": "plan", "eq": "pro" }` (also `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `exists`), `{ "has_event": "x", "within_days": 7 }`, `{ "not_has_event": "x" }`, `{ "clicked": { "node": "help" } }` or `{ "campaign": "<id>" }`, `{ "opened": ... }` (unreliable: Apple Mail opens everything), `{ "status": "active" }`, `{ "source": "api" }`, `{ "signup_age_days": { "gte": 7 } }`, combined with `all`, `any` and `not`.
- A contact goes through an automation once, unless it allows re-entry. Before every step Mailcheap checks `exitWhen` and that the contact is still subscribed; unsubscribes, bounces and complaints end the run. Each send node sends at most once per run, however often a job retries.
- Events and property changes move waiting runs right away; the 5-minute QStash schedule moves the rest. An automation pauses itself when its bounce or complaint rate passes the campaign limits.

## Email templates

Each newsletter can have its own design (Settings → Email template). Markdown and editor campaigns, automations, and welcome and confirmation emails are all rendered into it. HTML campaigns keep their own design.

- **Layout:** a whole HTML email with `{{content}}` where the text goes and `{{footer}}` for the unsubscribe footer. `{{subject}}` and `{{preview_text}}` are filled in too.
- **CSS:** styles the text. Rules for `.body <tag>` and for classes (`.btn`, `.btn-cell`, `.btn-table`, `.caption`…) are also copied inline, for clients that drop `<style>`.
- **Buttons:** in Markdown, a line of its own like `[[Try it now]](https://example.com)` becomes a button; `{.center}` right after it centers it.
- **Captions:** a picture's title, `![](https://…/shot.png "The caption")`, shows as a caption under it (also for a linked picture). Templates style them with `.figure`, `.captioned` and `.caption`.

**Write with AI:** with `OPENROUTER_API_KEY` set, the campaign editor has a panel where you paste the copy, links and pictures. Claude writes the email in the product's Markdown, following its last two sent campaigns, and you can ask for changes or undo it.

**HTML campaigns** (imported from MailerLite) have a "Convert to Markdown" button. It keeps the text, headings, pictures and buttons, and the product's template takes over the design.

The designs for our products live in `templates/`. `node templates/build.mjs` regenerates them, and `npm run templates:seed` gives each product its template. A product that already has one keeps it unless you pass `--force`.

## Deliverability basics

- **Send from a subdomain** (`mail.example.com`), so a bad week doesn't affect your main domain's email.
- **Authenticate everything:** DKIM (Easy DKIM), SPF through the custom MAIL FROM domain, and DMARC on the root domain.
- **Only email people who asked.** Never import a bought or scraped list. If bots fill your forms, turn on confirmed opt-in.
- **Warm up a new domain.** Send to your most engaged readers first, and grow each send over a few weeks.
- **Watch complaints and bounces.** Keep complaints under 0.1% and bounces under 2%. Mailcheap pauses a send above 0.08% complaints (at least 2) or 2% bounces (at least 5). Add your domain to [Google Postmaster Tools](https://postmaster.google.com) to see your spam rate at Gmail.
- **Make leaving easy.** Every email has one-click unsubscribe headers and a footer link, which Gmail and Yahoo require.
- **Clean your list.** Turn on list cleanup in each newsletter's settings to stop emailing people who never open.
- **Keep emails under 100 KB**, or Gmail clips them and hides the unsubscribe link.

## Environment variables

| Variable | Required | What it does |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection string: Supabase's session pooler (port 5432) on a long-running server, the transaction pooler (6543) on Vercel |
| `DIRECT_URL` | For migrations | Direct Postgres connection (port 5432), used by `npm run db:migrate` |
| `ADMIN_EMAIL` | Yes | Dashboard login, and where test emails and alerts go |
| `ADMIN_PASSWORD` | Without Access | Dashboard password, 12+ characters. Changing it signs out every session. |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | No | Sign in through Cloudflare Access instead of the password (see Optional) |
| `SESSION_SECRET` | Yes | Signs sessions and email links. 32+ random characters. Changing it breaks links in sent emails. |
| `APP_URL` | On other hosts | Public URL of the app. On Vercel it defaults to the production domain. |
| `SENDING_ENABLED` | To send | Nothing is sent unless it's `true` |
| `SES_REGION` | To send | SES region, `us-east-1` by default |
| `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | To send | IAM user keys |
| `SES_CONFIGURATION_SET` | To send | Configuration set that publishes events to SNS |
| `SES_SNS_TOPIC_ARN` | To send | SNS topic Mailcheap accepts at `/api/webhooks/ses` |
| `SES_TRANSACTIONAL_CONFIGURATION_SET` | No | Configuration set of other apps' email, shown on the Transactional page. Default `transactional` |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | To send campaigns | Background sending and scheduling |
| `OPENROUTER_API_KEY` | No | Turns on "Write with AI" in the campaign editor |
| `OPENROUTER_MODEL` | No | Model for AI drafts, `anthropic/claude-sonnet-5.5` by default |
| `QSTASH_URL` | No | QStash region other than the default, or a local QStash dev server |
| `SEND_RATE_PER_SECOND` | No | Emails per second, 1 to 14 (default 10) |
| `ARCHIVE_ENABLED` | No | `true` turns on the public archive and "Read online" links. Off by default. |
| `ARCHIVE_HOSTS` | No | Archive domains, like `news.example.com=weekly,letters.example.org=monthly` |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | No | Shared rate limits |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | No | Image uploads to Supabase Storage. `SUPABASE_STORAGE_BUCKET` picks the bucket (`uploads`). |
| `ALERT_FROM` | No | From address for alert emails, on a verified domain |
| `ALERT_ACTIVITY` | No | `true` also emails every login, new API key and send |

[`.env.example`](.env.example) has the same list with more detail.

## API

Create a key on the **API keys** page and send it as `Authorization: Bearer <key>`. A key can work with every newsletter or with just one (one product's app); for other newsletters it gets `403`. Every endpoint takes `newsletter` as a slug or an id.

**Add a contact**: `POST /api/v1/contacts`

```bash
curl -X POST https://<your-app>/api/v1/contacts \
  -H "Authorization: Bearer $MAILCHEAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"newsletter":"weekly","email":"jane@example.com","source":"website","ip":"203.0.113.7"}'
```

- `newsletter` (slug) and `email` are required. `source` labels where the signup came from.
- `resubscribe: true` brings back someone who unsubscribed (never someone who bounced or complained).
- Pass your visitor's IP as `ip` to get the per-visitor limit of 5 signups per 10 minutes. Each key is also limited to 600 signups an hour.
- `properties` (optional) merges into the contact's: strings (up to 500 characters), numbers and booleans, under names like `plan` or `last_name`. `null` removes one. Automations can branch on them.
- Answers `201` for a new contact, `200` if it already existed, with `{ id, status, created, properties }`. Signing up again never sends the welcome email again. When the newsletter confirms signups, `status` is `pending` and `inbox` links to the reader's email provider for your "check your inbox" message.

**Record an event**: `POST /api/v1/events` with `newsletter`, `email`, `name` (like `api_key_created`), and optional `properties` and `occurredAt` (ISO date, last 30 days). Creates the contact if the newsletter doesn't have it yet (`source: "api"`), then starts or wakes the automations that wait for it. Answers `201` with `{ id, contactId, contactStatus, created }`.

```bash
curl -X POST https://<your-app>/api/v1/events \
  -H "Authorization: Bearer $MAILCHEAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"newsletter":"supadata","email":"jane@example.com","name":"plan_upgraded","properties":{"plan":"pro"}}'
```

**Erase a contact (GDPR)**: `DELETE /api/v1/contacts` with `{ "email": "..." }` removes the address from every newsletter: its contacts, events, suppression and the address on sent emails (their counts stay in campaign stats). Add `newsletter` to erase from one; a key made for one newsletter always erases there only. Answers `{ deleted }`.

**Create a draft**: `POST /api/v1/campaigns` with `newsletter`, `subject`, `previewText` (optional), `html` or `markdown`, and `archiveSlug` (optional). Answers `201` with the draft's id and dashboard URL. Sending stays a click in the dashboard.

**List sent issues**: `GET /api/v1/campaigns?newsletter=<slug>` returns each issue's id, subject, preview text, archive URL and send date.

## How it works

- Next.js App Router, JavaScript, Tailwind CSS with shadcn/ui, Postgres (Supabase) through Drizzle ORM.
- **Send** picks the audience (active contacts, suppressions left out, most engaged first), creates one message per reader, and queues one QStash job per batch of 50. Each job sends through the SES v2 API at `SEND_RATE_PER_SECOND` and pauses the campaign if bounce or complaint rates pass the limits.
- Welcome and confirmation emails go out right away, capped at 100 every 10 minutes per newsletter.
- SES publishes events to SNS, which posts them to `/api/webhooks/ses`. Mailcheap verifies the SNS signature and updates the message, the campaign stats and the contact. A hard bounce suppresses the address for every newsletter; unsubscribes and spam complaints only stop the newsletter they came from.
- Opens and clicks go through `/o/...` and `/c/...` on your app's domain. Clicks within 30 seconds of the send, or from known link scanners, don't count.
- Archive pages are static and refresh when you send or save.

## Support

There's none: issues are off and pull requests may not be reviewed. This is a one-time release, with no updates planned. See [SECURITY.md](SECURITY.md) for what's built in.

## License

[MIT](LICENSE). Made by [Marc Lou](https://x.com/marclou).
