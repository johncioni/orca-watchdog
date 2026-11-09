# Console credit overflow plan: amendment 1

Amends `docs/superpowers/plans/2026-11-08-console-credit-overflow.md`
(merged at `57e752a`, reviewed head `7fb8012`). Where a rule below differs
from the plan, this file wins. Every Task 2, 3 and 4 brief quotes the
amendments that name it, and that task's code review checks them.

Sources: the plan review's final round (findings 1-4, carried as A1-A4),
the spike (`docs/superpowers/specs/2026-11-08-console-credit-overflow-spike.md`,
items cited by number), and John's decisions of 2026-11-08 (A6, A7, and
funding the Team Rocket org with a prepaid balance). Spike values that
change no plan rule (idle status, banner texts, option lists, seed keys)
are copied into the briefs as the plan's Task 1 says; they are not
repeated here.

## A1 (Task 4): accepted reset evidence is the next baseline

The plan's Trigger rule compares an observation with the stored event's
banner text, but `reconcile` keeps the old text for a same-kind
observation (`watchdog.mjs:908-925`), so an accepted later clock is
re-parsed on every read and lands a day late once past the parser's
two-hour grace.

Rule: `mode.evidence[handle] = { bannerText, resetAt, acceptedAt }`,
written with `mode` in phase 2 (not on `--dry-run`). Reset evidence for a
read observation is, in order: the evidence entry's `resetAt` when the
normalized banner text equals its `bannerText`; else the stored event's
`resetAt` when the text equals the event's `bannerText`; else the
observation's `resetAt`, which then replaces the evidence entry. An entry
is dropped when the handle has no registration file. `eventSnapshot`
stays separate and is never updated from evidence.

Test: accept changed text, hold the switch with a draft, restart the
controller, read the same text beyond the two-hour grace: `until` stays
on the accepted day.

## A2 (Tasks 2, 3, 4): a forced Max launch for a Console request is a failure

The plan classes every other-mode successor as supersede, which adds no
`noSwitch`, so an admission give-up or a failed Console preflight can
repeat the switch cycle without bound.

Rule: when the wrapper registers G+1 under the request lock (plan,
"Successor launch is atomic with the record"), it also writes
`launch: { mode, reason }` on the consumed record, where `reason` is
`ok`, `mode` (its `launchMode` re-check said `max`: deadline passed,
credit marked exhausted, or overflow disabled), `admission-timeout`, or
`preflight:<reason>` (`syncConsoleProject` returned `ok: false`). The
controller reads it under the same lock: `launch.mode === to` follows the
plan's rows; `reason: 'mode'` is **supersede**; any other reason is
**fail** (visible error, `<handle>:<W>` into `noSwitch`, snapshot
restored per A3).

Test: after an admission give-up and after an unseeded-cwd fallback,
several healthy ticks with a controller restart between them produce no
new request and no `/exit`; a deadline-passed fallback still supersedes.

## A3 (Task 4): record the outcome before restoring, restore before deleting

Rule for fail, cancel and supersede, each under the request lock: (1)
write `outcome: { kind, reason, at }` on the request record; (2) restore
`eventSnapshot` into the stored events and save state; (3) delete the
request. On startup and every tick, a request that already has `outcome`
is replayed from step 2. Replay is idempotent: restoring the same
snapshot twice yields the same events. `mode.lastError` and `noSwitch`
are written with step 1's `updateMode`.

Test: inject a failure between steps 2 and 3, and between steps 1 and 2;
restart; the original reset, anchor, banner text and attempts survive,
and a second replay changes nothing.

## A4 (Task 2): admission covers every Console resume

Rule: every Console launch that resumes a conversation (a `resume-id`
selector, or a relaunch for a consumed request) takes shared admission
and re-checks `launchMode` every `ADMISSION_POLL_MS` while waiting. The
revocation check and the `ADMISSION_GIVE_UP_MS` give-up apply only when
there is a consumed request; a direct `--resume` that loses `launchMode`
while waiting launches on Max with no record.

Test: direct `--resume` wrappers started during the window alongside a
switch relaunch (IPC barriers, injected clock); their Console children
start at least `ADMISSION_SPACING_MS` apart.

## A5 (Task 3): Console config writes use Claude's own lock

Spike item 13: a running Claude rewrites `<consoleDir>/.claude.json` at
onboarding, at each dialog answer and at exit, holding a proper-lockfile
lock: the **directory** `<consoleDir>/.claude.json.lock`, treated as
stale when its mtime is older than 10 s. Trust is inherited from a
trusted parent, but external-import approval is per project.

