#!/usr/bin/env bash
# Seed the lab: mock git repos, v1 services inside sdtest-target, packages on the file server. See TESTENV.md §4-5, §8.4-8.5.
#   seed.sh          full seed (repos + services + packages)
#   seed.sh --reset  only reset services to v1 and wipe target backups/tags (fast, between destructive tests)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
L="${SDTEST_DIR:-/tmp/claude-1000/-home-shahzod-mywork/9cc69e64-a217-469a-aadc-7f8a210ef0d3/scratchpad/deployer}"
[ -f "$L/lab.env" ] || { echo "run up.sh first" >&2; exit 1; }
. "$L/lab.env"
# one suite at a time on the shared lab; tests take the same lock and set SDTEST_LAB_LOCK_HELD for their own seed calls
if [ -z "${SDTEST_LAB_LOCK_HELD:-}" ]; then
  exec 9>"$L/lab.lock"
  flock -n 9 || { echo "==> waiting for lab lock $L/lab.lock" >&2; flock 9; }
fi
RESET_ONLY=0; [ "${1:-}" = "--reset" ] && RESET_ONLY=1
step() { echo "==> $*"; }
T=(docker exec sdtest-target docker)
G=(git -c user.name=sdtest -c user.email=sdtest@localhost)

make_repo() { # dir name image
  local d="$1" n="$2"
  rm -rf "$d"; mkdir -p "$d/www"; cd "$d"
  git init -q -b main
  printf '# mock-%s\n\nTest service for Swarm Deployer (sdtest lab).\n' "$n" >README.md
  if [ "$n" = web1 ]; then
    cat >Dockerfile <<'EOF'
FROM busybox:latest
COPY www /www
EXPOSE 8080
HEALTHCHECK --interval=2s --timeout=2s --start-period=2s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
CMD ["httpd", "-f", "-v", "-p", "8080", "-h", "/www"]
EOF
  else
    cat >Dockerfile <<'EOF'
FROM nginx:1.27-alpine
COPY default.conf /etc/nginx/conf.d/default.conf
COPY www /usr/share/nginx/html
HEALTHCHECK --interval=2s --timeout=2s --start-period=2s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
EOF
    echo 'server { listen 8080; location / { root /usr/share/nginx/html; default_type text/plain; } }' >default.conf
  fi
  printf '%s v1' "$n" >www/version; printf ok >www/health
  "${G[@]}" add -A; "${G[@]}" commit -qm "$n v1"
  "${G[@]}" checkout -qb v2 main; printf '%s v2' "$n" >www/version; "${G[@]}" commit -qam "$n v2"
  "${G[@]}" checkout -qb broken main
  if [ "$n" = web1 ]; then
    sed -i "s|^CMD .*|CMD [\"sh\", \"-c\", \"echo 'web1 broken: exiting'; sleep 1; exit 1\"]|" Dockerfile
  else
    echo "CMD [\"sh\",\"-c\",\"echo 'web2 broken: exiting'; sleep 1; exit 1\"]" >>Dockerfile
  fi
  "${G[@]}" commit -qam "$n broken"
  "${G[@]}" checkout -qb unhealthy main; printf '%s unhealthy' "$n" >www/version; "${G[@]}" rm -q www/health
  "${G[@]}" commit -qam "$n unhealthy"
  # v3 = v2 + a deploy.yml (the package names its own swarm service); v2/main have none (Settings fallback)
  "${G[@]}" checkout -qb v3 v2; printf '%s v3' "$n" >www/version
  local num="${n#web}"
  printf 'service: sdtest_%s\nimage: sdtest/%s\ntarget: lab\nhealth_url: http://127.0.0.1:808%s/health\n' "$n" "$n" "$num" >deploy.yml
  "${G[@]}" add -A; "${G[@]}" commit -qm "$n v3 + deploy.yml"
  "${G[@]}" checkout -q main; cd - >/dev/null
}

