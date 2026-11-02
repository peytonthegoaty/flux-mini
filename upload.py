"""
Puts Flux Mini on GitHub and turns on GitHub Pages, so it gets a free https link.

    python upload.py                 uses the GitHub CLI (gh) to make a repo called flux-mini
    python upload.py my-repo-name    same, with your own repo name
    python upload.py --dry-run       build and show the size, change nothing online

Run it again after any change to push the update. Needs git, and the GitHub CLI signed in
(`gh auth login`). The site then opens at https://<you>.github.io/<repo>/extra.svg?f3
"""

import subprocess
import sys
from pathlib import Path

from build_svg import build

ROOT = Path(__file__).resolve().parent
MAX_FILE = 100_000_000  # GitHub refuses single files over 100 MB
MAX_SITE = 1_000_000_000  # GitHub Pages sites are capped at 1 GB


def run(*args, check=True):
    print("$", " ".join(args))
    return subprocess.run(args, cwd=ROOT, check=check, text=True, capture_output=args[0] == "gh" and args[1] == "api")


def set_identity():
    """Git won't commit without a name, so use the GitHub login and its private no-reply email."""
    if subprocess.run(["git", "config", "user.email"], cwd=ROOT, capture_output=True).returncode == 0:
        return
    who = ["gh", "api", "user", "--jq", '.login + " " + (.id|tostring)']
    login, user_id = subprocess.run(who, capture_output=True, text=True, check=True).stdout.split()
    run("git", "config", "user.name", login)
    run("git", "config", "user.email", "%s+%s@users.noreply.github.com" % (user_id, login))


def check_size():
    files = [f for f in ROOT.rglob("*") if f.is_file() and ".git" not in f.parts]
    too_big = [str(f.relative_to(ROOT)) for f in files if f.stat().st_size >= MAX_FILE]
    total = sum(f.stat().st_size for f in files)
    print("%d files, %.0f MB" % (len(files), total / 1e6))
    if too_big or total >= MAX_SITE:
        sys.exit("Too big for GitHub: %s" % (too_big or "the whole site is over 1 GB"))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    repo = args[0] if args else "flux-mini"
    build()
    check_size()
    if "--dry-run" in sys.argv:
        print("Dry run: nothing was uploaded.")
        return

    if not (ROOT / ".git").exists():
        run("git", "init", "-b", "main")
    run("git", "config", "http.postBuffer", "524288000")  # large pushes fail on the default buffer
    set_identity()
    run("git", "add", "-A")
    if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT).returncode:
        run("git", "commit", "-m", "Update Flux Mini")

    if subprocess.run(["git", "remote", "get-url", "origin"], cwd=ROOT, capture_output=True).returncode:
        run("gh", "repo", "create", repo, "--public", "--source", ".", "--remote", "origin", "--push")
    else:
        run("git", "push", "-u", "origin", "main")

    full = subprocess.run(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    # Fails harmlessly if Pages is already on.
    run("gh", "api", "repos/%s/pages" % full, "-X", "POST", "-f", "source[branch]=main", "-f", "source[path]=/", check=False)
    owner, name = full.split("/")
    print("Done. In a minute or two: https://%s.github.io/%s/extra.svg?f3" % (owner.lower(), name))


if __name__ == "__main__":
    main()
