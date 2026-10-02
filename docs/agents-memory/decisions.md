# Decisions

Newest first. Format and rules: `README.md` in this directory.

## 2026-09-23: An accepted later reset re-baselines the event's text and anchor

When a moved-later reset is honoured with different text, the event stores
the fresh banner text and re-anchors relative resets to that moment
(`resetAnchorAt`), so later "unchanged" checks compare against the last
accepted text. Text identity is the only "unchanged" signal (open gaps: ruled-out.md).
PR: https://github.com/johncioni/orca-watchdog/pull/66

## 2026-09-23: An outage or retry line below a limit's reached line makes it stale

A request after the banner means the limit is no longer current, so an
outage payload or retry line below the reached line, above the input box,
stales it. The payload check runs on every platform, so a new provider
outage row widens it: rerun a main-vs-HEAD differential then.
PR: https://github.com/johncioni/orca-watchdog/pull/64

## 2026-09-23: Limit/outage arbitration uses the limit's reached line

An outage printed after a limit was reached is the newer event, so `pick`
keeps a limit only if its reached line is at or below the outage. Anchoring
on the last relevant line let an error line with reset words (`Service
Unavailable`) tie and revive a stale limit. Relies on chronological order.
PR: https://github.com/johncioni/orca-watchdog/pull/62

## 2026-09-23: A new agent message makes an earlier limit banner stale

A message-start marker (registry `chrome.outputStart`: claude `⏺`, gemini
`✦`) below the last reached line, above the input box, stales the limit.
Plain prose does not, because Claude banners carry `Tip:` lines. Staling a
limit can hand `pick` to an outage below it; tests pin both.
PR: https://github.com/johncioni/orca-watchdog/pull/60

## 2026-09-22: A limit's reset comes from its banner block

The clock comes from the block of consecutive relevant lines ending at the
last one, widening to the nearest earlier reached line when that block has
none, because a blank or tip line can split a banner. Wrapping is not
content. Re-parsing after a send follows the 2026-09-23 re-baseline entry.
PR: https://github.com/johncioni/orca-watchdog/pull/58

## 2026-09-22: An unsent limit event with an unchanged banner skips the moved-later hold

Before the first send, identical banner text skips the "reset moved later"
hold, so a limit resumes once reads recover, however long they were down.
After a send, identical text keeps the hold: a limit that has not really
reset reprints the same banner. John chose this over a docs-only caveat.
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

## 2026-09-22: Outage rows split payload from TUI envelope

Each registry outage row pairs a payload regex with an envelope of
line-prefix markers. A line counts only when its prefix is exactly a
marker, which is what keeps the unanchored payload regex from matching
prose.
PR: https://github.com/johncioni/orca-watchdog/pull/52

## 2026-09-22: Claude footer chrome is structural, not content

Claude Code's footer changes with terminal width, model and plugins, so
content regexes miss on other layouts. The closed input box
(`chrome.footerStart`: rule, bare `❯`, rule) marks where chrome starts, and
limit evidence comes only from above it, where real agent output always is.
PR: https://github.com/johncioni/orca-watchdog/pull/50
