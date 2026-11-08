# Console Credit Overflow Implementation Plan

> **For agentic workers:** this repo dispatches each task to an Orca worker
> per `~/.agents/ORCHESTRATION.md`; your brief is self-contained and quotes
> the parts of this plan you need. Steps use checkbox (`- [ ]`) syntax.
> Workers never commit: the orchestrator commits.

**Goal:** Eligible Claude sessions launched through `claude-overflow` move to
the Console API-credit login while the Claude Max limit is in force and
move back at the reset, in the same conversation, with every launch flag
and the incoming environment kept.

**Architecture:** A wrapper runs `claude` in a loop and owns one Orca
terminal handle. The daemon's overflow controller reads registrations each
5-minute tick, decides when a terminal switches, persists a switch request
and sends `/exit` through the same guards as today's resume sends. The
wrapper marks the request consumed and relaunches with `--resume`; the
controller alone confirms, fails or cancels it and deletes the record.
Shared state is owner-only JSON under `~/.local/state/orca-watchdog/overflow/`,
with every read-modify-write under a kernel `flock`.

**Tech Stack:** Node 22+ ES modules, no dependencies, `node --test`; bash
launcher shims; `/usr/bin/lockf` for `flock`; Homebrew formula.

**Spec:** `docs/superpowers/specs/2026-11-08-console-credit-overflow-design.md`
(DOG-81; approved by John, revised after review). Executors read both.

## Global Constraints

- Opt-in, off by default: nothing changes for anyone who has not run
  `orca-watchdog overflow enable` (public formula).
- No package.json, no dependencies (CLAUDE.md).
- The watchdog's only new terminal input is `/exit` + Enter, to a handle
  owned by exactly one live, foreground wrapper registration. It never
  types a shell command. Today's resume texts are reused unchanged.
- Never `--resume` a different session, never start a fresh one, never
  exit mid-turn or over a draft (tail or `draft` field).
- No purchase, `/usage-credits` or `/model` (decisions.md 2026-10-23).
- Console config dir `~/.claude-console`; Max = the wrapper's incoming
  environment, untouched. Every launch keeps the incoming environment,
  `CLAUDE_CODE_TMPDIR` included.
- Eligible models: Opus and Sonnet. Fable or unresolvable → always Max,
  never switched, never opens or extends the window.
- Credit-exhausted mark clears at 00:00 UTC on the 1st, or by hand. It
  blocks new Console launches; it does not end the window early for
  sessions already on Console (they switch back at the deadline).
- State files `0600`, dirs `0700`, written with `atomicWriteFile`
  (`lib/operations.mjs`); every read-modify-write of a shared file runs
  under `withFlock` (Task 2).
- Existing invariants are acceptance tests in Task 4: `--dry-run` writes
  nothing (no request, state, capture); the kill switch is checked before
  each action; degraded ticks and failed or unread observations authorize
  no send; a genuinely parsed reset is distinguished from `newEvent`'s
  60-minute fallback; stored events keep their reset anchors; detection
  and send captures keep the raw read and the newest-50 retention.
- Tests never touch live Orca terminals, `~/.claude*`, launchd or
  `install.sh`: temp `HOME`, fake `orca` deps, fake `claude` script.
  Cross-process tests coordinate with `child_process.fork` IPC messages as
  barriers and an injected clock, never sleeps.
- Tasks 2, 3 and 4 run one after another (shared files: `README.md`,
  `CHANGELOG.md`, `bin/claude-overflow.mjs`). Each has its own gate and
  review; after Task 4 merges, the orchestrator runs the full gate on main.

## Plan constants (spec "Left to the builder")

