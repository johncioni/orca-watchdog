# Console credit overflow plan: amendment 4

Amends `docs/superpowers/plans/2026-11-08-console-credit-overflow.md` and
amendments 1-3. Where a rule below differs from any of them, this file
wins. Sources: DOG-83 and DOG-84 (follow-ups from Task 4's reviews), and
John's decisions on DOG-84 and DOG-83 of 2026-11-09.

## A14 (DOG-83): a session showing the billing error switches back to Max (John)

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

### Ruled out

A screen line carries no identity or time, so the controller cannot tell
an old billing line from a new one by counting or fingerprinting lines
(a `/resume` repaints history; the 18-line window drops old lines as new
ones arrive). Scoping marks to Claude launches after the last clear
(round 2 of this amendment) misses a session already running at the clear
that later exhausts the new credit, after which Max-limited sessions keep
switching to Console and a refused turn clears each one's `/goal` (spike
item 4). Both were dropped (round-1 and round-3 reviews).

### Rule (John chose: move errored sessions to Max)

- **Current billing line.** A billing line counts only while it is the
  newest output above the input box: a message-start marker (registry
  `chrome.outputStart`, `⏺` for Claude) below it makes it stale, as for
  limits (decisions.md, 2026-09-23). A stale billing line neither marks
  credit nor triggers a switch.
- **Mark, as today.** A current billing line on a Console-mode
  registration sets `creditExhaustedUntil` to the next 1st of the month
  00:00 UTC.
- **Switch back.** The same registration is also a `to: max` candidate on
  that tick, although `switchBackDue` is false. Every other switch-back
  condition and guard still applies: a valid registration with a read,
  no request, not in `noSwitch`, no A15 entry with `nextAt` in the future,
  session agreement, pid-file status idle, and every phase-5 guard
  (dry run, kill switch, `tui-idle` wait, fresh read, foreground re-check,
  shell prompt, draft). The phase-5 fresh read must still show a current
  billing line, or nothing is sent. The request is an ordinary `to: max`
  request: its outcomes follow the transition table, A3 and A15 (a
  failure while still on Console is a counted failure, retried every
  `SWITCH_BACK_RETRY_MS`, then pinned with the stuck alert).
- The relaunch is on Max with `MAX_MESSAGE`. Its first turn meets the Max
  limit, which the ordinary path resumes at the reset; the billing error
  already cleared any `/goal` (spike item 4).
- This replaces the plan's "a credit mark alone never triggers it" for
  sessions showing a current billing line. A mark still triggers nothing
  for a Console session not showing one: it is still working on the
  credit it has, and it switches when its own turn is refused or at the
  Max reset.
- `clear-credit` is unchanged: it nulls only `creditExhaustedUntil`.

Result: once the errored sessions have switched, no Console session shows
a current billing line, so a clear sticks. Until one has switched (a
draft, a busy status, a failed read, a pending retry, a pinned wrapper)
its current line keeps re-marking after a clear. That is visible in
`overflow status` (the session is listed on Console, and a pinned one has
A15's stuck line), and it stops when the session switches or the person
exits it.

Tests (Task 4's files): a Console registration with a current billing
line marks credit and gets a `to: max` request before the Max deadline;
the same with a `⏺` line below the billing line neither marks nor
switches. A busy status, a draft, `noSwitch`, an A15 entry with a future
`nextAt`, or a session disagreement gives the mark but no request. A
phase-5 fresh read without a current billing line sends nothing and
writes no request. A Console registration without a billing line is not
switched while credit is marked. After the switch confirms, the
registration is on Max, and the next tick's `clear-credit` stays cleared.
A failed billing switch-back still on Console gets an A15 entry. Dry run
writes nothing.

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
