<!-- Linear issue id if any; delete this line otherwise -->

## What changed

<!-- One or two sentences. Why, not just what. -->

## Quality gate

- [ ] `node --test` passes locally; if `watchdog.mjs` / the plist changed, verified in isolation (`--dry-run` against `e2e/fake-tui.mjs`), never by re-installing from this branch

## Review evidence

<!-- Required by the review-evidence check. Fill in ONE of the two lines below
     truthfully and delete the other; the placeholders are rejected as written.
     A skip is accepted only when no path in .github/review-invariants.txt is
     touched and the diff is docs/test-only or <= 40 lines (see
     ~/.agents/MODELS.md).
     Reviewer is Opus for code reviews, Codex for spec/plan reviews and for
     code reviews of fallback-implementer (Opus) output.
     Rule is one of: docs-only | test-only | under-40-lines -->
Reviewed by <reviewer>, N rounds

Review skipped: <rule>