| Name | Value | Why |
|---|---|---|
| `RELAUNCH_WINDOW_MS` | 120 000 | wrapper consumes a request only if Claude exits within this of `sentAt` |
| `SESSION_POLL_MS` | 5 000 | wrapper re-reads its child's pid file this often |
| `SETTLE_MS` | 60 000 | a successor alive this long, with pid-file evidence, is settled |
| `CONSUMED_BOUND_MS` | 15 × 60 000 | consumed request with no successor (admission wait) → failed |
| `CONFIRM_BOUND_MS` | 10 × 60 000 | successor without pid-file evidence of the session → failed |
| `MAX_SWITCH_ATTEMPTS` | 3 | `/exit` sends per request before cancelling |
| `ADMISSION_SPACING_MS` | 60 000 | one Console resume per minute: a ≤1M-token uncached resume stays under 2,000,000 ITPM |
| `ADMISSION_POLL_MS` | 5 000 | wrapper re-checks mode and admission this often while waiting |
| `SWITCHES_TO_CONSOLE_PER_TICK` | 1 | controller side of admission |
| `FLOCK_TIMEOUT_S` | 10 | `lockf -t`; a timeout fails closed (no switch, pass-through) |
| window deadline | limit `resetAt` + `SCHEDULE.limit.bufferMs` | spec |

## Request record (Tasks 2 and 4 share it)

One file per handle, `requests/<handle>.json`, every change under
`withFlock(requests/<handle>.lock)`:

| State | Written by | Fields set |
|---|---|---|
| `pending` | controller, at commit | `handle, wrapperPid, generation (G), sessionId, to, attempts, sentAt, createdAt` |
| `pending` (retry) | controller | `attempts + 1`, new `sentAt` |
| `consumed` | wrapper, when Claude G exits | `consumedAt`, `successorGeneration: G+1` |
| deleted | controller only | on confirm, fail, cancel or supersede |

The wrapper consumes only a `pending` request whose `wrapperPid` and
`generation` are its own, whose `sessionId` equals the session it last
observed for child G (pid-file poll, falling back to the launch ID when no
poll succeeded), and whose `sentAt` is within `RELAUNCH_WINDOW_MS` of the
exit. Otherwise it leaves the record untouched and exits with Claude's
status (its death cancels the request on the next tick). The wrapper never
deletes a request.

Controller transitions for a request naming W, G, S (Task 4; every branch
ends within a stated bound, and none sends `/exit` to a successor):

