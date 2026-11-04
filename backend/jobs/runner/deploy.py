"""Deploy phases on the target: connect, transfer, backup, load, tag, deploy, verify, cleanup."""
import json
import os
import posixpath
import re
import shutil
import time

from backend.core.constants import ROLLBACK_STATES
from backend.core.enums import DeployMode, JobKind, Phase, PhaseStatus
from backend.core.errors import Fail, Skip
from backend.core.patterns import TAG_RE, TS_RE
from backend.remote.ssh import Shell, connect_target, shell_cmd
from backend.remote.swarm import service_info, service_tasks
from backend.utils.dates import ts_iso
from backend.utils.images import registry_mode, repo_of, same_image, split_ref, strip_digest
from backend.utils.text import hsize, jparse, last_line


class DeployPhases:
    def p_connect(self):
        j, t = self.job, self.t
        self.log(f"connecting ssh {j['target_label']} (host key policy {t['host_key_policy']})")
        self.sh = connect_target(t, self.log)
        self.log(f"signed in to {self.sh.label}")
        out = self.sh.check(self.D + ["info", "--format", "{{json .Swarm}}"], what="docker info")
        sw = jparse(out) or {}
        if sw.get("LocalNodeState") != "active" or sw.get("ControlAvailable") is not True:
            raise Fail("target is not a swarm manager")
        j["registry"] = t["registry"]["url"] if registry_mode(t, j["image_repo"]) else None
        self.save()
        if j["registry"]:
            self.registry_login(self.sh)
        svc = j["swarm_service"]
        argv = self.D + ["service", "inspect", "--format", "{{json .}}", svc]
        # quiet: the spec can hold Env secrets; log the command and the image only
        self.log(f"$ [{self.sh.host}] {shell_cmd(argv)}  (output hidden)")
        code, out = self.sh.run(argv, quiet=True)
        info = jparse(out) if code == 0 else None
        if info:
            ref = info["Spec"]["TaskTemplate"]["ContainerSpec"]["Image"]
            j.update(mode=DeployMode.UPDATE, previous_ref=ref, previous_image=strip_digest(ref),
                     previous_digest=ref.split("@", 1)[1] if "@" in ref else None)
            self.log(f"service {svc} runs {ref}")
            self.old_tasks = {x.get("ID") for x in service_tasks(self.sh, svc)}
        elif j["kind"] == JobKind.DEPLOY and self.m["create_if_missing"]:
            j["mode"] = DeployMode.CREATE
        else:
            raise Fail(f"swarm service {svc} not found on target")
        self.save()
        if j["kind"] == JobKind.DEPLOY and j["moving_tag"] == "@current":
            if j["mode"] == DeployMode.UPDATE:
                _r, tg, dg = split_ref(j["previous_ref"])
                if tg is None and not dg:
                    tg = "latest"
                def movable(x):
                    return bool(x) and bool(TAG_RE.fullmatch(x)) and not x.startswith("backup-") and not TS_RE.fullmatch(x)
                if not movable(tg) and movable(j.get("ci_tag")):  # e.g. stuck on :<ts>: DEV_IMAGE_TAG instead
                    self.log(f"{svc} runs {j['previous_ref']}; using DEV_IMAGE_TAG={j['ci_tag']} from .gitlab-ci.yml")
                    tg = j["ci_tag"]
                elif not movable(tg):
                    raise Fail(f'moving tag @current: {svc} runs {j["previous_ref"]}; its tag "{tg or "(none)"}" '
                               f"can't be a moving tag — retag the service (e.g. :dev) once, then deploy again")
            else:
                tg = "latest"
                self.log("@current: service is new, using latest")
            j["moving_image"] = f"{j['image_repo']}:{tg}"
            self.save()
            self.log(f"moving tag @current = {tg}")
        first = j["image_repo"].split("/")[0]
        if not j["registry"] and j.get("previous_digest") and "/" in j["image_repo"] and ("." in first or ":" in first):
            self.log(f"WARNING: {svc} runs a registry image but target {t['id']} has no registry for "
                     f"{j['image_repo']}; the image is only loaded on the connected hosts (set the registry in "
                     f"Settings → Targets)")
        if j["kind"] == JobKind.DEPLOY:
            jd = posixpath.join(t["work_dir"], j["package"], j["version"])
            j["artifacts"]["job_dir"] = jd  # set before mkdir: cleanup removes whatever got created
            self.save()
            self.sh.check(["mkdir", "-p", "--", jd])
            if j["registry"]:
                self.log(f"registry {j['registry']}: extra nodes pull from it, no tar copied to them")
            else:
                # ponytail: rollback jobs don't touch extra nodes (the backup tag lives on the manager)
                for n in t["extra_nodes"]:
                    try:
                        self.log(f"connecting extra node {n['username']}@{n['host']}:{n['port']}")
                        sh = Shell(n, t["host_key_policy"], t["docker_cmd"], self.log)
                    except Exception as e:
                        raise Fail(f"node {n['host']}:{n['port']}: {type(e).__name__}: {e}")
                    self.nodes.append(sh)
                    sh.check(["mkdir", "-p", "--", jd])
        now = f"running {j['previous_image']}" if j["mode"] == DeployMode.UPDATE else "missing, will be created"
        nodes = f" · {len(self.nodes)} extra node(s)" if self.nodes else ""
        reg = f" · registry {j['registry']}" if j["registry"] else ""
        return f"{self.sh.label} · service {svc} {now}{nodes}{reg}"

    def p_transfer(self):
        j = self.job
        jd = self.job_dir()
        rt = self.rt = posixpath.join(jd, j.get("tar_name") or f"{j['package']}_{j['version']}.tar")
        j["artifacts"]["remote_tar"] = rt  # set before upload: cleanup must also remove a partial/failed upload
        self.save()
        for sh in self.all_hosts():
            self.log(f"uploading {os.path.basename(self.local_tar)} to {sh.label}:{rt}")
            sh.sftp().put(self.local_tar, rt, callback=self.progress("uploaded"))
            out = sh.check(["sha256sum", "--", rt])
            if last_line(out).split(" ")[0] != j["artifacts"]["tar_sha256"]:
                raise Fail(f"checksum mismatch on {sh.host}:{sh.port}")
        if j["health_script"]:
            dst = jd + "/healthcheck.sh"
            self.sh.sftp().put(os.path.join(self.work, "healthcheck.sh"), dst)
            self.log(f"uploaded healthcheck.sh to {self.sh.label}:{dst}")
        return f"{hsize(j['artifacts']['tar_size'])} to {len(self.all_hosts())} host(s), sha256 verified"

    def p_backup(self):
        j = self.job
        if j["mode"] == DeployMode.CREATE:
            raise Skip("skipped: no running service to back up")
        sh, D, svc, prev = self.sh, self.D, j["swarm_service"], j["previous_image"]
        pref = self.prev_ref()
        bid = f"{svc}_{j['ts']}"
        bd = posixpath.join(self.t["backup_dir"], svc, j["ts"])
        btag = f"{j['image_repo']}:backup-{j['ts']}"
        sh.check(["mkdir", "-p", "--", bd])
        sh.check(D + ["service", "inspect", svc], redirect=posixpath.join(bd, "service.json"),
                 what="docker service inspect")
        self.prev_id = self.image_id(sh, pref)
        if not self.prev_id and j["registry"] and j["previous_digest"]:
            code, out = sh.run(D + ["pull", pref], timeout=1800)
            if code:
                self.log(f"WARNING: docker pull {pref} failed: {last_line(out)}")
            self.prev_id = self.image_id(sh, pref)
        if not self.prev_id and not j["registry"] and pref != prev:  # digest not known locally: use the tag
            pref = prev
            self.prev_id = self.image_id(sh, pref)
        if not self.prev_id:
            self.log("WARNING: current image not present locally; backup tag skipped")
            btag = None
        else:
            sh.check(D + ["tag", pref, btag], what="docker tag")
        j["backup"] = {"id": bid, "dir": bd, "tag": btag, "image_tar": False, "digest": None}
        self.save()
        if j["registry"] and btag:
            if j["previous_digest"]:  # the old image is in the registry by digest already: best effort
                try:
                    j["backup"]["digest"] = self.push(btag)
                except Fail as e:
                    self.log(f"WARNING: backup push failed: {e}")
            else:
                j["backup"]["digest"] = self.push(btag)
            self.save()
        has_tar = bool(j["save_image_tar"] and btag)
        if has_tar:
            sh.check(D + ["save", "-o", posixpath.join(bd, "image.tar"), btag], timeout=1800, what="docker save")
        bdig = j["backup"]["digest"]
        with sh.sftp().open(posixpath.join(bd, "image.txt"), "w") as f:
            f.write(f"image={j.get('previous_ref') or prev}\ndigest={j.get('previous_digest') or ''}\n"
                    f"id={self.prev_id or ''}\nbackup_tag={btag or ''}\nbackup_digest={bdig or ''}\n")
        meta = {"id": bid, "swarm_service": svc, "package": j["package"], "previous_image": prev,
                "backup_tag": btag, "has_image_tar": has_tar, "created_at": ts_iso(j["ts"]), "job_id": j["id"],
                "previous_ref": j.get("previous_ref"), "previous_digest": j.get("previous_digest"),
                "backup_digest": bdig, "registry": j["registry"]}
        with sh.sftp().open(posixpath.join(bd, "meta.json"), "w") as f:
            f.write(json.dumps(meta, indent=1))
        self.log(f"wrote {posixpath.join(bd, 'meta.json')}")
        j["backup"]["image_tar"] = has_tar
        self.save()
        pruned = self.prune(prev)
        what = ("spec + tag" + (" + push" if bdig else "")) if btag else "spec only"
        return f"backup {btag or bid} ({what}{' + tar' if has_tar else ''}), pruned {pruned}"

    def prune(self, current):
        """New layout B/<svc>/<ts> only (AD-5); never deletes registry tags (AD-6)."""
        j, sh = self.job, self.sh
        B = posixpath.join(self.t["backup_dir"], j["swarm_service"])
        bid = j.get("backup_id") or ""
        keep_ts = bid[-15:] if bid.startswith(j["swarm_service"] + "_") else None
        dirs = sorted((n for n in sh.sftp().listdir(B) if TS_RE.fullmatch(n)), reverse=True)
        pruned = 0
        for n in dirs[self.opt["keep_backups"]:]:
            if n == keep_ts:
                continue  # never prune the backup a rollback job is restoring
            d = posixpath.join(B, n)
            try:
                bt = sh.read_json(posixpath.join(d, "meta.json")).get("backup_tag")
            except (OSError, ValueError):
                bt = None
            if bt and bt != current:
                sh.run(self.D + ["rmi", bt])
            sh.check(["rm", "-rf", "--", d])
            self.log(f"pruned backup {j['swarm_service']}_{n}")
            pruned += 1
        return pruned

    def p_load(self):
        j, D = self.job, self.D
        if j["kind"] == JobKind.ROLLBACK:
            return self.load_backup()
        img = j["loaded_image"]
        if j["package_format"] == "tarzip":  # docker load moves every RepoTag: remember what they named before
            for sh in self.all_hosts():
                j["load_tags"][f"{sh.host}:{sh.port}"] = {t: self.image_id(sh, t, quiet=True) for t in self.archive_tags}
            self.save()
        for sh in self.all_hosts():
            out = sh.check(D + ["load", "-i", self.rt], timeout=1800, what="docker load")
            if img not in re.findall(r"Loaded image: (\S+)", out):
                if sh.run(D + ["image", "inspect", "--format", "{{.Id}}", img])[0] != 0:
                    raise Fail(f"image {img} not present on {sh.host}:{sh.port} after docker load")
            if sh is not self.sh:
                j["artifacts"]["nodes_loaded"].append(f"{sh.host}:{sh.port}")
                self.save()
        return f"loaded {img} on {len(self.all_hosts())} host(s)"

    def load_backup(self):
        j, D, sh = self.job, self.D, self.sh
        svc, bid = j["swarm_service"], j["backup_id"]
        meta = bd = None
        for d in (posixpath.join(self.t["backup_dir"], svc, bid[-15:]), posixpath.join(self.t["backup_dir"], bid)):
            try:
                meta, bd = sh.read_json(posixpath.join(d, "meta.json")), d
                break
            except (OSError, ValueError):
                pass
        if meta is None:
            raise Fail(f"backup {bid} not found")
        btag, pr = meta.get("backup_tag"), meta.get("previous_ref") or ""
        if not btag and j["registry"] and "@" in pr:  # backup push/pull failed: the old digest may still be pulled
            btag = f"{repo_of(pr)}@{pr.split('@', 1)[1]}"

        def present():
            return bool(btag) and self.image_id(sh, btag) is not None
        ok = present()
        if not ok and btag and j["registry"]:
            src = btag if meta.get("backup_digest") else (
                f"{repo_of(pr)}@{pr.split('@', 1)[1]}" if "@" in pr else None)
            if src:
                code, out = sh.run(D + ["pull", src], timeout=1800)
                if code == 0 and src != btag:
                    sh.run(D + ["tag", src, btag])
                ok = present()
        if not ok:
            tar = posixpath.join(bd, "image.tar")
            try:
                sh.sftp().stat(tar)
                have_tar = True
            except OSError:
                have_tar = False
            if have_tar:
                self.log(f"backup tag missing, loading {tar}")
                sh.check(D + ["load", "-i", tar], timeout=1800, what="docker load")
                ok = present()
        if not ok:
            raise Fail(f"backup image {btag} not available")
        # run the real version tag (not backup-<ts>) when it still points at the backed-up image
        prev, img = meta.get("previous_image"), btag
        if prev and prev != btag:
            c1, id1 = sh.run(D + ["image", "inspect", "--format", "{{.Id}}", btag], quiet=True)
            c2, id2 = sh.run(D + ["image", "inspect", "--format", "{{.Id}}", prev], quiet=True)
            if c2 != 0:
                sh.check(D + ["tag", btag, prev], what="docker tag")
                img = prev
            elif c1 == 0 and id1.strip() == id2.strip():
                img = prev
            else:
                self.log(f"WARNING: {prev} now points at another image; deploying {btag}")
        j["new_image"] = img
        if j["moving_tag"] == "@current":
            tg = split_ref(prev)[1] or "latest"
            if TAG_RE.fullmatch(tg) and not tg.startswith("backup-") and not TS_RE.fullmatch(tg):
                j["moving_image"] = f"{j['image_repo']}:{tg}"
                self.log(f"moving tag @current = {tg}")
            else:
                j["moving_image"] = None
                self.log(f"WARNING: backup ran {prev}; no moving tag for this rollback")
        self.save()
        if j["registry"]:  # AD-7: no moving-tag push here, verify does it
            same = repo_of(prev) == j["image_repo"]
            digest = meta.get("backup_digest") or (meta.get("previous_digest") if same else None) or self.push(btag)
            name = j["moving_image"] or (prev if same else btag)
            j.update(new_digest=digest, deploy_image=f"{name}@{digest}")
        else:
            j["deploy_image"] = img
        self.save()
        return f"backup image {btag} present, deploying {j['deploy_image']}"

    def p_tag(self):
        j = self.job
        tags = [j["new_image"]] + ([j["moving_image"]] if j["moving_image"] else [])
        for sh in self.all_hosts():
            for t in tags:
                sh.check(self.D + ["tag", j["loaded_image"], t], what="docker tag")
        msg = f"{j['loaded_image']} → " + ", ".join(tags)
        if j["registry"]:  # AD-7: only :<version> now; the moving tag goes to the registry after verify
            j["new_digest"] = self.push(j["new_image"])
            j["deploy_image"] = f"{j['moving_image'] or j['new_image']}@{j['new_digest']}"
            msg += f" · pushed {j['new_image']} {j['new_digest'][:19]}"
        else:  # the service spec names the moving tag (:dev), like the CI; on failure restore_tags moves it back
            j["deploy_image"] = j["moving_image"] or j["new_image"]
        self.save()
        return msg

    def p_deploy(self):
        j, D, svc = self.job, self.D, self.job["swarm_service"]
        ni = j["deploy_image"] or j["new_image"]
        if j["kind"] == JobKind.ROLLBACK and j["moving_image"]:
            self.sh.check(D + ["tag", j["new_image"], j["moving_image"]], what="docker tag")
        reg = ["--with-registry-auth"] if j["registry"] else []
        flags = ["--no-resolve-image", "--update-failure-action", "rollback"]
        if j["mode"] == DeployMode.UPDATE:
            argv = D + ["service", "update", "--image", ni, *reg, *flags,
                        "--update-monitor", f"{self.opt['update_monitor']}s", "--detach=true"]
            if (j["previous_digest"] == j["new_digest"]) if j["registry"] else j["previous_image"] == ni:
                argv.append("--force")
            argv.append(svc)
        else:
            c = self.m["create"]
            argv = D + ["service", "create", "--name", svc, "--replicas", str(c["replicas"])]
            for p in c["publish"]:
                pub, tgt = p.split(":")
                argv += ["--publish", f"published={pub},target={tgt},mode=host"]
            argv += [*reg, *flags, "--detach=true", ni]
        code, out = self.sh.run(argv)
        if code == 0:
            self.touched = True
        else:
            info = service_info(self.sh, svc)
            cur = info and info["Spec"]["TaskTemplate"]["ContainerSpec"]["Image"]
            if cur and (cur == ni if j["registry"] else strip_digest(cur) == ni):
                self.touched = True
            raise Fail(f"docker service {j['mode']} failed: {last_line(out)} (exit {code})")
        return f"service {svc} {'updating' if j['mode'] == 'update' else 'created'} to {ni}"

    def p_verify(self):
        j = self.job
        ni = j["deploy_image"] or j["new_image"]
        timeout = self.opt["converge_timeout"]
        deadline, last, new = time.monotonic() + timeout, None, []
        desired = 0
        while True:
            state, msg, desired, run = self.poll()
            new = [t for t in run if same_image(t.get("Image"), ni) and t.get("ID") not in self.old_tasks]
            s = f"update_state={state or 'none'} running={len(run)}/{desired} (new image {len(new)})"
            if s != last:
                self.log(s)
                last = s
            if state in ROLLBACK_STATES:
                self.swarm_auto = True
                raise Fail(f"swarm rejected the update ({msg})")
            if state == "paused":
                raise Fail(f"update paused: {msg}")
            if state in ("completed", None) and desired and len(run) == desired == len(new):
                break
            if time.monotonic() > deadline:
                raise Fail(f"not converged after {timeout}s (running {len(new)}/{desired} with new image)")
            time.sleep(2)
        url, parts = j.get("health_url") or self.m["health_url"], []
        if url:
            if not self.health_wait(url):
                raise Fail(f"health check failed: {url}")
            parts.append("health OK")
        if j["kind"] == JobKind.DEPLOY and j["health_script"]:
            self.log("running health script")
            ct = self.opt["converge_timeout"]
            code, out = self.sh.run(["timeout", str(ct), "bash", self.job_dir() + "/healthcheck.sh", f"--url={url}",
                                     f"--service={j['swarm_service']}"], timeout=ct + 30)
            if code:
                raise Fail(f"health script failed (exit {code}): {last_line(out)}")
            parts.append("health script OK")
        if j["registry"] and j["moving_image"]:  # AD-7: the registry moving tag only ever holds a verified image
            d2 = self.push(j["moving_image"])
            if d2 != j["new_digest"]:
                self.log(f"WARNING: {j['moving_image']} digest {d2} != {j['new_digest']}")
            parts.append(f"pushed :{split_ref(j['moving_image'])[1]}")
        return f"{desired}/{desired} tasks running {ni}" + "".join(" · " + p for p in parts)

    def p_cleanup(self):
        j, errors = self.job, []
        jd = self.job_dir()
        rt = getattr(self, "rt", None) or j["artifacts"]["remote_tar"]
        hosts = self.all_hosts() if self.sh else []
        argv = ["rm", "-rf", "--", jd] if jd else (["rm", "-f", "--", rt] if rt else None)
        for sh in hosts if argv else []:
            try:
                code, out = sh.run(argv)
                if code:
                    errors.append(f"{sh.host}:{sh.port}: {last_line(out)}")
            except Exception as e:
                errors.append(f"{sh.host}:{sh.port}: {e}")
        ok = not j["error"] and not getattr(self, "undone", False) and not any(
            p["status"] == PhaseStatus.FAILED for p in j["phases"])
        for key, tags in (j.get("load_tags") or {}).items():  # put back what format (2) load re-tagged
            sh = next((h for h in hosts if f"{h.host}:{h.port}" == key), None)
            for tag, old in tags.items() if sh else []:
                if ok and tag in (j["new_image"], j["moving_image"]):
                    continue  # success: these now name the deployed image; on failure put every tag back
                code, out = sh.run(self.D + (["tag", old, tag] if old else ["rmi", tag]))
                if code:
                    self.log(f"WARNING: could not restore tag {tag}: {last_line(out)}")
        extra = ""
        if not ok and self.sh and (j.get("registry") or j["moving_image"]) and j["kind"] == JobKind.DEPLOY and any(
                p["name"] == Phase.TAG and p["status"] in (PhaseStatus.SUCCESS, PhaseStatus.FAILED) for p in j["phases"]):
            self.sh.run(self.D + ["rmi", j["new_image"]])  # failed: the pushed :<ts> stays in the registry (AD-6)
        if ok and self.sh:
            if j["moving_image"] and j["kind"] == JobKind.DEPLOY:  # the image keeps only its old name (:dev)
                for sh in hosts:
                    sh.run(self.D + ["rmi", j["new_image"]])  # only the :<ts> tag; :<moving> keeps the image
            if self.opt.get("prune_after"):
                code, out = self.sh.run(self.D + ["system", "prune", "-f"], timeout=600)
                if code:
                    self.log(f"WARNING: docker system prune failed: {last_line(out)}")
                else:
                    extra = " · docker system prune done"
        shutil.rmtree(self.work, ignore_errors=True)
        self.log(f"removed local {self.work}")
        if errors:
            raise Fail("could not remove remote job files: " + "; ".join(errors))
        if (jd or rt) and self.sh:
            return f"removed {jd or 'remote tar'} and local temp files{extra}"
        return f"removed local temp files{extra}"
