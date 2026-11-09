# Ruled out

Newest first. Format and rules: `README.md` in this directory.

## 2026-11-09: Telling a billing line's age or extent by launch time, fingerprint, indent or token

Marks scoped to launches after the last clear missed sessions already running at the clear, and
screen lines carry no identity to fingerprint (`/resume` repaints them). Rules written from a trimmed
quote (column-0 `⎿`, one line, a bare goal notice) matched no real Claude screen. Continuation by
indentation swallowed a later retry or 429; by whitespace-free token, a later `Done.`.
PR: https://github.com/johncioni/orca-watchdog/pull/131, https://github.com/johncioni/orca-watchdog/pull/132

## 2026-11-08: Interactive Console sessions on the promotional credit

The spike found the server bills that credit for SDK-tagged requests (`claude -p`) and refuses every
interactive request on the same login (`credit balance is too low`). Setting the SDK entrypoint would
misreport the client, so the wrapper never does it; John funded a prepaid balance instead.
PR: https://github.com/johncioni/orca-watchdog/pull/120

## 2026-11-08: Overflow by watchdog-driven relaunch or by swapping credentials

Having the watchdog relaunch Claude itself means typing shell commands into every terminal and
recognising shell prompts. Swapping stored credentials under running sessions relies on an
undocumented re-read and switches every session at once. John chose a wrapper that relaunches on `/exit`.
PR: https://github.com/johncioni/orca-watchdog/pull/119

## 2026-10-31: Narrowing Codex's model-limit name so it cannot supply a reset

Restricting the name's characters (DOG-74) would make an unexpected server name match no form,
the silent miss the Codex entry in decisions.md warns about. Reading the reset only from the last
`try again` clause fixed the wrong-reset bug without rejecting any name.
PR: https://github.com/johncioni/orca-watchdog/pull/107

## 2026-10-23: Reading drafts from `tail` alone, or from the last prompt-glyph line

Orca 1.4.237 moves typed composer text into the read's `draft` field and leaves a bare `❯`/`›`
in `tail`, so a tail-only guard missed real drafts. Taking the last `>`/`›` line as the composer
let `>`-led draft lines hide the real one, and matching the boundary on trimmed rows let an
indented `›` inside a pasted draft do the same. The guard checks `draft`, then a column-0 composer.
PR: https://github.com/johncioni/orca-watchdog/pull/97

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

## 2026-09-23: A strict banner block, or a fallback boundary that excludes the marker line

Taking the reset only from the last consecutive block lost it when a blank or tip line split a banner;
treating the marker line as outside the older banner dropped a reached line starting with `⏺`. Each
fell to the 60-minute default and sent three resumes before the real reset. Widening to the last reached
line alone fails the mirror case; the block with a no-clock fallback matches 1.2.5 on every probed shape.
PR: https://github.com/johncioni/orca-watchdog/pull/58, https://github.com/johncioni/orca-watchdog/pull/60

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
