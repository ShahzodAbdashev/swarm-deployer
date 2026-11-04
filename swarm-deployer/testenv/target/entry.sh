#!/bin/sh
set -e
[ -f /keys/sdtest_ed25519.pub ] && install -o deploy -g deploy -m 600 /keys/sdtest_ed25519.pub /home/deploy/.ssh/authorized_keys
rm -f /var/run/docker.pid   # stale after docker restart
/usr/sbin/sshd
exec dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock --group docker
