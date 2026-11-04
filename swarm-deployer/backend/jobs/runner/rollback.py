"""Rollback after a failed deploy, registry repair, and recovery of interrupted jobs."""
from backend.core.constants import ROLLBACK_STATES
from backend.core.enums import DeployMode, JobKind, Phase, PhaseStatus, RollbackState
from backend.core.errors import Fail
from backend.remote.ssh import Shell, connect_target
from backend.remote.swarm import service_info
from backend.utils.dates import now_iso
from backend.utils.images import strip_digest
from backend.utils.text import last_line


class RollbackMixin:
    def restore_tags(self):
        """tag/deploy/verify failed: point previous_image and the moving tag back at the old image ID.
        Returns True if previous_image had been re-pointed by this job (e.g. service ran <repo>:latest)."""
        j, pid, prev = self.job, self.prev_id, self.job["previous_image"]
        if not (pid and prev and self.sh):
            return False
        code, out = self.sh.run(self.D + ["image", "inspect", "--format", "{{.Id}}", prev], quiet=True)
        moved = code != 0 or last_line(out) != pid
        btag = (j.get("backup") or {}).get("tag")
        if btag:
            c, o = self.sh.run(self.D + ["image", "inspect", "--format", "{{.Id}}", btag], quiet=True)
            if c != 0 or last_line(o) != pid:
                btag = None  # backup tag missing or not the old image: use the saved image ID
        for sh in self.all_hosts():  # the backup tag lives on the manager; other nodes use the same image ID
            for name in dict.fromkeys(n for n in (prev, j["moving_image"]) if n):
                sh.run(self.D + ["tag", btag if btag and sh is self.sh else pid, name])
        self.log(f"==> [rollback] {', '.join(n for n in (prev, j['moving_image']) if n)} ← backup image {btag or pid[:19]}")
        return moved


    # --- automatic rollback (SPEC §6.11), runs inside the failed tag/deploy/verify phase
    def auto_rollback(self):
        j = self.job
        try:
            moved, restored = self.restore_tags(), True
        except Exception as e:
            moved, restored = True, False  # unknown: don't trust previous_image, prefer the backup tag
            self.log(f"==> [rollback] restoring tags failed: {type(e).__name__}: {e}")
        rep = self.registry_repair()  # before any redeploy: a by-name previous_image must pull the old image
        if not self.touched or not self.sh:
            return rep
        D, svc, prev = self.D, j["swarm_service"], j["previous_image"]
        L = lambda s: self.log("==> [rollback] " + s)  # noqa: E731
        rb = {"performed": True, "method": None, "to_image": None, "ok": False}
        reason = ""
        try:
            if j["mode"] == DeployMode.CREATE:
                L(f"removing new service {svc}")
                rb.update(method="removed_new_service", ok=self.sh.run(D + ["service", "rm", svc])[0] == 0)
                reason = "service rm failed"
            elif j.get("registry"):  # by digest: whatever the registry's tags point at now
                pref = j.get("previous_ref") or prev
                rb["to_image"] = pref
                if self.swarm_auto:
                    L(f"swarm is rolling back by itself, waiting for {pref}")
                    rb.update(method="swarm_auto", ok=self.wait_on(pref, RollbackState.COMPLETED))
                if not rb["ok"]:
                    bdg = (j["backup"] or {}).get("digest")
                    if "@" in pref:
                        img, meth = pref, "previous_digest"
                    elif bdg:  # never the backup- tag in the spec: later @current deploys would fail
                        img, meth = f"{j['moving_image'] or prev}@{bdg}", "backup_digest"
                    else:
                        img, meth = prev, "previous_image"
                    L(f"redeploying {img} ({meth})")
                    code, _ = self.sh.run(D + ["service", "update", "--image", img, "--with-registry-auth",
                                               "--no-resolve-image", "--force", "--detach=true", svc])
                    rb.update(method=meth, to_image=img, ok=code == 0 and self.wait_on(img))
                reason = f"service did not converge on {rb['to_image']}"
            else:
                rb["to_image"] = prev
                if self.swarm_auto:
                    L(f"swarm is rolling back by itself, waiting for {prev}")
                    rb.update(method="swarm_auto", ok=self.wait_on(prev, RollbackState.COMPLETED))
                elif moved:
                    L(f"{prev} was re-tagged by this deploy; its tasks may run the new image")
                else:
                    L(f"docker service rollback {svc} (back to {prev})")
                    code, _ = self.sh.run(D + ["service", "rollback", "--detach=true", svc])
                    rb.update(method="service_rollback", ok=code == 0 and self.wait_on(prev))
                btag = (j["backup"] or {}).get("tag")
                if moved and btag:
                    rb["ok"] = False  # previous_image name was reused for the new image: redeploy the backup tag
                if not rb["ok"]:
                    # restore_tags re-pointed prev at the old image: keep the real tag in the spec, not backup-<ts>
                    present = [i for i in ((prev, btag) if restored else (btag, prev)) if i and self.sh.run(
                        D + ["image", "inspect", "--format", "{{.Id}}", i])[0] == 0]
                    img = present[0] if present else None
                    if btag and img != btag:
                        L(f"backup tag {btag} is gone from the target")
                    if img:
                        L(f"falling back to {img}")
                        code, _ = self.sh.run(D + ["service", "update", "--image", img, "--no-resolve-image",
                                                   "--force", "--detach=true", svc])
                        rb.update(method="backup_tag" if img == btag else "previous_image", to_image=img,
                                  ok=code == 0 and self.wait_on(img))
                reason = f"service did not converge on {rb['to_image']}"
            url = j.get("health_url") or (self.m or {}).get("health_url")
            if j["mode"] == DeployMode.UPDATE and rb["ok"] and url and not self.health_wait(url):
                rb["ok"] = False
                reason = "health check failed after rollback"
        except Exception as e:
            reason = f"{type(e).__name__}: {e}"
        j["rollback"] = rb
        self.save()
        L(f"{'done' if rb['ok'] else 'FAILED'}: method {rb['method']}, to {rb['to_image'] or '(service removed)'}")
        if not rb["ok"]:
            suffix = f"; ROLLBACK FAILED: {reason}"
        else:
            suffix = f"; rolled back to {rb['to_image']}" if rb["to_image"] else f"; removed new service {svc}"
        return suffix + rep

    def registry_repair(self):
        """AD-7: the registry moving tag only changed if verify's push started. Put the previous image back."""
        j = self.job
        mi = j.get("moving_image")
        if not (self.sh and j.get("registry") and mi and mi in (j.get("pushed") or []) and j.get("previous_ref")):
            return ""
        if not j.get("previous_digest") and not self.prev_id:  # local tag may still be the new image
            self.log(f"==> [rollback] WARNING: no previous digest or image id; registry {mi} not restored")
            return f" (registry {mi} not restored)"
        try:
            pref = self.prev_ref()
            if self.image_id(self.sh, pref) is None:
                self.sh.check(self.D + ["pull", pref], timeout=1800, what="docker pull")
            self.sh.check(self.D + ["tag", pref, mi], what="docker tag")
            d = self.push(mi)
            self.log(f"==> [rollback] {mi} -> {d} again")
            return ""
        except Exception as e:
            self.log(f"==> [rollback] WARNING: registry {mi} not restored: {e}")
            return f" (registry {mi} not restored)"

    def recover(self):
        """The server died while this job ran (SPEC §4). Undo a half-done tag/deploy/verify with the same
        restore_tags/auto_rollback as a verify failure, then clean up. Idempotent: the job stays running (and its
        service busy) until this ends, and an already rolled-back service no longer runs new_image."""
        j, msg, err = self.job, "interrupted (server restart)", None
        ph = {p["name"]: p for p in j["phases"]}
        st = lambda n: (ph.get(n) or {}).get("status")  # noqa: E731
        reached = (PhaseStatus.RUNNING, PhaseStatus.SUCCESS, PhaseStatus.FAILED)
        undo = any(st(n) in reached for n in (Phase.TAG, Phase.DEPLOY, Phase.VERIFY)) and st(Phase.VERIFY) != PhaseStatus.SUCCESS
        if not self.t:  # died before the target was known (old job file): nothing remote to undo
            undo = False
        try:
            self.log("==> [recovery] server restarted while this job was running")
            try:
                if undo or j["artifacts"]["remote_tar"] or j["artifacts"].get("job_dir"):
                    self.sh = connect_target(self.t, self.log)
                    if j.get("registry"):  # own try: rolling back by digest needs no login
                        try:
                            self.registry_login(self.sh)
                        except Exception as e:
                            self.log(f"WARNING: {e}" if isinstance(e, Fail) else
                                     f"WARNING: registry login failed: {type(e).__name__}: {e}")
                    for n in self.t["extra_nodes"] if j["kind"] == JobKind.DEPLOY and not j.get("registry") else []:
                        try:
                            self.nodes.append(Shell(n, self.t["host_key_policy"], self.t["docker_cmd"], self.log))
                        except Exception as e:
                            self.log(f"WARNING: node {n['host']}:{n['port']}: {type(e).__name__}: {e}")
            except Exception as e:
                err = f"{type(e).__name__}: {e}"
                self.log(f"==> [recovery] cannot reach target: {err}")
            if undo and err:
                msg += f"; rollback failed: {err}"
            elif undo:
                try:
                    btag = (j["backup"] or {}).get("tag")
                    if btag:
                        code, out = self.sh.run(self.D + ["image", "inspect", "--format", "{{.Id}}", btag], quiet=True)
                        self.prev_id = last_line(out) if code == 0 else None
                    info = service_info(self.sh, j["swarm_service"]) or {}
                    full = info.get("Spec", {}).get("TaskTemplate", {}).get("ContainerSpec", {}).get("Image")
                    img = strip_digest(full)
                    hit = full == j.get("deploy_image") if j.get("registry") else img == (j.get("deploy_image") or j["new_image"])
                    self.touched = st(Phase.DEPLOY) in reached and bool(info) and (j["mode"] == DeployMode.CREATE or hit)
                    self.swarm_auto = (info.get("UpdateStatus") or {}).get("State") in ROLLBACK_STATES
                    suffix = self.auto_rollback()
                    msg += suffix.replace("; ROLLBACK FAILED:", "; rollback failed:") if suffix else \
                        f"; tags restored, service still runs {img or '(none)'}"
                except Exception as e:
                    msg += f"; rollback failed: {type(e).__name__}: {e}"
            self.undone = undo  # cleanup: an interrupted, undone job is not a success
            c = ph.get("cleanup")
            if c:
                c.update(status=PhaseStatus.RUNNING, started_at=now_iso())
                self.save()
                try:
                    out = self.p_cleanup()
                    if (j["artifacts"]["remote_tar"] or j["artifacts"].get("job_dir")) and not self.sh:
                        raise Fail(f"remote job files left on target ({err})")
                    c.update(status=PhaseStatus.SUCCESS, message=out)
                except Exception as e:
                    c.update(status=PhaseStatus.FAILED, message=str(e)[:300])
                c["finished_at"] = now_iso()
                self.log(f"==> [cleanup] {c['status']}: {c['message']}")
        except Exception as e:
            msg += f"; recovery error: {type(e).__name__}: {e}"
        finally:
            j["error"] = f"{j['error']} ({msg})" if j["error"] else msg
            self.finish()