Rules:
- The plan's "Parent trust works" branch is dropped; the per-cwd sync
  ("It does not") is the strategy.
- Every write to the Console `.claude.json` (setup and per-launch sync)
  takes the lock by `mkdir` of that directory (retry on `EEXIST` up to
  `FLOCK_TIMEOUT_S`; remove and retake a lock whose mtime is older than
  10 s), re-reads the file inside it, changes only the named keys, writes
  a temp file in the same directory, renames it over, then removes the
  lock directory. Nothing creates a regular file at that path, and
  `withFlock` is never used on it.
- `syncConsoleProject(cwd)` reads `~/.claude.json` (read only, no lock)
  and writes, for the cwd's project key in the Console file:
  `hasTrustDialogAccepted: true` when the Max file has it true for that
  key or any ancestor key (Claude's inheritance, spike item 13), and
  `hasClaudeMdExternalIncludesApproved` and
  `hasClaudeMdExternalIncludesWarningShown` copied from the Max entry for
  that exact key. No Max entry for the key, or no trusted key at or
  above it: `{ ok: false, reason: 'unseeded' }`. A lock timeout is
  `reason: 'lock-timeout'`.
- The project key is the one Claude 2.1.319 uses. Task 3 establishes it
  and tests a non-git cwd (the spike saw the cwd itself), a repository
  root, a subdirectory of a repository, and an Orca worktree.
- `setupConsoleDir` seeds the global `hasCompletedOnboarding: true` and
  `lastOnboardingVersion` under the same lock.

Test: a forked `syncConsoleProject` that holds the lock directory delays a
second writer; a lock directory with an old mtime is taken over; a regular
file at the lock path is never created; a simulated Claude save (mkdir,
re-read, merge `projects`, rename) racing two syncs loses no key.

## A6 (Task 3): what a Console session shares with `~/.claude` (John)

Rule: `setupConsoleDir` symlinks `projects`, `settings.json`, `plugins`,
`skills`, `agents` and `commands` in `~/.claude-console` to their
`~/.claude` counterparts, creating none that `~/.claude` lacks. It never
links or copies `CLAUDE.md` (spike item 3: the parent walk already loads
it), any credential, or `.claude.json`. An existing non-link entry of the
same name is left alone and reported in `skipped`.

Test: on a fake home, exactly those six links; `CLAUDE.md` absent from
the Console dir; a pre-existing real `settings.json` there is untouched
and listed in `skipped`.

## A7 (Task 2): no advisor on Console (John)

Spike items 8 and 11: Orca launches Claude with `--advisor <model>`, and a
Console session enables an advisor by default even without the flag.

Rules:
- `--advisor` is a known option that takes a value (and `--advisor=x`),
  so the orchestrator's launch argv parses.
- A Console launch drops `--advisor` and its value from argv and sets
  `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` in the child's environment. A Max
  launch keeps the original argv and does not set the variable.

Test: argv with `--advisor claude-fable-5-1` launches the fake Claude on
Console without the option and with the variable, and on Max with both
unchanged. The Task 2 deliverable summary also records one real Console
launch's debug log showing no `[AdvisorTool] Server-side tool enabled`
line.

## A8 (Task 2): a signalled wrapper never relaunches

Spike item 12: `orca terminal close` delivers SIGTERM.

Rule: after the wrapper receives SIGTERM or SIGHUP it forwards the signal,
waits for Claude to exit, releases its registration and exits with
Claude's status; it never consumes a request and never launches again.

Test: SIGTERM with a matching pending request leaves the record
`pending` and spawns nothing.

## A9 (Tasks 2 and 4): foreground proof fields

Spike item 10. Rule: the `Registration` gains `tty` (the wrapper's
controlling terminal) and `pgid` (the wrapper's process group). The
controller's foreground check for a handle is: `ps -o pgid=,tpgid=,tty=`
for `claudePid` gives `pgid === tpgid === registration.pgid` and
`tty === registration.tty`. The wrapper spawns Claude in its own process
group (not detached).

Test (Task 4, with a stubbed `ps`): a mismatched `tpgid` or `tty`
withholds the handle from `facts.foreground`.

## A10 (Tasks 2 and 3): the Console config dir string

Spike item 9: the Keychain item is named from a hash of the exact
`CLAUDE_CONFIG_DIR` string. Rule: the wrapper and setup pass
`path.join(home, '.claude-console')` verbatim, never a realpath, a `~`
form or a trailing slash. Test: the fake Claude receives exactly
`<home>/.claude-console`.
