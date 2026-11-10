"""Defaults and fixed value sets (phases, job states, option limits)."""
from backend.core.enums import JobStatus, KeyPolicy, Phase, RollbackState

DOCKER_CMDS = ("docker", "sudo -n docker")
POLICIES = tuple(KeyPolicy)
DEPLOY_PHASES = list(Phase)
ROLLBACK_PHASES = [Phase.CONNECT, Phase.BACKUP, Phase.LOAD, Phase.DEPLOY, Phase.VERIFY]
DONE = (JobStatus.SUCCESS, JobStatus.FAILED)
ROLLBACK_STATES = tuple(RollbackState)
DEFAULTS = {
    "targets": [],
    "options": {"keep_backups": 5, "save_image_tar": True, "converge_timeout": 120, "update_monitor": 10,
                "health_timeout": 30, "prune_after": False},
    "gitlab": {"url": "", "token": ""},  # only for "Import from GitLab project"
    "env_import": {"sha": "", "at": None, "set": []},
}
SECRET_KEYS = ("password", "token")
TARGET_DEFAULTS = {"id": "", "name": "", "host": "", "port": 22, "username": "", "password": "",
                   "private_key_path": "", "host_key_policy": KeyPolicy.AUTO_ADD, "docker_cmd": "docker",
                   "packages_dir": "", "backup_dir": "", "extra_nodes": [],
                   "registry": {"url": "", "username": "", "password": ""}}
OPTION_RULES = {"keep_backups": (1, 50), "converge_timeout": (10, 1800), "update_monitor": (1, 600),
                "health_timeout": (1, 600)}
