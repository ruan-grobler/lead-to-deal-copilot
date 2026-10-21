# Publishing checklist

Nothing here has been pushed or published. The repo exists only on this machine.

## GitHub

**Description (one line):**
Inbound leads from a web form, email or Slack become deduplicated HubSpot deals that a person approves in Slack with one click. Claude extraction with fallbacks, retries, idempotency and a dead letter replay.

**Topics:**
`hubspot` `slack` `slack-bolt` `claude` `anthropic` `crm-automation` `sales-automation` `lead-management` `structured-outputs` `idempotency` `dead-letter-queue` `typescript` `nodejs` `vitest` `msw`

**To publish (after Ruan's go):** create the GitHub repo, push `main`, and check that the CI workflow (lint, typecheck, tests with coverage, demo, Docker build) goes green on the first run. CI has not run yet, because it only runs once the repo is on GitHub.

## Live demo: what Ruan must create

The demo needs no accounts. These steps are only for a live run. Use synthetic leads in live mode too.

### 1. Slack app (free workspace is fine)

1. Go to https://api.slack.com/apps, choose **Create New App**, then **From a manifest**, pick the workspace and paste [`slack-app-manifest.yml`](slack-app-manifest.yml).
2. **Install to Workspace**. Copy the **Bot User OAuth Token** from **OAuth & Permissions** into `SLACK_BOT_TOKEN`.
3. In **Basic Information**, under **App-Level Tokens**, generate a token with the `connections:write` scope (Socket Mode needs it). Copy it into `SLACK_APP_TOKEN`.
4. Create the channels `#sales`, `#support` and `#sales-ops` (or set other names in `.env`). Invite the bot to each with `/invite @Lead Copilot`, and to any channel where you will use the shortcut.
5. Optional: put your Slack member ID in `SLACK_SALES_LEAD_USER_ID` to be mentioned on high value leads and reminders.

Bot scopes in the manifest: `chat:write`, `commands` (for the message shortcut), `users:read` and `users:read.email` (to map "Assign to me" to a HubSpot owner by email).

### 2. HubSpot private app (free CRM is fine)

1. In HubSpot go to **Development**, then **Legacy apps**, click **Create legacy app** and choose **Private**. (HubSpot may also suggest Service Keys. A legacy private app is what this was written for.)
2. On the **Scopes** tab add:
   - `crm.objects.contacts.read`, `crm.objects.contacts.write`
   - `crm.objects.companies.read`, `crm.objects.companies.write`
   - `crm.objects.deals.read`, `crm.objects.deals.write`
   - `crm.objects.owners.read`

   HubSpot's notes API is covered by the contact write scope. If a call fails with `403 MISSING_SCOPES`, the log line names the scope to add.
3. Create the app, open the **Auth** tab, click **Show token** and copy it into `HUBSPOT_ACCESS_TOKEN`.
4. Optional: put your Hub ID (account menu) in `HUBSPOT_PORTAL_ID` so the Slack card links to the deal.
5. The defaults assume the standard deal pipeline stages `appointmentscheduled`, `qualifiedtobuy` and `closedlost`. If yours differ, set the internal stage IDs in `.env`.
6. For "Assign to me", each salesperson needs a HubSpot user with the same email as their Slack profile.

### 3. Claude (optional, paid)

Create an API key in the Anthropic Console and set `ANTHROPIC_API_KEY`. Without it, live mode still works: every lead goes through the fallback rules to human review.

### 4. Run it

```bash
cp .env.example .env    # then set MODE=live and paste the tokens
npm start
curl -s http://127.0.0.1:3000/health
```

Send a synthetic form lead:

```bash
BODY='{"submissionId":"live_test_1","name":"Test Person","email":"test.person@example.com","message":"We need managed IT for 20 staff, budget R20k a month."}'
curl -s -X POST http://127.0.0.1:3000/webhooks/form -H 'content-type: application/json' -d "$BODY"
```

If `FORM_WEBHOOK_SECRET` is set, add the signature header:

```bash
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$FORM_WEBHOOK_SECRET" | sed 's/^.* //')"
curl -s -X POST http://127.0.0.1:3000/webhooks/form -H 'content-type: application/json' -H "x-signature: $SIG" -d "$BODY"
```

Then in Slack: open a message's **More actions** menu, choose **Create lead from message**, and click **Approve** on the card. Check that the deal moved stage in HubSpot and that the note is on its timeline.

### 5. First live run, things to confirm

- [ ] `server.started` in the log, and `/health` returns `ok`
- [ ] A form lead creates a contact, company, deal and note in HubSpot, and a card in `#sales`
- [ ] Sending the same `submissionId` again answers `duplicate`
- [ ] The message shortcut creates a lead and an ephemeral confirmation
- [ ] Approve, Assign to me and Not a fit update HubSpot and the card
- [ ] Record the run (screenshots or a short screen recording) for the README

The `.data/` folder (SQLite) holds lead text and contact details in live mode. It is gitignored. Delete it after a live demo.

## Secret scan

- **Date:** 21 Oct 2026
- **Tool:** gitleaks is not installed on this machine, so a regex scan ran over `git log -p --all` (every commit in the history) plus any untracked, non-ignored files.
- **Patterns:** Slack bot, user and app tokens and webhook URLs, HubSpot private app tokens (`pat-na1-...` shape), Anthropic and OpenAI keys, AWS access keys, GitHub tokens, Google API keys, Stripe live keys, Twilio SIDs, private key headers, and generic `key/secret/token/password = "..."` assignments.
- **Result: no real credentials.** Two matches, both deliberate fake values:
  - `xoxb-mock-token`, the placeholder bot token mock mode gives the Slack client (`src/runtime.ts`).
  - `demo-signing-secret-not-a-real-credential`, the HMAC secret the demo signs its own webhooks with (`demo/run-demo.ts`).
- `.env` has never been committed. Only `.env.example` is tracked, and every secret in it is empty.
- Before pushing, run `gitleaks detect` if it is available, as a second check.
