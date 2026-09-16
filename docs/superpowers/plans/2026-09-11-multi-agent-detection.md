> **Status (2026-09-15):** approved 2026-09-11 (epic DOG-35). Phase 0 spike
> DOG-36 done for Gemini (Orca `agentIdentity="gemini"`; idle box uses `▄`/`▀`
> block borders + ` *   Type your message or @path/to/file` placeholder), Cursor
> identity `"cursor"` (chrome pending auth), opencode blocked on install. Phase 1
> DOG-37 merged as `933effc`. Copilot (P4) dropped for now. DOG-38 hardens the
> registry contract before Phase 2. **Deploy note:** the live daemon is installed
> via the Homebrew tap; deploy by cutting a release and `brew upgrade`, not by
> running `install.sh` (see DOG-32). Original planning file:
> `~/.claude/plans/ok-let-s-discuss-the-wild-emerson.md`.

# Plan: Extend the watchdog to all Orca-supported agent platforms

## Context

Today `orca-watchdog` only recognizes stalled/limited agent TUIs for **Claude
Code** and **Codex** (rate-limit banner → resume after reset; API-outage banner →
resume after a hold, gated on `status.claude.com`/`status.openai.com`). Orca runs
many more coding agents. **Goal:** extend the daemon to watch the broader set of
Orca-supported agents, without widening its blast radius or weakening its
"err toward not sending" posture. `watchdog.mjs` is an invariant file — a bug
here can spam `orca terminal send` into every live session.

**User decisions (2026-09-11) driving this plan:**
- **Scope = maximum:** provider-registry refactor + add **Gemini CLI** and
  **GitHub Copilot CLI** (both expose absolute reset times) + a **degraded mode**
  for provider-agnostic agents (opencode, Aider, Continue, Cursor).
- **Identity:** prefer Orca's `agentIdentity`; fall back to **TUI-content
  fingerprinting** where Orca doesn't tag an agent. Real values are unconfirmed →
  an empirical spike gates feasibility.
- **Signal:** **spike Orca's own status detection** (`agentWait`) first; consume
  it where reliable (more robust than parsing drifting TUIs), else parse the TUI.

**Verified against the code while planning** (so the phasing is safe): Gemini's
`3:00 PM PST` and Copilot's `November 5, 2026 at 9:00 AM` / `try again in N hours`
**already parse** with the existing `parseResetTime`/`parseClock`/`MONTH_DAY_RE`
(`watchdog.mjs:304-357`) — no parser change needed (Gemini only has a TZ-semantics
nuance). `OUTAGE_PATTERNS` (`:98-106`) is `{id, platforms, re}`, the one existing
per-provider table. `CHROME_RES` (`:109-119`) hardcodes Claude's `>` box and
Codex's `› Ask Codex to do anything`, so a new agent's idle box **fails the
final-block guard** unless its glyph is added per-provider — the real work is
chrome/glyphs + identity, not parsing.

## Open questions being researched (Phase 1)
1. Current detection architecture: exact patterns, where defined, how
   per-provider vs hardcoded, the natural seam for a new provider.
