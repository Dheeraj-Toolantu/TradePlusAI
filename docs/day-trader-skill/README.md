# Day Trader skill pack in TradePlusAI

This repository vendors the 11 Claude Code skills from
[Jakeschincariol/day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill)
(MIT, pinned to upstream commit `3d0f4ef6986f4984b7c6bd46f7ff4f87744c3abd`, 2026-10-20) as
**project-local skills**. Anyone who opens TradePlusAI in Claude Code gets `/trader-scanner`,
`/trader-news` and the other nine as slash commands, with no plugin install. The upstream README
is kept as published in [UPSTREAM-README.md](UPSTREAM-README.md).

## What it is and how it works

Each skill has two parts:

- **`SKILL.md`** tells Claude when to use the skill, the method to follow and the safety rules.
- **One standard-library Python tool** does the data fetching and arithmetic. It needs Python 3.8+
  and nothing from pip.

Claude runs the tool through `${CLAUDE_SKILL_DIR}`, explains the output in plain words and asks
you before every step that matters. The skills share a `trader/` folder in the project root, and
each one reads what the previous one wrote:

```
scanner -> news -> entry -> exit -> timemachine -> budget -> risk -> broker   (one trade)
alerts: stop, target, flat by the close                                       (while it is open)
news / analyst / pelosi                                                        (on a schedule)
```

| command | tool | reads | writes |
| --- | --- | --- | --- |
| `/trader-scanner` | `scan.py` | Nasdaq Trader symbol lists, Yahoo daily + 5m bars | `trader/universe.txt`, `trader/watchlist.json` |
| `/trader-news` | `news.py` | Yahoo RSS headlines, SEC 8-K feed, Yahoo chart | `trader/state/news.json` |
| `/trader-entry` | `entry.py` | Yahoo 1m/5m bars | entry trigger (waiting / triggered / expired) |
| `/trader-exit` | `exit.py` | bars + entry | `trader/plan.json` (stop, target, flat-by) |
| `/trader-timemachine` | `timemachine.py` | 60 days of 5m bars | 10,000 Monte Carlo replays + historical replays of the same rule |
| `/trader-budget` | `size.py` | `trader/plan.json`, `trader/config.json` | `trader/orders.json` (bracket order) |
| `/trader-risk` | `check.py` | orders + config + today's fills | PASS / BLOCK per order |
| `/trader-broker` | `ticket.py` | risk-passed orders | a ticket; Claude places it through the Alpaca MCP connector **only after you type yes** |
| `/trader-alerts` | `alerts.py` | `trader/plan.json`, Yahoo quotes | `trader/alerts.json`, `trader/state/alerts.json` |
| `/trader-analyst` | `facts.py` | SEC EDGAR XBRL company facts | quarters, growth, EPS |
| `/trader-pelosi` | `ptr.py` | House Clerk periodic transaction reports | disclosed Congress trades |

Nothing in the pack can place an order by itself. `/trader-broker` needs a passing `/trader-risk`
check for that exact order and an explicit "yes" from you in chat. Claude's own "Allow once / Deny"
card on the broker connector is a second check. Paper trading is the default.

## What was set up in this repo

| path | what it holds |
| --- | --- |
| `.claude/skills/trader-*/` | the 11 skills, unchanged from upstream |
| `.claude/skills/LICENSE.day-trader-skill` | the upstream MIT license |
| `tests/day-trader-skill/` | the upstream offline unittest suite and its real-data fixtures; `_load.py` points at `.claude/skills`, and `test_skills_layout.py` replaces upstream's `test_repo.py` |
| `.github/workflows/trader-skills.yml` | runs the suite in CI when the skills or their tests change |
| `.gitignore` | ignores `/trader/` (your budget, positions, state and SEC contact) |
| `.prettierignore` | leaves the vendored files and fixtures as published |
| `package.json` | `npm run test:trader-skills` |

## Using it

