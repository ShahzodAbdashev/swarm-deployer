"""Defaults and fixed value sets (steps, protocols)."""
from backend.core.enums import JobStatus, Protocol, Step

GH_API = "https://api.github.com"
# deploy.yml rules (same as Swarm Deployer's check_manifest)
MANIFEST_KEYS = {"service", "image", "target", "health_url", "moving_tag"}
GL_DEFAULT = "http://192.168.33.175"
PROTOCOLS = tuple(Protocol)
STEPS = list(Step)
DONE = (JobStatus.SUCCESS, JobStatus.FAILED)
DEFAULT_UPLOAD = {"enabled": False, "protocol": Protocol.SFTP, "host": "", "port": 22, "username": "",
                  "password": "", "remote_dir": "/", "private_key_path": "", "domain": "", "share": ""}
