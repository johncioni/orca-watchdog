# Ruled out

Newest first. Format and rules: `README.md` in this directory.

## 2026-10-02: Fixing DOG-60's relative-clock re-anchoring gaps

Captured limit banners (Claude, Codex, Gemini) all state an absolute clock, so the early third
send on an identical reprint, which needs relative wording, could not happen as of that date.
An endless hold (two banners alternating with ticks, absolute ones too) and a send ~21 h late
(a screen reverting to an older banner) need screens never seen; nothing real to test.
PR: https://linear.app/johncioni/issue/DOG-60

## 2026-09-23: Tier-2 degraded mode for Cursor and opencode

Canceled with its spikes (DOG-45, DOG-46, DOG-47) because John doesn't use Cursor or
opencode on this machine, and the watchdog exists for the agents that run here. Both are
also provider-agnostic, so Phase 5 of DOG-35 could only ever notify, never resume. Reopen
only if one runs real work here; the design is in the multi-agent plan, "Degraded mode (Tier-2)".
PR: https://github.com/johncioni/orca-watchdog/pull/68

## 2026-09-23: A word boundary on `available` alone for DOG-59

`\bavailable` fixed one of five shapes that revived a stale limit. `⎿` error and retry
lines are trailing chrome, so they never trip the final-block guard, and `try again later`
is reset wording by itself. The fix stales the limit on outage or retry lines instead.
PR: https://github.com/johncioni/orca-watchdog/pull/64

## 2026-09-23: An exclusive fallback boundary at the marker line

Treating the marker line as outside the older banner dropped a banner whose reached
line starts with `⏺`. The split banner then fell to the 60-minute default and sent
three resumes before the real reset. The marker line now belongs to the older banner.
PR: https://github.com/johncioni/orca-watchdog/pull/60

## 2026-09-22: A strict banner block with no fallback

Taking the reset only from the last consecutive block lost it when a blank or tip
line split a banner: the 60-minute default sent three resumes before the real reset,
then gave up. Widening to the last reached line alone fails the mirror case. The
block with a no-clock fallback matches 1.2.5 on every probed shape.
PR: https://github.com/johncioni/orca-watchdog/pull/58

## 2026-09-22: Deleting an event on one missing or short confirmation of its handle

Deleting on the first tick a handle was missing from `terminal list` lost two limit
events during the 2026-09-22 Orca CLI outage (7-, 4-, and 0-terminal lists
alternating for hours). A 10-minute confirmation window was still too short:
partial lists persisted 20+ minutes. Hence the 12 h window and degraded-tick freeze.
PR: https://github.com/johncioni/orca-watchdog/pull/56

## 2026-09-22: Any parenthesised slash line as the wrapped zone

The first DOG-50 rule took any `(x/y)` line under any evidence line as the wrapped
zone, so `(src/foo)` or `(1/2)` under prose extended the banner past the stale guard
and could turn an old screen into a resume. Now the zone must be valid and the line
above must end in a clock.
PR: https://github.com/johncioni/orca-watchdog/pull/54

## 2026-09-22: Last payload-matching line as the outage candidate

Picking the last line whose payload regex matches, before checking the marker,
let a chrome line quoting the error (`⎿ Tip: … API Error: 500 …`) shadow a real
banner above it. Detection uses the last line with a valid marker; the
payload-only line only feeds the near-miss label.
PR: https://github.com/johncioni/orca-watchdog/pull/52

## 2026-09-22: Content-pinned claude-hud statusline regexes as trailing chrome

Nine anchored patterns matched only the narrow Fable layout, so on the wide Opus
layout the outage went undetected. Treating the split `Usage … (resets in …)` line
as chrome while it stayed limit evidence also made a resume fire at the footer's
time, not the banner's. Replaced by the input-box rule (decisions.md).
PR: https://github.com/johncioni/orca-watchdog/pull/50

## 2026-09-22: Fixing only the `⏺` glyph for DOG-48

Adding `⏺` to the outage regex alone detected nothing on the real terminals: the
wrapped continuation lines, `✻ Worked for …`, the `❯` box, and the statusline
all failed the final-block chrome check. Verbatim captures, not the ticket
text, defined the fixture.
PR: https://github.com/johncioni/orca-watchdog/pull/50
