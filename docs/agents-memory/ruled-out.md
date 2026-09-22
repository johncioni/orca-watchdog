# Ruled out

Newest first. Format and rules: `README.md` in this directory.

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
