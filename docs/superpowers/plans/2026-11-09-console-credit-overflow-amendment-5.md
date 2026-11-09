# Console credit overflow plan: amendment 5

Amends `docs/superpowers/plans/2026-11-09-console-credit-overflow-amendment-4.md`
(#131), A14 only. Where a rule below differs from A14, this file wins. The
round-2 fix brief for the A14/A15 controller task quotes it, and that
task's round-2 code review checks it.

Source: the controller task's round-1 code review (Opus xhigh, reviewed
commit `b7f726a`), findings 1-4. A14's line-shape wording was the
orchestrator's, not part of John's choice ("move errored sessions to
Max"), which stands unchanged.

## A16: Claude's billing line as it is drawn

### The gap

A14 asked for `⎿` at column 0, a single line, and a bare goal-cleared
notice. Every real Claude capture in this repo draws `⎿` lines at column
2 (`  ⎿  You've hit your session limit …`), wraps them at pane width with
a hanging indent (`     (America/New_York)`), and prints goal notices
with a `⏺ ` marker (`⏺ Goal paused · …`), wrapping a long `⏺` line onto a
column-0 continuation. The sighted billing text with its URL is about 85
columns at Claude's indent, so in this machine's 55- and 80-column panes
the URL wraps. Built literally, A14 matches no real screen: it never
switches, and it also drops the credit mark 1.3.0 sets, so Max-limited
sessions keep switching to an empty Console account and each refused turn
clears that session's `/goal`.

### Rule

These replace A14's "Billing line shape" and "Current billing line"
bullets. Everything else in A14 stands.

- **Billing line.** After the side-panel cut and above the input box, a
  line whose text, with leading whitespace removed, starts with `⎿`,
  whitespace, then exactly `Credit balance too low · Add funds:`. Any
  indentation is allowed (Claude draws it at column 2).
- **Its continuation.** Up to 4 lines directly below it that start with
  whitespace (the registry's `claude-api-error` envelope
  `continuation`, `/^[ \t]+\S/`, `maxLines: 4`) belong to it: the wrapped
  URL, and any hint line Claude adds under the error, as the limit banner
  adds `/upgrade …`. A line starting with `⏺`, `⎿`, `❯` or `>` after its
  indentation ends the continuation.
- **Current.** The billing line is current when every line after its
  continuation, up to the input box, is blank, Claude registry
  `chrome.trailing`, or the goal-cleared notice. The notice is one line,
  or two consecutive lines, whose texts with surrounding whitespace
  removed, joined by one space, read `Goal cleared after an unrecoverable
  error (credit balance too low)`, optionally preceded on its first line
  by `⏺` or `⎿` and whitespace. Anything else after the continuation (a
  `⏺` answer, a submitted prompt, a Console 429, a retry line) makes the
  billing line stale.
- **Not shown is not cleared.** A14's billing-cleared supersede needs a
  read whose billing check ran: the registration was valid this tick
  (A9 foreground proof, live pid, listed once), the read succeeded, and
  the predicate found no current billing line. When the registration is
  not valid this tick, the request holds, as for a failed read.

The phrase quoted inside a `⏺` answer is still not a billing line (it
does not start with `⎿`). A tool result whose first line is exactly the
billing text, ending a turn with nothing but chrome below it, is drawn the
same way as the real error and counts: it marks credit and can make an
early, fully guarded switch to Max. That was possible in 1.3.0's mark too.
`overflow status` shows the mark and `clear-credit` clears it.

Task 6's live capture of a billing screen, with and without a `/goal`,
remains the authority on the exact shape. If it differs from this rule,
it comes back as a plan amendment before any code change.

Tests (the controller task's files; screens built from this repo's real
captures' indentation, wrap and markers):
- The billing line at column 2 with the URL on the same line; the same
  wrapped so the URL is on a 5-space continuation (55 and 80 columns);
  the same with an indented hint line under it. Each marks credit and,
  before the deadline on an idle valid registration, creates a `billing`
  request and sends one `/exit`.
- Each of those followed by `⏺ Goal cleared after an unrecoverable error
  (credit balance too low)` on one line, and by the same notice wrapped
  onto a column-0 second line: same result.
- Not billing, or stale, at observation, fresh read and resend: the
  phrase inside a `⏺` answer; the phrase after other text on a `⎿` line;
  a column-2 billing line followed by a `⏺` answer; by a submitted prompt
  and a column-2 Console 429; by a `⏺` line that is not the notice.
- A pending `billing` request past the window whose registration fails
  the foreground check this tick, with the billing screen still current:
  holds (no outcome, attempts unchanged); the next valid tick resends.
- 1.3.0 parity: every screen above that 1.3.0's substring rule marked
  and this rule calls current still marks.
