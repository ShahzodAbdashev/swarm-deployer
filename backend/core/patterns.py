"""Validation regexes for names, hosts, image refs and file names."""
import re

NAME_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}")
PKG_FILE_RE = re.compile(r"(?P<service>[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62})_(?P<ts>\d{8}_\d{6})\.zip")
TARZIP_RE = re.compile(r"(?P<service>[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}?)(?:_(?P<ts>\d{8}_\d{6}))?(?:\.tar)?\.zip")
REG_URL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?")
REG_USER_RE = re.compile(r"[A-Za-z0-9_.@+-]{1,128}")
GL_URL_RE = re.compile(r"https?://[A-Za-z0-9.-]+(:\d{1,5})?(/[A-Za-z0-9._~/-]*)?")
GL_PROJECT_RE = re.compile(r"[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+){1,19}")
HOST_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9.:-]*")
USER_RE = re.compile(r"[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}")
TID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")
TAG_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}")
TS_RE = re.compile(r"\d{8}_\d{6}")
URL_RE = re.compile(r"https?://\S+")
BACKUP_ID_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}_\d{8}_\d{6}")
JOB_ID_RE = re.compile(r"[0-9a-f]{32}")
