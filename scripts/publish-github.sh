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
#   MOVE_TAGS=1 … --push <git-url>         also re-point tags the mirror has under another sha
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
  api/extensions/efp-ops
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
# Regexes (grep -E) checked over every blob alongside the literal terms.
LEAK_PATTERNS=(
  'sk_(live|test)_''[A-Za-z0-9]{16,}'
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
# Test fixtures shaped like provider keys trip GitHub push protection even
# when fake (a Stripe-shaped value in replay-context.test.ts, 2026-10-10).
# Built by concatenation so this script's own blob never matches.
printf 'regex:sk_(live|test)_[A-Za-z0-9]{16,}==>%s\n' 'key_''example_redacted' >> /tmp/nivaro-redactions.txt
git filter-repo --replace-text /tmp/nivaro-redactions.txt --force >/dev/null

echo "→ verifying: stripped paths absent from all commits"
for p in "${STRIP_PATHS[@]}"; do
  if [ -n "$(git log --all --oneline -- "$p" | head -1)" ]; then
    echo "LEAK: $p still present in history" >&2
    exit 1
  fi
done

echo "→ verifying: leak terms absent from every blob in history"
# One pass over each UNIQUE reachable blob. `git grep <every commit>` read the
# same files once per commit — 3441 trees took ~7 minutes per release; this
# reads ~17k blobs once in seconds. Binary blobs are scanned too (git grep
# matched them as well). git-filter-repo needs python3, so it is always here.
ARGS=()
for term in "${LEAK_TERMS[@]}"; do ARGS+=(-t "$term"); done
for pat in "${LEAK_PATTERNS[@]}"; do ARGS+=(-p "$pat"); done
python3 -I - "${ARGS[@]}" <<'PY'
import re, subprocess, sys, threading
checks = []
argv = sys.argv[1:]
for kind, value in zip(argv[0::2], argv[1::2]):
    raw = value.encode()
    rx = re.compile(re.escape(raw), re.I) if kind == '-t' else re.compile(raw)
    checks.append((value, rx))
objects = subprocess.run(['git', 'rev-list', '--all', '--objects'], capture_output=True, check=True).stdout
listing = subprocess.run(['git', 'cat-file', '--batch-check=%(objecttype) %(objectname) %(rest)'],
                         input=objects, capture_output=True, check=True).stdout
blobs = []
for line in listing.splitlines():
    kind, rest = line.split(b' ', 1)
    if kind == b'blob':
        sha, _, path = rest.partition(b' ')
        blobs.append((sha, path))
cat = subprocess.Popen(['git', 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
def feed():
    cat.stdin.write(b''.join(sha + b'\n' for sha, _ in blobs))
    cat.stdin.close()
threading.Thread(target=feed, daemon=True).start()
hits = {name: [] for name, _ in checks}
for sha, path in blobs:
    size = int(cat.stdout.readline().split()[2])
    data = cat.stdout.read(size)
    cat.stdout.read(1)
    for name, rx in checks:
        if len(hits[name]) < 3 and rx.search(data):
            hits[name].append(path.decode(errors='replace'))
if cat.wait() != 0:
    sys.exit('git cat-file failed')
failed = False
for name, found in hits.items():
    if found:
        failed = True
        print(f"LEAK: '{name}' found:", file=sys.stderr)
        for f in found:
            print(f'    {f}', file=sys.stderr)
sys.exit(1 if failed else 0)
PY

echo "✓ mirror clean: $(git rev-list --count HEAD) commits, tip $(git rev-parse --short HEAD)"

if [ "${1:-}" = "--push" ]; then
  URL="${2:?usage: publish-github.sh --push <git-url>}"
  git remote add public "$URL"
  # No background `gc --auto` while the tags go out: it repacks refs, and a
  # push that has to re-read a ref mid-repack dies ("refs/tags/@react-0.1.103
  # cannot be resolved to branch", 2026-10-19). The mirror is disposable.
  git config gc.auto 0
  echo "→ force-pushing main + tags to $URL"
  # main only — never every local branch (a --all push once dragged dozens of
  # stale agent worktree branches onto the public repo).
  git push --force public refs/heads/main:refs/heads/main
  # Tags ONE PER PUSH: GitHub creates no push events (and fires no workflows)
  # when a single push contains more than three tags. filter-repo is
  # deterministic, so a tag already on the remote at the same sha needs no
  # push at all — compare once against the remote and push only new/changed
  # tags (570 tags × one round trip each took 15 minutes; this takes seconds).
  # `|| true`: a remote with no tags yet (a first publish) makes grep exit 1,
  # which pipefail would turn into the end of the script.
  # One set difference, not a fork-per-tag compare (1225 tags took ~55 s
  # even when none needed pushing). An empty remote (a first publish) means
  # every tag: an empty pattern file would match — and hide — everything.
  REMOTE_TAGS="$(git ls-remote --tags public | grep -v '\^{}$' || true)"
  LOCAL_TAGS="$(git for-each-ref --format='%(objectname)%09%(refname)' refs/tags)"
  if [ -n "$REMOTE_TAGS" ]; then
    TO_PUSH="$(printf '%s\n' "$LOCAL_TAGS" | grep -vxF -f <(printf '%s\n' "$REMOTE_TAGS") | cut -f2 || true)"
  else
    TO_PUSH="$(printf '%s\n' "$LOCAL_TAGS" | cut -f2)"
  fi
  # A tag the mirror already has under another sha MOVED: the strip list or a
  # leak rewrite changed history (2026-10-21: the efp-ops strip of 10-15 moved
  # 115 old tags, and re-pushing them fired 80+ publish/image workflows that
  # rebuilt old releases and starved the new one). Old releases are already
  # built and published, so moved tags stay where they are unless --move-tags.
  REMOTE_NAMES="$(printf '%s\n' "$REMOTE_TAGS" | cut -f2)"
  if [ "${MOVE_TAGS:-0}" != 1 ] && [ -n "$REMOTE_TAGS" ]; then
    MOVED="$(printf '%s\n' "$TO_PUSH" | grep -xF -f <(printf '%s\n' "$REMOTE_NAMES") || true)"
    if [ -n "$MOVED" ]; then
      echo "⚠ $(printf '%s\n' "$MOVED" | grep -c .) tag(s) moved (history rewritten) — NOT re-pushed, so no old release rebuilds: $(printf '%s\n' "$MOVED" | sed 's|refs/tags/||' | head -5 | xargs)…" >&2
      echo "  (MOVE_TAGS=1 re-points them and fires a workflow for each)" >&2
      TO_PUSH="$(printf '%s\n' "$TO_PUSH" | grep -vxF -f <(printf '%s\n' "$MOVED") || true)"
    fi
  fi
  total=$(printf '%s\n' "$LOCAL_TAGS" | grep -c . || true)
  pushed=0
  failed=()
  for ref in $TO_PUSH; do
    t="${ref#refs/tags/}"
    # Explicit src:dst — without a destination git re-reads the source ref to
    # name one, which is what died above. One failed tag no longer abandons
    # every tag after it: retry once, then record it and go on.
    if git push --force public "$ref:$ref" ||
      { sleep 2 && git push --force public "$ref:$ref"; }; then
      pushed=$((pushed + 1))
    else
      failed+=("$t")
    fi
  done
  skipped=$((total - pushed - ${#failed[@]}))
  echo "✓ published — tags pushed: $pushed, already current: $skipped"
  if [ "${#failed[@]}" -gt 0 ]; then
    echo "✗ ${#failed[@]} tag(s) failed to push: ${failed[*]} — rerun to retry them" >&2
    exit 1
  fi
else
  echo "  (dry build — rerun with --push <github-url> to publish)"
fi
