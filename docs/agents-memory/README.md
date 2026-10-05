# Project memory

Durable, cross-agent memory for this repo: what stays true after a branch
merges. It is the tier above `HANDOFF.md` (live state, gitignored) and is
shared by every harness and every worktree. Rules live in
`~/.agents/MODELS.md` under "Project memory"; this file restates them.

- `decisions.md`: decisions that still bind future work.
- `ruled-out.md`: approaches tried and abandoned, and why.

**Read both before the first edit** of any task. **Only the orchestrator
writes here**, in reviewed memory PRs. It captures each task's summaries
into the repo's memory queue and adjudicates ready tasks in batches: when a
plan's wave finishes, once three or more are ready, when the oldest has been
ready for 14 days, or sooner when one matters to work about to start. Tasks
with durable material go into one memory PR that touches only this
directory; a task with nothing durable is retired in the queue's
`retired.log` without a PR. Policy, sandbox and harness material goes to
orca-ops' `docs/policy-memory/` instead. The repo's
`.github/review-invariants.txt` must list this directory, so that PR never
skips review; the spec/plan reviewer reviews it at high. Task PRs carry no
memory edits. Implementers never edit this directory; they list durable
learnings under a "Memory candidates" heading in the deliverable summary
instead.

Entry format, newest first:

```
## 2026-09-21 Short title

Two to four lines: what was decided or ruled out, and why. PR #123.
```

Each entry records what a future agent would otherwise get wrong, and
why: a constraint, a rejected approach, a measured result. It does not
restate what the code or tests show beyond the name needed to find the
code. When a new entry supersedes an older one, the same PR edits or
deletes the older one, so no two entries disagree.

Keep each file under about 100 lines. When promoting, drop entries the code
now makes obvious. Nothing here requires a `HANDOFF.md` checkpoint.
