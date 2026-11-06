#!/usr/bin/env bash
# Whether a CI job's slow check can be skipped for this change: writes run=true or run=false to $GITHUB_OUTPUT.
#
# SKIP is an extended regular expression for the paths that cannot change what the check proves, and KEEP one for
# paths inside SKIP that still can (the job's own workflow file). The check is skipped only when every file the change
# touches matches SKIP and none matches KEEP. A list of what may be skipped, never of what must run, so a file in a new
# directory, a new gate script or a new config file runs the check without anyone updating a list.
#
# What "this change" is: on a pull request, the merge commit GitHub checks out against its first parent, the base
# branch's head, so the list is exactly what the pull request brings onto the base as it is now. On a push, the commit
# against its parent, only when the push is that one commit (a squash or a merge commit); a push of several commits
# runs. Renames count twice (--no-renames), so a file moved out of a checked directory counts as a change there. A
# schedule, a workflow_dispatch, or anything that fails to read runs the check. Needs a checkout with fetch-depth: 2.

set -euo pipefail
: "${SKIP:?SKIP must name the paths that may be skipped}" "${KEEP:?KEEP must name the paths inside SKIP that still run}"

run=true
base=""
parent=$(git rev-parse --verify --quiet HEAD^1 || true)
case "${GITHUB_EVENT_NAME:-}" in
  pull_request) base=$parent ;;
  push) if [ -n "$parent" ] && [ "$parent" = "${BEFORE:-}" ]; then base=$parent; fi ;;
esac

if [ -n "$base" ] && changed=$(git diff --name-only --no-renames "$base" HEAD); then
  relevant=$(printf '%s\n' "$changed" | awk 'length($0) && ($0 ~ ENVIRON["KEEP"] || $0 !~ ENVIRON["SKIP"])')
  if [ -z "$relevant" ]; then
    run=false
    echo "Every changed file is one this check cannot be affected by; skipping it:"
    printf '%s\n' "$changed" | sed 's/^/  /'
  else
    echo "Changed files this check covers:"
    printf '%s\n' "$relevant" | sed 's/^/  /'
  fi
else
  echo "No single base to compare with (${GITHUB_EVENT_NAME:-no event}); running the check."
fi

echo "run=$run" >> "$GITHUB_OUTPUT"
