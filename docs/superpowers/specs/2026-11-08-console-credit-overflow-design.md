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

- On each launch it reads the overflow state file and takes the mode in
  effect at that moment (deadline and credit mark re-checked; a switch
  request authorizes a relaunch, not a mode). Console mode means
  `CLAUDE_CONFIG_DIR=~/.claude-console`; Max mode means the environment the
  wrapper was started with, untouched. Every launch, relaunches included,
  keeps the rest of the incoming environment, `CLAUDE_CODE_TMPDIR`
  included.
- **Eligible sessions only.** The wrapper resolves the session's model
  from `--model`, else `ANTHROPIC_MODEL`, else the `model` setting of the
  config dir it launches with. Opus and Sonnet models are eligible. Fable,
  or a model it cannot establish, is ineligible: always launched on Max,
  registered as ineligible, never switched (Controller, "Eligibility").
- **Supported invocation forms (session identity).** A session is
  switchable only when the wrapper knows its ID: no session selector (the
  wrapper generates one and passes `--session-id`), `--resume <id>`, or
  `--session-id <id>`. `--continue`/`-c`, a bare `--resume` (the picker),
  `--fork-session`, `-p`/`--print`, or any argv the wrapper cannot parse
  with certainty runs as a plain pass-through, unregistered and never
  switched. Because `/clear` and `/resume` inside the TUI change the
  session, the ID used for a relaunch is the one Claude's pid file
  (`sessions/<pid>.json`) names when the switch is requested, not the
  launch-time ID.
- **One owner per handle.** It registers under the watchdog's state dir,
  keyed by `ORCA_TERMINAL_HANDLE`: wrapper pid, a launch generation, Claude
  pid, session ID, mode, eligibility, launch time. Registration is
  exclusive: when a live wrapper already owns the handle, or this wrapper
  runs inside another wrapper's Claude (an inherited marker says so), it
  runs as a plain pass-through, unregistered. A wrapper removes only its
  own entry when it exits; the watchdog ignores an entry whose pids are
  dead.
- When Claude exits, the wrapper relaunches only for a switch request that
  names its own wrapper pid, launch generation and session, and only when
  Claude exited within a short window after the request was sent;
  anything else (no request, a stale or foreign one) is deleted and the
  wrapper exits with Claude's status, so a person's own `/exit` still ends
  the session. A relaunch uses the original args, `--resume <sessionId>` in
  place of any first-launch-only args, and an initial message. Both messages
  tell the session that a
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
- **Failed relaunch, no loop.** If a relaunched Claude exits with a failure
  before it settles, the wrapper makes one fallback relaunch of the same
  session on Max; if that fails too, it exits with a message naming the
  session ID so a person can `--resume` it. It never restarts more than
  that per request.
- **Admission.** A Console launch that resumes a conversation (a switch
  relaunch, or a new wrapper launch with `--resume` during the window)
  first takes an admission slot shared by all wrappers, spaced so uncached
  resumes stay under the org's input-token rate (spacing is the plan's).
- Without the opt-in, or outside Orca (no `ORCA_TERMINAL_HANDLE`), the
  wrapper is a transparent `exec claude`. The public wrapper allocates no
  temp dir of its own; the harness launches it through an adapter that
  does (Harness adoption).

### Controller (watchdog, only when overflow is enabled)

- **Eligibility (one policy, our call):** only eligible sessions (Opus and
  Sonnet, Wrapper above) take part. Fable is metered separately from Opus
  and Sonnet, and Start tier's 500k Fable ITPM cannot take a large uncached
  resume, so every Fable session, and every session whose model is
  unknown, stays on Max and gets today's reset resume. The same policy
  applies when a limit opens or extends the window, when a terminal
  switches, and when a wrapper launches during the window. Among eligible
  models the limit is treated as shared; if Max still had quota for one of
  them, the credit spent is accepted (Intent).