1. Open this repository in Claude Code (CLI, desktop or web). The skills load automatically: type
   `/trader-` to list them.
2. The first time you run `/trader-budget`, Claude copies
   `.claude/skills/trader-budget/config.example.json` to `trader/config.json` and asks you for each
   limit: budget, max loss per trade, daily loss limit, entry window and so on. Keep
   `"paper": true`.
3. For the SEC tools (`/trader-news` filings, `/trader-analyst`), set your identity:
   `"sec_user_agent": "Your Name you@example.com"` in `trader/config.json`, or the
   `SEC_USER_AGENT` environment variable.
4. Optional, only for `/trader-broker`: add Alpaca's MCP server with **paper** keys. See
   `.claude/skills/trader-broker/claude_desktop_config.example.json`. Set its tool permission to
   "Needs approval", never "Always allow". Keys go in environment variables, never in chat.

You can also run the tools directly from the repo root:

```bash
python3 .claude/skills/trader-scanner/scan.py orb --at 10:15
python3 .claude/skills/trader-exit/exit.py plan --stop or-mid --target 1R --write
python3 .claude/skills/trader-timemachine/timemachine.py run --write
python3 .claude/skills/trader-risk/check.py
```

Run the offline tests:

```bash
npm run test:trader-skills
```

## How it relates to the rest of TradePlusAI

The pack is a **separate, Claude-driven workflow**. It is not wired into the TradePlusAI services.
Keep these differences in mind:

- **Market.** The pack targets **US equities**: NYSE hours (9:30 to 16:00 ET, with NYSE holidays
  and early closes built in), USD limits, a Nasdaq Trader universe, SEC EDGAR and Alpaca. TradePlusAI
  targets **Indian markets** (NSE/BSE, IST, Groww). Yahoo's chart endpoint serves NSE symbols such
  as `RELIANCE.NS`, but the session clock, holiday calendar, entry window and USD fields in the
  tools are US-specific. Their timings are wrong for NSE, so do not use the pack's entry, exit or
  risk output for Indian trades.
- **Execution.** The pack's only route to an order is the Alpaca MCP connector, in chat, after your
  yes. It never touches `services/execution`, the Groww adapter, `LIVE_EXECUTION_ENABLED` or the
  `ALGO_*` live-trading switches, and those gates still govern every TradePlusAI order.
- **Risk limits.** `trader/config.json` (USD, per-Claude-session) is separate from the
  `LIVE_MAX_*` limits in `.env`. Changing one does not change the other.
- **Useful overlap.** The ideas map onto existing TradePlusAI modules. For example, the opening-range
  breakout and Time Machine replay are comparable to `quant/` ORB backtests, and the risk gate is
  comparable to `services/risk`. Use the pack as a reference or research companion. Porting a tool
  to NSE means swapping its session calendar, timezone and currency fields, and that is not done here.

## Updating from upstream

```bash
git clone --depth 1 https://github.com/Jakeschincariol/day-trader-skill /tmp/dts
rm -rf .claude/skills/trader-* && cp -r /tmp/dts/trader-* .claude/skills/
cp /tmp/dts/LICENSE .claude/skills/LICENSE.day-trader-skill
cp /tmp/dts/README.md docs/day-trader-skill/UPSTREAM-README.md
rm -rf tests/day-trader-skill/fixtures && cp -r /tmp/dts/tests/fixtures tests/day-trader-skill/
cp /tmp/dts/tests/test_*.py tests/day-trader-skill/ && rm tests/day-trader-skill/test_repo.py
npm run test:trader-skills
```

Then update the pinned commit at the top of this file.

## Fine print

This is not financial advice. The tools read free, unofficial public data and do arithmetic. Most
people who day trade lose money. The Time Machine is a simulation, not a prediction, and a stop is a
plan, not a guarantee. See "Fine print" in [UPSTREAM-README.md](UPSTREAM-README.md).
