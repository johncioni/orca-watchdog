# Project memory

Durable, cross-agent memory for this repo: what stays true after a branch
merges. It is the tier above `HANDOFF.md` (live state, gitignored) and is
shared by every harness and every worktree. Rules live in
`~/.agents/MODELS.md` under "Project memory"; this file restates them.

- `decisions.md`: decisions that still bind future work.
- `ruled-out.md`: approaches tried and abandoned, and why.

**Read both before the first edit** of any task. **Only the orchestrator
writes here**, once per task: after the review round passes and before the
merge, it promotes the task's decisions and ruled-out approaches as one
docs-only commit on the feature branch. Implementers never edit this
directory; they list durable learnings under a "Memory candidates" heading
in the deliverable summary instead.

Entry format, newest first:

```
## 2026-09-21 Short title

Two to four lines: what was decided or ruled out, and why. PR #123.
```

Keep each file under about 100 lines. When promoting, drop entries the code
now makes obvious. Nothing here requires a `HANDOFF.md` checkpoint.