- **Trigger:** a Claude `limit` event (not `credits`, not an outage) with a
  genuinely parsed reset time (not the 60-minute fallback), in a terminal
  with a live, eligible wrapper registration, while credit is not marked
  exhausted. It writes the state file: Console mode until the reset plus
  the existing limit buffer. Later eligible limit events extend the
  deadline, never shorten it; an ineligible session's limit never touches
  it. The state file means Console only while the deadline is ahead and
  credit is not exhausted; otherwise every new launch takes Max.
- **Send gate (every `/exit`, both directions):** the controller acts only
  on a handle owned by exactly one live wrapper whose Claude is the
  terminal's current foreground program (the spike settles the proof);
  duplicate, dead or unverifiable ownership authorizes nothing. Right
  before each `/exit` it repeats the resume sends' guards in their order:
  the kill switch, the idle wait, a fresh read with the banner re-detected
  (switch to Console: still the limit banner), the shell-prompt guard and
  the draft guard on the read's `draft` field as well as the tail. Missing
  or ambiguous session metadata holds; degraded ticks and failed reads
  hold; `--dry-run` writes no request, state or capture.
- **Switch to Console:** for an eligible Max-mode terminal showing the
  limit banner that passes the gate: persist the request (wrapper pid,
  generation, session ID from the pid file, target mode, attempt count),
  then send `/exit` and Enter. Switches are spaced (Wrapper, "Admission").
  The wrapper's initial message is the resume, so the watchdog sends
  nothing more.
- **Request lifecycle:** from the moment a request is written until it is
  confirmed or cancelled, the controller alone acts on that terminal and
  its limit event yields to it. Confirmed means the wrapper registered a new
  generation in the target mode for the same session and Claude's pid file
  shows that session live after a settle time; a changed launch time alone
  is not confirmation. Unconfirmed `/exit` sends are retried a bounded
  number of times, then the request is cancelled. A request is also
  cancelled when its registration dies or changes generation, when the
  deadline passes before a Console switch is consumed, or when credit is
  marked exhausted before it is consumed. Requests survive a watchdog or
  wrapper restart and are re-evaluated by these rules. On cancellation or a
  failed relaunch the controller logs an error (visible in `status` and
  the log) and the terminal goes back to the ordinary limit path, with no
  further switch attempts for that launch.
- **Sessions not stalled:** a wrapper session that never showed the banner
  is left alone; if it hits the limit later it switches then. Any eligible
  wrapper launch during the Console window starts on Console.
- **Switch back (our call: every Console session):** once the deadline
  passes, the state file returns to Max mode, and every registration in
  Console mode, whether the controller switched it or it launched during
  the window, is exited and relaunched the same way, through the same send
  gate and request lifecycle, and only when its session is idle
  (`sessions/<pid>.json` status) with no draft. A busy session is switched
  when its turn ends.
- **Console-mode terminals: one owner at a time.** A terminal with a
  pending request belongs to the controller alone. Otherwise, retryable
  stalls in a Console-mode terminal (an API outage, overload or connection
  error, or a Console 429 rate limit; texts from the spike) keep the
  ordinary outage path's bounded, provider-status-gated resumes, so a
  short outage or a 429 does not stall the session until the Max reset.
  Only permanent billing exhaustion (below) waits for switch-back. A
  claude.ai limit or credits banner never starts an ordinary send in a
  Console-mode terminal.
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
setup command shipped with the wrapper builds and repairs the dir. It
copies no credential and makes no extra copy of the login. Where
`~/.claude` relies on a filesystem restriction rather than a setting, the
Console dir gets the same one: `agent-memory/` is an empty, mode-555
directory, as `~/.claude/agent-memory` is (HARNESS-SYNC.md).

### Harness adoption (dotfiles; reviewed separately)

- Orca: `agentCmdOverrides.claude` points at a trusted launch adapter in
  the dotfiles (John sets it in Orca if the UI owns it). The adapter does
  what the zsh `claude` function in `~/.agents/sandbox/claude-launch.zsh`
  does today, allocating a private `CLAUDE_CODE_TMPDIR` under
  `~/.cache/claude-sessions` when none is set and failing closed when it
  cannot, then execs `claude-overflow` with every argument. Overriding
  Orca's command must not bypass that allocation, on the pass-through path
  included. Role tabs keep their own `CLAUDE_CODE_TMPDIR`.
