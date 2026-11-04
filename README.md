# devtools

| Folder | What | Run |
|---|---|---|
| `build-packager/` | builds a repo's Docker image into a password-protected release zip on SFTP | `cd build-packager && ./run.sh` → http://127.0.0.1:8090 |
| `swarm-deployer/` | deploys those zips to Docker Swarm services (backup + automatic rollback) | `cd swarm-deployer && ./run.sh` → http://127.0.0.1:8095 |
| `shared-ui/` | React UI kit both frontends use (`@devtools/ui`) | — |
| `devtools-stack/` | runs both apps with Docker Compose | `cd devtools-stack && docker compose up -d --build` |

Keep the folders side by side: the frontends import `../../shared-ui`.
