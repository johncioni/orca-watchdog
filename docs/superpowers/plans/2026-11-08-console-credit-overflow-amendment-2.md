# Console credit overflow plan: amendment 2

Amends `docs/superpowers/plans/2026-11-08-console-credit-overflow.md` and
amendment 1 (`2026-11-08-console-credit-overflow-amendment.md`, merged in
#122). Where a rule below differs from either, this file wins. The Task 3
round-2 fix brief quotes it, and Task 3's round-2 code review checks it.

Sources: Task 3's round-1 code review (finding 1 and its "A5 gap"
follow-up note), John's Max `~/.claude.json` as read on 2026-11-08, spike
item 3, and John's decision of 2026-11-08.

## A11 (Task 3): Console approves external imports for every synced project (John)

### Evidence

- Spike item 3: in a Console session, Claude walks up from the cwd and
  loads `/Users/john/.claude/CLAUDE.md` as the `.claude/CLAUDE.md` of
  `/Users/john`. Its `@` imports (`~/.claude/RTK.md`, `~/.agents/MODELS.md`,
  `~/.agents/ORCHESTRATION.md`) are then external imports, so the first
  launch per project shows "Allow external CLAUDE.md file imports?" with
  **No, disable external imports** preselected. Approval is per project
  and not inherited (spike, trust section).
- On Max the same file is the user memory file
  (`CLAUDE_CONFIG_DIR` unset), whose imports never ask. John's Max entries
  for every project he uses record `hasClaudeMdExternalIncludesApproved:
  false` (read 2026-11-08: `/Users/john/Projects/orca-limit-watchdog`,
  `orca-ops`, `codefm`, `codefm-website`,
  `/Users/john/orca/projects/GlamBook`, `/Users/john/flipguides`). Five
  record `hasClaudeMdExternalIncludesWarningShown: false`: the dialog never
  appeared there. `orca-ops` records it `true`: the dialog appeared on Max
  once and was not approved.
- None of those six projects imports anything from outside its repository
  in its root `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`
  (checked 2026-11-08 at each default branch: only
  `docs/agents-memory/*` and GlamBook's `AGENTS.md`). So on Console the
  approval loads the same instruction files a Max session there loads,
  orca-ops included.
- Copying them as A5 says would make every first Console launch either
  stop at the dialog (an unattended switch relaunch then waits for a
  person), or, once the warning is marked shown, run without the
  instruction files the Max session had.

### Rule

This replaces A5's sentence "and `hasClaudeMdExternalIncludesApproved`
and `hasClaudeMdExternalIncludesWarningShown` copied from the Max entry
for that exact key". Everything else in A5 stands: the lock protocol, the
project key (canonical repository root, else the cwd's real path), the
trust rule (`hasTrustDialogAccepted: true` when the Max file has it true
for the key or any ancestor key), and `unseeded` when the Max file has no
entry for the exact key or no trusted key at or above it.

- For a project that is not `unseeded`, `syncConsoleProject(cwd)` writes
  `hasClaudeMdExternalIncludesApproved: true` and
  `hasClaudeMdExternalIncludesWarningShown: true` in the Console entry for
  that key, whatever the Max entry holds for them, absent or `false`
  included.
- The sync never removes or sets to `false` either key in the Console
  file. It never writes either key to the Max file.
- A write happens only when a key differs (`wrote: false` when the
  Console entry already has all three values).
- The exact-entry requirement stays the bound on what gets approved: a
  directory John has never opened in a Max Claude session (no entry for
  its project key) is `unseeded` and launches on Max, even though
  `/Users/john` itself is trusted and every directory under it inherits
  that trust.

Consequence John accepted: on Console, the approval also covers any
external import a project's own `CLAUDE.md` files add later, which a Max
session would ask about (and, in orca-ops, would not load, since Max
records that dialog as answered without approval).

### Tests (Task 3, `console-config.test.mjs`)

- Max entry `{ hasTrustDialogAccepted: true,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false }`: the Console entry gets
  all three `true`, `{ ok: true, wrote: true }`.
- Max entry with trust only (both import keys absent): same result.
- Trust inherited from an ancestor key, exact entry present without trust:
  same result.
- Console entry that already holds all three `true`, Max entry with both
  import keys `false`: nothing is written (`wrote: false`, file bytes and
  mtime unchanged), and both keys stay `true`.
- No Max entry for the exact key, trusted ancestor present: `unseeded`,
  Console file unchanged.
- Each test asserts the Max file is byte-identical afterwards.

This supersedes Task 3 round-1 finding 1's fix direction ("copy a field
only when the Max entry has it"); the failure that finding describes (a
sync deleting a Console approval) cannot happen under this rule, and the
fourth test pins it.
