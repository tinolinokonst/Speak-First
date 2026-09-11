# Screenshot pipeline

A daily Playwright run that photographs the public pages and emails the batch.
Capture → email. **Nothing auto-publishes** — captions and posting stay manual.

| File | Role |
| --- | --- |
| `capture.mjs` | Drives headless Chromium, writes PNGs to `screenshots/` |
| `send-email.mjs` | Sends one Resend email with every PNG attached |
| `../.github/workflows/screenshots.yml` | Schedule + manual trigger |

## What gets shot

Four surfaces × two viewports — mobile `390×844 @2x` (9:16-friendly) and
desktop `1280×800 @2x`:

1. **Landing hero** — the first viewport of `/`
2. **Landing full page** — full-page `/`
3. **Why Speak First** — full-page `/why`
4. **Guest demo** — clicks *"Try it — say hi to Sofía"* on `/` and shoots the
   expanded panel. If that button ever moves or is renamed, this shot is
   **skipped**, not failed — the run still delivers the other seven.

Files land in `screenshots/` (git-ignored) as `YYYY-MM-DD_<shot>_<viewport>.png`,
e.g. `2026-09-11_hero_mobile.png`. The date is UTC. The directory is wiped at the
start of every run, so a batch never carries yesterday's shots.

The run exits non-zero if **every** shot fails, or if Resend rejects the email.

## Secrets to set

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
| --- | --- |
| `SITE_URL` | Base URL to shoot, no trailing slash — e.g. `https://speak-first.org` |
| `RESEND_API_KEY` | Resend API key (`re_…`) from [resend.com/api-keys](https://resend.com/api-keys) |
| `AGENT_RECIPIENT_EMAIL` | Where the batch is sent. Comma-separate for several recipients |

Notes:

- `SITE_URL` is optional — it defaults to `https://speak-first-one.vercel.app`,
  which 308-redirects to `https://speak-first.org`. Setting it to the canonical
  domain saves a redirect hop.
- The sender is `onboarding@resend.dev`, Resend's shared test sender. It needs no
  domain verification but can land in spam — swap `FROM` in `send-email.mjs` for
  an address on a verified domain when you have one.
- Resend caps attachments at 40 MB per message. The batch budget is 30 MB; if a
  run exceeds it, the largest shots are dropped and listed in the email as
  "Not attached" rather than failing the send.

## Running it manually

**Actions → Screenshots → Run workflow** (the `workflow_dispatch` trigger). Pick
a branch and go — it takes about two minutes.

Locally:

```bash
npm install
npx playwright install chromium
npm run screenshots          # captures and emails
```

Capture without sending anything — the PNGs stay in `screenshots/`:

```bash
SKIP_EMAIL=1 npm run screenshots
```

Point a run at somewhere else, e.g. a preview deployment or a local dev server:

```bash
SITE_URL=http://localhost:5173 SKIP_EMAIL=1 npm run screenshots
```

## Changing the schedule

Edit the `cron` line in [`../.github/workflows/screenshots.yml`](../.github/workflows/screenshots.yml):

```yaml
schedule:
  - cron: "0 7 * * *"   # min hour day month weekday, always UTC
```

GitHub cron is **always UTC** and has no timezone option, so the local hour moves
with daylight saving. `0 7 * * *` is 09:00 CEST in summer and 08:00 CET in winter
— shift it to `0 8 * * *` in winter if you want a steady 09:00 local.

Other handy values: `0 7 * * 1-5` weekdays only, `0 7 * * 1` Mondays only.
Scheduled runs fire only on the default branch, and GitHub queues them under
load, so expect a few minutes of drift.

## Tuning capture

Both knobs are env vars, no code change needed:

- `SETTLE_MS` (default `3000`) — pause after load before each shot, so fonts and
  entrance animations finish. Raise it if shots look half-painted.
- The browser context runs with `reducedMotion: "reduce"`, which makes
  `Reveal.jsx` render scroll-triggered sections immediately. Without it,
  full-page screenshots come out as pages of invisible content.
