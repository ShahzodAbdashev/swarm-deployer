""".env key names and the settings they set."""
ENV_BOOL = {"true": True, "1": True, "yes": True, "on": True, "false": False, "0": False, "no": False, "off": False}
ENV_TARGET = {"host": ("SD_TARGET_HOST", "BASE_DEVELOPMENT_HOST"), "port": ("SD_TARGET_PORT",),
              "username": ("SD_TARGET_USER", "BASE_DEVELOPMENT_HOST_USER"), "password": ("SD_TARGET_PASSWORD",),
              "private_key_path": ("SD_TARGET_KEY_PATH",), "packages_dir": ("SD_PACKAGES_DIR",),
              "backup_dir": ("SD_BACKUP_DIR",), "docker_cmd": ("SD_DOCKER_CMD",),
              "host_key_policy": ("SD_HOST_KEY_POLICY",)}
ENV_REGISTRY = {"url": ("SD_REGISTRY", "CI_REGISTRY"), "username": ("SD_REGISTRY_USER", "CI_REGISTRY_USER"),
                "password": ("SD_REGISTRY_PASSWORD", "CI_REGISTRY_PASSWORD")}
ENV_KEY = ("SD_TARGET_SSH_KEY", "BASE_DEVELOPMENT_SSH_PRIVATE_KEY")
ENV_OPT_INT = {"SD_KEEP_BACKUPS": "keep_backups", "SD_CONVERGE_TIMEOUT": "converge_timeout",
               "SD_UPDATE_MONITOR": "update_monitor", "SD_HEALTH_TIMEOUT": "health_timeout"}
ENV_OPT_BOOL = {"SD_SAVE_IMAGE_TAR": "save_image_tar", "SD_PRUNE_AFTER": "prune_after"}
ENV_KEYS = {"GITLAB_URL", "GITLAB_TOKEN", "SD_TARGET_ID", "SD_PACKAGE",
            *ENV_KEY, *ENV_OPT_INT, *ENV_OPT_BOOL,
            *(k for d in (ENV_TARGET, ENV_REGISTRY) for ks in d.values() for k in ks)}
