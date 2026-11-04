#!/usr/bin/env bash
# Bring up the sdtest lab (file servers incl. SMB, dind swarm target + registry, mock GitLab). Idempotent. See TESTENV.md.
# Run it as: flock -o "$L/lab.lock" testenv/up.sh [--node2]   (-o: the daemons it starts must not inherit the lock)
# Safety: every swarm command runs inside sdtest-* containers via "docker exec", never on the host daemon.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
L="${SDTEST_DIR:-/tmp/claude-1000/-home-shahzod-mywork/9cc69e64-a217-469a-aadc-7f8a210ef0d3/scratchpad/deployer}"
step() { echo "==> $*"; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]; }
exists() { docker inspect "$1" >/dev/null 2>&1; }

FILES_USER=files FILES_PASS=sdtest-files-pass DEPLOY_USER=deploy DEPLOY_PASS=sdtest-deploy-pass ZIP_PASS=sdtest-zip-pass
REG_USER=sdtest-reg REG_PASS=sdtest-reg-pass GITLAB_USER=sdtest-dev GITLAB_PAT=glpat-sdtest-dev-0001
GITLAB_VIEWER_PAT=glpat-sdtest-viewer-0002 GITLAB_CLIENT_ID=sdtest-oauth-client GITLAB_CLIENT_SECRET=sdtest-oauth-secret
# previous run's ports (kept while their containers live)
[ -f "$L/lab.env" ] && . "$L/lab.env"
NODE2=0; [ "${1:-}" = "--node2" ] && NODE2=1

# ---- ports: keep the existing container's, else default if free, else next free one
TAKEN=" "
busy() { case "$TAKEN" in *" $1 "*) return 0;; esac; ss -ltnH "sport = :$1" | grep -q .; }
pick() { local p="$1"; while busy "$p"; do p=$((p+1)); done; TAKEN="$TAKEN$p "; echo "$p"; }
pick_range() { local p="$1" i ok; while :; do ok=1; for i in $(seq 0 9); do busy $((p+i)) && { ok=0; break; }; done
  [ "$ok" = 1 ] && break; p=$((p+10)); done; for i in $(seq 0 9); do TAKEN="$TAKEN$((p+i)) "; done; echo "$p"; }
# from the config, not `docker port`: that fails on a stopped container (after a host reboot)
hostport() { docker inspect -f "{{(index (index .HostConfig.PortBindings \"$2/tcp\") 0).HostPort}}" "$1"; }

step "ports"
if exists sdtest-files; then SFTP_PORT="$(hostport sdtest-files 22)"; TAKEN="$TAKEN$SFTP_PORT "; else SFTP_PORT="$(pick 2222)"; fi
if exists sdtest-target; then
  TARGET_SSH_PORT="$(hostport sdtest-target 22)"; WEB1_PORT="$(hostport sdtest-target 8081)"
  WEB2_PORT="$(hostport sdtest-target 8082)"; SPARE_PORT="$(hostport sdtest-target 8083)"
  TAKEN="$TAKEN$TARGET_SSH_PORT $WEB1_PORT $WEB2_PORT $SPARE_PORT "
else
  TARGET_SSH_PORT="$(pick 2223)"; WEB1_PORT="$(pick 18081)"; WEB2_PORT="$(pick 18082)"; SPARE_PORT="$(pick 18083)"
fi
if exists sdtest-node2; then NODE2_SSH_PORT="$(hostport sdtest-node2 22)"; TAKEN="$TAKEN$NODE2_SSH_PORT "; else NODE2_SSH_PORT="$(pick 2224)"; fi
alive() { [ -f "$L/$1.pid" ] && kill -0 "$(cat "$L/$1.pid")" 2>/dev/null; }
reserve_range() { local i; for i in $(seq 0 9); do TAKEN="$TAKEN$(($1+i)) "; done; }
FTP_ALIVE=0; FTPS_ALIVE=0
if alive ftp; then FTP_ALIVE=1; TAKEN="$TAKEN${FTP_PORT:-} "; reserve_range "${FTP_PASV:-30000}"
else FTP_PORT="$(pick 2121)"; FTP_PASV="$(pick_range 30000)"; fi
if alive ftps && [ -n "${FTPS_PORT:-}" ]; then FTPS_ALIVE=1; TAKEN="$TAKEN$FTPS_PORT "; reserve_range "$FTPS_PASV"
else FTPS_PORT="$(pick 2990)"; FTPS_PASV="$(pick_range 30010)"; fi
if exists sdtest-samba; then SMB_PORT="$(hostport sdtest-samba 445)"; TAKEN="$TAKEN$SMB_PORT "; else SMB_PORT="$(pick 1445)"; fi
if alive gitlab && [ -n "${GITLAB_PORT:-}" ]; then GITLAB_ALIVE=1; TAKEN="$TAKEN$GITLAB_PORT "
else GITLAB_ALIVE=0; GITLAB_PORT="$(pick 18929)"; fi
BP_PORT="$(pick 18090)"; SD_PORT="${SD_PORT:-8095}"
echo "sftp=$SFTP_PORT ssh=$TARGET_SSH_PORT node2=$NODE2_SSH_PORT web1=$WEB1_PORT web2=$WEB2_PORT spare=$SPARE_PORT ftp=$FTP_PORT pasv=$FTP_PASV-$((FTP_PASV+9)) ftps=$FTPS_PORT pasv=$FTPS_PASV-$((FTPS_PASV+9)) smb=$SMB_PORT gitlab=$GITLAB_PORT"