- Role-tab recipe in ORCHESTRATION.md calls `claude-overflow` instead of
  `claude`; HARNESS-SYNC.md and `check-models-sync.py` updated to match,
  the checker also pinning the adapter's allocation.
- Worker protection before enabling: every sensitive path under
  `~/.claude-console` (the login and its backups, wherever the spike finds
  the credential, and the transcript and state paths, symlinked ones
  included) gets the same denial `~/.claude` has in the managed Codex
  policy (`deny_read`, with `/**` companions) and the generated sandbox
  policy, with the checker and a probe updated to match. Overflow stays
  off until this lands.
- ORCHESTRATION.md: a wrapper relaunch with identical argv is an explicit
  exception to "never resume a role tab"; after its own restart the
  orchestrator re-arms every background waiter and prompt-wait, which die
  with the process.
- MODELS.md Provider outages: a row for "Max limit hit, overflow on":
  Opus and Sonnet roles continue on Console credit with the same models;
  every Fable session stays on Max and waits for the reset.

## Spike before building (first plan task)

1. `/exit` sent through `orca terminal send` exits Claude cleanly from the
   limit-banner state (and from idle).
2. `--resume <id>` with shared `projects/` across the two config dirs
   resumes the same conversation with the original flags and an initial
   message. Also: the exact argv Orca launches the orchestrator with, and
   whether each supported form (no selector with a generated
   `--session-id`, `--resume <id>`, `--session-id <id>`) yields the
   session the wrapper expects, including after `/clear` and `/resume`
   inside the TUI (pid-file session ID).
3. Which trust, onboarding or login prompts a fresh `~/.claude-console`
   shows in a new cwd, and how to pre-seed them.
4. Whether an active `/goal` survives `/exit` and `--resume`; if not, the
   resume message must restate it or the design must say the goal is lost.
5. What `agentCmdOverrides.claude` replaces (binary only, keeping Orca's
   default args and wrapper env), whether `ORCA_TERMINAL_HANDLE` reaches
   the wrapper, and that a session started through the override still gets
   a private `CLAUDE_CODE_TMPDIR` under `~/.cache/claude-sessions` (the
   adapter), on the pass-through path too.
6. The exact text Claude Code shows when an API-key org is out of credit,
   and the texts of a Console 429 rate limit and an overload or connection
   error, so retryable and permanent stalls are told apart.
7. That `sessions/<pid>.json` status is a reliable idle signal in both
   config dirs.
8. That `claude-opus-5-5[1m]` (1M context) and `--permission-mode auto`
   both work under the Console API-key login. If either does not, role tabs
   cannot switch without changing flags, and the scope goes back to John.
   Record which role restrictions each probe actually shows in effect
   (tools, permission mode, sandbox settings, `--advisor`).
9. Where the Console login's credential lives (a file under
   `~/.claude-console`, its backups, or the Keychain) and which other files
   there hold sensitive state, without recording any secret value. This
   feeds the worker-protection list in Harness adoption.
10. How the controller can prove the wrapper's Claude is the terminal's
    foreground program (what Orca's terminal list or read exposes, or the
    process tree), for the send gate.

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
key name for the opt-in, timing constants (relaunch window, settle time,
retry bound, admission spacing), the ownership primitive, how the wrapper
strips first-launch-only args, fixtures (captured from real sessions, per
repo rules) and test layout. The plan carries the existing invariants into
its acceptance tests: nothing written on `--dry-run`, the kill switch
checked before each action, degraded and unread observations authorize no
send, parsed resets distinguished from the 60-minute fallback, and raw
detection and send captures kept.

## Deliverables and order

1. Spike (above).
2. Watchdog controller, wrapper and setup command: one DOG issue and one
   release (the plan may split it into several reviewed PRs).
3. Harness adoption in dotfiles, after 2 is released, worker protection
   for `~/.claude-console` included.
4. John: enable the opt-in and set Orca's command override, only after 3
   has landed.
