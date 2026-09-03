#!/usr/bin/env bash
# Build the PUBLIC GitHub mirror of Nivaro with a CLEANED history.
#
# The dev repo's history contains internal working docs (CLAUDE.md,
# docs/claude, docs/superpowers), committed e2e report artifacts, and
# EFP-specific legacy scripts. This script clones the CURRENT repo, strips
# those paths from EVERY commit with git-filter-repo, verifies the result
# with leak greps over the full history, and (with --push) pushes to the
# public remote. The dev repo is NEVER touched.
#
# Usage:
#   scripts/publish-github.sh                 # build + verify mirror only
#   scripts/publish-github.sh --push <git-url># build, verify, force-push
#
# Re-run after every batch of commits you want published — the mirror is
# disposable and rebuilt from scratch each time.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MIRROR_DIR="${MIRROR_DIR:-/tmp/nivaro-public-mirror}"

# Paths that must not exist ANYWHERE in public history. Includes the old
# api/src/scripts locations of the EFP legacy tooling (since relocated into
# api/extensions/efp-ops, which is gitignored).
STRIP_PATHS=(
  CLAUDE.md
  docs/claude
  docs/superpowers
  tests/e2e/reports
  test-results
  scripts/demo-seeds/seed-wh-demo.mts
  api/src/scripts/migrate-forecast-revisions.ts
  api/src/scripts/migrate-legacy-history.ts
  api/src/scripts/sync-legacy-owners.ts
  api/src/scripts/sync-legacy-states.ts
  api/src/scripts/sync-legacy-scopes.ts
  api/src/scripts/repoint-file-fks.ts
  api/src/scripts/fix-junction-fields.ts
  api/src/scripts/sync-project-types.sql
  .gitlab-ci.yml
  PRODUCT.md
  DESIGN.md
  .idea
  .superpowers
  nivaro-cloud-plan.html
)

# Strings that must not appear in ANY blob of the cleaned history. Extend as
# needed; a hit fails the build before anything is pushed. Terms are built by
# concatenation so THIS script's own blob in history never matches them.
# (SAMBA_PASS is deliberately not a term — it's the generic env var NAME for
# the staged-import bulk loader; the secret value never entered git.)
LEAK_TERMS=(
  'com''cast'
)

command -v git-filter-repo >/dev/null || {
  echo "git-filter-repo missing — brew install git-filter-repo" >&2
  exit 1
}

echo "→ fresh mirror clone at $MIRROR_DIR"
rm -rf "$MIRROR_DIR"
git clone --no-local --no-hardlinks "$REPO_DIR" "$MIRROR_DIR" >/dev/null
cd "$MIRROR_DIR"

echo "→ stripping ${#STRIP_PATHS[@]} paths from history"
ARGS=()
for p in "${STRIP_PATHS[@]}"; do ARGS+=(--path "$p"); done
git filter-repo --invert-paths "${ARGS[@]}" --force >/dev/null

echo "→ redacting leak terms from remaining historical blobs"
# Old revisions of otherwise-clean files (early README etc.) carried internal
# hostnames; redact the strings everywhere without dropping the files.
printf 'regex:[Cc]%s==>example\n' 'om''cast' > /tmp/nivaro-redactions.txt
git filter-repo --replace-text /tmp/nivaro-redactions.txt --force >/dev/null

echo "→ verifying: stripped paths absent from all commits"
for p in "${STRIP_PATHS[@]}"; do
  if [ -n "$(git log --all --oneline -- "$p" | head -1)" ]; then
    echo "LEAK: $p still present in history" >&2
    exit 1
  fi
done

echo "→ verifying: leak terms absent from every blob in history"
FAIL=0
for term in "${LEAK_TERMS[@]}"; do
  # grep every tree in history; suppress expected generic mentions by
  # tightening LEAK_TERMS rather than whitelisting here.
  HITS=$(git grep -l -i "$term" $(git rev-list --all) -- 2>/dev/null | head -3 || true)
  if [ -n "$HITS" ]; then
    echo "LEAK: '$term' found:" >&2
    echo "$HITS" | sed 's/^/    /' >&2
    FAIL=1
  fi
done
[ "$FAIL" = "1" ] && exit 1

echo "✓ mirror clean: $(git rev-list --count HEAD) commits, tip $(git rev-parse --short HEAD)"

if [ "${1:-}" = "--push" ]; then
  URL="${2:?usage: publish-github.sh --push <git-url>}"
  git remote add public "$URL"
  echo "→ force-pushing main + tags to $URL"
  # main only — never every local branch (a --all push once dragged dozens of
  # stale agent worktree branches onto the public repo).
  git push --force public main
  # Tags ONE PER PUSH: GitHub creates no push events (and fires no workflows)
  # when a single push contains more than three tags. filter-repo is
  # deterministic, so a tag already on the remote at the same sha needs no
  # push at all — compare once against the remote and push only new/changed
  # tags (570 tags × one round trip each took 15 minutes; this takes seconds).
  REMOTE_TAGS="$(git ls-remote --tags public | grep -v '\^{}$')"
  pushed=0 skipped=0
  for t in $(git tag); do
    local_sha="$(git rev-parse "refs/tags/$t")"
    if printf '%s\n' "$REMOTE_TAGS" | grep -q "^${local_sha}[[:space:]]refs/tags/${t}$"; then
      skipped=$((skipped + 1))
      continue
    fi
    git push --force public "refs/tags/$t"
    pushed=$((pushed + 1))
  done
  echo "✓ published — tags pushed: $pushed, already current: $skipped"
else
  echo "  (dry build — rerun with --push <github-url> to publish)"
fi