make_repo3() { # dir   (mock-web3: a fortress_ownercheck look-alike, TESTENV.md §8.4)
  local d="$1"
  rm -rf "$d"; mkdir -p "$d/.deploy"; cd "$d"
  git init -q -b main
  printf '# mock-web3\n\nReads /app/.env like fortress_ownercheck; health script in .deploy/ (sdtest lab).\n' >README.md
  printf v1 >VERSION
  printf '.git\n' >.dockerignore
  cat >Dockerfile <<'EOF'
FROM busybox:latest
COPY . /app
USER nobody
EXPOSE 8084
CMD ["sh", "/app/start.sh"]
EOF
  cat >start.sh <<'EOF'
#!/bin/sh
# mock-web3: reads /app/.env (KEY=value lines, no shell sourcing); /health is "ok" only with MONGO_HOST and MONGO_PASSWORD set
[ -f /app/.env ] && while IFS='=' read -r k v; do case "$k" in ''|\#*) continue;; esac; export "$k=$v"; done </app/.env
W=/tmp/www; mkdir -p $W
printf 'web3 %s' "$(cat /app/VERSION)" >$W/version
printf 'GREETING=%s\nSVC_PORT=%s\nMONGO_HOST=%s\nAPP_ENV=%s\n' "${GREETING:-}" "${SVC_PORT:-}" "${MONGO_HOST:-}" "${APP_ENV:-}" >$W/config
if [ -n "${MONGO_HOST:-}" ] && [ -n "${MONGO_PASSWORD:-}" ]; then printf ok >$W/health; else printf 'missing MONGO_HOST/MONGO_PASSWORD' >$W/health; fi
exec httpd -f -v -p 8084 -h $W
EOF
  cat >.deploy/healthcheck.sh <<'EOF'
#!/usr/bin/env bash
# usage: healthcheck.sh --url=<url> --service=<name>   (same contract as the fortress CI deploy job)
URL=""; SERVICE=""
for a in "$@"; do case "$a" in --url=*) URL="${a#--url=}";; --service=*) SERVICE="${a#--service=}";; esac; done
[ -n "$URL" ] || { echo "healthcheck: --url is required"; exit 2; }
echo "healthcheck: $SERVICE at $URL"
body=""
for i in $(seq 1 15); do
  body="$(curl -fsS --max-time 3 "$URL" 2>/dev/null || true)"
  [ "$body" = ok ] && { echo "healthcheck: OK after $i tries"; exit 0; }
  sleep 2
done
echo "healthcheck: FAILED ($URL returned '${body:-nothing}')"; exit 1
EOF
  chmod 755 .deploy/healthcheck.sh
  # quoted heredoc: the $VARS stay literal (Build Packager resolves them from the mock GitLab's CI/CD variables)
  cat >.gitlab-ci.yml <<'YAML'
stages: [prepare, build, deploy]
variables:
  DEV_IMAGE_TAG: dev
  APP_ENV_NAME: development
export_env:
  stage: prepare
  script:
    - |
      cat <<EOF >> .env
      SVC_PORT=$WEB3_SERVICE_PORT
      GREETING=${WEB3_GREETING}
      MONGO_HOST=$BASE_MONGO_HOST
      MONGO_PASSWORD=$BASE_MONGO_PASSWORD
      APP_ENV=$APP_ENV_NAME
      EOF
  artifacts:
    paths: [.env]
build:
  stage: build
  script:
    - docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" $CI_REGISTRY
    - docker load -i /app/python.tar
    - docker build -t $CI_REGISTRY_IMAGE:$DEV_IMAGE_TAG .
    - docker push $CI_REGISTRY_IMAGE:$DEV_IMAGE_TAG
deploy_dev:
  stage: deploy
  script:
    - echo "deployed by Swarm Deployer (mock); health check runs .deploy/healthcheck.sh"
