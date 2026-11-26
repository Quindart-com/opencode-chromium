"""Check the actual release archives or Git inputs. Diagnostics contain filenames only."""
import argparse
import io
import re
import subprocess
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

SECRET = re.compile(rb"-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,}|sk-(?:proj-)?[A-Za-z0-9_-]{40,}|AKIA[0-9A-Z]{16}")
HOST = re.compile(rb"https://([a-z0-9-]+)\.convex\.(?:site|cloud)\b", re.I)
FIXTURES = {b"fixture-registry", b"offline-pattern-fixture"}
HOME = str(Path.home()).replace("\\", "/").rstrip("/").encode().lower()
def inspect(name, data, release=False, depth=0):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or any(part.startswith(".env") and part != ".env.example" for part in path.parts) or path.suffix == ".pem":
        raise ValueError("Unexpected private path: " + name)
    # Git tracks the ZIPs as blobs, so inspect their members as well.
    if path.suffix == ".zip" and depth < 2:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for member in archive.infolist():
                inspect(member.filename, archive.read(member), release, depth + 1)
        return
    if SECRET.search(data) or any(match[1].lower() not in FIXTURES for match in HOST.finditer(data)):
        raise ValueError("Credential or deployment URL in " + name)
    if len(HOME) > 5 and HOME + b"/" in data.replace(b"\\", b"/").lower():
        raise ValueError("Local home path in " + name)
    if release and path.name == "background.js" and b"com.opencode.browser.site_registry_dev" in data:
        raise ValueError("Development bridge in " + name)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--git", action="store_true")
    parser.add_argument("archives", nargs="*")
    args = parser.parse_args()
    if not (args.git or args.archives):
        parser.error("Supply --git or an archive")
    if args.git:
        files = subprocess.check_output(["git", "-c", "safe.directory=" + Path.cwd().as_posix(), "ls-files", "-z"])
        for item in files.decode().split("\0"):
            if item and Path(item).is_file():
                inspect(item, Path(item).read_bytes())
    for name in args.archives:
        archive = Path(name)
        if archive.suffix == ".zip":
            inspect(archive.name, archive.read_bytes(), True)
        else:
            with tarfile.open(archive, "r:gz") as tar:
                for member in tar:
                    if member.isfile():
                        inspect(member.name, tar.extractfile(member).read(), True)
    print("Public artifact checks passed.")

if __name__ == "__main__":
    main()