| Observed | Outcome |
|---|---|
| `pending`, G registered, `sentAt` older than `RELAUNCH_WINDOW_MS` | resend `/exit` (all guards) while `attempts < MAX_SWITCH_ATTEMPTS`, else **cancel** |
| `pending`, G registered, deadline passed (Console) or credit marked exhausted | **cancel** |
| `consumed`, no G+1 yet, W alive, `consumedAt` within `CONSUMED_BOUND_MS` | hold (admission wait) |
| `consumed`, no G+1 after `CONSUMED_BOUND_MS` | **fail** |
| G+1 registered by W, mode = `to`, younger than `SETTLE_MS` | hold: no `/exit`, no ordinary send, no cancel |
| G+1, mode = `to`, ≥ `SETTLE_MS`, pid file shows S live | **confirm** |
| G+1, mode = `to`, no pid-file evidence of S by `CONFIRM_BOUND_MS` | **fail** |
| G+1 registered in the other mode (wrapper's launch-time re-check) | **supersede** (info log; not a failure) |
| G+2 or later registered by W (fallback relaunch) | **fail** |
| W dead, or another wrapper owns the handle | **cancel** |

Confirm: delete the request, log `switched <handle> to <to>`, delete the
handle's events detected before the successor's `launchedAt` (removal
reason `switched`). Fail and cancel: delete the request, set
`mode.lastError`, log at `error`, add `<handle>:<W>` to `mode.noSwitch`;
the handle's events (kept throughout) return to the ordinary path with
their original reset anchors. Supersede: delete the request, no
`noSwitch`.

## Review Focus

1. `/clear` or `/resume` inside a wrapped session before the limit: the
   relaunch resumes the session on screen. Task 2 test `relaunch resumes
   the pid file's current session` (launch `s1`, pid file `s2`, relaunch
   argv has `--resume s2`; a request naming `s3` is not consumed).
2. A person's own `/exit` long after a request was sent, or a request from
   an earlier generation: no relaunch. Task 2 tests `request outside the
   relaunch window is not consumed`, `request for another generation is
   not consumed`.
3. Old limit banner reprinted by the resumed transcript after switch-back:
   no ordinary resume fires on it. Task 4 test `switch-back reprint sends
   nothing`.
4. A Console session hits a 529 or a 429 mid-window: it recovers through
   the bounded, status-gated outage path, not at the Max reset. Task 4 test
   `console 429 resumes via outage path` (asserts the actual resume send
   after the health and draft guards).
5. Two wrappers racing for one handle, or a guarded switch that never
   commits: one owner, and the ordinary path keeps the original reset.
   Task 2 test `two wrappers race for a dead owner's handle`; Task 4 test
   `uncommitted or cancelled switch keeps the original reset anchor`.

---

### Task 1: Spike (orchestrator, throwaway Orca terminals)

Run by the orchestrator (John's decision), never in John's sessions, with a
little Console credit. Results, with tool versions and no secret values,
go in `docs/superpowers/specs/2026-11-08-console-credit-overflow-spike.md`
on the spec branch. A result that contradicts the spec goes to John before
Task 2 is dispatched. Items 1-10 are the spec's; 11-13 are the plan's.

- [ ] **1-10** as the spec lists them. For each, record what the probe
  establishes and what it does not. Item 7 also records how long a pid
  file outlives its process, if at all.
- [ ] **11.** `claude --help` (2.1.319): every option that takes a value,
  short forms, `--opt=value` acceptance. This list becomes Task 2's
  `VALUE_OPTIONS` and `KNOWN_FLAGS`.
- [ ] **12.** Closing the Orca tab (SIGHUP): do wrapper and Claude both
  die, so the wrapper never relaunches into a dead pane?
- [ ] **13.** Item 3 follow-up: whether accepting trust for a parent
  directory covers its subdirectories in a fresh config dir, and whether a
  running Claude rewrites `.claude.json` (and when). This picks Task 3's
  sync strategy (below).
- [ ] Before dispatching Tasks 2-4, copy into each brief the spike's
  values: idle status values (item 7), billing, 429 and overload texts
  (item 6), the foreground proof (item 10), the trust/onboarding key list
  and link/copy table (items 3, 13), the option list (item 11).

---

### Task 2: Shared overflow state, argv parser and the `claude-overflow` wrapper

**Files:**
- Create: `lib/overflow-state.mjs`, `lib/claude-argv.mjs`,
  `bin/claude-overflow` (bash shim), `bin/claude-overflow.mjs`,
  `e2e/fake-claude.mjs`
- Modify: `Formula/orca-watchdog.rb`, `README.md` (wrapper section),
  `CHANGELOG.md` (Unreleased)
- Test: `overflow-state.test.mjs`, `claude-argv.test.mjs`,
  `claude-overflow.test.mjs`

**Triage:** BEHAVIORAL — an enabled, eligible `claude-overflow --model
claude-opus-5-5 x` whose Claude exits within `RELAUNCH_WINDOW_MS` of a
matching `pending` `to: console` request marks it `consumed` and relaunches
`claude` with `CLAUDE_CONFIG_DIR=<home>/.claude-console --model
claude-opus-5-5 --resume <sessionId> <CONSOLE_MESSAGE>`.

**Route:** implementer, Astra (`gpt-6-astra`) at high (TTY, signal,
locking and ownership design remains; selection rule 1). Code review:
Opus xhigh.

**Interfaces (produces; Tasks 3 and 4 consume these exact names):**
- `lib/overflow-state.mjs`, every function taking `{ home = os.homedir() }`
  unless noted:
  - `overflowPaths(home) -> { dir, enabledFile, modeFile, admissionFile, registrationsDir, requestsDir, consoleDir }`,
    `dir = <home>/.local/state/orca-watchdog/overflow`,
    `consoleDir = <home>/.claude-console`.
  - `withFlock(lockPath, fn, { timeoutS = FLOCK_TIMEOUT_S } = {}) -> fn's result`:
    opens `lockPath` (`0600`), runs `/usr/bin/lockf -s -t <timeoutS> 3`
    with that descriptor as the child's fd 3 (the lock belongs to the open
    file description, so it is held after `lockf` exits), runs `fn`, closes
    the descriptor in `finally`. Non-zero `lockf` status throws
    `FlockTimeout`. The kernel releases the lock if the holder dies.
  - `isEnabled(opts) -> boolean`.
  - `readMode(opts) -> { until, creditExhaustedUntil, lastError, noSwitch }`
    (ISO strings or null; `noSwitch` an array of `<handle>:<wrapperPid>`;
    missing or invalid file → nulls and `[]`). `updateMode(fn, opts)`
    applies `fn` under `withFlock(modeFile + '.lock')`.
  - `launchMode(mode, now) -> 'console'|'max'`: console iff `until > now`
    and not `creditExhaustedUntil > now`. Used for every launch.
  - `switchBackDue(mode, now) -> boolean`: `until !== null && until <= now`.
    Credit exhaustion does not make it true.
  - Registrations are one file per wrapper, `registrations/<handle>/<wrapperPid>.json`:
    `Registration = { handle, wrapperPid, wrapperStartedAt, generation, claudePid, sessionId, configDir, mode, eligible, model, launchedAt, cwd }`.
    `claimHandle(entry, opts) -> boolean` runs under
    `withFlock(registrations/<handle>.lock)`: deletes sibling files whose
    `wrapperPid` is dead, returns false when another live sibling remains,
    else writes its own file. `updateRegistration(entry, opts)` rewrites
    only its own file. `releaseHandle(handle, wrapperPid, opts)` deletes
    only its own file. `readRegistrations(opts) -> Registration[]` (all
    files, dead ones included; liveness is the reader's call).
  - `readRequest(handle, opts)`, `updateRequest(handle, fn, opts)` (under
    `withFlock(requests/<handle>.lock)`; `fn(current|null) -> next|null`,
    null deletes), shape per "Request record" above.
  - `takeAdmission(now, opts) -> boolean` under
    `withFlock(admissionFile + '.lock')`: true and records `now` when the
    last admission is at least `ADMISSION_SPACING_MS` old.
  - Handles must match `/^[A-Za-z0-9_-]+$/`; anything else throws.
- `lib/claude-argv.mjs`: `parseClaudeArgv(argv) -> { keep, prompt, sessionId, selector: 'none'|'resume-id'|'session-id'|'unsupported', print, model, parseable }`.
  `keep` = argv minus `--session-id`, `--resume`/`-r` and their values,
  and the positional prompt. `--continue`/`-c`, bare `--resume`,
  `--fork-session` → `'unsupported'`. Unknown option → `parseable: false`.
- `resolveModel({ argvModel, env, configDir }) -> string|null` (argv, then
  `env.ANTHROPIC_MODEL`, then `model` in `<configDir>/settings.json`) and
  `isEligibleModel(model) -> boolean` (`/opus|sonnet/i` and not `/fable/i`;
  null → false).
- Messages, exact (spec): `CONSOLE_MESSAGE`, `MAX_MESSAGE` as quoted in the
  spec's Wrapper section.

- [ ] **Step 1: Write failing tests**

`claude-argv.test.mjs`: the Orca launch argv from spike item 2 parses with
`keep` equal to it minus the prompt; `--resume abc`, `-r abc`,
`--session-id abc`, `--model=claude-sonnet-5-5` land in the right fields;
`--continue`, bare `--resume`, `--fork-session` → `'unsupported'`;
`['--brand-new-flag','x','hi']` → `parseable: false`; `-p` → `print: true`.

`overflow-state.test.mjs` (temp `HOME`): `launchMode` and `switchBackDue`
tables (credit mark with a future `until` → `launchMode` max,
`switchBackDue` false); `withFlock` two-process test (fork B, A holds,
B's `fn` runs only after A's message releases); `withFlock` holder killed
→ next caller acquires; `two wrappers race for a dead owner's handle`
(two forked claimers released by one barrier message over a dead owner's
file → exactly one true, the winner's file intact, the dead file gone);
`releaseHandle` by the loser leaves the owner's file; `takeAdmission`
raced by two forks at the same injected `now` → exactly one true; modes
`0600`/`0700`; handle `../x` throws.

`claude-overflow.test.mjs` (temp `HOME`; `CLAUDE_OVERFLOW_CLAUDE` →
`e2e/fake-claude.mjs`, which logs `{argv, CLAUDE_CONFIG_DIR,
CLAUDE_CODE_TMPDIR}` to `FAKE_CLAUDE_LOG`, writes a pid file
`<configDir>/sessions/<pid>.json` with a session ID from
`FAKE_CLAUDE_SESSION` (changeable mid-run through a control file), can
write a request through the real `updateRequest`, and exits with
`FAKE_CLAUDE_EXIT` on a control message):
- `not enabled → pass-through, unregistered`; `no ORCA_TERMINAL_HANDLE →
  pass-through`; `unsupported selector passes through` (`--continue`);
  `unknown flag runs unwrapped`; `print mode is pass-through`.
- `nested wrapper passes through` (marker env set); `second wrapper on a
  live handle passes through`.
- `first launch adds --session-id`, registers it, generation 1, with
  `configDir` and `wrapperStartedAt`.
- `console request relaunches with console dir and --resume`: argv =
  `keep + ['--resume', S, CONSOLE_MESSAGE]`, `CLAUDE_CONFIG_DIR` = console
  dir, `CLAUDE_CODE_TMPDIR` unchanged, generation 2, the request is
  `consumed` with `successorGeneration: 2` and still on disk.
- `relaunch resumes the pid file's current session` (Review Focus 1).
- `max request relaunches with inherited env` (unset stays unset),
  message `MAX_MESSAGE`.
- `request outside the relaunch window is not consumed`, `request for
  another generation is not consumed`: wrapper exits with Claude's
  status, record untouched.
- `admission wait re-checks the mode`: a consumed `to: console` request
  whose admission is taken; while waiting, `until` passes (injected clock)
  → launches on Max at once; likewise when credit is marked exhausted
  during the wait.
- `failed console relaunch falls back to max once`: generation 2 exits 1
  before `SETTLE_MS` → generation 3 on Max with the same session; a second
  failure → wrapper exits non-zero, prints the session ID, appends one line
  to the watchdog activity log, no fourth launch.
- `ineligible model never launches on console` (Fable; unresolvable).
- `SIGHUP ends without relaunch` and releases the registration.
- `flock timeout fails closed`: a held registration lock → pass-through.

- [ ] **Step 2: Run, expect FAIL**: `node --test claude-argv.test.mjs overflow-state.test.mjs claude-overflow.test.mjs`
- [ ] **Step 3: Implement**
  - `bin/claude-overflow`: the `bin/orca-watchdog` symlink pattern. Fast
    path: no `ORCA_TERMINAL_HANDLE`, or no `enabled` file → `exec
    "$CLAUDE_BIN" "$@"`. `CLAUDE_BIN` = `CLAUDE_OVERFLOW_CLAUDE`, else the
    first `claude` on `PATH` whose realpath is not this script's. Otherwise
    exec Node on `bin/claude-overflow.mjs`.
  - `bin/claude-overflow.mjs`: pass-through cases spawn once and exit with
    Claude's status. Owned loop: `claimHandle` (false → pass-through); set
    `CLAUDE_OVERFLOW_OWNER=<handle>:<pid>` for the child; each launch picks
    `launchMode` (ineligible → max); a Console `--resume` launch loops on
    `ADMISSION_POLL_MS`, re-checking `launchMode` and `takeAdmission`;
    spawn with `stdio: 'inherit'`; update the registration (generation +1,
    `claudePid`, `launchedAt`, `configDir`, `mode`); poll the child's pid
    file every `SESSION_POLL_MS` and record its `sessionId` in the
    registration when it changes. On exit, consume per "Request record".
    Ignore SIGINT/SIGQUIT; forward SIGTERM/SIGHUP and stop. Release the
    handle in `finally` and on `exit`.
  - Formula: `(bin/"claude-overflow").write_env_script libexec/"bin/claude-overflow", ORCA_WATCHDOG_NODE: formula_opt_bin("node")/"node"`.
- [ ] **Step 4: Gate**: `bash scripts/orca-setup.sh` → syntax checks pass,
  `node --test` all pass.
- [ ] **Step 5: Summary**, commit message
  `feat: claude-overflow wrapper and shared overflow state (DOG-81)`.

---

### Task 3: Console config dir setup and the `overflow` CLI

**Files:**
- Create: `lib/console-config.mjs`
- Modify: `lib/management.mjs` (`runCli` `overflow` subcommands,
  `doctorText` overflow lines), `bin/claude-overflow.mjs` (one call),
  `completions/*`, `man/orca-watchdog.1`, `README.md`, `CHANGELOG.md`
- Test: `console-config.test.mjs`, `management.test.mjs`,
  `claude-overflow.test.mjs`

**Triage:** BEHAVIORAL — `orca-watchdog overflow setup` on a temp `HOME`
yields a `~/.claude-console` matching spike items 3 and 13, with an empty
mode-555 `agent-memory/` and no credential copied.

**Route:** implementer, Astra at high (selection rule 1: login state).
After Task 2 merges; before Task 4. Code review: Opus xhigh.

**Interfaces:**
- Consumes: `overflowPaths`, `withFlock`, `readMode`, `updateMode`,
  `isEnabled`, `readRegistrations`, `readRequest` (Task 2).
- Produces: `setupConsoleDir({ home }) -> { linked, seeded, skipped }`;
  `syncConsoleProject(cwd, { home }) -> boolean`.
- Sync strategy, chosen from spike item 13 before dispatch:
  - **Parent trust works:** `setupConsoleDir` seeds trust and onboarding
    for the roots Orca uses (`~/orca/workspaces`, `~/orca/projects`,
    `~/Projects`, and each `orca repo list` path), and
    `syncConsoleProject` becomes a check that returns false and logs when
    `cwd` is not under a seeded root; no per-launch write.
  - **It does not:** `syncConsoleProject` copies only the named keys for
    `cwd` under `withFlock(<consoleDir>/.claude.json.lock)`, re-reading
    inside the lock. If spike item 13 showed a running Claude rewrites
    `.claude.json`, that residual race goes to John before dispatch.
- CLI: `orca-watchdog overflow enable|disable|status|setup|clear-credit`.
  `enable` refuses before `setup`. `status` prints launch mode,
  `until`, credit mark, `lastError`, `noSwitch`, live registrations
  (handle, mode, model, eligible, session ID prefix) and requests.

- [ ] **Step 1: Failing tests**: `setupConsoleDir` on a fake `~/.claude`
  tree links exactly the spike's link entries, creates `agent-memory/`
  empty and mode 555, leaves an existing `.claude.json` byte-identical
  apart from seeded keys, copies no file the spike marks sensitive, and is
  idempotent; two forked `syncConsoleProject` calls for different cwds,
  released by one barrier, leave both projects' keys and the auth fields
  intact (locked-sync variant); `overflow enable` before setup exits
  non-zero with `run 'orca-watchdog overflow setup' first`; `clear-credit`
  nulls only `creditExhaustedUntil`; the wrapper calls
  `syncConsoleProject(cwd)` before each Console launch.
- [ ] **Step 2: Run, expect FAIL**: `node --test console-config.test.mjs management.test.mjs claude-overflow.test.mjs`
- [ ] **Step 3: Implement** per the interfaces and the chosen strategy.
- [ ] **Step 4: Gate**: `bash scripts/orca-setup.sh` → all pass.
- [ ] **Step 5: Summary**, commit message
  `feat: orca-watchdog overflow setup/enable/status and console dir sync (DOG-81)`.

---

### Task 4: Overflow controller in the daemon

**Files:**
- Create: `lib/overflow.mjs`
- Modify: `watchdog.mjs` (`PROVIDERS.claude` Console-scoped outage row and
  the derived `OUTAGE_PATTERNS`; `detectBanner`, `hasOutageLine`,
  `classifyOutageNearMiss` option; `tick` phases; `DEFAULT_DEPS.overflow`),
  `README.md` ("How it works"), `CHANGELOG.md`
- Test: `overflow.test.mjs`, `watchdog.test.mjs`

**Triage:** BEHAVIORAL — enabled tick, one eligible live foreground
Max-mode registration, fresh Claude limit banner with a parsed reset →
`pending` request persisted, then exactly
`['terminal','send','--terminal',H,'--text','/exit','--enter']`, no
`RESUME_TEXT`, and the limit event still stored with its reset.

**Route:** implementer, Astra at high (invariant `watchdog.mjs`, the send
path; selection rule 1). After Task 3 merges. Code review: Opus xhigh.

**Interfaces:**
- Consumes: Task 2's exported state functions, called with their real
  files in tests (no fabricated wrapper state where a Task 2 function
  exists).
- `lib/overflow.mjs` imports nothing from `watchdog.mjs`. It exports
  `planOverflow(input) -> Plan`, pure:
  - `input = { enabled, mode, registrations, requests, sessions, facts, events, listedHandles, now }`;
    `sessions: Map<'<configDir>:<pid>', { sessionId, status } | null>`;
    `facts = { alive: Set<number>, foreground: Set<string> }` (handles
    whose owner's Claude is the foreground program, spike item 10).
  - `Plan = { mode, suppress: Map<handle, 'all'|'limit-credits'>, switches: Array<{ handle, to, wrapperPid, generation, sessionId }>, resends: Array<{ handle }>, confirms: Array<{ handle, successorLaunchedAt }>, fails: Array<{ handle, reason }>, cancels: Array<{ handle, reason }>, supersedes: Array<{ handle }>, consoleHandles: Set<string> }`.
- The tick adapter (in `watchdog.mjs`, so it uses the private `readTail`)
  builds `facts` and `sessions` from `readRegistrations` (pid liveness via
  `process.kill(pid, 0)`, foreground per spike item 10, pid files read from
  each registration's `configDir`) and applies the plan.
- `detectBanner(lines, platform, now, { consoleRows = false } = {})`; the
  Console 429 row is a `PROVIDERS.claude.outage` entry with
  `consoleOnly: true`, excluded from `OUTAGE_PATTERNS` and the stale-limit
  check unless `consoleRows`. Both `detectBanner` call sites in `tick`
  (observation read and fresh re-read) pass `consoleRows` for
  `consoleHandles`.

Rules `planOverflow` encodes (each a test in `overflow.test.mjs`):
- Disabled → empty plan; the tick is byte-identical to today's suite.
- A handle counts only with exactly one registration whose `wrapperPid`
  and `claudePid` are in `facts.alive` and whose handle is in
  `facts.foreground` and listed once.
- `noSwitch` is checked before any switch in either direction; an entry is
  dropped once no registration file for that `<handle>:<wrapperPid>`
  exists.
- Trigger: a `limit` event on platform `claude` whose `resetAt` came from
  the banner (not the 60-minute fallback) on an eligible Max-mode
  registration, credit not exhausted → `until = max(until, resetAt +
  bufferMs)`; at most `SWITCHES_TO_CONSOLE_PER_TICK` switches, oldest
  event first. Ineligible registrations never touch `until`.
- Switch-back: `switchBackDue(mode, now)` → each Console-mode registration
  whose session `status` is idle (spike item 7) → `to: max`; busy or
  missing status → nothing this tick. A credit mark alone never triggers
  it.
- Billing text (spike item 6) in a Console handle's window →
  `creditExhaustedUntil` = next 1st of the month 00:00 UTC; no send.
- `suppress`: `'all'` for handles with a request or switched this tick;
  `'limit-credits'` for `consoleHandles` without a request. The plan never
  deletes events except on `confirms`.
- Request transitions exactly per the "Request record" tables.

Tick phases (in this order; degraded ticks run only phase 1 and the
ordinary freeze):
1. Reads, detection captures and `reconcile` exactly as today (no
   observation filtering), with `consoleRows` for handles that were
   Console-mode at tick start.
2. `planOverflow`; persist `mode` via `updateMode`.
3. Remove suppressed handles' candidates from `sendCandidates` (`'all'`:
   every kind; `'limit-credits'`: limit and credits only). Events stay.
4. Apply `confirms` (delete request, delete the handle's events detected
   before `successorLaunchedAt`, reason `switched`), `fails`, `cancels`,
   `supersedes` per the Request record.
5. Commit `switches` and `resends`, each through the send loop's guards in
   order: dry-run (prints `would switch <handle> to <to>`, writes
   nothing), kill switch, `terminal wait --for tui-idle`, fresh `readTail`,
   foreground re-check, shell-prompt guard, draft guard
   (`isInputOccupied(tail, 'claude', draft)`), for `to: console` the fresh
   banner must still be a Claude `limit`. Any guard failing → nothing
   written this tick. Then `updateRequest` (create `pending`, or
   `attempts + 1`), send `/exit` + Enter, and capture with
   `reason: 'send'` plus `overflow: { to, attempt }` and the raw read (so
   the newest-50 retention covers it).
6. The ordinary send loop, unchanged.

- [ ] **Step 1: Failing tests** for each rule and each Request-record row,
  plus: `uncommitted or cancelled switch keeps the original reset anchor`
  (a draft blocks the commit; then a cancelled request; the ordinary path
  later sends on the event's original `resetAt`, not a re-parsed one);
  `tick between successor and settle keeps the request pending` then
  `confirms on the next tick` with real Task 2 files and a controller
  restart in between (new `tick` call, fresh deps); `credit exhaustion
  waits for the deadline` (mark set at 10:00 with `until` 15:00: no
  `/exit` to Console sessions on ticks before 15:00, switch-back after);
  `noSwitch blocks later ticks` after retry exhaustion, a failed relaunch
  and a cancel, and a new wrapper pid on the same handle can switch;
  `dead, duplicate or background registration authorizes nothing`;
  `fallback reset never opens the window`; `later limit extends until,
  never shortens`; `wall clock moving back does not shorten until`;
  `deadline passing mid-turn waits for idle`; `console 429 resumes via
  outage path`; `switch-back reprint sends nothing`; `dry-run writes
  nothing`; `pause mid-tick halts switches`; `degraded tick holds`;
  `captures keep the newest 50 across mixed detected, send and switch
  captures` (writes 60, asserts the exact surviving names and that a
  switch capture holds its raw read); a replay of every recorded screen
  inline in `watchdog.test.mjs` (DOG-52, DOG-78 and outage fixture tables)
  with `consoleRows: true` detecting exactly what it detects today.
- [ ] **Step 2: Run, expect FAIL**: `node --test overflow.test.mjs watchdog.test.mjs`
- [ ] **Step 3: Implement** `planOverflow`, the adapter and the phases.
- [ ] **Step 4: Gate**: `bash scripts/orca-setup.sh`; `node watchdog.mjs
  --dry-run` on a temp `HOME` with `e2e/fake-tui.mjs` prints the switch
  line and leaves the state dir unchanged.
- [ ] **Step 5: Summary**, commit message
  `feat: overflow controller switches wrapped Claude sessions to Console credit and back (DOG-81)`.

---

### Task 5: Release and deploy (orchestrator)

After Tasks 2-4 merge (each its own PR; nothing released before Task 4):
version bump, CHANGELOG, formula `url`/`sha256`, tap bump, then
`orca-watchdog stop` → `brew upgrade johncioni/tap/orca-watchdog` →
`orca-watchdog doctor && orca-watchdog start`. Overflow stays disabled.

### Task 6: Harness adoption (OPS child ticket, its own spec and review)

Filed as an OPS child of DOG-81 after Task 5. Covers, per the spec's
"Harness adoption": the trusted launch adapter (private
`CLAUDE_CODE_TMPDIR`, fail-closed, pass-through included) and Orca's
`agentCmdOverrides.claude`; the role-tab recipe; the never-resume
exception; the Provider-outages row; worker protection for every
sensitive `~/.claude-console` path (managed `deny_read` with `/**`
companions, generated sandbox policy, checker, probe); HARNESS-SYNC.md and
`check-models-sync.py`. Then John runs `overflow setup` and `overflow
enable` and sets the override (John-only: his login state). DOG-81 closes
after that and a verified first live switch, or when John says so.
