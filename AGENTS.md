# AGENTS.md

Paris metro alerts for lines 1 and 7. A free Cloudflare Worker checks IDFM on weekday commute hours and messages ntfy and Telegram only when a line's status changes.

The human plan is in the Obsidian vault at `personal/1-projects/job-pipeline/metro-alerts-plan.md`. This file is the source of truth for the code that is actually deployed.

## What runs in production

The clock is the Worker in `src/index.js` and `src/check.js`, configured by `wrangler.toml`.

- Cron, UTC: `* 5-9,15-19 * * MON-FRI`. Those hours cover Paris summer time and winter time.
- The Worker still drops any minute outside Mon–Fri 07:30–10:00 and 17:00–20:00 Europe/Paris. Do not move that window into the cron. France changes clocks, and cron is UTC.
- Account: `maxim-metro`. Worker URL: `https://metro-alerts.maxim-metro.workers.dev`.
- A request with no `Authorization: Bearer <CHECK_TOKEN>` gets 404. `?force=1` with that header runs outside the commute window. Do not log the token or the ntfy topic.

`check.py` is the same job for a local run. It reads `state.json` in the repo. The Worker reads D1 table `line_state` (`migrations/0001_init.sql`). Those two stores can diverge. The Worker is the one that alerts.

`.github/workflows/check.yml` is manual only (`workflow_dispatch`). Do not put the schedule back. A GitHub run and a Worker run will each send the alert.

## Lines and source

Only line 1 (`line:IDFM:C01371`) and line 7 (`line:IDFM:C01377`). This replaces an older bot that already watched those two lines. Do not add lines unless asked.

IDFM PRIM is the only source. Citymapper was removed after it returned 403. One live disruption is enough. Lift, elevator, and escalator notices are ignored unless the text also describes a service problem.

The first live, non-equipment disruption becomes the line status. `issue` if one exists, otherwise `ok`. If PRIM fails, leave that line's saved status unchanged and try again next minute.

## When it alerts

Compare with the saved status.

- Same status: store the new text, stay quiet.
- First time a line is `ok`: store it, stay quiet.
- `ok` to `issue`: send the disruption text.
- `issue` to `ok`: send `✅ line X back to normal`.
- Both ntfy and Telegram failed: do not save the new status, so the next run retries.

Every alert includes two Paris times. `status` is IDFM's `updated_at` for an issue, or the check time for "back to normal". `checked` is when this run saw the change.

`Metro 1 · status 22:03 · checked 22:08 · …`

`✅ line 1 back to normal · status 08:12 · checked 08:12`

## Secrets

Names only. Never commit values, and never print them.

| Name | Where it is used |
|---|---|
| `PRIM_API_KEY` | IDFM header `apikey` |
| `NTFY_TOPIC` | `https://ntfy.sh/<topic>` |
| `TELEGRAM_TOKEN` | Bot token |
| `TELEGRAM_CHAT_ID` | `356194392` is the chat, not a secret by itself, but it lives with the token |
| `CHECK_TOKEN` | Worker manual run only |

Local copy: `.env`, gitignored. Production copy: Worker secrets. GitHub Actions has the four alert secrets, not `CHECK_TOKEN`. Generating a new PRIM token replaces the old one.

## Local run

```bash
set -a && source .env && set +a
python check.py
```

Outside the commute window the script exits before any request. `node --test test/check.test.js` checks the window, the IDFM clock, and the alert text.

The committed `state.json` is the last known status from the night the Worker was seeded. On 21 Oct 2026 both lines were `issue` because Châtelet was closed until end of service. The D1 rows were seeded from that, so the Worker must not send that closure again.

## Do not

- Commit `.env`, `seed.sql`, or `.wrangler/`.
- Run the GitHub workflow while the Worker is live.
- Treat GitHub's old 5-minute cron as the clock. It was removed because it starts late.
- Add a model call on the polling path. v2, if asked, is one cheap call only when a status turns to `issue`, with a one-line summary and a reroute.

## Handoff

The old always-on bot stays up for two commute days after the Worker catches a real change. Pause that bot only when this checker has matched it. The first scheduled window after deploy is Thu 22 Oct 2026 at 07:30 Paris.
