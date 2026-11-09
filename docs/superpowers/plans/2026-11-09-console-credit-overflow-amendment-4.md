# Console credit overflow plan: amendment 4

Amends `docs/superpowers/plans/2026-11-08-console-credit-overflow.md` and
amendments 1-3. Where a rule below differs from any of them, this file
wins. Sources: DOG-83 and DOG-84 (follow-ups from Task 4's reviews), and
John's decision on DOG-84 of 2026-11-09.

## A14 (DOG-83): after `clear-credit`, only a later Claude launch can mark credit

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

A screen line carries no identity or time: a count or fingerprint of
billing lines cannot tell a repainted old error (`/resume`, a relaunch)
from a new failed turn, and an 18-line window drops old lines as new ones
arrive (round-1 review of this amendment). So the mark is scoped to the
Claude launch that showed it, which the controller does know:

- `clear-credit` sets `creditClearedAt = now` as well as nulling
  `creditExhaustedUntil`. `readMode` accepts `creditClearedAt` as an
  optional ISO time or null; a malformed value reads as null. (This
  replaces Task 3's "`clear-credit` nulls only `creditExhaustedUntil`".)
- A Console-mode registration's billing line marks credit (as today)
  only when `creditClearedAt` is null or the registration's `launchedAt`
  (set at each launch, so per generation) is later than
  `creditClearedAt`. A Claude launched before the clear never marks again.

Consequences, accepted by the orchestrator (neither charges money: an
out-of-credit request is refused, spike item 6; but a refused turn clears
an active `/goal`, spike item 4):
- **Missed mark:** after a clear, a session launched before it that fails
  again does not mark. Credit then still reads available, so the next
  Max-limited session switches to Console, and its first turn is refused
  and clears its goal, where with the mark it would have waited on Max
  with its goal intact. That refusal puts a billing line on a post-clear
  launch, which the next tick marks. Since `SWITCHES_TO_CONSOLE_PER_TICK`
  is 1, a miss costs about one extra session's failed turn and its goal.
  It needs credit to run out first in a pre-clear session, one that had
  already hit billing and is used again by hand (nothing resumes those:
  their `limit` and `credits` events stay suppressed).
- **False mark:** a Console launch after the clear whose resumed screen
  repaints an old billing line from that conversation marks once. Overflow
  then sends new launches to Max until the next `clear-credit`, which
  `overflow status` shows. Nothing is lost but overflow time.

Tests (Task 4's and Task 3's files): with no clear, a billing line marks,
as today. After `clear-credit`, a registration launched before the clear
showing the same line does not mark, on this tick or later; a
registration whose `launchedAt` is after the clear and shows a billing
line marks. `/clear` and `/resume` inside a pre-clear generation never
mark. `clear-credit` writes `creditClearedAt` and nulls
`creditExhaustedUntil` and changes no other field. A malformed
`creditClearedAt` reads as null without resetting the other mode fields.
Dry run leaves the mode file byte-identical.

## A15 (DOG-84): a session left on Console retries switching back, then alerts (John)

### The gap

A cancel or fail of any request adds `<handle>:<W>` to `noSwitch`, which
blocks switches in both directions for that wrapper. That is free when
the surviving session is on Max. It is not when the survivor is on
Console: a `to: max` request whose `/exit` sends were ignored or whose
relaunch fell back to Console, and also a `to: console` request whose
Console successor is running but was not confirmed within
`CONFIRM_BOUND_MS`. That session then runs on API credit for the
wrapper's lifetime, after the Max limit has reset, and the only trace is
`lastError` in `overflow status`.

### Rule (John chose: retry later, then alert)

New plan constants:

| Name | Value | Why |
|---|---|---|
| `SWITCH_BACK_RETRY_MS` | 30 min | wait after a counted failure before the next switch back to Max |
| `SWITCH_BACK_RETRIES` | 3 | counted failures after the first before the wrapper is pinned |

- **Surviving mode decides, not the request's direction.** When a cancel
  or fail outcome is written, the controller looks at W's current
  registration (the highest generation it holds). If W is dead or holds
  none, nothing new is recorded (pruning clears it). If that registration
  is in **Max** mode, the effects add `noSwitch` as today. If it is in
  **Console** mode, the outcome is a **counted failure**:
  - The mode file gains `switchBackRetry`: an object from `<handle>:<W>`
    to `{ failures, nextAt, stuckAt }` (`stuckAt` null until pinned).
    `readMode` accepts it as optional, as it does `evidence`; a malformed
    value reads as absent without resetting other fields. Entries are
    pruned with the registration, as `noSwitch` entries are, so a new W
    starts with no entry.
  - While `failures` after this one is at most `SWITCH_BACK_RETRIES`,
    the effects set the entry to that count with `nextAt = now +
    SWITCH_BACK_RETRY_MS` and add no `noSwitch`.
  - On the failure that takes `failures` past `SWITCH_BACK_RETRIES`, the
    effects add `noSwitch`, set `stuckAt = now`, and the adapter logs one
    `warn` line naming the handle and the count.
  - The entry is computed when the outcome is written and stored in it,
    so A3's replay at any step writes the same entry (no double count).
    Everything else in A3 (outcome first, `lastError`, restore, delete)
    is unchanged.
- **Planning:** a registration whose entry has `nextAt` in the future gets
  no `to: max` switch this tick (it holds without a log). At or after
  `nextAt`, the ordinary switch-back rule applies unchanged: Console mode,
  `switchBackDue`, idle, session agreement, no draft and every phase-5
  guard. A `to: console` switch is never planned for a handle with an
  entry.
- **Reset:** a confirmed `to: max` request deletes the entry. An A12
  supersede neither counts nor resets it (it needs the person's own
  `/clear` or `/resume`, and the next request may follow at once).
- **Alert:** `orca-watchdog overflow status` and `orca-watchdog doctor`
  each print one line per entry with `stuckAt` set whose registration is
  alive and in Console mode: `overflow: <handle> stuck on Console credit
  since <stuckAt> after <failures> failed switches to Max; exit Claude in
  that tab to restart it on Max`. Doctor's exit status does not change
  (it is not an install fault). `--dry-run` writes nothing.

Bound: per wrapper, at most `1 + SWITCH_BACK_RETRIES` consecutive counted
failures before it is pinned and alerted, each followed by at least
`SWITCH_BACK_RETRY_MS` before the next request, so at most 12 `/exit`
sends in such a series. Superseded requests (each needs the person's own
session change) and successful round trips are outside the series.

Tests (Task 4's files; `lib/management.mjs` tests for the alert):
- Each outcome row with a live Console survivor counts, asserted on the
  durable mode-file effects: `switch retries exhausted`, `generation
  mismatch`, `successor not registered` (`CONSUMED_BOUND_MS`), `successor
  session not confirmed` (`CONFIRM_BOUND_MS`, including a `to: console`
  request whose Console G+1 is alive), `fallback generation`, and an A2
  launch-reason fail. Each gives `failures: 1`, `nextAt` 30 min on, no
  `noSwitch`. The same rows with a Max survivor add `noSwitch` and no
  entry; `wrapper ownership lost` with W dead records nothing.
- The `to: console` confirm-timeout case then recovers (pid file agrees,
  idle, deadline passed): no switch before `nextAt`, a `to: max` request
  at `nextAt`.
- At `nextAt`, a busy session, a draft, a registration already on Max, or
  a replacement W (entry pruned, new W has none) gets no retry request.
- Four counted failures in a row: the fourth adds `noSwitch`, sets
  `stuckAt`, logs one `warn`; no fifth request is ever created.
- A confirmed retry deletes the entry. A supersede between retries leaves
  `failures` unchanged and allows the next request at once.
- A crash after each of A3 steps 1, 2 and 3 of a counted failure replays
  to the same entry.
- `status` and `doctor` print the stuck line only while the registration
  is alive and on Console; doctor's exit status is unchanged.
- Dry run leaves the mode file byte-identical.
