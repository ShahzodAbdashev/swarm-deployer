#!/usr/bin/env bash
# Safety snapshot of host containers (minus sdtest*). Diff before/after a test run.
set -euo pipefail
docker ps -a --format '{{.Names}} {{.Image}}' | grep -v '^sdtest' | sort >"${1:?usage: host_snapshot.sh <out>}"
