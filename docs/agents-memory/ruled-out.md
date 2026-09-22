# Ruled out

Newest first. Format and rules: `README.md` in this directory.

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

Nine anchored patterns matched the narrow Fable layout (`[Fable 5.1 ◔ medium]`,
`Context █░░░ 24%`, `2 CLAUDE.md | 15 hooks`, ...). The wide Opus layout joins
segments with ` │ `, uses `◕`, adds `| 1 MCPs |`, and the outage went undetected.
Worse, treating the split `Usage … (resets in …)` line as chrome while it stayed
limit evidence made a limit resume fire at the footer's time, not the banner's.
Replaced by the structural input-box rule (see decisions.md).
PR: https://github.com/johncioni/orca-watchdog/pull/50

## 2026-09-22: Fixing only the `⏺` glyph for DOG-48

Adding `⏺` to the outage regex alone detected nothing on the real terminals: the
wrapped continuation lines, `✻ Worked for …`, the `❯` box, and the statusline
all failed the final-block chrome check. Verbatim captures, not the ticket
text, defined the fixture.
PR: https://github.com/johncioni/orca-watchdog/pull/50
