# Console credit overflow plan: amendment 3

Amends `docs/superpowers/plans/2026-11-08-console-credit-overflow.md`,
amendment 1 (`2026-11-08-console-credit-overflow-amendment.md`, #122) and
amendment 2 (`2026-11-08-console-credit-overflow-amendment-2.md`, #124).
Where a rule below differs from any of them, this file wins. The Task 4
round-2 fix brief quotes it, and Task 4's round-2 code review checks it.

Source: Task 4's round-1 code review (Opus xhigh, reviewed commit
`6fd3524`), findings 1 and 2.

## A12 (Task 4): a pending request whose session changed is superseded

### The gap

The Request record has no row for a `pending` request whose session no
longer matches the handle's current session. That happens when the first
`/exit` does not take effect (the send fails, or Claude ignores it) and
the person then runs `/clear` or `/resume`, so the pid file and the
registration move from `S` to `S'`. Each later tick plans a resend
(`pending`, `sentAt` older than `RELAUNCH_WINDOW_MS`), and the session
check under the request lock holds it, correctly: an `/exit` now would
make the wrapper refuse the record (plan, "Session agreement": it prints
both IDs and exits non-zero). But a held resend writes nothing, so
`attempts` never grows and the request never reaches the cancel row.
While the wrapper lives, the request holds forever: `suppress: 'all'`
blocks every ordinary send for the handle, and a `to: max` switch-back
never happens, so the session stays on Console credit past the deadline.
That breaks the plan's "every branch ends within a stated bound".

### Rule

A new controller transition, evaluated after the "W dead, or another
wrapper owns the handle" row and before every other `pending` row (the
resend row and the deadline or credit cancel rows):

| Observed | Outcome |
|---|---|
| `pending` (either `to`), G registered, `sentAt` older than `RELAUNCH_WINDOW_MS`, and the registration's `sessionId` and the pid file's `sessionId` agree on a value other than the request's `sessionId` | **supersede** |

- Supersede follows A3 with `kind: 'supersede'`: write the outcome
  (`reason: 'session-changed'`), apply its effects (an informational
  `lastError` only), restore `eventSnapshot` and save state, delete the
  request. It adds no `noSwitch` entry and sends no `/exit`.
- Inside `RELAUNCH_WINDOW_MS` the existing hold row still applies.
- When the registration and the pid file disagree, or the pid file is
  missing, the request holds this tick (plan, "Session agreement": the
  wrapper catches up within `SESSION_POLL_MS`). A missing pid file with G
  still registered is not this row.
- The next tick plans from scratch. A switch-back that is still due
  (`switchBackDue`, an idle session) creates a new request naming `S'`; a
  switch to Console needs a fresh trigger, as for any handle.

Why supersede, not cancel: cancel adds `<handle>:<W>` to `noSwitch`,
which blocks switches in both directions for that wrapper. For a `to:
max` request that would leave the session on Console credit for the
wrapper's lifetime. A session change is the person's own action, not a
failure of the switch.

Bound: each supersede needs a `/clear` or `/resume` by the person after
a request was committed, and each new request carries its own
`MAX_SWITCH_ATTEMPTS`, so the row cannot repeat on its own.

Test: commit a `to: max` request for `s1`; the first `/exit` send fails;
the pid file and the registration then move to `s2`. On the first tick
past `RELAUNCH_WINDOW_MS`: no `/exit`, the request is gone, the snapshot
is restored, `noSwitch` has no entry for the wrapper, and `lastError`
names `session-changed`. With the switch-back still due and `s2` idle,
the following tick creates a request naming `s2` and sends `/exit` once.
A variant where the pid file says `s2` but the registration still says
`s1` holds (no supersede, no `/exit`) until they agree.

## A13 (Task 4): the `/exit` send under the request lock is time-bounded

### The gap

The controller holds the request lock through the `/exit` send, so a
separately exiting Claude cannot consume the new `pending` record before
the send (the round-1 review judged that hold sound). But Orca CLI calls
run with a 15 s exec timeout, and the wrapper waits for the same lock
with `FLOCK_TIMEOUT_S` (10 s) when Claude exits, about 1.1 s after the
`/exit` arrives (spike item 1). A send that is delivered but returns 10 s
or more later makes the wrapper's consume time out; Task 2's wrapper then
reports "overflow stopped", releases its registration and exits 1 with
Claude already gone, and the conversation is not resumed.

### Rule

A new plan constant:

| Name | Value | Why |
|---|---|---|
| `SWITCH_SEND_TIMEOUT_MS` | 5 000 | exec timeout of the `/exit` send while the request lock is held: the controller releases the lock within this of the send, well inside the wrapper's `FLOCK_TIMEOUT_S` wait after Claude's ~1.1 s exit |

- The `/exit` send in phase 5 runs with this exec timeout. Every other
  Orca call keeps its current timeout.
- A send that times out is a failed send: the `pending` record stays as
  written (`attempts` already counts it), nothing else is written, and
  the resend row handles it after `RELAUNCH_WINDOW_MS`. If Orca did
  deliver it, the wrapper consumes the record inside the window as
  usual.
- No other work that can block (a `terminal wait`, a `terminal read`, a
  `ps` call) runs between the request-lock write and the send. Work
  before the write keeps its own timeouts.

Test: the injected `orca` dep records that the `/exit` send, and only
that call, carries `SWITCH_SEND_TIMEOUT_MS`; a send that rejects as timed
out leaves the record `pending` with its counted attempt and the request
lock released (a forked process's `updateRequest` on the real Task 2 lock
then succeeds, coordinated by IPC barriers, never a real wait), and the
next tick past `RELAUNCH_WINDOW_MS` resends.
