"""Make one Build Packager-format package: <service>_<ts>.zip (AES-256) holding <service>_<ts>/<service>_<ts>.tar
(docker save of <service>:<ts>) plus the source folder. Run with the scratch venv (needs pyzipper).
Prints the zip path. --bad writes a plain tar without manifest.json instead of a docker archive."""
import argparse, glob, os, shutil, subprocess, tarfile, tempfile, time
import pyzipper

ap = argparse.ArgumentParser()
ap.add_argument("--repo", required=True)
ap.add_argument("--branch", default="main")
ap.add_argument("--service", required=True)
ap.add_argument("--password", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--bad", action="store_true")
a = ap.parse_args()
assert a.service.startswith("sdtest"), "test packages must be named sdtest*"
os.makedirs(a.out, exist_ok=True)

ts = time.strftime("%Y%m%d_%H%M%S")
def taken(ts):  # unique second across the release tree (out and its parent)
    return any(glob.glob(os.path.join(d, "**", f"*_{ts}.zip"), recursive=True) for d in (a.out, os.path.dirname(a.out)))


while taken(ts):
    time.sleep(0.2)
    ts = time.strftime("%Y%m%d_%H%M%S")
top = f"{a.service}_{ts}"
tmp = tempfile.mkdtemp(prefix="sdtest-pkg-")
try:
    F = os.path.join(tmp, top)
    src = os.path.join(F, os.path.basename(a.repo.rstrip("/")))
    subprocess.run(["git", "clone", "-q", "--depth", "1", "-b", a.branch, "file://" + os.path.abspath(a.repo), src], check=True)
    shutil.rmtree(os.path.join(src, ".git"))
    tar = os.path.join(F, top + ".tar")
    if a.bad:
        with tarfile.open(tar, "w") as t:
            t.add(os.path.join(src, "README.md"), "README.md")
    else:
        image = f"{a.service.lower()}:{ts}"
        subprocess.run(["docker", "build", "-q", "-t", image, src], check=True, stdout=subprocess.DEVNULL)
        try:
            subprocess.run(["docker", "save", "-o", tar, image], check=True)
        finally:
            subprocess.run(["docker", "rmi", image], check=True, stdout=subprocess.DEVNULL)
    zpath = os.path.join(a.out, top + ".zip")
    with pyzipper.AESZipFile(zpath, "w", compression=pyzipper.ZIP_DEFLATED, encryption=pyzipper.WZ_AES) as z:
        z.setpassword(a.password.encode())
        z.setencryption(pyzipper.WZ_AES, nbits=256)
        for root, _, files in os.walk(F):
            for name in files:
                full = os.path.join(root, name)
                z.write(full, f"{top}/{os.path.relpath(full, F)}")
    print(zpath)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
