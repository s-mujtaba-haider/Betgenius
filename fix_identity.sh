#!/usr/bin/env bash
# One-shot: make every commit show only "Mujtaba Haider <mujtabazaidi0512@gmail.com>"
# and remove the Claude co-author trailer, then publish the rewritten history.
#
# Backups already exist as local tags:
#   backup-before-identity-fix       -> 04bb54f  (round4/deep-optimisation tip)
#   backup-r3-before-identity-fix    -> 6cf3245  (round3/deep-optimisation tip)
#   backup-c60-before-identity-fix   -> 8a499a2  (checkpoint/c60-round2 tip)
# To undo everything:  git reset --hard backup-before-identity-fix   (per branch)
set -euo pipefail
cd "$(dirname "$0")"

export FILTER_BRANCH_SQUELCH_WARNING=1

echo "==> rewriting author identity and stripping co-author trailers"
git filter-branch -f \
  --env-filter '
    if [ "$GIT_AUTHOR_EMAIL" = "ghassenmans@gmail.com" ]; then
        GIT_AUTHOR_NAME="Mujtaba Haider"
        GIT_AUTHOR_EMAIL="mujtabazaidi0512@gmail.com"
        export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL
    fi
    if [ "$GIT_COMMITTER_EMAIL" = "ghassenmans@gmail.com" ]; then
        GIT_COMMITTER_NAME="Mujtaba Haider"
        GIT_COMMITTER_EMAIL="mujtabazaidi0512@gmail.com"
        export GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
    fi
  ' \
  --msg-filter 'grep -viE "^co-authored-by:.*(claude|anthropic)"' \
  -- main round4/deep-optimisation round3/deep-optimisation checkpoint/c60-round2

echo
echo "==> verifying: every commit should now be mujtabazaidi0512@gmail.com"
git log --format='%h | A: %an <%ae> | C: %cn <%ce>' main
echo
echo "==> any co-author trailers left? (nothing below = clean)"
git log --format='%b' main | grep -i "co-authored-by" || echo "   none"
echo
read -r -p "Force-push these four branches to origin? [y/N] " ok
[ "$ok" = "y" ] || { echo "stopped; nothing pushed."; exit 0; }

git push --force-with-lease origin main
git push --force-with-lease origin round4/deep-optimisation
git push --force-with-lease origin round3/deep-optimisation
git push --force-with-lease origin checkpoint/c60-round2

echo
echo "Done. GitHub's contributor list can take a few minutes to recompute."
echo "If 'claude' or 'ghassenmans' still show, they are cached on stale commits;"
echo "they disappear once the old objects are unreferenced."
