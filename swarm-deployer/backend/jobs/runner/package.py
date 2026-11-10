"""Package phases: fetch the zip from the target's packages folder, extract and inspect it."""
import hashlib
import json
import os
import posixpath
import re
import tarfile
import zipfile
import zlib

import pyzipper

from backend.core.errors import Fail
from backend.jobs.store import known_services
from backend.remote.fileserver import fileserver
from backend.utils.images import repo_of
from backend.utils.text import hsize


class PackagePhases:
    # --- phases: return success message, raise Skip(msg) or Fail(msg)
    def p_fetch(self):
        t, path = self.t, self.job["package_path"]
        name = posixpath.basename(path)
        os.makedirs(self.work, exist_ok=True)
        local = os.path.join(self.work, name)
        # ponytail: the zip comes here and the tar goes back to the target (extract is local, AES zips); unzip on
        # the target instead if big images on a slow link make that round trip hurt
        self.log(f"connecting {t['username']}@{t['host']}:{t['port']} for the package")
        try:
            with fileserver(t) as (_ls, get):
                self.log(f"downloading {path}")
                size = get(path, local, self.progress("downloaded"))
        except FileNotFoundError:
            raise Fail(f"file not found on {t['id']}: {path}")
        self.local_zip = local
        self.job["artifacts"]["zip_size"] = size
        self.save()
        return f"downloaded {name} ({hsize(size)})"

    def p_extract(self):
        j = self.job
        pkg, ver = j["package"], j["version"]
        want = f"{pkg}_{ver}/{pkg}_{ver}.tar"
        tar_path = None  # set once the member is known: keeps the package's own name (e.g. <svc>_<branch>_<ts>.tar)
        try:
            zf = pyzipper.AESZipFile(self.local_zip)
        except (zipfile.BadZipFile, OSError) as e:
            raise Fail(f"not a valid zip file: {e}")
        with zf:
            names = zf.namelist()
            if want in names:
                member = want
            else:
                tars = [n for n in names if n.endswith(".tar") and n.count("/") <= 1]
                if not tars:
                    raise Fail("no image .tar found in zip")
                if len(tars) > 1:
                    raise Fail("several .tar files in zip: " + ", ".join(tars[:5]))
                member = tars[0]
            # build_tar.sh rule for its <name>.tar.zip (any layout) and for a flat .tar in any zip
            flat = j.get("package_format") == "tarzip" or "/" not in member
            info = zf.getinfo(member)
            enc = "AES" if getattr(info, "wz_aes_strength", None) else ("ZipCrypto" if info.flag_bits & 1 else "no encryption")
            base = posixpath.basename(member)
            j["tar_name"] = base if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\.tar", base) else f"{pkg}_{ver}.tar"
            tar_path = os.path.join(self.work, j["tar_name"])
            self.log(f"extracting {member} ({enc})")
            pw = self.secret.pop("password")
            self.masks = [m for m in self.masks if m is not pw]  # drop the last reference after extract
            zf.setpassword(pw.encode())
            del pw
            hc = posixpath.join(posixpath.dirname(member), ".deploy/healthcheck.sh")
            try:  # stream one member to a fixed name: never extractall (zip-slip safe)
                prog, done = self.progress("extracted"), 0
                with zf.open(member) as src, open(tar_path, "wb") as dst:
                    for chunk in iter(lambda: src.read(1 << 20), b""):
                        dst.write(chunk)
                        done += len(chunk)
                        prog(done, info.file_size)
                if hc in names:
                    n = zf.getinfo(hc).file_size
                    if n > 262144:
                        raise Fail("healthcheck.sh: larger than 256 KB")
                    with open(os.path.join(self.work, "healthcheck.sh"), "wb") as f:
                        f.write(zf.read(hc))
                    j["health_script"] = True
                    self.log(f"package has .deploy/healthcheck.sh ({n} bytes)")
            except (RuntimeError, zlib.error, zipfile.BadZipFile) as e:
                if "password" in str(e).lower() or isinstance(e, (zlib.error, zipfile.BadZipFile)):
                    raise Fail("wrong zip password")
                raise
            finally:
                zf.pwd = None
        try:
            with tarfile.open(tar_path) as tf:
                manifest = json.load(tf.extractfile("manifest.json"))
        except (KeyError, tarfile.TarError, ValueError, AttributeError, TypeError):
            manifest = None
        if not (isinstance(manifest, list) and manifest and all(isinstance(e, dict) for e in manifest)):
            raise Fail("not a docker image archive (manifest.json/RepoTags missing)")
        tags = [t for e in manifest for t in (e.get("RepoTags") or []) if isinstance(t, str)]
        j["package_format"] = "tarzip" if flat else "packager"
        if flat:  # docker save <name> stores every tag of the repo: one image, any number of its tags
            if len(manifest) != 1:
                raise Fail(f"archive holds {len(manifest)} images ({', '.join(tags)[:200]}); save just one, "
                           f"e.g. docker save -o x.tar <name>:latest")
            if not tags:
                raise Fail("archive image has no tag; docker save it by name")
            loaded = next((t for t in tags if t.endswith(":latest")), tags[0])
        else:
            if not tags:
                raise Fail("not a docker image archive (manifest.json/RepoTags missing)")
            loaded = f"{pkg.lower()}:{ver}"
            if tags != [loaded]:  # docker load would (re)tag every RepoTag on the target, other services' included
                raise Fail(f"archive must hold exactly one image tagged {loaded}, found: {', '.join(tags)[:200]}")
        self.archive_tags = tags
        h = hashlib.sha256()
        with open(tar_path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        size = os.path.getsize(tar_path)
        self.local_tar = tar_path
        j["loaded_image"] = loaded
        j["artifacts"].update(tar_size=size, tar_sha256=h.hexdigest())
        os.remove(self.local_zip)
        self.save()
        self.log(f"sha256 {h.hexdigest()}")
        if flat:  # docker load sets every RepoTag on the target: none may name another service's repo
            for t in tags:
                clash = next((m for m in known_services(self.cfg) if m["image_repo"] == repo_of(t)
                              and (m["swarm_service"], m["target"]) != (j["swarm_service"], j["target"])), None)
                if clash:
                    raise Fail(f"image tag {t} belongs to service {clash['swarm_service']} ({clash['package']})")
        if j["health_script"] and not j["health_url"]:
            raise Fail("package has .deploy/healthcheck.sh but no health check URL was given for this deploy")
        return (f"image {loaded} · {hsize(size)} · service {j['swarm_service']}"
                + (" · health script" if j["health_script"] else ""))
