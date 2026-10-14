#!/usr/bin/env bash
# Builds the body of a fork nightly release. The app's update popover shows
# each line as a "What's changed" item (the last 8 per release) and stops at a
# "Full changelog" heading, so the order is: upstream changes, then fork
# changes and warnings last (always visible), then metadata below the cut.
#
# Usage: release-notes.sh <fork-repo> <upstream-repo> <old-upstream-base> <head-sha> <resolved-by-claude>
# Needs: full git history with the upstream remote fetched, GH_TOKEN, gh, jq.
set -euo pipefail

FORK_REPO="$1"
UPSTREAM_REPO="$2"
OLD_BASE="$3"
HEAD_SHA="$4"
RESOLVED_BY_CLAUDE="$5"

# Previous fork release: its publish time bounds which upstream notes are new,
# its tag tells which fork changes are new.
prev_tag="$(gh release list --repo "$FORK_REPO" --limit 1 --json tagName --jq '.[0].tagName // ""')"
prev_published=""
if [ -n "$prev_tag" ]; then
  prev_published="$(gh release view "$prev_tag" --repo "$FORK_REPO" --json publishedAt --jq .publishedAt)"
fi

# Upstream nightly releases published since then (newest first from gh; print oldest first).
upstream_tags="$(
  gh release list --repo "$UPSTREAM_REPO" --limit 60 --json tagName,publishedAt 2>/dev/null |
    jq -r --arg since "$prev_published" \
      '[.[] | select(.tagName | test("-nightly\\.")) | select($since == "" or .publishedAt > $since)] | reverse | .[].tagName' ||
    true
)"
if [ -z "$prev_published" ]; then
  # First release: only the newest upstream nightly, not the whole history.
  upstream_tags="$(printf '%s\n' "$upstream_tags" | tail -n 1)"
fi

upstream_items=""
while read -r tag; do
  [ -z "$tag" ] && continue
  body="$(gh release view "$tag" --repo "$UPSTREAM_REPO" --json body --jq .body 2>/dev/null || true)"
  # "* title by @user in https://github.com/o/r/pull/123" -> "title (#123)"
  items="$(printf '%s\n' "$body" | sed -nE 's/^\* (.+) by @[^ ]+ in https:\/\/github\.com\/[^ ]+\/pull\/([0-9]+).*$/\1 (#\2)/p')"
  upstream_items+="${items}"$'\n'
done <<<"$upstream_tags"
upstream_items="$(printf '%s' "$upstream_items" | awk 'NF && !seen[$0]++')"

# Fork changes: fork commit subjects now that were not in the previous release.
current_fork="$(git log --reverse --format=%s "upstream/main..$HEAD_SHA" | grep '^fork:' || true)"
previous_fork=""
if [ -n "$prev_tag" ] && git rev-parse -q --verify "refs/tags/$prev_tag" >/dev/null; then
  prev_base="$(git merge-base "$prev_tag" upstream/main)"
  previous_fork="$(git log --format=%s "$prev_base..$prev_tag" | grep '^fork:' || true)"
fi
fork_items="$(
  comm -23 <(printf '%s\n' "$current_fork" | sort -u) <(printf '%s\n' "$previous_fork" | sort -u) |
    grep -v '^$' | sed -E 's/^fork: /Fork: /' || true
)"

migrations="$(git diff --name-only --diff-filter=A "$OLD_BASE" upstream/main -- apps/server/src/persistence/Migrations | xargs -n1 basename 2>/dev/null | tr '\n' ' ' || true)"

{
  echo "## What's Changed"
  [ -n "$upstream_items" ] && printf '%s\n' "$upstream_items" | sed 's/^/* /'
  [ -n "$fork_items" ] && printf '%s\n' "$fork_items" | sed 's/^/* /'
  if [ -n "${migrations// /}" ]; then
    echo "* Warning: new upstream database migrations (${migrations% }); don't switch back to an older official build."
  fi
  if [ -z "$upstream_items" ] && [ -z "$fork_items" ]; then
    echo "* No user-facing changes since the previous build."
  fi
  echo
  echo "## Full changelog"
  echo
  echo "Built from \`$HEAD_SHA\` (upstream main + fork commits)."
  [ -n "$prev_tag" ] && echo "Previous fork release: \`$prev_tag\`."
  [ -n "$upstream_tags" ] && echo "Upstream nightlies included: $(printf '%s' "$upstream_tags" | tr '\n' ' ')"
  if [ "$RESOLVED_BY_CLAUDE" = "true" ]; then
    echo "Conflicts or broken checks were fixed by Claude in this run; see the workflow log."
  fi
}