step "dirs + ssh key in $L"
mkdir -p "$L/keys" "$L/files/releases" "$L/repos" "$L/sd-data" "$L/shots"
[ -f "$L/keys/sdtest_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C sdtest -f "$L/keys/sdtest_ed25519"
chmod 600 "$L/keys/sdtest_ed25519"
[ -f "$L/keys/ftps.pem" ] || openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=sdtest-ftps \
  -keyout "$L/keys/ftps.pem" -out "$L/keys/ftps.pem" 2>/dev/null   # self-signed: cert + key in one file
chmod 600 "$L/keys/ftps.pem"

step "scratch venv (pyftpdlib pyopenssl pyzipper paramiko smbprotocol)"
[ -x "$L/venv/bin/python" ] || python3 -m venv "$L/venv"
"$L/venv/bin/python" -c 'import pyftpdlib, OpenSSL, pyzipper, paramiko, smbclient' 2>/dev/null ||
  "$L/venv/bin/pip" install -q pyftpdlib pyopenssl pyzipper paramiko smbprotocol

step "network sdtest-net"
docker network inspect sdtest-net >/dev/null 2>&1 || docker network create sdtest-net >/dev/null

step "image sdtest-target-img"
docker build -q -t sdtest-target-img "$HERE/target" >/dev/null

step "file server sdtest-files"
if ! running sdtest-files; then
  docker rm -f sdtest-files >/dev/null 2>&1 || true
  docker run -d --name sdtest-files -p "127.0.0.1:$SFTP_PORT:22" \
    -v "$L/files/releases:/home/$FILES_USER/releases" \
    atmoz/sftp:latest "$FILES_USER:$FILES_PASS:$(id -u)" >/dev/null
fi

step "SMB file server sdtest-samba (share releases = the same $L/files/releases)"
if ! running sdtest-samba; then
  docker rm -f sdtest-samba >/dev/null 2>&1 || true
  # -r: no recycle bin; USERID/GROUPID remap the image's forced smbuser/smb to the host uid/gid (no -p chown)
  docker run -d --name sdtest-samba -p "127.0.0.1:$SMB_PORT:445" -v "$L/files/releases:/releases" \
    -e USERID="$(id -u)" -e GROUPID="$(id -g)" \
    dperson/samba:latest -r -u "$FILES_USER;$FILES_PASS" \
    -s "releases;/releases;yes;no;no;$FILES_USER" >/dev/null
fi
for i in $(seq 1 30); do   # docker-proxy binds the port before smbd is up: wait for a real SMB listing
  "$L/venv/bin/python" -c 'import sys, smbclient; smbclient.listdir(r"\\127.0.0.1\releases", port=int(sys.argv[1]), username=sys.argv[2], password=sys.argv[3])' \
    "$SMB_PORT" "$FILES_USER" "$FILES_PASS" >/dev/null 2>&1 && break
  [ "$i" = 30 ] && { echo "SMB server did not answer on $SMB_PORT, see: docker logs sdtest-samba" >&2; exit 1; }
  sleep 1
done

run_node() { # name sshport [extra -p args...]
  local name="$1" port="$2"; shift 2
  running "$name" && return 0
  if exists "$name"; then docker start "$name" >/dev/null; return 0; fi
  docker run -d --name "$name" --hostname "$name" --privileged --network sdtest-net \
    -v "$name-docker:/var/lib/docker" -v "$L/keys:/keys:ro" \
    -p "127.0.0.1:$port:22" "$@" sdtest-target-img >/dev/null
}
step "target sdtest-target"
run_node sdtest-target "$TARGET_SSH_PORT" -p "127.0.0.1:$WEB1_PORT:8081" -p "127.0.0.1:$WEB2_PORT:8082" -p "127.0.0.1:$SPARE_PORT:8083"
[ "$NODE2" = 1 ] && { step "node2 sdtest-node2"; run_node sdtest-node2 "$NODE2_SSH_PORT"; }

wait_node() { # name port
  local i
  for i in $(seq 1 60); do docker exec "$1" docker info >/dev/null 2>&1 && break; sleep 1; done
  docker exec "$1" docker info >/dev/null 2>&1 || { echo "dockerd in $1 did not start" >&2; exit 1; }
  for i in $(seq 1 30); do ssh-keyscan -p "$2" 127.0.0.1 2>/dev/null | grep -q ed25519 && return 0; sleep 1; done
  echo "sshd in $1 not reachable on $2" >&2; exit 1
}
step "wait for dockerd + sshd"
wait_node sdtest-target "$TARGET_SSH_PORT"
[ "$NODE2" = 1 ] && wait_node sdtest-node2 "$NODE2_SSH_PORT"
for i in $(seq 1 30); do ssh-keyscan -p "$SFTP_PORT" 127.0.0.1 2>/dev/null | grep -q . && break; sleep 1; done

T=(docker exec sdtest-target docker)
step "swarm init inside sdtest-target"
[ "$("${T[@]}" info --format '{{.Swarm.LocalNodeState}}')" = active ] || "${T[@]}" swarm init --advertise-addr eth0 >/dev/null
MANAGER_IP="$(docker exec sdtest-target sh -c "ip -4 -o addr show eth0 | awk '{print \$4}' | cut -d/ -f1")"
if [ "$NODE2" = 1 ]; then
  step "join sdtest-node2 as worker"
  N=(docker exec sdtest-node2 docker)
  NID="$("${N[@]}" info --format '{{.Swarm.NodeID}}')"
  if [ -z "$NID" ] || ! "${T[@]}" node ls -q | grep -qx "$NID"; then
    "${N[@]}" swarm leave --force >/dev/null 2>&1 || true
    "${N[@]}" swarm join --token "$("${T[@]}" swarm join-token -q worker)" "$MANAGER_IP:2377" >/dev/null
  fi
fi

step "registry sdtest_registry (inside sdtest-target)"
"${T[@]}" image inspect registry:2 >/dev/null 2>&1 || docker save registry:2 | docker exec -i sdtest-target docker load -q >/dev/null
if ! "${T[@]}" secret inspect sdtest_registry_htpasswd >/dev/null 2>&1; then   # bcrypt via host python3.12 crypt (libxcrypt)
  python3 -W ignore -c 'import crypt,sys; print(sys.argv[1]+":"+crypt.crypt(sys.argv[2], crypt.mksalt(crypt.METHOD_BLOWFISH)))' \
    "$REG_USER" "$REG_PASS" | docker exec -i sdtest-target docker secret create sdtest_registry_htpasswd - >/dev/null
fi
if ! "${T[@]}" service inspect sdtest_registry >/dev/null 2>&1; then
  "${T[@]}" service create -q --name sdtest_registry --constraint node.role==manager \
    --mount type=volume,src=sdtest-registry,dst=/var/lib/registry --secret sdtest_registry_htpasswd \
    -e REGISTRY_AUTH=htpasswd -e REGISTRY_AUTH_HTPASSWD_REALM=sdtest \
    -e REGISTRY_AUTH_HTPASSWD_PATH=/run/secrets/sdtest_registry_htpasswd \
    --publish published=5050,target=5000,mode=ingress --detach=false registry:2 >/dev/null
fi
reg_code() { docker exec "$1" curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5050/v2/ 2>/dev/null || true; }
for i in $(seq 1 60); do [ "$(reg_code sdtest-target)" = 401 ] && break; sleep 1; done
if [ "$(reg_code sdtest-target)" != 401 ]; then
  echo "   ingress 5050 not answering inside the manager: falling back to mode=host (node2 can't reach it)"
  "${T[@]}" service update -q --publish-rm 5000 --publish-add published=5050,target=5000,mode=host --detach=false sdtest_registry >/dev/null
  for i in $(seq 1 60); do [ "$(reg_code sdtest-target)" = 401 ] && break; sleep 1; done
  [ "$(reg_code sdtest-target)" = 401 ] || { echo "registry not reachable on 127.0.0.1:5050 inside sdtest-target" >&2; exit 1; }
fi
REGISTRY_ON_NODE2=0
running sdtest-node2 && [ "$(reg_code sdtest-node2)" = 401 ] && REGISTRY_ON_NODE2=1
echo "   registry 127.0.0.1:5050 ok inside target (node2: $REGISTRY_ON_NODE2)"

step "FTP server (pyftpdlib)"
if [ "$FTP_ALIVE" = 0 ]; then
  nohup "$L/venv/bin/python" -m pyftpdlib -i 127.0.0.1 -p "$FTP_PORT" -r "$FTP_PASV-$((FTP_PASV+9))" \
    -d "$L/files" -u "$FILES_USER" -P "$FILES_PASS" -w >"$L/ftp.log" 2>&1 &
  echo $! >"$L/ftp.pid"
  for i in $(seq 1 20); do ss -ltnH "sport = :$FTP_PORT" | grep -q . && break; sleep 0.5; done
fi

step "FTPS server (pyftpdlib TLS, self-signed $L/keys/ftps.pem)"
if [ "$FTPS_ALIVE" = 0 ]; then
  nohup "$L/venv/bin/python" "$HERE/ftps_server.py" "$L/files" "$FTPS_PORT" "$FTPS_PASV" "$FILES_USER" "$FILES_PASS" \
    "$L/keys/ftps.pem" >"$L/ftps.log" 2>&1 &
  echo $! >"$L/ftps.pid"
  for i in $(seq 1 20); do ss -ltnH "sport = :$FTPS_PORT" | grep -q . && break; sleep 0.5; done
  ss -ltnH "sport = :$FTPS_PORT" | grep -q . || { echo "FTPS server did not start, see $L/ftps.log" >&2; exit 1; }
fi

step "mock GitLab (testenv/gitlab_mock.py) on 127.0.0.1:$GITLAB_PORT"
if [ "$GITLAB_ALIVE" = 0 ]; then
  nohup python3 "$HERE/gitlab_mock.py" "$L" "$GITLAB_PORT" >"$L/gitlab.log" 2>&1 &
  echo $! >"$L/gitlab.pid"
  for i in $(seq 1 20); do ss -ltnH "sport = :$GITLAB_PORT" | grep -q . && break; sleep 0.5; done
  ss -ltnH "sport = :$GITLAB_PORT" | grep -q . || { echo "mock GitLab did not start, see $L/gitlab.log" >&2; exit 1; }
fi

step "write $L/lab.env and $HERE/env.json"
cat >"$L/lab.env" <<EOF
L='$L'
KEY='$L/keys/sdtest_ed25519'
SFTP_PORT=$SFTP_PORT
FTP_PORT=$FTP_PORT
FTP_PASV=$FTP_PASV
FTPS_PORT=$FTPS_PORT
FTPS_PASV=$FTPS_PASV
TARGET_SSH_PORT=$TARGET_SSH_PORT
NODE2_SSH_PORT=$NODE2_SSH_PORT
NODE2=$( [ "$NODE2" = 1 ] || running sdtest-node2 && echo 1 || echo 0 )
WEB1_PORT=$WEB1_PORT
WEB2_PORT=$WEB2_PORT
SPARE_PORT=$SPARE_PORT
MANAGER_IP=$MANAGER_IP
BP_PORT=$BP_PORT
SD_PORT=$SD_PORT
FILES_USER=$FILES_USER
FILES_PASS=$FILES_PASS
DEPLOY_USER=$DEPLOY_USER
DEPLOY_PASS=$DEPLOY_PASS
ZIP_PASS=$ZIP_PASS
SMB_PORT=$SMB_PORT
SMB_SHARE=releases
GITLAB_PORT=$GITLAB_PORT
GITLAB_URL=http://127.0.0.1:$GITLAB_PORT
GITLAB_USER=$GITLAB_USER
GITLAB_PAT=$GITLAB_PAT
GITLAB_VIEWER_PAT=$GITLAB_VIEWER_PAT
GITLAB_CLIENT_ID=$GITLAB_CLIENT_ID
GITLAB_CLIENT_SECRET=$GITLAB_CLIENT_SECRET
REGISTRY=127.0.0.1:5050
REG_USER=$REG_USER
REG_PASS=$REG_PASS
REGISTRY_ON_NODE2=$REGISTRY_ON_NODE2
WEB3_PORT=8084
EOF
( set -a; . "$L/lab.env"; python3 - "$HERE/env.json" <<'PY'
import json, os, sys
e = os.environ; L = e["L"]
env = {
  "scratch_dir": L,
  "lab_env": f"{L}/lab.env",
  "packages_json": f"{L}/packages.json",
  "file_server": {"container": "sdtest-files",
    "sftp": {"host": "127.0.0.1", "port": int(e["SFTP_PORT"]), "user": e["FILES_USER"], "password": e["FILES_PASS"], "remote_dir": "/releases"},
    "ftp": {"host": "127.0.0.1", "port": int(e["FTP_PORT"]), "passive_ports": [int(e["FTP_PASV"]), int(e["FTP_PASV"]) + 9],
            "user": e["FILES_USER"], "password": e["FILES_PASS"], "remote_dir": "/releases", "pid_file": f"{L}/ftp.pid"},
    "ftps": {"host": "127.0.0.1", "port": int(e["FTPS_PORT"]), "passive_ports": [int(e["FTPS_PASV"]), int(e["FTPS_PASV"]) + 9],
             "user": e["FILES_USER"], "password": e["FILES_PASS"], "remote_dir": "/releases", "pid_file": f"{L}/ftps.pid",
             "certfile": f"{L}/keys/ftps.pem", "self_signed": True},
    "smb": {"host": "127.0.0.1", "port": int(e["SMB_PORT"]), "user": e["FILES_USER"], "password": e["FILES_PASS"],
            "share": e["SMB_SHARE"], "remote_dir": "/"},
    "local_root": f"{L}/files/releases"},
  "gitlab": {"url": e["GITLAB_URL"], "port": int(e["GITLAB_PORT"]), "user": e["GITLAB_USER"], "pat": e["GITLAB_PAT"],
    "viewer_pat": e["GITLAB_VIEWER_PAT"], "client_id": e["GITLAB_CLIENT_ID"], "client_secret": e["GITLAB_CLIENT_SECRET"],
    "pid_file": f"{L}/gitlab.pid", "log": f"{L}/gitlab.log",
    "projects": {"mock-web1": "sdtest/mock-web1", "mock-web2": "sdtest/mock-web2", "mock-web3": "sdtest/apps/mock-web3"}},
  "registry": {"url": e["REGISTRY"], "user": e["REG_USER"], "password": e["REG_PASS"], "service": "sdtest_registry",
    "on_node2": e["REGISTRY_ON_NODE2"] == "1"},
  "target": {"name": "lab", "container": "sdtest-target", "host": "127.0.0.1", "port": int(e["TARGET_SSH_PORT"]),
    "user": e["DEPLOY_USER"], "password": e["DEPLOY_PASS"], "key_path": e["KEY"], "host_key_policy": "auto_add",
    "work_dir": "/home/deploy/sd-work", "backup_dir": "/home/deploy/sd-backups", "manager_ip": e["MANAGER_IP"]},
  "node2": {"enabled": e["NODE2"] == "1", "container": "sdtest-node2", "host": "127.0.0.1", "port": int(e["NODE2_SSH_PORT"]),
    "user": e["DEPLOY_USER"], "password": e["DEPLOY_PASS"], "key_path": e["KEY"]},
  "services": {
    "sdtest-web1": {"swarm_service": "sdtest_web1", "repo": "sdtest/web1", "moving_tag": "latest", "container_port": 8081,
                    "host_url": f"http://127.0.0.1:{e['WEB1_PORT']}", "health_url": "http://127.0.0.1:8081/health"},
    "sdtest-web2": {"swarm_service": "sdtest_web2", "repo": "sdtest/web2", "moving_tag": "latest", "container_port": 8082,
                    "host_url": f"http://127.0.0.1:{e['WEB2_PORT']}", "health_url": "http://127.0.0.1:8082/health"},
    "sdtest-web3": {"swarm_service": "sdtest_web3", "repo": "127.0.0.1:5050/sdtest/web3", "moving_tag": "dev",
                    "container_port": 8084, "health_url": "http://127.0.0.1:8084/health"},
    "sdtest-bad": {"swarm_service": "sdtest_web1"}},
  "spare_port": {"container_port": 8083, "host_port": int(e["SPARE_PORT"])},
  "zip_password": e["ZIP_PASS"],
  "repos": {"mock-web1": f"{L}/repos/mock-web1", "mock-web2": f"{L}/repos/mock-web2",
            "mock-web3": f"{L}/repos/mock-web3"},
  "swarm_deployer": {"url": f"http://127.0.0.1:{e['SD_PORT']}", "SD_DATA": f"{L}/sd-data"},
  "build_packager_copy": {"dir": f"{L}/bp", "url": f"http://127.0.0.1:{e['BP_PORT']}"},
  "options": {"converge_timeout": 90, "update_monitor": 5, "health_timeout": 20},
}
json.dump(env, open(sys.argv[1], "w"), indent=2)
PY
)
step "lab is up (run seed.sh next)"
