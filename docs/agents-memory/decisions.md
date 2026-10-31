# Decisions

Newest first. Format and rules: `README.md` in this directory.

## 2026-10-31: Codex limit forms come from Codex's source; resets only from the retry clause

Codex picks its usage-limit sentence by plan and model limit, so check `UsageLimitReachedError` and
`RetryLimitReachedError` in `codex-rs/protocol/src/error.rs` at each new Codex tag, not just session logs:
a `■` line no form matches makes no event (0.155.1's `You’ve`, 0.166.0's Pro form). Resets come only
from the last `try again` clause, because a model-limit name is free text and once supplied a date.
PR: https://github.com/johncioni/orca-watchdog/pull/94, https://github.com/johncioni/orca-watchdog/pull/105, https://github.com/johncioni/orca-watchdog/pull/107

## 2026-10-23: Out-of-credits Claude sessions get blind resumes, never a purchase

Credits never reset and the allowance's reset time is not on screen, so a `credits` event
resumes blindly every 6 h for up to 7 days (at most 27 sends) and never sends `/usage-credits` or `/model`
(John's call). Detection anchors on the message's first sentence and its ending; John declined
a whole-message match (DOG-71) because a reword would then miss silently, as Codex drift does.
PR: https://github.com/johncioni/orca-watchdog/pull/99, https://linear.app/johncioni/issue/DOG-71

## 2026-10-23: Captures keep the raw terminal read

The daemon saves Orca's read behind each detection and send to `captures/` (newest 50, owner-only).
John accepted terminal contents and drafts on local disk because a replayable fixture is the point:
never sanitize, trim or drop `draft` without asking him. Names stay unique only while a handle gets
at most one `detected` and one `send` capture per tick.
PR: https://github.com/johncioni/orca-watchdog/pull/103

## 2026-10-23: The LaunchAgent keeps launchd's default process type

`ProcessType Background` throttled the daemon until concurrent `orca terminal read` calls hit the
15 s exec timeout: from 2026-09-24 to 2026-10-23, 1,034 reads failed, 700 of them logged as
timeouts (1.2.12 began naming the cause). Leave the key out, and measure read latency under load
before adding any launchd throttling key.
PR: https://github.com/johncioni/orca-watchdog/pull/91

## 2026-09-23: An accepted later reset re-baselines the event's text and anchor

When a moved-later reset is honoured with different text, the event stores
the fresh banner text and re-anchors relative resets to that moment
(`resetAnchorAt`), so later "unchanged" checks compare against the last
accepted text. Text identity is the only "unchanged" signal (open gaps: ruled-out.md).
PR: https://github.com/johncioni/orca-watchdog/pull/66

## 2026-09-23: A new message, outage or retry below a limit's reached line makes it stale

Anything printed after the banner means the limit is no longer current: a message-start marker
(registry `chrome.outputStart`), an outage payload or a retry line below the reached line, above the
input box, stales it. Plain prose does not (Claude banners carry `Tip:` lines). It runs on every
platform, so a new outage row also stales limits: replay recorded screens against the last release.
PR: https://github.com/johncioni/orca-watchdog/pull/60, https://github.com/johncioni/orca-watchdog/pull/64

## 2026-09-23: Limit/outage arbitration uses the limit's reached line

An outage printed after a limit was reached is the newer event, so `pick`
keeps a limit only if its reached line is at or below the outage. Anchoring
on the last relevant line let an error line with reset words (`Service
Unavailable`) tie and revive a stale limit. Relies on chronological order.
PR: https://github.com/johncioni/orca-watchdog/pull/62

## 2026-09-22: A limit's reset comes from its banner block

The clock comes from the block of consecutive relevant lines ending at the
last one, widening to the nearest earlier reached line when that block has
none, because a blank or tip line can split a banner. Wrapping is not
content. Re-parsing after a send follows the 2026-09-23 re-baseline entry.
PR: https://github.com/johncioni/orca-watchdog/pull/58

## 2026-09-22: An unsent limit event with an unchanged banner skips the moved-later hold

Before the first send, identical banner text skips the "reset moved later"
hold, so a limit resumes once reads recover (John chose this over a docs-only
caveat). After a send, an identical absolute clock keeps the hold, since a
limit that has not reset reprints it; identical relative text stays anchored.
PR: https://github.com/johncioni/orca-watchdog/pull/56

## 2026-09-22: Orca list and read results are weak evidence of a closed terminal

Orca CLI outages return empty or partial terminal lists for hours. A tick
whose listing is missing, or empty with events stored, or whose reads all
fail is degraded (events frozen, one `warn`), and a missing handle is
removed only after 12 h of healthy misses. Every removal is logged.
PR: https://github.com/johncioni/orca-watchdog/pull/56

## 2026-09-22: Reset clocks honour a parenthesised IANA zone

`resets 12:30am (America/New_York)` resolves in that zone; an invalid zone
falls back to local time. A DST-overlap clock always takes the later
occurrence: an unsent, unchanged banner skips the moved-later hold (#56), so
an earlier pick resumed before the reset (DOG-61). Up to an hour late is accepted.
PR: https://github.com/johncioni/orca-watchdog/pull/54, https://github.com/johncioni/orca-watchdog/pull/73

## 2026-09-22: Claude footer chrome is structural, not content

Claude Code's footer changes with terminal width, model and plugins, so
content regexes miss on other layouts. The closed input box
(`chrome.footerStart`: rule, bare `❯`, rule) marks where chrome starts, and
limit evidence comes only from above it, where real agent output always is.
PR: https://github.com/johncioni/orca-watchdog/pull/50
