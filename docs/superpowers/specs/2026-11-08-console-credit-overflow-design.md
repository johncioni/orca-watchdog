# Console credit overflow: design

Date: 2026-11-08. Status: approved by John 2026-11-08 (DOG-81). Lines marked "our
call" are the author's decisions, not John's.

## Intent

John's Claude Max plan (max_5x) hits its usage limit, and every Claude
session in Orca then stalls until the reset; today the watchdog only types a
resume line once the reset passes. John also gets $100 a month of
promotional API credit in a Console org ("Team Rocket") that he does not
otherwise use. He wants Claude sessions to keep working on that credit while
Max is limited, unattended and overnight included, and to go back to Max at
the reset. Spending the whole credit is fine; it is otherwise wasted.

## Goals

- When a Claude Max limit banner appears in a terminal launched through the
  new wrapper, that session switches to the Console login automatically and
  carries on in the same conversation.
- At the reset time of the limit that started the switch, each switched
  session goes back to the Max login, again in the same conversation.
- Works for the orchestrator's own session and for Claude role tabs, with
  every launch flag preserved.
- Opt-in and off by default: orca-watchdog is a public Homebrew formula.

## Non-goals

- Codex, Gemini and other agents (their limits are not Anthropic's).
- Buying credit, `/usage-credits`, `/model` or any purchase (decisions.md,
  2026-10-23, still holds).
- Orca-managed Claude accounts (`orca account add`), which accept only
  claude.ai subscription logins (verified in Orca 1.4.253).
- Creating or refreshing the Console login: John's one-time step, done.

## Anti-goals (a failure even if it "works")

- The watchdog typing a shell command into any terminal. It may send only
  `/exit` into a Claude TUI and nothing else new.
- A role tab coming back with different flags (sandbox settings, permission
  mode, tools, model, effort), or as plain `claude --resume`.
- Resuming the wrong conversation, or starting a fresh one.
- Exiting a session mid-turn, or one with a typed draft.
- A trust, login or onboarding prompt appearing after a switch: in a role
  tab that is a John-only stop and breaks unattended runs.

## Facts established (2026-11-08)

- Both logins coexist. `claude auth status`: `~/.claude` is claude.ai,
  `subscriptionType: max`; `CLAUDE_CONFIG_DIR=~/.claude-console` is
  `authMethod: api_key`, org "Team Rocket". The Console login did not
  displace the Max one. `~/.claude-console` holds only `.claude.json` and
  `backups/` so far.
- The org is on the Start tier: Opus 5.5 2,000,000 ITPM, Fable 500,000 ITPM
  (docs.claude.com rate-limits page). Only uncached input counts, and a
  resume after a switch is fully uncached, so an Opus session up to 1M
  tokens fits; a Fable session over about 500k tokens cannot resume on
  Console. Monthly spend cap $500; no card, no auto-reload, so running out
  of credit stops calls and charges nothing.
- A running Claude Code process cannot change its login; switching means
  exiting and relaunching with `--resume`.
- `~/.claude/sessions/<pid>.json` maps a Claude process to its `sessionId`,
  `cwd` and `status` (`busy`/idle).
- Every Orca terminal has `ORCA_TERMINAL_HANDLE` in its environment, so a
  process can say which watchdog terminal handle it lives in.
- Orca has a per-agent command override (`settings.agentCmdOverrides`), so
  Orca's own Claude launch (the orchestrator) can start through the
  wrapper. Semantics not yet verified (spike item 5).
- The watchdog already parses Claude limit banners and reset times
  (`PROVIDERS.claude`, `kinds.limit`), guards drafts, and sends via
  `orca terminal send`.

## Approaches considered

1. **Watchdog restarts sessions itself:** it exits Claude, waits for the
   shell prompt and types the relaunch command, reading flags from the
   process. No launch changes, but the watchdog types shell commands into
   every Claude terminal and must recognise shell prompts; an error lands
   everywhere.
2. **Watchdog decides when, a wrapper restarts (chosen by John).** Claude
   runs under a small looping launcher that knows its own argv and session.
   The watchdog only writes a state file and sends `/exit`. Only
   wrapper-launched sessions can switch, which is the opt-in.
3. **Swap credentials under running sessions:** no restarts, but whether a
   running session re-reads its login is undocumented, it switches all
   sessions blindly, and it means scripted changes to stored credentials.
   Ruled out.

## Design (decided)

### Components

1. `claude-overflow`, a wrapper shipped in the orca-watchdog formula.
2. An overflow controller inside the watchdog daemon.
3. A Console config dir, `~/.claude-console`, made to behave like `~/.claude`.
4. Harness adoption in John's dotfiles (separate, later deliverable).

### Wrapper

`claude-overflow <claude args…>` runs `claude` in a loop:

- On each launch it reads the overflow state file. Console mode means
  `CLAUDE_CONFIG_DIR=~/.claude-console`; Max mode means the environment the
  wrapper was started with, untouched.
- It knows the session ID before Claude starts: the one given in the args
  (`--resume`/`--session-id`), or one it generates and passes as
  `--session-id` on the first launch.
- It registers itself under the watchdog's state dir, keyed by
  `ORCA_TERMINAL_HANDLE`: wrapper pid, Claude pid, session ID, mode, launch
  time. The entry is removed when the wrapper exits; the watchdog ignores an
  entry whose pids are dead.
- When Claude exits and the watchdog left a switch request for this
  handle, the wrapper consumes the request and relaunches with the
  original args, `--resume <sessionId>` in place of any first-launch-only
  args, and an initial message. Both messages tell the session that a
  restart killed its background jobs (the orchestrator's waiters and
  prompt-waits) and that it is not a new instruction:
  - To Console: "Your session restarted on API credit because the Max
    limit was reached. Re-arm any background waits you had running, then
    resume where you left off."
  - Back to Max: "Your session restarted to move back to the Max plan. This
    is not a new instruction: re-arm any background waits you had running,
    then carry on as before, or keep waiting if you were waiting for the
    user." (Our call: a session idle at switch-back may be done or waiting
    on John, so the message must not read as a go-ahead; sending nothing
    would leave the orchestrator with no live wake source.)
  With no switch request, the wrapper exits with Claude's status, so a
  person's own `/exit` still ends the session.
