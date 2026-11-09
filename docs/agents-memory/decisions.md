# Decisions

Newest first. Format and rules: `README.md` in this directory.

## 2026-11-09: A Console session stalled on billing moves to Max; failed moves retry, then alert (John)

A Console session whose newest output is Claude's own billing error marks credit and switches back to
Max before the reset, under every switch-back guard, so `clear-credit` sticks (DOG-83). A failed switch
that leaves the survivor on Console counts by surviving mode, retries every 30 min up to 3 times, then
pins with a stuck alert (DOG-84). The billing line is matched as drawn, anchored on its URL (A16).
PR: https://github.com/johncioni/orca-watchdog/pull/131, https://github.com/johncioni/orca-watchdog/pull/132, https://github.com/johncioni/orca-watchdog/pull/133

## 2026-11-09: Overflow supersedes a changed-session switch and bounds the locked `/exit`

A pending switch whose agreed session moved (a `/clear` or `/resume` after a failed `/exit`) is
superseded once the relaunch window passes, never cancelled: a session change is the person's own
action, and a cancel would count it as a failed switch (Console survivor) or block both directions. The `/exit` sent under the request
lock times out at 5 s, inside the wrapper's 10 s lock wait, or the wrapper gives up and drops to a shell.
PR: https://github.com/johncioni/orca-watchdog/pull/126, https://github.com/johncioni/orca-watchdog/pull/127

## 2026-11-08: Console `.claude.json` writes take our flock, then Claude's lock

Claude Code saves `.claude.json` under a `mkdir` lock (`<file>.lock`) it calls stale after 10 s, and
merges `projects` on save. This repo's writers serialize through a flock under the overflow state
directory, then take Claude's lock; never flock Claude's lock path or unlink a flock inode in use.
PR: https://github.com/johncioni/orca-watchdog/pull/123, https://github.com/johncioni/orca-watchdog/pull/125

## 2026-11-08: Console sync approves external imports; Console drops the advisor (John)

On Console, `~/.claude/CLAUDE.md` loads as a project file whose imports ask per project, default No,
so an unattended relaunch would stop or run without them: the sync approves them for every synced
project, even where Max declined (A11). Console turns the advisor on even without `--advisor`, so a
Console launch strips the flag and sets `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` (A7).
PR: https://github.com/johncioni/orca-watchdog/pull/124, https://github.com/johncioni/orca-watchdog/pull/122

## 2026-11-08: Claude chrome and side panels are found by structure, not content

Claude Code's footer changes with width, model and plugins, so the closed input box (rule, bare `❯`,
rule; the opening rule may carry one label, such as `ultracode`) marks where chrome starts, and limit
evidence comes only from above it. A side panel (Flightdeck) is cut by geometry before the detection
window: an aligned `│` run touching the box at chat column 40 or more. Any doubt leaves the read
whole, because review showed a cut chat-side box or tree makes an older banner look current.
PR: https://github.com/johncioni/orca-watchdog/pull/50, https://github.com/johncioni/orca-watchdog/pull/114

## 2026-10-31: Codex limit forms come from Codex's source; resets only from the retry clause

Codex picks its usage-limit sentence by plan and model limit, so check `UsageLimitReachedError` and
`RetryLimitReachedError` in `codex-rs/protocol/src/error.rs` at each new Codex tag, not just session logs:
a `■` line no form matches makes no event (0.155.1's `You’ve`, 0.166.0's Pro form). Resets come only
from the last `try again` clause, because a model-limit name is free text and once supplied a date.
PR: https://github.com/johncioni/orca-watchdog/pull/94, https://github.com/johncioni/orca-watchdog/pull/105, https://github.com/johncioni/orca-watchdog/pull/107

## 2026-10-23: Out-of-credits Claude sessions get blind resumes, never a purchase

Credits never reset and the allowance's reset time is not on screen, so a `credits` event
resumes blindly every 6 h for up to 7 days (at most 27 sends) and never sends `/usage-credits` or `/model`
(John's call). Detection anchors on the message's first sentence and its ending; John declined
a whole-message match (DOG-71) because a reword would then miss silently, as Codex drift does.
PR: https://github.com/johncioni/orca-watchdog/pull/99, https://linear.app/johncioni/issue/DOG-71

## 2026-10-23: Captures keep the raw terminal read

The daemon saves Orca's read behind each detection and send to `captures/` (newest 50, owner-only).
John accepted terminal contents and drafts on local disk because a replayable fixture is the point:
never sanitize, trim or drop `draft` without asking him. Names stay unique only while a handle gets
at most one `detected` and one `send` capture per tick.
PR: https://github.com/johncioni/orca-watchdog/pull/103

## 2026-10-23: The LaunchAgent keeps launchd's default process type

`ProcessType Background` throttled the daemon until concurrent `orca terminal read` calls hit the
15 s exec timeout: from 2026-09-24 to 2026-10-23, 1,034 reads failed, 700 of them logged as
timeouts (1.2.12 began naming the cause). Leave the key out, and measure read latency under load
before adding any launchd throttling key.
PR: https://github.com/johncioni/orca-watchdog/pull/91

## 2026-09-23: A limit's reset comes from its banner block; text identity gates the moved-later hold

The clock comes from the block of relevant lines ending at the last one, widening to the nearest earlier
reached line when that block has none (a blank or tip line can split a banner). Before the first send,
identical text skips the "reset moved later" hold, so a limit resumes once reads recover (John's call);
after a send, an identical absolute clock keeps the hold and identical relative text stays anchored. A
later reset honoured with new text re-baselines the text and `resetAnchorAt` (open gaps: ruled-out.md).
PR: https://github.com/johncioni/orca-watchdog/pull/56, https://github.com/johncioni/orca-watchdog/pull/58, https://github.com/johncioni/orca-watchdog/pull/66

## 2026-09-23: Output below a limit's reached line stales it or outranks it

A message-start marker (`chrome.outputStart`), outage payload or retry line below the reached line,
above the input box, stales the limit; prose does not (banners carry `Tip:` lines). `pick` keeps a limit
over an outage only if its reached line is at or below it: anchoring on the last relevant line let
`Service Unavailable` revive a stale limit. Runs on every platform: replay recorded screens on changes.
PR: https://github.com/johncioni/orca-watchdog/pull/60, https://github.com/johncioni/orca-watchdog/pull/62, https://github.com/johncioni/orca-watchdog/pull/64

## 2026-09-22: Orca list and read results are weak evidence of a closed terminal

Orca CLI outages return empty or partial terminal lists for hours. A tick
whose listing is missing, or empty with events stored, or whose reads all
fail is degraded (events frozen, one `warn`), and a missing handle is
removed only after 12 h of healthy misses. Every removal is logged.
PR: https://github.com/johncioni/orca-watchdog/pull/56
