# Decisions

Newest first. Format and rules: `README.md` in this directory.

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

## 2026-09-22: `claude-agent-teams` stays unmapped until DOG-50

Coordinator terminals report `agentIdentity: claude-agent-teams`. They resolve to
`unknown` and reach Claude only through the `alsoUnknown` outage pattern. Mapping
the identity (and the session-limit banner shapes) is DOG-50, not DOG-48.
PR: https://github.com/johncioni/orca-watchdog/pull/50
