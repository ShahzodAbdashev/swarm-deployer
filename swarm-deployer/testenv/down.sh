#!/usr/bin/env bash
# Tear down the sdtest lab. Removes ONLY sdtest* resources (the registry, its secret and volume live inside the
# target's dind volume and go with it). --keep-files keeps generated files in $L.
set -euo pipefail
L="${SDTEST_DIR:-/tmp/claude-1000/-home-shahzod-mywork/9cc69e64-a217-469a-aadc-7f8a210ef0d3/scratchpad/deployer}"
step() { echo "==> $*"; }
step "stop FTP + FTPS + mock GitLab"
for n in ftp ftps gitlab; do
  if [ -f "$L/$n.pid" ]; then kill "$(cat "$L/$n.pid")" 2>/dev/null || true; rm -f "$L/$n.pid"; fi
done
step "containers"
docker rm -f sdtest-files sdtest-samba sdtest-target sdtest-node2 >/dev/null 2>&1 || true
step "volumes + network"
docker volume rm sdtest-target-docker sdtest-node2-docker >/dev/null 2>&1 || true
docker network rm sdtest-net >/dev/null 2>&1 || true
step "host images ^sdtest"
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^sdtest' | while read -r img; do
  case "$img" in sdtest*) docker rmi "$img" >/dev/null || true;; esac
done
if [ "${1:-}" != "--keep-files" ]; then
  step "generated files"
  rm -rf "$L/files" "$L/repos" "$L/sd-data" "$L/bp" "$L/lab.env" "$L/packages.json" "$L/gl-preload.tar"
  rm -f "$(cd "$(dirname "$0")" && pwd)/env.json"
fi
step "down"
