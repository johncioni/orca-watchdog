# Decisions

Newest first. Format and rules: `README.md` in this directory.

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