YAML
  "${G[@]}" add -A; "${G[@]}" commit -qm "web3 v1"
  "${G[@]}" checkout -qb v2 main; printf v2 >VERSION; "${G[@]}" commit -qam "web3 v2"
  "${G[@]}" checkout -qb unhealthy main; printf unhealthy >VERSION
  sed -i 's|MONGO_HOST=\$BASE_MONGO_HOST|MONGO_HOST=$WEB3_MONGO_HOST_TYPO|' .gitlab-ci.yml
  "${G[@]}" commit -qam "web3 unhealthy (typo in export_env)"
  "${G[@]}" checkout -qb broken main
  sed -i "s|^CMD .*|CMD [\"sh\",\"-c\",\"echo 'web3 broken: exiting'; sleep 1; exit 1\"]|" Dockerfile
  "${G[@]}" commit -qam "web3 broken"
  "${G[@]}" checkout -q main; cd - >/dev/null
}
WEB3=127.0.0.1:5050/sdtest/web3
WEB3_ENV='SVC_PORT=8084
GREETING=hello from project var
MONGO_HOST=mongo.sdtest.local
MONGO_PASSWORD=sdtest-mongo-secret-42
APP_ENV=development
'
reg_login() { printf %s "$REG_PASS" | docker exec -i sdtest-target docker login -u "$REG_USER" --password-stdin 127.0.0.1:5050 >/dev/null 2>&1 ||
  { echo "registry login to 127.0.0.1:5050 failed" >&2; exit 1; }; }

if [ "$RESET_ONLY" = 0 ]; then
  step "mock repos in $L/repos"
  make_repo "$L/repos/mock-web1" web1
  make_repo "$L/repos/mock-web2" web2
  make_repo3 "$L/repos/mock-web3"

  step "base images into target (and node2 if up)"
  docker save busybox:latest nginx:1.27-alpine | docker exec -i sdtest-target docker load -q
  if [ "$(docker inspect -f '{{.State.Running}}' sdtest-node2 2>/dev/null || true)" = true ]; then
    docker save busybox:latest nginx:1.27-alpine | docker exec -i sdtest-node2 docker load -q
  fi

  for n in web1 web2; do
    step "build sdtest/$n:v1 inside target"
    git -C "$L/repos/mock-$n" archive main | docker exec -i sdtest-target sh -c "rm -rf /seed/$n && mkdir -p /seed/$n && tar -x -C /seed/$n"
    "${T[@]}" build -q -t "sdtest/$n:v1" "/seed/$n" >/dev/null
  done

  step "build $WEB3:v1 inside target (with its generated .env), push v1 + dev to sdtest_registry"
  git -C "$L/repos/mock-web3" archive main | docker exec -i sdtest-target sh -c 'rm -rf /seed/web3 && mkdir -p /seed/web3 && tar -x -C /seed/web3'
  printf %s "$WEB3_ENV" | docker exec -i sdtest-target sh -c 'cat > /seed/web3/.env && chmod 644 /seed/web3/.env'
  "${T[@]}" build -q -t "$WEB3:v1" /seed/web3 >/dev/null
  "${T[@]}" tag "$WEB3:v1" "$WEB3:dev"
  reg_login
  "${T[@]}" push -q "$WEB3:v1" >/dev/null
  "${T[@]}" push -q "$WEB3:dev" >/dev/null
fi

step "reset services inside target (never sdtest_registry)"
"${T[@]}" image inspect "$WEB3:v1" >/dev/null 2>&1 || { echo "$WEB3:v1 missing in sdtest-target: run seed.sh (full) first" >&2; exit 1; }
"${T[@]}" service rm sdtest_web1 sdtest_web2 sdtest_missing sdtest_web3 >/dev/null 2>&1 || true
for s in sdtest_web1 sdtest_web2 sdtest_missing sdtest_web3; do   # per service: the registry task never goes away
  for i in $(seq 1 30); do [ -z "$("${T[@]}" ps -aq --filter "label=com.docker.swarm.service.name=$s")" ] && break; sleep 1; done
done
docker exec sdtest-target rm -rf /home/deploy/sd-work /home/deploy/sd-backups /home/deploy/sd-gl-work \
  /home/deploy/sd-gl-backups /home/deploy/sd-ui-work /home/deploy/sd-ui-backups /home/deploy/.docker
