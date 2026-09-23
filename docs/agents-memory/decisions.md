# Decisions

Newest first. Format and rules: `README.md` in this directory.

## 2026-09-23: An outage or retry line below a limit's reached line makes it stale

The DOG-57 `stale` check also fires on any `OUTAGE_PATTERNS` payload or `RETRY_RE` line
strictly below `r`, above the input box: the agent made requests after the banner.
`RESET_RE` uses `\bavailable`. The payload check runs on every platform, anywhere in the
line, so adding a provider outage row widens it; rerun a main-vs-HEAD differential then.
PR: https://github.com/johncioni/orca-watchdog/pull/64

## 2026-09-23: Limit/outage arbitration uses the limit's reached line

`pick` keeps a limit only if its reached line (`reachedIndex`) is at or below the
detected outage; an outage printed after the limit was reached is the newer event.
The old anchor, the last relevant line, let an error line carrying reset words
(`Service Unavailable`) tie with the outage and revive a stale limit. Relies on
chronological screen order.
PR: https://github.com/johncioni/orca-watchdog/pull/62

## 2026-09-23: A new agent message makes an earlier limit banner stale

Registry `chrome.outputStart` lists message-start markers (claude `⏺`, gemini `✦`,
codex none; `unknown` uses all). A marker below the last reached line, above the input
box, stales the limit. Plain prose does not, since Claude banners carry `Tip:` lines. The
no-clock fallback stops at a marker; the marker line itself belongs to the message it
starts. Staling a limit can hand `pick` to an outage below it; tests pin both.
PR: https://github.com/johncioni/orca-watchdog/pull/60

## 2026-09-22: A limit's reset comes from its banner block

`bannerText` (and so `resetAt`) is the run of consecutive relevant lines ending at
the last relevant line; if that block has no clock, it widens to the nearest earlier
reached line, skipping gap lines. Pre-send comparisons normalise ` | ` joins and
whitespace (wrapping is not content). After a send, an unchanged relative banner is
re-parsed against `detectedAt`, so it cannot drift later forever.
PR: https://github.com/johncioni/orca-watchdog/pull/58

## 2026-09-22: An unsent limit event with an unchanged banner skips the moved-later hold

The DOG-24 pre-send "reset moved later" hold is skipped only when the fresh banner
text equals the stored text and `attempts === 0`, so a limit resumes once reads
recover, however long they were down. After a send, identical text keeps the hold:
a limit that has not really reset reprints the same banner. John approved this over
a docs-only "within 2 hours" caveat as the better long-term rule.
PR: https://github.com/johncioni/orca-watchdog/pull/56

## 2026-09-22: Orca list and read results are weak evidence of a closed terminal

A tick is degraded (events frozen, one `warn`) when `terminal list` has no array,
is empty with stored events, attempts no reads, or every read fails; a read with no
`tail` array is a failed read. A missing handle gets `vanishedAt` and the event is
removed only after 12 h of healthy misses; any listing clears the mark. Every
removal is logged.
PR: https://github.com/johncioni/orca-watchdog/pull/56

## 2026-09-22: Reset clocks honour a parenthesised IANA zone

`resets 12:30am (America/New_York)` resolves through `Intl.DateTimeFormat`, not
machine-local time. An invalid zone falls back to local time. A DST gap resolves
forward. In an overlap the pre-send re-parse always lands on the later occurrence,
so the send waits for it (up to an hour late if the earlier one was meant; the safe
direction). A wrapped zone line joins the banner only if it names a real zone and
sits directly under a line ending in a clock.
PR: https://github.com/johncioni/orca-watchdog/pull/54

## 2026-09-22: `claude-agent-teams` is a Claude identity

Coordinator terminals report `agentIdentity: claude-agent-teams`; it maps to the
claude provider, and identity checks such as `isShellPrompt()` resolve through the
registry instead of comparing against `'claude'`. Supersedes the earlier decision
to leave it unmapped.
PR: https://github.com/johncioni/orca-watchdog/pull/54

## 2026-09-22: Outage rows split payload from TUI envelope

Each registry outage row has a payload regex (the strict semantic allowlist) and
an `envelope` (`markers[]` matched against the line prefix, optional bounded
`continuation`). A line counts only when its prefix is exactly a marker, which
is what keeps the unanchored payload regex from matching prose. Near-miss debug
labels are fixed: `envelope`, `identity`, `retry`, `final-block`.
PR: https://github.com/johncioni/orca-watchdog/pull/52

## 2026-09-22: Claude footer chrome is structural, not content

Claude Code's footer (turn summary, `❯` box, claude-hud statusline) changes with
terminal width, model, and plugins, so per-line content regexes miss on other
machines and layouts. The registry's `chrome.footerStart` (rule, bare `❯`, rule)
marks the closed input box; the prompt and everything below it is chrome, and
the limit rule takes evidence only from lines above the box. Real agent output
always sits above the box, so this cannot create a false positive.
PR: https://github.com/johncioni/orca-watchdog/pull/50
