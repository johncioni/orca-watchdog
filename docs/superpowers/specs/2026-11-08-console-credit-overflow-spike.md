# Console credit overflow: spike results (DOG-81, plan Task 1)

Run 2026-11-08 by the orchestrator in two throwaway Orca tabs it opened
itself, with fresh test sessions in `~/.cache/dog81-spike/`, never in
John's sessions. Versions: Claude Code 2.1.319 (native binary,
`~/.local/share/claude/versions/2.1.319`), Orca 1.4.253, macOS 15.8.2.
Bundle findings come from `strings` on that binary. No secret value was
read or recorded.

Side effects on John's machine, kept on purpose: `~/.claude-console/projects`
is now a symlink to `~/.claude/projects` (the link Task 3's setup makes),
and `~/.claude-console/.claude.json` now has onboarding complete and three
project entries for the `~/.cache/dog81-spike/` test dirs.

## Contradicts the spec: the Console org has no usable credit

The first Console turn failed with `Credit balance too low · Add funds:
https://platform.claude.com/settings/billing`. The login's org is "Team
Rocket", `billingType: prepaid`. The spec assumes a $100/month promo
credit there. Until the org has a balance, every switch to Console would
fail on its first turn and mark credit exhausted. This goes to John before
Task 2 (plan, Task 1). It also left item 8's 1M-context check and the live
429 text unestablished.

## Results by item

**1. `/exit` through `orca terminal send`.** From idle, with a `/goal`
active and its turn interrupted: Claude exits cleanly, exit status 0,
process gone about 1.1 s after the send, and it prints `Resume this
session with: claude --resume <id>`. Tested on Max and on Console. The
limit-banner state was not produced (stand-in per the spec).

**2. Resume and launch forms.**
- Orca launches the orchestrator by typing into a login `zsh -l`:
  `claude --plugin-dir <Orca agent-view plugin> --dangerously-skip-permissions --advisor claude-fable-5-1 <prompt>`.
  No session selector, so the wrapper must add `--session-id`. The
  `claude` it runs is the zsh function from
  `~/.agents/sandbox/claude-launch.zsh`.
- `--session-id <uuid>`: the pid file's `sessionId` is that uuid.
- `--resume <id>` with a positional message, on the other config dir
  (Max session resumed on Console through the `projects` symlink): the
  whole conversation is there, the pid file keeps the same `sessionId`
  (no fork), and the message is delivered as the first user turn.
- `/clear` inside the TUI changes the pid file's `sessionId` to a new
  uuid (new transcript). `/resume <id>` inside the TUI changes it back.
  The wrapper's pid-file poll is therefore required, as the plan says.

**3. First launch of a fresh `~/.claude-console`, in order:**
1. Onboarding: theme picker ("Let's get started. Choose the text style").
   Accepting it wrote `hasCompletedOnboarding: true` and
   `lastOnboardingVersion`. Seed both.
2. Trust dialog ("Accessing workspace: ... Quick safety check"). Its
   default selection is **No, exit**: a blind Enter exits with status 1.
3. "Allow external CLAUDE.md file imports?" for `~/.claude/RTK.md`,
   `~/.agents/MODELS.md`, `~/.agents/ORCHESTRATION.md`. Default **No,
   disable external imports**. It appears because Claude walks up from the
   cwd and loads `/Users/john/.claude/CLAUDE.md` as the `.claude/CLAUDE.md`
   of `/Users/john`, for any cwd under the home directory.
Per-project keys written: `hasTrustDialogAccepted`,
`hasClaudeMdExternalIncludesApproved`,
`hasClaudeMdExternalIncludesWarningShown`; on exit Claude also writes the
`last*` stats, `allowedTools`, `mcpServers`, `mcpContextUris`,
`enabledMcpjsonServers`, `disabledMcpjsonServers`.
Also shown on Console only, not prompts: a `▎ Use your existing Claude
subscription with Claude Code · /login to activate` line under the logo,
and on the first auto-mode turn an explanation paragraph in the
conversation.

**4. `/goal` across `/exit` and `--resume`.** It survives: the goal set
on Max was still active after `/exit` and `--resume` on Console, and its
next turn ran. That turn hit the billing error and Claude printed `Goal
cleared after an unrecoverable error (credit balance too low)`. So the
resume message need not restate the goal, but a billing failure clears it.

**5. `agentCmdOverrides.claude`** (from Orca's source, not changed live,
because it is an Orca setting that reaches John's own tabs). The value is
a program plus prefix arguments; it is rejected if it contains `$`,
backticks, newlines, an environment assignment or shell metacharacters,
and a leading `~/` is expanded. Orca resolves the program to an absolute
path. The source read shows only the program and prefix arguments being
resolved; that `agentDefaultArgs` and `agentDefaultEnv` are still applied
is likely but not verified. An absolute path
bypasses the zsh `claude` function, so the adapter must allocate
`CLAUDE_CODE_TMPDIR` itself, as the spec says. Orca sets
`ORCA_TERMINAL_HANDLE` (and `ORCA_PANE_KEY`, `ORCA_TAB_ID`) in the tab's
environment, so the wrapper sees it. Live confirmation belongs with John
at harness adoption (Task 6).

**6. Texts** (bundle, plus one live sighting).
- Out of credit, live and in the bundle: `⎿  Credit balance too low · Add
  funds: https://platform.claude.com/settings/billing` (from the API
  message `Your credit balance is too low to access the Anthropic API.
  Please go to Plans & Billing to upgrade or purchase credits.`).
- Console 429 (API-key orgs): `API Error: Request rejected (429) · <API
  error message>`, or `... · this may be a temporary capacity issue.` when
  the body has none. Subscription logins instead get `Server is
  temporarily limiting requests (not your usage limit)`. Not seen live.
- Overload: `Repeated 529 Overloaded errors`, and `API Error: ...` lines
  carrying `overloaded_error`, which the existing outage rows already
  match. Connection: `Connection error.`, `Request timed out.`

**7. Pid-file status.** Values come from Claude's map `running → busy`,
`requires_action → waiting` (with `waitingFor`: `permission prompt`,
`input needed` or `dialog open`), `idle → idle`. Seen live: `idle` on
Max and on Console, `busy` mid-turn. Console sessions write
`~/.claude-console/sessions/<pid>.json`. The pid file is removed before
the process exits: it was already gone when `kill -0` first failed, in
both config dirs and on SIGTERM.

**8. Model and permission mode on Console.** `--permission-mode auto`
works (`⏵⏵ auto mode on`). `--model 'claude-opus-5-5[1m]'` is accepted
at launch, but no request succeeded, so 1M context is **not
established**. User-level configuration under `~/.claude` does not apply
to a Console session: no statusline or HUD, effort fell to `medium`
instead of John's `high`, "1 skill available", no user hooks or plugins.
Role restrictions passed as flags (`--settings <file>`, `--tools`,
`--strict-mcp-config`, `--permission-mode`) still apply, but
`--setting-sources user` reads `~/.claude-console/settings.json`. Task 3's
link table decides which user files a Console session shares. Orca's
default `--advisor claude-fable-5-1` would run the Fable advisor on API
credit in a Console session; that is a Task 6 decision.

**9. Credential storage.** No credential file under `~/.claude-console`
(only `.claude.json` and `backups/`). Claude stores OAuth credentials in
the macOS Keychain under the service `Claude Code<suffix>-credentials-<h>`,
where `<h>` is the first 8 hex digits of SHA-256 of the
`CLAUDE_CONFIG_DIR` string: the wrapper must pass exactly
`/Users/john/.claude-console`, or Claude looks up a different item and
asks for a login. Sensitive but not secret: `.claude.json`
(`oauthAccount` with email, names and org uuid; `userID`;
`customApiKeyResponses`) and `backups/` (copies of it).

**10. Foreground proof.** `orca terminal list` has no pid fields;
`orca terminal create` returns the tab's `processId` (its `login`). On
the tty, the foreground process group (`tpgid`) is the job's group. With a
Node stub wrapper spawning Claude (`stdio: 'inherit'`, not detached),
Claude and its helpers share the wrapper's process group, and `tpgid`
equals the wrapper's pid. Proof for the send gate: the wrapper records
its tty and `ORCA_TERMINAL_HANDLE`; the controller checks that
`ps -o tpgid=` on the Claude pid equals the wrapper's pgid and that
Claude's pgid is the wrapper's.

**11. Options** (help text plus Claude's own internal list). Required
value: `--add-dir`, `--agent`, `--agents`, `--allowedTools` /
`--allowed-tools`, `--append-system-prompt`, `--autocompact`, `--betas`,
`--debug-file`, `--disallowedTools` / `--disallowed-tools`, `--effort`,
`--environment`, `--fallback-model`, `--file`, `--input-format`,
`--json-schema`, `--max-budget-usd`, `--mcp-config`, `--model`,
`-n` / `--name`, `--output-format`, `--permission-mode`,
`--permission-prompts`, `--plugin-dir`, `--plugin-url`,
`--remote-control-session-name-prefix`, `--session-id`,
`--setting-sources`, `--settings`, `--system-prompt`,
`--system-prompt-snapshot`, `--tools`; hidden but value-taking:
`--advisor` (in Orca's launch), `--append-system-prompt-file`,
`--system-prompt-file`, `--plugin-dir-no-mcp`, `--max-turns`,
`--thinking-display`, `--inherit-permission-mode`, `--managed-settings`,
`--prefill`, `-m`, and the rest of Claude's internal list. Variadic
(`<x...>`): `--add-dir`, `--allowedTools`, `--betas`,
`--disallowedTools`, `--file`, `--mcp-config`, `--tools`. Optional value:
`-r` / `--resume`, `-d` / `--debug`, `--cloud`, `--from-pr`,
`--prompt-suggestions`, `--remote-control`, `--teleport`,
`-w` / `--worktree`. Everything else is a plain flag
(`--dangerously-skip-permissions`, `--strict-mcp-config`, `--no-chrome`,
`-c` / `--continue`, `--fork-session`, `-p` / `--print`, ...). Claude's
parser is commander, which accepts `--opt=value`. An option the wrapper
does not know makes argv unparseable (pass-through), so `--advisor` must
be known or the orchestrator never switches.

**12. Closing the tab.** `orca terminal close` delivered **SIGTERM**, not
SIGHUP, to the stub wrapper; the wrapper forwarded it, Claude exited with
143 about 1.5 s later, and the wrapper, Claude and its helpers were all
gone within 3 s, pid file removed. A tab closed from Orca's UI was not
tested. The wrapper must treat SIGTERM like SIGHUP: stop, never relaunch,
never consume a request.

**13. Trust inheritance and config writes.**
- Accepting trust for a parent directory covers its subdirectories: a
  launch in `root/sub` after trusting `root` showed no trust dialog. The
  external-imports approval is **not** inherited: `root/sub` asked again
  and stored `hasTrustDialogAccepted: false`,
  `hasClaudeMdExternalIncludesApproved: false` for itself. So the
  parent-trust strategy alone is not enough; Task 3 needs the per-cwd
  sync (the plan's "It does not" branch).
- A running Claude rewrites `.claude.json`: at onboarding, at each dialog
  answer, and at exit (not seen while idle for about 70 s). It saves under
  a proper-lockfile lock: it `mkdir`s the **directory**
  `<config>/.claude.json.lock` (stale after about 10 s by mtime), re-reads
  the file under the lock and merges `projects` with what is on disk.
  The plan's `withFlock(<consoleDir>/.claude.json.lock)` would put a
  regular file at that path and break Claude's saves. Task 3 must take
  the same `mkdir` lock (same path, same stale rule), re-read inside it,
  write atomically, then remove the directory. Done that way, the residual
  race the plan sends to John is closed.

## Values for the build briefs

- Idle: `status === 'idle'`; `busy` and `waiting` are not idle (item 7).
- Billing: `Credit balance too low · Add funds:`; Console 429:
  `API Error: Request rejected (429)`; overload and connection: existing
  outage rows (item 6).
- Foreground: `tpgid(claudePid) === pgid(wrapperPid) === pgid(claudePid)`
  on the tty the wrapper recorded (item 10).
- Seed keys: global `hasCompletedOnboarding`, `lastOnboardingVersion`;
  per cwd `hasTrustDialogAccepted`, `hasClaudeMdExternalIncludesApproved`,
  `hasClaudeMdExternalIncludesWarningShown`; lock protocol in item 13.
- Links: `projects` → `~/.claude/projects` (done). Which user files
  (`settings.json`, `plugins/`, `skills/`, `agents/`, `commands/`) are
  shared is open for Task 3, with item 8 as the evidence. Do not link
  `CLAUDE.md`: for any cwd under `/Users/john` the parent walk already
  loads `~/.claude/CLAUDE.md` (item 3), so a link would load it twice.
- Options: item 11.
