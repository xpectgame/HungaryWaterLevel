#!/usr/bin/env bash
#
# Run the probe and push its output to the repository, so it can be read without
# anyone pasting a terminal into a chat window.
#
# The GitHub runner is the better route - see .github/workflows/probe.yml - but these
# services have refused datacentre IPs before, and from a Hungarian connection they
# answer. This is the fallback for exactly that case.
#
#   ./scripts/probe-save.sh --mavir
#   ./scripts/probe-save.sh --live
#
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="probe-output/$(date -u +%Y%m%dT%H%M%SZ)$(printf '%s' "${*:-all}" | tr -c 'a-zA-Z0-9' '-').txt"
mkdir -p probe-output

echo "running: npm run probe -- $*"
# The output is the deliverable, so a failing probe still gets recorded rather than
# leaving an empty file and a non-zero exit.
npm run probe -- "$@" 2>&1 | tee "$OUT" || true

cd ..
git add -f "HungaryWaterLevel/$OUT"
git commit -q -m "Probe output: ${*:-all}"
git push -q origin HEAD
echo
echo "pushed HungaryWaterLevel/$OUT"
