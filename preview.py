#!/usr/bin/env python3
"""Get a temporary public HTTPS link to test the proxy, using Cloudflare.

Two modes:

  tunnel (default)  Serves the site/ folder from this computer and opens a
                    Cloudflare Quick Tunnel to it. You get a random
                    https://<words>.trycloudflare.com link that works until you
                    press Ctrl+C. No Cloudflare account needed; cloudflared is
                    downloaded automatically if it isn't installed.

  pages             Uploads the site/ folder to Cloudflare Pages as a preview
                    deployment (https://<branch>.<project>.pages.dev). Needs a
                    free Cloudflare account and Node.js (it runs wrangler via
                    npx). The link stays up until you delete the deployment.

Examples:

  python preview.py                 # quick tunnel
  python preview.py --mode pages    # Cloudflare Pages

Uses only the Python standard library (3.8+).
"""
import argparse
import functools
import http.server
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

SITE = Path(__file__).resolve().parent
WRANGLER = "wrangler@4.149.0"
CLOUDFLARED_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/"
TUNNEL_URL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
PAGES_URL = re.compile(r"https://[a-z0-9.-]+\.pages\.dev")


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


# --- Quick Tunnel --------------------------------------------------------------


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".webp": "image/webp",
        ".avif": "image/avif",
        ".jfif": "image/jpeg",
    }

    def end_headers(self):
        # Always serve the latest build, including sw.js updates.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format, *args):
        pass


def start_server(directory, port):
    handler = functools.partial(Handler, directory=str(directory))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def cache_dir():
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home()))
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / "static-proxy"


def cloudflared_asset():
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "amd64"
    if system == "linux":
        return f"cloudflared-linux-{arch}"
    if system == "darwin":
        return f"cloudflared-darwin-{arch}.tgz"
    if system == "windows":
        return "cloudflared-windows-amd64.exe"
    fail(f"No cloudflared download for {platform.system()} {platform.machine()}. Install it yourself and retry.")


def find_cloudflared():
    found = shutil.which("cloudflared")
    if found:
        return found
    binary = cache_dir() / ("cloudflared.exe" if os.name == "nt" else "cloudflared")
    if binary.exists():
        return str(binary)

    asset = cloudflared_asset()
    print(f"Downloading cloudflared ({asset})...")
    binary.parent.mkdir(parents=True, exist_ok=True)
    download = binary.parent / asset
    try:
        urllib.request.urlretrieve(CLOUDFLARED_URL + asset, download)
    except OSError as err:
        fail(f"Couldn't download cloudflared: {err}")
    if asset.endswith(".tgz"):
        with tarfile.open(download) as archive:
            member = archive.getmember("cloudflared")
            with archive.extractfile(member) as src, open(binary, "wb") as dst:
                shutil.copyfileobj(src, dst)
        download.unlink()
    else:
        download.replace(binary)
    binary.chmod(binary.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return str(binary)


def run_tunnel(site, port, open_browser, timeout):
    server = start_server(site, port)
    local = f"http://127.0.0.1:{server.server_address[1]}"
    print(f"Serving {site} at {local}")

    process = subprocess.Popen(
        [find_cloudflared(), "tunnel", "--no-autoupdate", "--url", local],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
    )
    found = threading.Event()
    output = []

    def read_output():
        for line in process.stdout:
            output.append(line.rstrip())
            match = TUNNEL_URL.search(line)
            if match and not found.is_set():
                found.url = match.group(0)
                found.set()

    threading.Thread(target=read_output, daemon=True).start()

    try:
        print("Starting Cloudflare Quick Tunnel...")
        if not found.wait(timeout):
            print("\n".join(output[-20:]), file=sys.stderr)
            fail("cloudflared didn't report a link. Check your connection (it needs outbound port 7844 or 443).")
        print()
        print(f"  Test link: {found.url}")
        print()
        print("It can take a few seconds before the link starts working.")
        print("Press Ctrl+C to stop; the link stops working when you do.")
        if open_browser:
            time.sleep(3)
            webbrowser.open(found.url)
        while process.poll() is None:
            time.sleep(0.5)
        print("\n".join(output[-20:]), file=sys.stderr)
        fail("cloudflared exited unexpectedly.")
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        process.terminate()
        try:
            process.wait(5)
        except subprocess.TimeoutExpired:
            process.kill()
        server.shutdown()


# --- Cloudflare Pages ----------------------------------------------------------


def run_pages(site, project, branch, open_browser):
    npx = shutil.which("npx")
    if not npx:
        fail("Pages mode needs Node.js (for npx wrangler). Install it from https://nodejs.org or use --mode tunnel.")
    if not (os.environ.get("CLOUDFLARE_API_TOKEN") or (Path.home() / ".wrangler").exists()):
        print("If you aren't logged in, wrangler will open a browser to log in to Cloudflare.")
        print("(Or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.)\n")

    # Creating the project fails harmlessly if it already exists.
    subprocess.run(
        [npx, "--yes", WRANGLER, "pages", "project", "create", project, "--production-branch", "main"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    result = subprocess.run(
        [npx, "--yes", WRANGLER, "pages", "deploy", str(site),
         "--project-name", project, "--branch", branch, "--commit-dirty=true"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
    )
    print(result.stdout)
    if result.returncode != 0:
        fail("wrangler pages deploy failed (see output above).")

    alias = f"https://{branch}.{project}.pages.dev"
    urls = PAGES_URL.findall(result.stdout)
    print(f"  Test link:       {alias}")
    if urls:
        print(f"  This deployment: {urls[-1]}")
    print()
    print("Preview deployments stay up until you delete them in the Cloudflare dashboard")
    print(f"(Workers & Pages -> {project} -> Deployments). New links can take a minute to start working.")
    if open_browser:
        webbrowser.open(alias)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mode", choices=("tunnel", "pages"), default="tunnel",
                        help="tunnel = temporary trycloudflare.com link (default), pages = Cloudflare Pages preview")
    parser.add_argument("--port", type=int, default=0, help="local port for tunnel mode (default: any free port)")
    parser.add_argument("--project", default="static-proxy-preview", help="Cloudflare Pages project name")
    parser.add_argument("--branch", default="preview", help="Cloudflare Pages preview branch name")
    parser.add_argument("--open", action="store_true", help="open the link in your browser")
    parser.add_argument("--timeout", type=int, default=60, help="seconds to wait for the tunnel link")
    args = parser.parse_args()

    if not (SITE / "index.html").exists():
        fail(f"{SITE} is missing; preview.py must sit in the site root.")
    if args.mode == "tunnel":
        run_tunnel(SITE, args.port, args.open, args.timeout)
    else:
        run_pages(SITE, args.project, args.branch, args.open)


if __name__ == "__main__":
    main()
