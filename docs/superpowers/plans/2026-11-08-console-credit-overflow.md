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
terminal handle through an exclusive registration. The daemon's overflow
controller reads registrations each 5-minute tick, decides when a terminal
switches, persists a switch request and sends `/exit` through the same
guards as today's resume sends; the wrapper relaunches with `--resume`
only for a request bound to its own launch. Shared state is owner-only JSON
under `~/.local/state/orca-watchdog/overflow/`.

**Tech Stack:** Node 22+ ES modules, no dependencies, `node --test`; bash
launcher shims; Homebrew formula.

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
- Credit-exhausted mark clears at 00:00 UTC on the 1st, or by hand.
- State files `0600`, dirs `0700`, written with `atomicWriteFile`
  (`lib/operations.mjs`).
- Existing invariants are acceptance tests in Task 4: `--dry-run` writes
  nothing (no request, state, capture); the kill switch is checked before
  each action; degraded ticks and failed or unread observations authorize
  no send; a genuinely parsed reset is distinguished from `newEvent`'s
  60-minute fallback; detection and send captures keep the raw read.
- Tests never touch live Orca terminals, `~/.claude*`, launchd or
  `install.sh`: temp `HOME`, fake `orca` deps, fake `claude` script.

## Plan constants (spec "Left to the builder")

| Name | Value | Why |
|---|---|---|
| `RELAUNCH_WINDOW_MS` | 120 000 | wrapper honours a request only if Claude exits within this of `sentAt` |
| `SETTLE_MS` | 60 000 | a relaunched Claude alive this long counts as settled |
| `MAX_SWITCH_ATTEMPTS` | 3 | `/exit` sends per request before cancelling |
| `ADMISSION_SPACING_MS` | 60 000 | one Console resume per minute: a ≤1M-token uncached resume stays under 2,000,000 ITPM |
| `SWITCHES_TO_CONSOLE_PER_TICK` | 1 | controller side of admission |
| window deadline | limit `resetAt` + `SCHEDULE.limit.bufferMs` | spec |

## Review Focus

1. `/clear` or `/resume` inside a wrapped session before the limit: the
   relaunch resumes the session on screen (pid-file ID). Task 4 test
   `request carries the pid file's current sessionId`.
2. A person's own `/exit` long after a request was sent, or a request from
   an earlier generation: no relaunch. Task 2 tests `request outside the
   relaunch window is ignored`, `request for another generation is ignored`.
3. Old limit banner reprinted by the resumed transcript after switch-back:
   no ordinary resume fires on it. Task 4 test `switch-back reprint sends
   nothing`.
4. A Console session hits a 529 or a 429 mid-window: it recovers through
   the bounded, status-gated outage path, not at the Max reset. Task 4 test
   `console 429 resumes via outage path`.
5. Two wrappers in one terminal (nested, or a second launch): only one
   owns the handle, and the loser never deletes the owner's entry. Task 2
   tests `nested wrapper passes through`, `second wrapper on a live handle
   passes through`.

---

### Task 1: Spike (orchestrator, throwaway Orca terminals)

