# Fork sync instructions (for Claude in CI)

You are maintaining a personal fork of T3 Code. The branch `fork/split-sidebar`
carries a few fork commits (subjects start with `fork:`) on top of upstream
`pingdotgg/t3code` `main`. The nightly job rebases those commits onto the latest
`upstream/main`. You are called when that rebase hit conflicts, or when the fork
checks fail after the rebase.

Read `FORK.md` first: it lists the fork features and where their code lives.

## Goal

End with a working tree where:

1. No rebase is in progress (`git status` is clean of conflicts and
   `.git/rebase-merge` / `.git/rebase-apply` do not exist).
2. `upstream/main` is an ancestor of `HEAD`, and every fork commit is still
   there (`git log --oneline upstream/main..HEAD` shows the `fork:` commits).
3. `make install`, `make typecheck-web`, `make lint-web` and `make test-fork`
   all pass.

## Rules

- Keep upstream's changes. Re-apply the fork's intent on top of the new
  upstream code; never revert or drop an upstream change to make a conflict go
  away, and never delete a fork feature.
- Fork code lives in `apps/web/src/fork/`. Upstream files only carry small
  hook-up edits (see FORK.md). Keep it that way: if upstream moved or rewrote a
  hooked spot, re-attach the hook at the new spot with the smallest edit.
- To resolve a conflicted rebase: fix each conflicted file, `git add` it, then
  `GIT_EDITOR=true git rebase --continue`. Repeat until the rebase finishes.
  If a conflict is in a file the fork does not need to touch any more, take the
  upstream version (`git checkout --theirs` is the fork side during a rebase,
  `--ours` is upstream; double-check before using either).
- If the checks fail after the rebase, fix the cause with the smallest change
  and commit it as `fork: adapt to upstream <short description>`.
- Do not push, do not create tags or releases, do not edit `.github/workflows/`
  except `fork-nightly.yml` if it is itself broken.
- Code comments in English.
- When done, print a short summary: which files conflicted, how each was
  resolved, and the result of each `make` target.