- Without the opt-in, or outside Orca (no `ORCA_TERMINAL_HANDLE`), the
  wrapper is a transparent `exec claude`.

### Controller (watchdog, only when overflow is enabled)

- **Trigger:** a Claude `limit` event (not `credits`, not an outage) with a
  parsed reset time, in a terminal with a live wrapper registration, while
  credit is not marked exhausted. It writes the state file: Console mode
  until the reset plus the existing limit buffer. The limit is
  account-wide, so later limit events extend the deadline, never shorten
  it. The state file means Console only while the deadline is ahead and
  credit is not exhausted; otherwise every new launch takes Max.
- **Sessions that never switch (our call):** Fable sessions (model from the
  wrapper's args) stay on Max and get today's reset resume, because Start
  tier's 500k Fable ITPM cannot take a large uncached resume. Opus and
  Sonnet sessions always fit under 2M ITPM. Switches are spaced so their
  uncached resumes together stay under the org's ITPM (spacing is the
  builder's call).
- **Switch to Console:** for each registered terminal in Max mode that
  shows the limit banner with no draft: write a switch request, then send
  `/exit` and Enter. A later tick confirms the relaunch (new launch time,
  Console mode); the wrapper's initial message is the resume, so the
  watchdog sends nothing more. The terminal's limit event closes as
  switched instead of waiting for a reset resume.
- **Sessions not stalled:** a wrapper session that never showed the banner
  is left alone; if it hits the limit later it switches then. Any wrapper
  launch during the Console window starts on Console.
- **Switch back (our call: every Console session):** once the deadline
  passes, the state file returns to Max mode, and every registration in
  Console mode, whether the controller switched it or it launched during
  the window, is exited and relaunched the same way, but only when its
  session is idle (`sessions/<pid>.json` status) with no draft. A busy
  session is switched when its turn ends.
- **Console-mode terminals belong to the controller:** a limit, 429 or
  billing banner in a Console-mode terminal never starts the ordinary
  limit, outage or credits resume sends; the controller's switch-back is
  the only thing that acts on that terminal.
- **Credit runs out first:** the controller recognises Claude Code's
  API-key billing error (exact text captured in the spike; it is neither the
  claude.ai "out of usage credits" line nor an outage), marks credit
  exhausted, sends nothing, and the session waits for the deadline and
  switches back as above. While credit is marked exhausted no new switch to
  Console starts; the mark clears at 00:00 UTC on the 1st, when the monthly
  credit renews, or by hand.
- **Existing behaviour** for every other terminal (non-wrapper Claude,
  Codex, Gemini) is unchanged. Logs, captures and `--dry-run` cover the new
  sends ("would switch handle X to console").

### Console config dir

`~/.claude-console` must make a Console session indistinguishable from a
Max one apart from the login: same settings, hooks, skills, plugins,
commands, rules and memory, and shared `projects/` and `sessions/` so
`--resume` finds the conversation and the controller finds the pid file.
Its own `.claude.json` keeps the Console login; project trust and
onboarding state must be present for every cwd the sessions use so no
prompt appears (spike item 3 decides symlink vs. sync and what syncs). A
setup command shipped with the wrapper builds and repairs the dir.

### Harness adoption (dotfiles; reviewed separately)

- Orca: `agentCmdOverrides.claude` points at `claude-overflow` (John sets
  it in Orca if the UI owns it).
- Role-tab recipe in ORCHESTRATION.md calls `claude-overflow` instead of
  `claude`; HARNESS-SYNC.md and `check-models-sync.py` updated to match.
- ORCHESTRATION.md: a wrapper relaunch with identical argv is an explicit
  exception to "never resume a role tab"; after its own restart the
  orchestrator re-arms every background waiter and prompt-wait, which die
  with the process.
- MODELS.md Provider outages: a row for "Max limit hit, overflow on":
  Claude roles continue on Console credit with the same models; Fable
  sessions too large for 500k ITPM wait for the reset.

## Spike before building (first plan task)

1. `/exit` sent through `orca terminal send` exits Claude cleanly from the
   limit-banner state (and from idle).
2. `--resume <id>` with shared `projects/` across the two config dirs
   resumes the same conversation with the original flags and an initial
   message.
3. Which trust, onboarding or login prompts a fresh `~/.claude-console`
   shows in a new cwd, and how to pre-seed them.
4. Whether an active `/goal` survives `/exit` and `--resume`; if not, the
   resume message must restate it or the design must say the goal is lost.
5. What `agentCmdOverrides.claude` replaces (binary only, keeping Orca's
   default args and wrapper env) and whether `ORCA_TERMINAL_HANDLE`
   reaches the wrapper.
6. The exact text Claude Code shows when an API-key org is out of credit.
7. That `sessions/<pid>.json` status is a reliable idle signal in both
   config dirs.
8. That `claude-opus-5-5[1m]` (1M context) and `--permission-mode auto`
   both work under the Console API-key login. If either does not, role tabs
   cannot switch without changing flags, and the scope goes back to John.

How the spike runs (John's decision, 2026-11-08): the orchestrator runs it
in throwaway Orca terminals it opens itself, with fresh test sessions,
never John's working sessions, spending a little Console credit. States
that cannot be produced on demand use stand-ins: `/exit` from an idle
session stands in for the limit-banner state (item 1), and the
out-of-credit text comes from Claude Code's own bundle (item 6). The build
proceeds on those; the first real Max limit after release is the live
test, checked afterwards from the watchdog's log and captures.

Any spike result that contradicts this design comes back to John before
the build continues.

## Left to the builder

File formats and paths under `~/.local/state/orca-watchdog/`, the config
key name for the opt-in, timing constants, how the wrapper strips
first-launch-only args, fixtures (captured from real sessions, per repo
rules) and test layout.

## Deliverables and order

1. Spike (above).
2. Watchdog controller, wrapper and setup command: one DOG issue, PR and
   release.
3. Harness adoption in dotfiles, after 2 is released.
4. John: enable the opt-in and set Orca's command override.
