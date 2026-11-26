# Project memory

Durable, cross-agent memory for this repo: what stays true after a branch
merges. It is the tier above `HANDOFF.md` (live state, gitignored) and is
shared by every agent and every worktree. Rules live in
`~/.agents/AGENTS.md` under "Project memory"; this file restates them.

- `decisions.md`: decisions that still bind future work.
- `ruled-out.md`: approaches tried and abandoned, and why.

**Read both before the first edit** of any task. Add an entry in the same PR
as the work that taught it, and only when it will still matter in a month.

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

Keep each file under about 100 lines. When adding an entry, drop entries the
code now makes obvious.
