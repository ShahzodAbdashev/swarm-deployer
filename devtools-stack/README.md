# devtools-stack

Runs **Build Packager** (http://127.0.0.1:8090) and **Swarm Deployer** (http://127.0.0.1:8095) with Docker Compose.

```bash
cd devtools-stack
GH_TOKEN=$(gh auth token) docker compose up -d --build   # first run ~1 min, later runs use the cache
docker compose logs -f                                   # live logs
docker compose down                                      # stop (data volumes are kept)
```

- **Images** build from `../build-packager/Dockerfile` and `../swarm-deployer/Dockerfile`. The UI is plain HTML/CSS/JS served as-is, so neither the host nor the image needs Node.
- **Host network:** both apps still listen on 127.0.0.1 only, and can reach servers on localhost exactly like `run.sh`.
- **Data** is kept in the volumes `devtools_bp-data` and `devtools_sd-data`. It starts empty, separate from the `data/` folders that `run.sh` uses, so sign in and enter Settings once.
- **GitHub:** `GH_TOKEN` makes "Continue with GitHub" work. Without it, paste a token on the sign-in screen. Set `GITHUB_CLIENT_ID` to enable device-flow sign-in.
- **Docker socket (Build Packager only):** it gets `/var/run/docker.sock` to run `docker build`/`docker save` on the host daemon, which is the same access `run.sh` has. Swarm Deployer has no Docker access; it runs every docker/swarm command over SSH on the target.
- **SSH keys:** `~/.ssh` is mounted read-only at `/root/.ssh`, so a key path like `~/.ssh/id_ed25519` in Settings works.
- **Local repos:** a repo path from the host (e.g. `/home/me/repo`) is not visible inside the container. Use GitHub or clone URLs, or add a bind mount.
- **Time zone:** the host `/etc/localtime` is mounted, so `<service>_<datetime>` names use your local time.
