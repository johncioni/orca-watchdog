# Console credit overflow plan: amendment 4

Amends `docs/superpowers/plans/2026-11-08-console-credit-overflow.md` and
amendments 1-3. Where a rule below differs from any of them, this file
wins. Sources: DOG-83 and DOG-84 (follow-ups from Task 4's reviews), and
John's decision on DOG-84 of 2026-11-09.

## A14 (DOG-83): a billing line marks credit only when it is new

### The gap

The plan marks `creditExhaustedUntil` whenever a Console-mode handle's
read shows `Credit balance too low · Add funds:` above the input box. A
session that hit that error stays on Console and stays idle (a credit mark
never triggers a switch-back, and its `limit`/`credits` events are
suppressed), so the line stays on screen. After `orca-watchdog overflow
clear-credit` (John added funds), the next tick reads the same old line
and sets the mark again, so clearing does nothing until every such line
scrolls out of the read window or the session switches back at the Max
reset.

### Rule

- The controller keeps, in the mode file, `billingSeen`: an object from
  `<handle>:<wrapperPid>:<generation>` to the number of billing lines in
  that handle's last successful read window (above the input box, as
  today).
- On each successful read of a Console-mode registration, with `n` billing
  lines: the handle marks credit (as today) only when `n` is greater than
  its stored count (a missing key counts as 0); then the stored count
  becomes `n`, whether it rose, fell or stayed. A failed or missing read
  changes nothing.
- Keys whose registration or generation is gone are pruned on the same
  tick, as `noSwitch` entries are.
- `clear-credit` clears only `creditExhaustedUntil`, as today, and leaves
  `billingSeen`, so lines already on screen at the clear never mark
  again. A new failed turn adds a line, raises `n`, and marks.
- `--dry-run` writes nothing, as for every mode change.

Residual, accepted: a relaunch is a new generation, so if a resumed
session's screen repaints an old billing line inside the read window, it
marks once. That needs a session that hit billing on Console, switched to
Max and later back to Console with the old error still in the last
screenful; `clear-credit` then clears it for good.

Tests (Task 4's files): a Console handle shows one billing line → marked;
`clear-credit`; the same read next tick → not marked; a second billing
line appears → marked. A read with two lines then one then two → marked
on the first and the last read only. A failed read between two identical
reads changes nothing. A key for a gone generation is pruned. Dry run
leaves the mode file byte-identical.

## A15 (DOG-84): a failed switch back to Max retries later, then alerts (John)

### The gap

A `to: max` request that ends in **cancel** (`switch retries exhausted`,
`generation mismatch`, `wrapper ownership lost`) or **fail** (any A2 or
confirm reason) adds `<handle>:<W>` to `noSwitch`, which blocks switches
in both directions for that wrapper. When the session is still on Console
(Claude ignored three `/exit` sends, or the relaunch fell back to
Console), it then runs on API credit for the wrapper's lifetime, after
the Max limit has reset, and the only trace is `lastError` in `overflow
status`.

### Rule (John chose: retry later, then alert)

New plan constants:

| Name | Value | Why |
|---|---|---|
| `SWITCH_BACK_RETRY_MS` | 30 min | wait after a failed switch back to Max before the next request |
| `SWITCH_BACK_RETRIES` | 3 | requests after the first; at most 4 × `MAX_SWITCH_ATTEMPTS` `/exit` sends per wrapper |

- The mode file gains `switchBackRetry`: an object from `<handle>:<W>` to
  `{ failures, nextAt, stuckAt }` (`stuckAt` null until the last failure).
  `readMode` accepts it as optional, as it does `evidence`; a malformed
  value reads as absent. Entries are pruned with the registration, as
  `noSwitch` entries are.
- A `to: max` cancel or fail no longer adds `noSwitch` while `failures`
  (after counting this one) is at most `SWITCH_BACK_RETRIES`. Instead its
  A3 effects set the entry to `failures + 1` and `nextAt = now +
  SWITCH_BACK_RETRY_MS`; everything else in A3 (outcome first, restore,
  delete, `lastError`) is unchanged. The values are computed when the
  outcome is written, so a replay writes the same entry.
- On the failure that makes `failures` exceed `SWITCH_BACK_RETRIES`, the
  effects add `noSwitch` as today, set `stuckAt = now`, and the adapter
  logs one `warn` line naming the handle and the failure count.
- Planning: a registration with an entry whose `nextAt` is in the future
  gets no `to: max` switch this tick (it holds, with no log). At or after
  `nextAt`, the ordinary switch-back rule applies unchanged (Console mode,
  `switchBackDue`, idle, no draft, every phase-5 guard).
- A `to: max` request that confirms deletes the entry. A12 supersede and
  a `to: console` outcome never touch it; `to: console` cancels and fails
  keep adding `noSwitch` as today (that session stays on Max, at no cost).
- Alert: `orca-watchdog overflow status` and `orca-watchdog doctor` each
  print one line per entry with `stuckAt` set whose registration is still
  alive and in Console mode: `overflow: <handle> stuck on Console credit
  since <stuckAt> after <failures> failed switches to Max; exit Claude in
  that tab to restart it on Max`. Doctor's exit status does not change
  (it is not an install fault). `--dry-run` writes nothing.

Bound: per wrapper, at most `1 + SWITCH_BACK_RETRIES` switch-back
requests, so at most 12 `/exit` sends, spaced at least
`SWITCH_BACK_RETRY_MS` apart between requests; then the existing
fail-closed `noSwitch` holds.

Tests (Task 4's files, `lib/management.mjs` tests for the alert): a
`to: max` request exhausts its sends → no `noSwitch`, entry `failures: 1`,
`nextAt` 30 min on; a tick before `nextAt` plans no switch; at `nextAt`
with an idle session a new `to: max` request is created. Four failures in
a row → the fourth adds `noSwitch`, sets `stuckAt`, logs one `warn`, and
no fifth request is ever created. A confirmed retry deletes the entry. A
crash after A3 step 1 of a counted failure replays to the same entry (no
double count). A `to: console` failure still adds `noSwitch` and no
entry. `status` and `doctor` print the stuck line only while the
registration is alive and on Console, and doctor's exit status is
unchanged. Dry run leaves the mode file byte-identical.