docker exec sdtest-target sh -c \
  "docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^((127\.0\.0\.1:5050/)?sdtest/[^:]+:(backup-|2)|sdtest-[a-z0-9-]+:(2|latest))' | xargs -r docker rmi >/dev/null" || true
step "registry $WEB3:dev -> v1"
reg_login   # root's /root/.docker lives in the container fs: a recreated sdtest-target has no credentials
"${T[@]}" tag "$WEB3:v1" "$WEB3:dev" && "${T[@]}" push -q "$WEB3:dev" >/dev/null
for n in 1 2; do
  "${T[@]}" service create -q --name "sdtest_web$n" --replicas 1 \
    --constraint node.role==manager --publish "published=808$n,target=8080,mode=host" \
    --no-resolve-image --update-failure-action rollback --update-monitor 10s --detach=false "sdtest/web$n:v1" >/dev/null
done
# with resolve-image: the spec gets :dev@sha256:<v1>, exactly like a CI update --with-registry-auth
"${T[@]}" service create -q --name sdtest_web3 --replicas 1 --constraint node.role==manager \
  --publish published=8084,target=8084,mode=host --with-registry-auth --update-failure-action rollback \
  --update-monitor 5s --detach=false "$WEB3:dev" >/dev/null
step "wait for v1 on host ports $WEB1_PORT / $WEB2_PORT and web3 v1 on 8084 (inside target)"
w3() { docker exec sdtest-target wget -qO- "http://127.0.0.1:8084/$1" 2>/dev/null || true; }
for i in $(seq 1 60); do
  [ "$(curl -fsS "127.0.0.1:$WEB1_PORT/version" 2>/dev/null)" = "web1 v1" ] &&
  [ "$(curl -fsS "127.0.0.1:$WEB2_PORT/version" 2>/dev/null)" = "web2 v1" ] &&
  [ "$(w3 health)" = ok ] && [ "$(w3 version)" = "web3 v1" ] && break
  [ "$i" = 60 ] && { echo "services did not come up at v1" >&2; exit 1; }
  sleep 1
done
[ "$RESET_ONLY" = 1 ] && { step "reset done"; exit 0; }

step "packages on file server ($L/files/releases)"
R="$L/files/releases"
find "$R" -mindepth 1 -delete
printf 'Releases uploaded by Build Packager (sdtest lab).\n' >"$R/README.txt"
PK=("$L/venv/bin/python" "$HERE/make_package.py" --password "$ZIP_PASS")
declare -A P
mk() { local key="$1"; shift; local z; z="$("${PK[@]}" "$@")"; P[$key]="${z#"$L/files"}"; echo "   $key -> ${P[$key]}"; }
mk web1_v1b       --repo "$L/repos/mock-web1" --branch main      --service sdtest-web1 --out "$R"
mk web1_v2        --repo "$L/repos/mock-web1" --branch v2        --service sdtest-web1 --out "$R"
mk web1_broken    --repo "$L/repos/mock-web1" --branch broken    --service sdtest-web1 --out "$R"
mk web1_unhealthy --repo "$L/repos/mock-web1" --branch unhealthy --service sdtest-web1 --out "$R"
mk web2_v2        --repo "$L/repos/mock-web2" --branch v2        --service sdtest-web2 --out "$R"
mk bad            --repo "$L/repos/mock-web1" --branch main      --service sdtest-bad  --out "$R" --bad
mk nomap          --repo "$L/repos/mock-web1" --branch v2        --service sdtest-nomap --out "$R"
mk archive_web1   --repo "$L/repos/mock-web1" --branch v2        --service sdtest-web1 --out "$R/archive"
{ echo "{"; first=1; for k in web1_v1b web1_v2 web1_broken web1_unhealthy web2_v2 bad nomap archive_web1; do
  [ $first = 1 ] || echo ","; first=0; printf '  "%s": "%s"' "$k" "${P[$k]}"; done; echo; echo "}"; } >"$L/packages.json"
step "seed done ($L/packages.json)"
