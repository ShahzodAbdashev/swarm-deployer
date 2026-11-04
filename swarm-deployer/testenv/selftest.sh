#!/usr/bin/env bash
# P1 lab self-test: target ssh (key + password), swarm inside target, v1 services, SFTP + FTP + SMB, package content,
# mock GitLab (API + git), registry, web3, and the safety grep (no host-daemon swarm commands in testenv/ or tests/).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
L="${SDTEST_DIR:-/tmp/claude-1000/-home-shahzod-mywork/9cc69e64-a217-469a-aadc-7f8a210ef0d3/scratchpad/deployer}"
. "$L/lab.env"
ok() { echo "PASS $*"; }
SSH=(ssh -q -i "$KEY" -p "$TARGET_SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$DEPLOY_USER@127.0.0.1")

[ "$("${SSH[@]}" docker info --format '{{.Swarm.LocalNodeState}}/{{.Swarm.ControlAvailable}}')" = "active/true" ]
ok "ssh key login; swarm active manager inside target"
"${SSH[@]}" "docker service ls --format '{{.Name}} {{.Image}} {{.Replicas}}'" | sort
[ "$(curl -fsS "127.0.0.1:$WEB1_PORT/version")" = "web1 v1" ]; ok "web1 v1 on $WEB1_PORT"
[ "$(curl -fsS "127.0.0.1:$WEB2_PORT/version")" = "web2 v1" ]; ok "web2 v1 on $WEB2_PORT"
[ "$("${SSH[@]}" curl -fsS http://127.0.0.1:8081/health)" = ok ]; ok "health URL reachable from inside target"

"$L/venv/bin/python" -I - "$L" <<'PY'
import ftplib, json, os, sys, tarfile, io, paramiko, pyzipper
L = sys.argv[1]
e = dict(l.strip().split("=", 1) for l in open(f"{L}/lab.env") if "=" in l)
e = {k: v.strip("'") for k, v in e.items()}
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("127.0.0.1", int(e["TARGET_SSH_PORT"]), e["DEPLOY_USER"], e["DEPLOY_PASS"], look_for_keys=False, allow_agent=False)
_, o, _ = c.exec_command("id -nG"); assert "docker" in o.read().decode(); c.close()
print("PASS ssh password login (deploy in group docker)")
t = paramiko.Transport(("127.0.0.1", int(e["SFTP_PORT"]))); t.connect(username=e["FILES_USER"], password=e["FILES_PASS"])
s = paramiko.SFTPClient.from_transport(t); names = s.listdir("/releases"); t.close()
print("PASS sftp /releases:", sorted(names))
f = ftplib.FTP(); f.connect("127.0.0.1", int(e["FTP_PORT"])); f.login(e["FILES_USER"], e["FILES_PASS"])
fn = f.nlst("/releases"); f.quit(); print("PASS ftp /releases:", len(fn), "entries")
f = ftplib.FTP_TLS(); f.connect("127.0.0.1", int(e["FTPS_PORT"])); f.login(e["FILES_USER"], e["FILES_PASS"]); f.prot_p()
fs = f.nlst("/releases"); f.quit(); assert sorted(fs) == sorted(fn), (fs, fn); print("PASS ftps /releases (TLS):", len(fs), "entries")
pk = json.load(open(f"{L}/packages.json"))
with pyzipper.AESZipFile(f"{L}/files{pk['web1_v2']}") as z:
    z.setpassword(e["ZIP_PASS"].encode())
    tar = next(n for n in z.namelist() if n.endswith(".tar"))
    with tarfile.open(fileobj=io.BytesIO(z.read(tar))) as tf:
        tags = json.load(tf.extractfile("manifest.json"))[0]["RepoTags"]
assert tags and tags[0].startswith("sdtest-web1:2"), tags
print("PASS zip opens with ZIP_PASS; docker archive", tar, tags)
PY