Run by the orchestrator (John's decision), never in John's sessions, with a
little Console credit. Results, with tool versions and no secret values,
go in `docs/superpowers/specs/2026-11-08-console-credit-overflow-spike.md`
on the spec branch. A result that contradicts the spec goes to John before
Task 2 is dispatched. Items 1-10 are the spec's; 11-12 are the plan's.

- [ ] **1-10** as the spec lists them. For each, record what the probe
  establishes and what it does not (round-1 follow-up note).
- [ ] **11.** `claude --help` (2.1.319): every option that takes a value,
  short forms, `--opt=value` acceptance. This list becomes Task 2's
  `VALUE_OPTIONS` and `KNOWN_FLAGS`.
- [ ] **12.** Closing the Orca tab (SIGHUP): do wrapper and Claude both
  die, so the wrapper never relaunches into a dead pane?
- [ ] Before dispatching Tasks 2-4, copy into each brief the spike's
  values: idle status values (item 7), billing, 429 and overload texts
  (item 6), the foreground proof (item 10), the trust/onboarding key list
  and link/copy table (item 3), the option list (item 11).

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
matching `to: console` request relaunches `claude` with
`CLAUDE_CONFIG_DIR=<home>/.claude-console --model claude-opus-5-5 --resume
<sessionId> <CONSOLE_MESSAGE>`.

**Route:** implementer, Astra (`gpt-6-astra`) at high (TTY, signal and
ownership design remains; selection rule 1). Code review: Opus xhigh.

**Interfaces (produces):**
- `lib/overflow-state.mjs`, every function taking `{ home = os.homedir() }`:
  - `overflowPaths(home) -> { dir, enabledFile, modeFile, admissionFile, registrationsDir, requestsDir, consoleDir }`,
    `dir = <home>/.local/state/orca-watchdog/overflow`,
    `consoleDir = <home>/.claude-console`.
  - `isEnabled(opts) -> boolean`.
  - `readMode(opts) -> { until, creditExhaustedUntil, lastError, noSwitch }`
    (ISO strings or null, `noSwitch` an array of `<handle>:<wrapperPid>` keys; missing or
    invalid file → nulls and `[]`).
  - `effectiveMode(mode, now) -> 'console'|'max'`: console iff `until > now`
    and not `creditExhaustedUntil > now`.
  - `writeMode(mode, opts)`.
  - `claimHandle(entry, opts) -> boolean`: exclusive create of
    `registrations/<handle>.json`; an existing entry whose `wrapperPid` is
    alive → false; a dead one is replaced. `updateRegistration(entry, opts)`
    writes only while the file still names `entry.wrapperPid`.
    `releaseHandle(handle, wrapperPid, opts)` removes it only then.
  - `readRegistrations(opts) -> Registration[]`,
    `Registration = { handle, wrapperPid, generation, claudePid, sessionId, mode, eligible, model, launchedAt, cwd }`.
  - `writeRequest(req, opts)`, `readRequest(handle, opts)`,
    `deleteRequest(handle, opts)`;
    `Request = { handle, wrapperPid, generation, sessionId, to, attempts, sentAt, createdAt }`.
  - `takeAdmission(now, opts) -> boolean`: true and records `now` when the
    last admission is at least `ADMISSION_SPACING_MS` old (exclusive lock
    file around the read-modify-write).
  - Handles must match `/^[A-Za-z0-9_-]+$/`; anything else throws.
- `lib/claude-argv.mjs`: `parseClaudeArgv(argv) -> { keep, prompt, sessionId, resume, selector: 'none'|'resume-id'|'session-id'|'unsupported', print, model, parseable }`.
  `keep` = argv minus `--session-id`, `--resume`/`-r`, and the positional
  prompt. `--continue`/`-c`, bare `--resume`, `--fork-session` →
  `selector: 'unsupported'`. Unknown option → `parseable: false`.
- `resolveModel({ argvModel, env, configDir }) -> string|null` and
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

`overflow-state.test.mjs` (temp `HOME`): `effectiveMode` table (until past
→ max; future → console; future + credit mark future → max);
`claimHandle` false while the owner pid is alive, true after it dies;
`releaseHandle` with another pid leaves the file; `takeAdmission` true,
then false within 60 s, true after; modes `0600`/`0700`; handle `../x`
throws.

`claude-overflow.test.mjs` (temp `HOME`; `CLAUDE_OVERFLOW_CLAUDE` →
`e2e/fake-claude.mjs`, which logs `{argv, CLAUDE_CONFIG_DIR, CLAUDE_CODE_TMPDIR}`
to `FAKE_CLAUDE_LOG`, can write a request via `FAKE_CLAUDE_WRITE_REQUEST`,
and exits with `FAKE_CLAUDE_EXIT` after `FAKE_CLAUDE_MS`):
- `not enabled → pass-through, unregistered`; `no ORCA_TERMINAL_HANDLE →
  pass-through`.
- `unsupported selector passes through` (`--continue`), `unknown flag runs
  unwrapped`, `print mode is pass-through`.
- `nested wrapper passes through` (marker env set), `second wrapper on a
  live handle passes through`.
- `first launch adds --session-id` and registers it, generation 1.
- `console request relaunches with console dir and --resume`: argv =
  `keep + ['--resume', req.sessionId, CONSOLE_MESSAGE]`,
  `CLAUDE_CONFIG_DIR` = console dir, `CLAUDE_CODE_TMPDIR` unchanged,
  generation 2, request deleted.
- `max request relaunches with inherited env` (unset stays unset), message
  `MAX_MESSAGE`.
- `request outside the relaunch window is ignored`, `request for another
  generation is ignored`: exit with Claude's status, request deleted.
- `mode is re-checked at relaunch`: a `to: console` request after `until`
  passed relaunches on Max.
- `failed console relaunch falls back to max once`: the relaunched fake
  exits 1 within `SETTLE_MS` → one Max relaunch with the same session; a
  second failure → wrapper exits non-zero, prints the session ID, appends
  one line to the watchdog activity log, no third launch.
- `ineligible model never launches on console` (Fable; unresolvable).
- `console resume waits for admission`: with an admission taken 10 s ago
  the launch waits (injectable clock) rather than skipping.
- `SIGHUP ends without relaunch` and releases the registration.

- [ ] **Step 2: Run, expect FAIL**: `node --test claude-argv.test.mjs overflow-state.test.mjs claude-overflow.test.mjs`
- [ ] **Step 3: Implement**
  - `bin/claude-overflow`: the `bin/orca-watchdog` symlink pattern. Fast
    path: no `ORCA_TERMINAL_HANDLE`, or no `enabled` file → `exec
    "$CLAUDE_BIN" "$@"`. `CLAUDE_BIN` = `CLAUDE_OVERFLOW_CLAUDE`, else the
    first `claude` on `PATH` whose realpath is not this script's. Otherwise
    exec Node on `bin/claude-overflow.mjs`.
  - `bin/claude-overflow.mjs`: pass-through cases spawn once and exit with
    Claude's status. Owned loop: `claimHandle`; set the nested marker
    `CLAUDE_OVERFLOW_OWNER=<handle>:<pid>` for the child; each launch picks
    the mode by `effectiveMode` (ineligible → max), takes admission for a
    Console `--resume` launch, spawns with `stdio: 'inherit'`, updates the
    registration (generation +1, `claudePid`, `launchedAt`). On exit,
    honour only a request that names this `wrapperPid`, generation and
    session and whose `sentAt` is within `RELAUNCH_WINDOW_MS`; delete any
    request either way. Ignore SIGINT/SIGQUIT; forward SIGTERM/SIGHUP and
    stop. Release the handle in `finally` and on `exit`.
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
yields a `~/.claude-console` matching spike item 3's table, with an empty
mode-555 `agent-memory/` and no credential copied.

**Route:** implementer, Astra at high (selection rule 1: login state).
After Task 2 merges; parallel with Task 4 (disjoint files). Code review:
Opus xhigh.

**Interfaces:**
- Consumes: `overflowPaths`, `readMode`, `writeMode`, `isEnabled`,
  `readRegistrations` (Task 2).
- Produces: `setupConsoleDir({ home }) -> { linked, seeded, skipped }`;
  `syncConsoleProject(cwd, { home }) -> boolean` (copies only the trust and
  onboarding keys spike item 3 names, for `cwd`, from `~/.claude.json` into
  `~/.claude-console/.claude.json`; never an auth key; true when it wrote).
- CLI: `orca-watchdog overflow enable|disable|status|setup|clear-credit`.
  `enable` refuses before `setup`. `status` prints effective mode, `until`,
  credit mark, `lastError`, live registrations (handle, mode, model,
  eligible, session ID prefix) and pending requests.

- [ ] **Step 1: Failing tests**: `setupConsoleDir` on a fake `~/.claude`
  tree links exactly the spike's link entries, creates `agent-memory/`
  empty and mode 555, leaves an existing `.claude.json` byte-identical
  apart from seeded keys, copies no file the spike marks sensitive, and is
  idempotent; `syncConsoleProject` copies only the named keys and leaves
  auth fields byte-identical; `overflow enable` before setup exits
  non-zero with `run 'orca-watchdog overflow setup' first`;
  `clear-credit` nulls only `creditExhaustedUntil`; the wrapper calls
  `syncConsoleProject(cwd)` before each Console launch.
- [ ] **Step 2: Run, expect FAIL**: `node --test console-config.test.mjs management.test.mjs claude-overflow.test.mjs`
- [ ] **Step 3: Implement** per the interfaces. If spike item 3 found that
  a running Console session rewrites `.claude.json`, `syncConsoleProject`
  re-reads immediately before its atomic write and writes only when a key
  is missing.
- [ ] **Step 4: Gate**: `bash scripts/orca-setup.sh` → all pass.
- [ ] **Step 5: Summary**, commit message
  `feat: orca-watchdog overflow setup/enable/status and console dir sync (DOG-81)`.

---

### Task 4: Overflow controller in the daemon

**Files:**
- Create: `lib/overflow.mjs`
- Modify: `watchdog.mjs` (`PROVIDERS.claude` Console-scoped outage row;
  `detectBanner` option; `tick` controller pass; `DEFAULT_DEPS.overflow`),
  `README.md` ("How it works"), `CHANGELOG.md`
- Test: `overflow.test.mjs`, `watchdog.test.mjs`

**Triage:** BEHAVIORAL — enabled tick, one eligible live foreground
Max-mode registration, fresh Claude limit banner with a parsed reset →
request persisted, then exactly `['terminal','send','--terminal',H,'--text','/exit','--enter']`,
and no `RESUME_TEXT`.

**Route:** implementer, Astra at high (invariant `watchdog.mjs`, the send
path; selection rule 1). After Task 2 merges. Code review: Opus xhigh.

**Interfaces:**
- Consumes: Task 2's state functions; `detectBanner`, `isInputOccupied`,
  `isShellPrompt`, `readTail`, `newEvent`, `SCHEDULE` from `watchdog.mjs`.
- Produces (`lib/overflow.mjs`, pure):
  `planOverflow({ enabled, mode, registrations, requests, sessions, events, observations, listedHandles, now }) -> { mode, controllerOwned: Set<string>, consoleHandles: Set<string>, switches: Array<{ handle, to, sessionId, attempt }>, cancel: Array<{ handle, reason }>, errors: string[] }`.
  `sessions` maps `claudePid → { sessionId, status } | null` from
  `<configDir>/sessions/<pid>.json`; the adapter supplies
  `alive(pid)` and `isForeground(handle, claudePid)` (spike item 10;
  unknown → false).
- `detectBanner(lines, platform, now, { consoleRows = false } = {})`: the
  Console 429 row (spike item 6) is a `PROVIDERS.claude.outage` entry with
  `consoleOnly: true`, applied only when `consoleRows` is true.

Rules (each a test in `overflow.test.mjs`):
- Disabled → empty plan; the tick is byte-identical to today's suite.
- A registration counts only if both pids are `alive`, its handle is
  listed exactly once, and `isForeground` is true.
- Trigger: a `limit` event on platform `claude` whose `resetAt` came from
  the banner (not the 60-minute fallback) on an eligible Max-mode
  registration, credit not exhausted → `until = max(until, resetAt +
  bufferMs)`; at most `SWITCHES_TO_CONSOLE_PER_TICK` switches, oldest
  event first. Ineligible registrations never touch `until`.
- `controllerOwned` = handles with a pending request and handles switched
  this tick. The tick drops their observations before `reconcile` and
  deletes their stored events (removal reason `overflow`).
- `consoleHandles` = Console-mode registrations without a request: the tick
  reads them with `consoleRows: true`; their `limit` and `credits` events
  are dropped (reason `overflow`), their `outage` events (529, connection,
  Console 429) run the ordinary bounded, status-gated outage path.
- Switch-back: `effectiveMode` max → each Console-mode registration whose
  session `status` is idle (spike item 7) → `to: max`; busy or missing
  status → nothing this tick.
- Billing text (spike item 6) in a Console handle's window →
  `creditExhaustedUntil` = next 1st of the month 00:00 UTC; no send.
- Request lifecycle, for a request naming wrapper W, generation G,
  session S (spec "Request lifecycle"):
  - registered generation G, `sentAt` older than `RELAUNCH_WINDOW_MS` →
    resend `/exit` while `attempts < MAX_SWITCH_ATTEMPTS`, else cancel;
  - expected successor (W, G+1, S) registered, not yet `SETTLE_MS` old →
    pending: no `/exit`, no ordinary send, no cancel;
  - successor in mode `to`, pid file shows S live, `SETTLE_MS` old →
    confirmed: delete request, log `switched <handle> to <to>`;
  - successor gone before settling, or generation G+2 (the wrapper's Max
    fallback after a Console request) → failed relaunch;
  - W dead, or any other generation registered → cancel;
  - G still registered when `until` passes (Console request) or credit is
    marked exhausted → cancel.
  Each cancel or failure records `mode.lastError`, logs at `error`, returns
  the handle to the ordinary path and adds `<handle>:<W>` to `noSwitch`, kept in
  the mode file until W's registration is gone.

Tick execution of a switch (after the alert pass, before the send loop),
reusing the send loop's guards in order: dry-run (prints `would switch
<handle> to <to>`, writes nothing), kill switch, `terminal wait --for
tui-idle`, fresh `readTail`, foreground re-check, shell-prompt guard, draft
guard (`isInputOccupied(tail, 'claude', draft)`), for `to: console` the
fresh banner must still be a Claude `limit`. Then persist the request
(`attempts + 1`, `sentAt` now, `sessionId` from the pid file), send `/exit`,
capture `reason: 'overflow-switch'` with the raw read. Degraded ticks run
no switches and cancel nothing.

- [ ] **Step 1: Failing tests** for each rule above, plus:
  `request carries the pid file's current sessionId` (pid file `s2`,
  registration `s1` → request `s2`); `tick between successor and settle
  keeps the request pending` (no send, no cancel; the next tick
  confirms); `exit retries only target generation G`; `max fallback
  after a console request is a failed relaunch`; `stored reset anchor
  survives a long read outage`; `wall clock moving back does not shorten
  until`; `deadline passing mid-turn waits for idle before switch-back`;
  `credit marked exhausted during an admission wait launches on Max`
  (wrapper side, in `claude-overflow.test.mjs`); `dead, duplicate or background
  registration authorizes nothing`; `fallback reset never opens the
  window`; `later limit extends until, never shortens`; `credit mark blocks
  new switches and clears after the 1st`; `draft appearing after detection
  blocks the send`; `console 429 resumes via outage path`; `switch-back
  reprint sends nothing` (a Max-mode handle whose screen shows the old
  limit banner above the `MAX_MESSAGE` turn); `dry-run writes nothing`;
  `pause mid-tick halts switches`; `degraded tick holds`; and a replay of
  every recorded screen already inline in `watchdog.test.mjs` (the DOG-52
  and DOG-78 fixture tables and the outage fixtures) with
  `consoleRows: true`: each detects exactly what it detects today.
- [ ] **Step 2: Run, expect FAIL**: `node --test overflow.test.mjs watchdog.test.mjs`
- [ ] **Step 3: Implement** `planOverflow`, the adapter and the tick pass.
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
