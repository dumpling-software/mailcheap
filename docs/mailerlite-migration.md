# Moving from MailerLite

How Supadata, Poof and Gistly move from MailerLite to this Mailcheap. Spell isn't migrated.

## What comes over

`npm run import:mailerlite -- all` (see the header of `scripts/mailerlite/import.mjs`):

| MailerLite | Mailcheap |
| --- | --- |
| Groups `supadata`, `poof`, `gistly` | Newsletters with those slugs (from address from each group's latest campaign) |
| Subscribers | One contact per newsletter they're in, with signup and opt-in dates, fields as properties, and their old open and click rates |
| Unsubscribed | Unsubscribed in the newsletter whose campaign they unsubscribed from; in all their newsletters when that can't be traced. Subscribers left without a group (former Spell) only where a campaign shows they left |
| Bounced | Bounced in their newsletters, and on the global suppression list |
| Junk (spam reports) | Complained in their newsletters only |
| Sent campaigns (and the draft) | Campaigns with their HTML (MailerLite footer removed, images moved to Supabase Storage) and stats. Segment campaigns go to the newsletter most recipients are in. Campaigns for Spell or everyone are skipped |
| Per-subscriber campaign activity | Messages (delivered, opened, clicked, bounced at the send time), then each contact's last open, click and ignored-issue count |
| Automations | Draft automations: emails as send nodes (HTML, plus a Markdown draft to review), delays as waits, triggered when a contact joins |

Not available from MailerLite's API: the draft campaign's content (copy it by hand), exact open and click times, and unsubscribes from automation emails (those count toward the "all their newsletters" rule).

The import never sends an email or starts an automation, and running it again is safe: contacts only move to stricter statuses, so a late run never undoes an unsubscribe made in Mailcheap.

## Runbook

1. **SES.** Verify `supadata.ai`, `poof.bg` and `dumpling.software` (DKIM and MAIL FROM; the Domains page shows both). Check the account has production access and a quota above Supadata's list (about 70,000 per send). Make the configuration set suppress bounces only: `aws sesv2 put-configuration-set-suppression-options --configuration-set-name <set> --suppressed-reasons BOUNCE`.
2. **Deploy Mailcheap** (Railway service `mailcheap`, https://mailcheap.dumpling.software; its pre-deploy command `npm run db:migrate:deploy` applies migrations) with `ARCHIVE_ENABLED` unset and `SENDING_ENABLED=false`, and add the QStash schedule for `/api/jobs/automations` (README, Setup > QStash).
3. **Import.** `MAILERLITE_API_KEY=... DIRECT_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run import:mailerlite -- all --dry-run`, check the report, then run it without `--dry-run` (about 40 minutes, most of it the activity stage). Responses are cached in `.import-cache/`, so a stopped run picks up where it was.
4. **Review.** In each newsletter, set the postal address. In each automation, read the emails, switch them to Markdown where the draft reads well, and send yourself a test. Copy the draft campaign's content by hand.
5. **Switch.** Create one API key per newsletter (API keys > New > Only <newsletter>). Set `SENDING_ENABLED=true`. Activate the three automations. Set `MAILCHEAP_URL` and `MAILCHEAP_API_KEY` in Supadata, Poof and Gistly and deploy them (branches `feat/mailcheap`): signups then go to Mailcheap and start its welcome automation.
6. **Drain.** Leave MailerLite's automations on for about two weeks: the contacts already in them (1,459 Supadata, 40 Poof, 9 Gistly at the inventory) finish there, and no new ones join. Then run `npm run import:mailerlite -- attribution contacts --refresh` to bring over the unsubscribes and bounces from those weeks.
7. **First campaign.** Send to the most engaged readers first (a send limit in the send dialog), check bounces and complaints on the report, then send to more.
8. **Close MailerLite.** Turn its automations off, export a backup, and revoke the API key used for the import.

## Events from the apps

The apps send `api_key_created` when someone creates an API key. Automations can also wait for events the apps don't send yet; adding them is a call to `trackMailcheapEvent(email, name, properties)` (`packages/email/src/mailcheap.ts`) where they happen:

- `first_api_call`: in the gateway, once per organization.
- `quota_reached`, `plan_upgraded`: in the billing webhooks.