# ---- SMB (python smbprotocol; there is no smbclient binary on this host): same listing as SFTP, writes as host uid
"$L/venv/bin/python" -I - "$L" <<'PY'
import os, sys, paramiko, smbclient
L = sys.argv[1]
e = {k: v.strip().strip("'") for k, _, v in (l.partition("=") for l in open(f"{L}/lab.env")) if v}
kw = dict(port=int(e["SMB_PORT"]), username=e["FILES_USER"], password=e["FILES_PASS"])
smb = sorted(smbclient.listdir(r"\\127.0.0.1\releases", **kw))
t = paramiko.Transport(("127.0.0.1", int(e["SFTP_PORT"]))); t.connect(username=e["FILES_USER"], password=e["FILES_PASS"])
sftp = sorted(paramiko.SFTPClient.from_transport(t).listdir("/releases")); t.close()
assert smb == sftp, (smb, sftp)
print("PASS smb \\\\127.0.0.1\\releases (port %s) lists the same %d entries as SFTP /releases" % (e["SMB_PORT"], len(smb)))
with smbclient.open_file(r"\\127.0.0.1\releases\.smb-probe", mode="wb", **kw) as f:
    f.write(b"probe")
st = os.stat(f"{L}/files/releases/.smb-probe")
smbclient.remove(r"\\127.0.0.1\releases\.smb-probe", **kw)
assert st.st_uid == os.getuid(), (st.st_uid, os.getuid())
assert not os.path.exists(f"{L}/files/releases/.smb-probe")
print("PASS smb write+delete; file owned by host uid", st.st_uid)
smbclient.reset_connection_cache()
PY

# ---- mock GitLab
[ "$(curl -fsS -H "Authorization: Bearer $GITLAB_PAT" "$GITLAB_URL/api/v4/user" | python3 -c 'import json,sys; print(json.load(sys.stdin)["username"])')" = sdtest-dev ]
ok "mock GitLab $GITLAB_URL /api/v4/user = sdtest-dev"
git ls-remote "http://oauth2:$GITLAB_PAT@127.0.0.1:$GITLAB_PORT/sdtest/apps/mock-web3.git" | grep -q 'refs/heads/v2$'
if GIT_TERMINAL_PROMPT=0 git ls-remote "http://oauth2:glpat-bad@127.0.0.1:$GITLAB_PORT/sdtest/apps/mock-web3.git" >/dev/null 2>&1; then
  echo "FAIL git ls-remote with a bad token succeeded"; exit 1
fi
ok "git smart HTTP: ls-remote mock-web3 lists v2 with the PAT, a bad token fails"

# ---- registry sdtest_registry inside the lab swarm
T=(docker exec sdtest-target docker)
reg() { docker exec "$1" curl -s -o /dev/null -w '%{http_code}' "${@:2}" http://127.0.0.1:5050/v2/ || true; }
[ "$(reg sdtest-target)" = 401 ] && [ "$(reg sdtest-target -u "$REG_USER:$REG_PASS")" = 200 ]
ok "registry 127.0.0.1:5050 inside target: 401 anonymous, 200 with $REG_USER"
if [ "$(docker inspect -f '{{.State.Running}}' sdtest-node2 2>/dev/null || true)" = true ]; then
  echo "INFO registry from node2: $(reg sdtest-node2 -u "$REG_USER:$REG_PASS") (REGISTRY_ON_NODE2=$REGISTRY_ON_NODE2, informational)"
fi

# ---- web3 (registry image with its .env, health script service)
w3() { docker exec sdtest-target wget -qO- "http://127.0.0.1:8084/$1"; }
[ "$(w3 health)" = ok ] && [ "$(w3 version)" = "web3 v1" ]; ok "web3 v1 healthy on 8084 (inside target)"
img="$("${T[@]}" service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' sdtest_web3)"
case "$img" in 127.0.0.1:5050/sdtest/web3:dev@sha256:*) ok "sdtest_web3 spec image $img";; *) echo "FAIL sdtest_web3 spec image $img"; exit 1;; esac

# safety grep: swarm-level docker commands only inside sdtest-* containers
bad="$(grep -rnE 'docker (service|swarm|stack|node) ' "$HERE" "$HERE/../tests" 2>/dev/null | grep -v -e 'exec sdtest-' -e 'SSH\[@\]' || true)"
[ -z "$bad" ] || { echo "FAIL host swarm command found:"; echo "$bad"; exit 1; }
ok "safety grep"
echo "P1 lab selftest: all passed"
