"""Validation regexes."""
import re

NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$")
BRANCH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
URL_RE = re.compile(r"^(https?://|ssh://|file://|git@[^:\s]+:|/)\S+$")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
DOCKER_REPO_RE = re.compile(r"([a-z0-9.-]+(:[0-9]{1,5})?/)?[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*")
GL_URL_RE = re.compile(r"^https?://[A-Za-z0-9.-]+(:\d{1,5})?(/[A-Za-z0-9._~/-]*)?$")
PROJECT_RE = re.compile(r"^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+){1,19}$")
SHARE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.$-]{0,79}$")
DOMAIN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SECRET_KEY_RE = re.compile(r"(?i)(PASS|SECRET|TOKEN|KEY|PRIVATE|CREDENTIAL)")