2. How the watchdog identifies which agent runs in a terminal ("Codex-identified
   terminals only") and whether Orca exposes agent type per terminal.
3. The exhaustive list of agents Orca supports.
4. Per-provider: rate-limit / outage wording (source-verified where possible),
   reset-time format, and official status page URL.

## Findings

### A. Current detection architecture (watchdog.mjs) — from Explore agent 1

**Core model.** `platform ∈ ['claude','codex','unknown']` (hardcoded, `:40`).
`kind ∈ limit | outage | limit-open` (`SCHEDULE`, `:31-39`). Single detection
entry `detectBanner` (`:165`). Pure-logic section is unit-tested; imperative
shell from `:499`.

**Agent identity is already provided by Orca.** `inferPlatform(terminal, banner)`
(`:227-233`) reads `terminal.agentIdentity` from `orca terminal list --json`
(`.terminals[].agentIdentity`), falling back to banner `patternId`. **This is the
key enabler** — Orca tags each terminal with an agent identity; adding providers
hinges on what values that field can take (agent 2 investigating).

**Rate-limit detection is asymmetric (not table-driven):**
- Claude/generic branch (`:184-204`): regexes `LIMIT_RE` (`:57`), `REACHED_RE`
  (`:58`), `RESET_RE` (`:59`), vetoes `VETO_RE`/`FOOTER_RE`. Needs a line matching
  LIMIT+REACHED, a RESET match, and trailing-chrome.
- Codex branch (`:154-182`): bespoke `CODEX_*` constants + 3 literal limit forms +
  multi-line block parser, gated `platform==='codex'`. No reset → `limit-open`.

**Outage detection = the one existing per-provider table.** `OUTAGE_PATTERNS`
array of `{id, platforms, re}` (`:98-106`): `claude-api-error` (`API Error: 5xx /
Connection error / overloaded_error`), `codex-api-error` (source-verified from
`codex-rs/protocol/src/error.rs`; 429 deliberately excluded as the rate-limit
path). Comment `:96-97`: "Outage banners are platform-owned TUI shapes; no generic
rule."

**Reset-time parsing** `parseResetTime` (`:322-357`): handles `in N days`, `in Nh
Nm`, `in N minutes`, clock `3pm/14:00` (`parseClock`), month+day (`MONTH_DAY_RE`).
`GRACE_PAST_MS=2h`. Does NOT parse ISO from banner text.

**Codex no-reset alert path** (`limit-open`): native macOS `osascript display
alert` with Continue / Wait 1h / Stop (`:561-589`), currently Codex-only by rule
(`validateEvent` `:262`).

**Status-page gating** `STATUS_URLS` (`:441-444`): claude/openai Statuspage
`/api/v2/status.json`; connectivity probe `captive.apple.com`. `fetchIndicator`
reads `status.indicator`; `major`/`critical` ⇒ hold, `null` ⇒ hold fail-closed.
**Only `outage` resumes are status-gated** — limit resumes are not.

**Send-safety per candidate** (`:801-879`): connectivity → outage-status →
`orca terminal wait --for tui-idle` (busy hold) → fresh re-read/re-detect →
`isShellPrompt` (agent exited) → `isInputOccupied` (draft hold) → send. Glyph
sets (`SHELL_PROMPT_RE`, `INPUT_DRAFT_RE`, `CHROME_RES`) bake in Claude `>` box and
Codex "Ask Codex to do anything".

**What a new provider must supply:** (a) identity signal (an `agentIdentity`
value or banner `patternId`); (b) limit detector + reset parser →
`{kind,resetAt,bannerText,patternId}`; (c) outage patterns gated by platform;
(d) a Statuspage-shaped status URL (or no gate for non-outage); (e) prompt/input
glyph conventions if different.

**Verdict / seam:** mostly hardcoded Claude/Codex branches + one small table.
Cleanest extension = generalize into a single **provider registry**: array of
`{ id, agentIdentity, limitForms[], outagePatterns[], statusUrl, resetParser,
promptGlyphs, inputDraftRe, supportsOpenAlert }`, and drive `detectBanner`,
`inferPlatform`, `STATUS_URLS`, `PLATFORMS`, and the `validateEvent` gates from it.
`OUTAGE_PATTERNS` is the template to widen; the Codex limit block is the main
bespoke piece to fold into a per-provider `limitForms`+`resetParser` entry.

### B. Orca supported agents + agent-type signal — from Explore agent 2

**"Supported" is open-ended, but integration comes in tiers** (onorca.dev/docs/agents/supported):
- **Deep integration** (usage tracking, hot-swap, hooks): **Claude Code, Codex**
  (+ Claude Agent Teams, off by default). These are the only first-class ones.
- **Auto-setup + status detection**: OpenCode, Pi, OMP, Prime Agent, Antigravity,
  Ante.
- **Auto-setup only**: Grok, GitHub Copilot CLI, Gemini, Aider, Goose, Amp,
  Kilocode, Kiro, Cursor CLI, GLM-5.2, … (site advertises "27 supported agents"
  + "any other CLI agent").
- Orca launches each with its full-autonomy flag pre-applied.

**Agent identity — THE pivotal constraint.** The only structured signal is
`orca terminal list --json → terminals[].agentIdentity`. **Confirmed live: it
returns `"claude"` for a Claude Code terminal and `null` for a plain shell. The
agent could NOT observe what (if anything) Orca emits for Gemini / Cursor /
OpenCode / etc.** — no such terminal was running, and probing by launching one is
prohibited in plan mode. There is **no `command`/launch-binary field**; `title`
is the OSC conversation title (unreliable for typing); `orca terminal read` does
not expose the agent. Orca docs: status indicators appear only for agents Orca
"recognizes" and that were launched via the agent combobox (not by typing the
binary).

**Consequence:** whether we can *reliably route* detection to a new provider
depends entirely on whether `agentIdentity` yields a distinct per-agent value for
that agent. If it does → clean registry keyed by `agentIdentity`. If it only ever
returns `claude`/`codex`/`null` → new providers must be identified by
**TUI-content fingerprinting** (matching agent-specific chrome), which is the
fragile path the current code deliberately avoids for everything but the banner
fallback. **⇒ This is an open question needing empirical confirmation (launch each
target agent once, read `agentIdentity`) and a user decision on how far to go.**

**Possible alternative mechanism worth weighing:** Orca itself does "status
detection" for a tier of agents, and `orca terminal show --json` exposes an
`agentWait` field. If Orca surfaces a machine-readable "this agent is
blocked/waiting/limited" state, the watchdog could lean on Orca's own detection
for the status-detection tier instead of re-implementing per-agent TUI regexes.
Needs verification of what that state actually contains.

### B-note. Empirical gap to close before/into implementation
`agentIdentity` values for non-Claude/Codex agents are unknown. Closing this
requires launching each candidate agent in a throwaway worktree and reading
`orca terminal list --json` — an action for implementation time, not plan mode.

### C. Per-provider error wording + status pages — from Explore agent 3

Source-verified against shipping source (open-source repos + the installed Claude
Code binary) and live status JSON (fetched 2026-09-11). Grouped by **fit with the
watchdog's model** (distinctive banner + absolute reset + deterministic status):

**Tier 1 — clean fit (absolute reset time + model-locked status page):**
| Agent | OSS | Limit wording (source-verified) | Reset format | Status JSON |
|---|---|---|---|---|
| Claude Code | ❌ | `Usage limit reached · continuing shortly`; `resets 3pm`; `until your limit resets at {time}` | absolute (`resets {d}`, epoch internally) | status.claude.com `/api/v2/status.json` |
| Codex | ✅ | `You’ve hit your usage limit… or try again at {time}.` (curly `’`) | absolute (`3:00 PM` / `Sep 12th, 2026 3:00 PM`) | status.openai.com `/api/v2/status.json` |
| **Gemini CLI** | ✅ | `Usage limit reached for {model}.` + `Access resets at {time}.` | absolute (`3:00 PM PST`, has TZ name) | Google Cloud `status.cloud.google.com/incidents.json` (**different schema** — incident array, filter by product) |
| **Copilot CLI** | ❌ | `You've reached your weekly rate limit… reset on {Month D, YYYY at H:MM AM}` | absolute (weekly) OR relative (`try again in N hours`) | githubstatus.com `/api/v2/status.json` |

**Tier 2 — detectable limit string but NO absolute reset (relative/backoff only):**
opencode (`Quota exceeded. Check your plan and billing details.`), Aider (`The API
provider has rate limited you…`), Continue (`Hit rate limit. Retrying in N
seconds`), Cursor (`…try again in a few moments`). All are **provider-agnostic**
(any underlying model provider) → no deterministic status page.

**Tier 3 — weak/no distinctive signal (flagged):** Charm Crush (passes through
provider text, retry only in slog), Cline (provider passthrough). Lowest
reliability.

**Status pages:** most are Atlassian Statuspage `/api/v2/status.json` with
`.status.indicator ∈ none|minor|major|critical` (Anthropic, OpenAI, GitHub,
Cursor, Amp). **Google Cloud is the exception** — `incidents.json`, a different
schema. Provider-agnostic agents have no single page.

**Gotchas:** Codex uses curly `’` (U+2019); Claude uses `·` (middot) + `—` (em
dash) — match on Unicode, not ASCII. Closed-source wording (Claude Code, Cursor,
Copilot, Amp) can drift silently → prefer status-JSON polling for outage-clear.

### D. Synthesis — the real design tension

"Orca supports 27 agents" overstates what's *watchable*. The watchdog's safety
model needs three things per provider: (1) a **distinctive TUI limit/outage
banner**, (2) an **absolute reset time**, (3) a **deterministic status page**.
Only **Claude Code, Codex, and Gemini CLI** satisfy all three (Copilot CLI nearly,
but closed-source + weekly-only + relative fallback). The long tail
(opencode/Aider/Continue/Cursor/Crush/Cline) are **provider-agnostic**: the agent
doesn't determine the model backend, so we can't know which status page applies,
and most give only relative backoff countdowns — not the absolute reset the
current design waits on.

Two constraints compound this:
- **Identity** (finding B): reliable routing needs `agentIdentity` per agent; only
  `claude`/`codex` are confirmed. Untagged agents need TUI-content fingerprinting.
- **Safety posture** (invariant `watchdog.mjs`): "only act when we *know* it's
  safe." Extending to Tier 2/3 means resuming without a known reset or verifiable
  status — a real relaxation of that guarantee.

⇒ The natural, safe extension is **Gemini CLI**, behind a **provider-registry
refactor** that makes future additions cheap. Everything beyond that trades
safety for breadth and is a user decision.

## Recommended approach

### Core idea: one declarative provider registry

Replace the scattered hardcoded Claude/Codex logic with a single frozen,
**ordered** `PROVIDERS` array (claude before codex to preserve `OUTAGE_PATTERNS`
order). Every entry is declarative and every scattered constant becomes a
derivation of it. Representative entry shape:

```
{ id, tier: 1|2,
  agentIdentity: [<Orca values>],          // spike fills; [] if untagged
  kinds: { limit, outage, limitOpen },      // capability flags → gate validateEvent
  limit: { rule: 'generic'|'codex', reNoReset?, tz? },
  outage: [{ id, re, alsoUnknown }],        // generalizes OUTAGE_PATTERNS
  fingerprint: [RegExp],                    // distinctive idle chrome, upgrades 'unknown' only
  chrome: { trailing: [RegExp], emptyBoxIsAgent },  // per-provider box glyphs
  status: { kind: 'statuspage'|'gcp-incidents'|'none', url?, product? } }
```

Derive from it: `PLATFORMS` (`:40`), `OUTAGE_PATTERNS` (`:98-106`, flatten with
`alsoUnknown`), `inferPlatform` (`:227-233`), `statusConfigFor` (was `STATUS_URLS`
`:441-444`), the `validateEvent` capability gates (`:257-262`), and the
final-block chrome / send-side glyph sets — **per-provider extensions apply only
when `platform===that id`, so claude/codex/unknown see today's exact base sets.**

**Non-negotiable parity gate:** for `platform ∈ {claude,codex,unknown}` every
derived structure must equal today's literal. Phase 1 ships a characterization
test feeding the existing Claude/Codex fixtures through the registry-driven code
and asserting identical output; the full existing `watchdog.test.mjs` must stay
green unchanged.

### Detection asymmetry stays

Codex keeps its bespoke multi-line `■` parser (`limit.rule:'codex'`, gated
`platform==='codex'` at `:167`); Claude + all new Tier-1 agents use the generic
`LIMIT_RE/REACHED_RE/RESET_RE` rule (`:184-204`). The registry carries the
discriminator rather than unifying them.

### Phasing (each phase touching watchdog.mjs / plist / CLAUDE.md = full review round)

- **Phase 0 — Spikes, no code** (§Identity + §Orca-native below). Launch each
  candidate agent in a throwaway Orca worktree, capture `agentIdentity`, idle
  chrome, and `agentWait`. Deliverable: a data table filling the registry blanks
  and the "consume Orca signal?" decision. *Gates feasibility; no invariant edit.*
- **Phase 1 — Registry refactor, ZERO behavior change** (invariant; riskiest for
  regressions). `PROVIDERS` with claude+codex only; derive everything; add
  characterization test.
- **Phase 2 — Status-adapter abstraction** (invariant). Add `fetchHealth`
  dispatcher + a Google Cloud `incidents.json` adapter; leave `fetchIndicator`
  (`:487-495`) untouched for the Statuspage path; route the `tick` outage gate
  (`:819-834`) through it, preserving fail-closed `null⇒hold`.
- **Phase 3 — Gemini CLI** (Tier-1, limit-only, `kinds.outage:false` since its
  high-demand line self-heals). Registry entry + chrome/fingerprint + GCP status;
  optional TZ hardening (below). Replace the *synthetic* Gemini test fixture
  (`watchdog.test.mjs:22-24,38-40`) with the real two-line format.
- **Phase 4 — Copilot CLI** (Tier-1). Registry entry; **no parser change**;
  githubstatus Statuspage; fixtures for both absolute-weekly and relative wording.
  Annotate closed-source wording as version-fragile.
- **Phase 5 — Tier-2 degraded mode** (invariant + plist; the safety-relaxation
  phase — review hardest). Opt-in, default OFF (below).
- **Phase 6 — Docs** (invariant `CLAUDE.md` + README + CHANGELOG/version bump).

### Degraded mode (Tier-2) — safety design

Provider-agnostic agents have no absolute reset and no deterministic status page,
so the daemon *cannot know* it is safe to auto-send. Therefore:
- **Opt-in, default OFF** via `WATCHDOG_TIER2=<comma-list>` injected through the
  launchd plist `EnvironmentVariables` (`lib/management.mjs` `renderPlist`
  `:200-206`). Unset ⇒ Tier-2 providers are not registered at all ⇒ **byte-for-byte
  unchanged behavior.**
- **Notify-only (Level A, default):** a Tier-2 limit string (`limit.reNoReset`,
  e.g. opencode `Quota exceeded…`, Aider `The API provider has rate limited
  you…`) → `resetAt:null` → `kind:'limit-open'`, reusing the existing consent
  alert (`spawnAlert:513`/`runAlert:561`). **No `orca terminal send` without a
  human clicking through.** `validateEvent` (`:262`) relaxes from "limit-open
  requires codex" to "requires `kinds.limitOpen`".
- **Guarded auto-send (Level B, second opt-in):** allowed only for a Tier-2 entry
  whose idle/draft glyphs were confirmed in the spike; otherwise "Continue" just
  dismisses. This keeps the "don't land text on a shell/draft" guarantee.
- **Self-recovering strings excluded:** Continue's `Retrying in N seconds` and
  Gemini's auto-fallback line are transient, not stalls — no rule, and never added
  to any trailing-chrome set.

### Reset parser + status specifics

- **Copilot:** no change; add regression tests pinning `Month D, YYYY at H:MM AM`
  and `try again in N hours`.
- **Gemini TZ:** clock parses as **local**; correct in the standard same-machine
  deployment. Optional hardening: detect a trailing TZ abbreviation, map a curated
  set (confirmed in spike) → IANA zone, recompute only when confidently different,
  **fall back to local on anything unrecognized** (never throw/guess). Anchor with
  a fixed-`TZ` child test like the DST regression (`watchdog.test.mjs:405-425`).
- **Google Cloud status:** `incidents.json` (array; filter open incidents by the
  Gemini/Vertex product string — confirm in spike). Fail to `null` (hold) on any
  parse ambiguity. Only exercised if a Gemini outage kind is ever added.

### Identity spike + fingerprint fallback

Priority in `inferPlatform`: **agentIdentity > outage-banner patternId >
fingerprint (upgrades `unknown` only, never overrides a tag) > unknown**
(steps 1–2 are today's behavior verbatim). Pass the tail `window` in (already
computed at `:715`). Providers left untagged with weak fingerprints stay
`unknown` = fail closed (no Tier-1 outage, no Tier-2 alert).

### Orca-native status spike

On a live agent terminal, `orca terminal show --terminal <h> --json` and grep for
`agentWait`/`status`/`state`; correlate working vs idle vs limited. **Consume
Orca's signal for a provider iff** it reliably means "stalled/limited," is
distinguishable from idle, and is available without blowing the read budget
(`READ_BUDGET_MS:48`). If so the entry gains `signal:'orca-agentWait'` and it
*supplements* (never replaces) TUI parsing and **never bypasses** the send-safety
chain (`:835-875`). Run before finalizing Copilot (drops its fragile regexes).

### Top risks (see Findings §D + Plan detail)
1. **Identity unknowns** — mitigated by the Phase-0 spike + fail-closed `unknown`.
2. **Tier-2 safety relaxation** — default OFF, notify-only, parity-when-unset.
3. **False-positive sends** — per-provider glyphs scoped to that platform; Tier-2
   never auto-sends by default.
4. **Closed-source wording drift (Copilot)** — prefer `agentWait`; regexes fail safe.
5. **Gemini TZ** — same-machine default correct; optional TZ-aware step, local fallback.
6. **State rollback** — a `platform:'gemini'` event is rejected by an older daemon
   (non-fatal reset); note in the release/rollback checklist.

### Critical files
- `watchdog.mjs` — registry, `detectBanner`, `inferPlatform`, status gate, glyph
  sets, `validateEvent` (the invariant core).
- `watchdog.test.mjs` — characterization + per-provider tests; replace synthetic
  Gemini fixture (`:22-24,:38-40`).
- `e2e/fake-tui.mjs` — Gemini/Copilot/Tier-2 modes with **real** box glyphs.
- `e2e/status-stub.mjs` — Google Cloud `incidents.json` mode alongside Statuspage.
- `lib/management.mjs` — plist `EnvironmentVariables` for `WATCHDOG_TIER2`.
- `README.md` / `CLAUDE.md` — supported-agent list, decision flow, opt-in flag.

## Verification

- **Per phase:** `bash scripts/orca-setup.sh` (node floor + syntax + `node
  --test`) green; Phase 1 additionally asserts the characterization test (registry
  output == pre-refactor literals for claude/codex/unknown) and the **entire
  existing `watchdog.test.mjs` passes unchanged**.
- **New detection:** unit tests per provider — `detectBanner` positive (real
  source-verified wording) + negatives (prose, near-miss, non-final block);
  `inferPlatform` via agentIdentity, via banner patternId, and via
  fingerprint-when-unknown; `validateEvent` accepts `limit-open` only for
  capable providers.
- **Status adapter:** GCP `fetchHealth` returns ok/impacted/null for
  open/closed/malformed incidents; outage gate holds fail-closed on `null`.
- **Tier-2 parity:** with `WATCHDOG_TIER2` unset, a Tier-2 tail yields **zero**
  events (byte-for-byte parity); with it set, yields a `limit-open` notify-only
  event and **never** a send.
- **End-to-end (never against live terminals):** `node watchdog.mjs --dry-run`
  plus `e2e/fake-tui.mjs` (new Gemini/Copilot/Tier-2 modes) and the extended
  `e2e/status-stub.mjs` (loopback via `WATCHDOG_STATUS_URL_<PLATFORM>`), per
  CLAUDE.md Safety.
- **Deploy (post-merge, orchestrator, from main checkout only):** since
  `watchdog.mjs` + the plist change, run `install.sh` from main and verify
  `orca-watchdog doctor` + a live tick, per CLAUDE.md.

## Suggested Linear structure
DOG-34 was the docs pass. This is a multi-phase epic — recommend a parent DOG
issue ("Multi-agent detection") with a child per phase (0–6), each its own Orca
child worktree + review round, Phase 0 (spike) first since it gates the rest.
