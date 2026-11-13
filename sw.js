// One service worker for every engine, registered in the site's folder (the root
// locally, /<bucket>/ on S3). Ultraviolet handles <folder>uv/service/*, Scramjet handles
// <folder>scramjet/*, Scramjet 2 (beta) handles <folder>sj2/*, everything else (the site
// itself) passes through untouched.
const base = new URL("./", self.location.href).pathname;
importScripts("uv/uv.bundle.js", "uv/uv.config.js", "uv/uv.sw.js", "scram/scramjet.all.js", "scram2/controller.sw.js");

const uv = new UVServiceWorker();
const { ScramjetServiceWorker } = $scramjetLoadWorker();

// Scramjet keeps its config in IndexedDB, and the page creates that database.
// The ScramjetServiceWorker constructor opens it, so create it only once the
// database exists; opening it first would create it empty and break the page.
let scramjet = null;
const getScramjet = () => (scramjet ??= new ScramjetServiceWorker());
indexedDB.databases?.().then((dbs) => {
	if (dbs.some((db) => db.name === "$scramjet")) getScramjet();
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
	if (event.data === "claim") self.clients.claim();
});

async function isScramjetRequest(event) {
	const { pathname } = new URL(event.request.url);
	if (pathname.startsWith(base + "scramjet/")) return true;
	// Proxied Scramjet pages load the wasm through the worker, which wraps it as a script.
	if (pathname !== base + "scram/scramjet.wasm.wasm" || !event.clientId) return false;
	const client = await self.clients.get(event.clientId);
	return !!client && new URL(client.url).pathname.startsWith(base + "scramjet/");
}

async function handleRequest(event) {
	if (uv.route(event)) {
		return await uv.fetch(event);
	}
	if (await isScramjetRequest(event)) {
		const sj = getScramjet();
		await sj.loadConfig();
		if (sj.route(event)) {
			const res = await sj.fetch(event).catch(() => null);
			// Scramjet can get stuck answering everything with an empty 500 until the worker
			// restarts (seen in testing, cause unknown). Rebuild it once and retry, as a restart would.
			const stuck = !res || (res.status === 500 && !res.headers.get("content-type"));
			if (!stuck || !["GET", "HEAD"].includes(event.request.method)) return res || Response.error();
			scramjet = null;
			const fresh = getScramjet();
			await fresh.loadConfig();
			return await fresh.fetch(event);
		}
	}
	return await fetch(event.request);
}

// Zip sites from the HTML section: js/files.js unpacks the zip into this cache.
async function zipSite(request) {
	const url = new URL(request.url);
	if (url.pathname.endsWith("/")) url.pathname += "index.html";
	const cache = await caches.open("flux-zipsite");
	const hit = await cache.match(url.href, { ignoreSearch: true });
	return hit || new Response("That file isn't in the zip.", { status: 404, headers: { "content-type": "text/plain" } });
}

// Only proxy traffic goes through the worker; games and site files load natively (faster, range requests work).
self.addEventListener("fetch", (event) => {
	if (new URL(event.request.url).pathname.startsWith(base + "zipsite/")) return event.respondWith(zipSite(event.request));
	// Scramjet 2 knows its own tabs (the page's controller registers them with this worker).
	if ($scramjetController.shouldRoute(event)) return event.respondWith(fluxErrors(event.request, $scramjetController.route(event), "Scramjet 2"));
	const { pathname } = new URL(event.request.url);
	if (
		pathname.startsWith(__uv$config.prefix) ||
		pathname.startsWith(base + "scramjet/") ||
		pathname === base + "scram/scramjet.wasm.wasm"
	) {
		event.respondWith(fluxErrors(event.request, handleRequest(event), pathname.startsWith(__uv$config.prefix) ? "Ultraviolet" : "Scramjet"));
	}
});

// Flux-styled error pages ------------------------------------------------------------------
// When a proxied page fails, each engine answers with its own plain error page (status 500). For
// pages (not images, scripts...), swap in one that matches Flux: centred, the address, the error,
// Try again and Copy error. Ultraviolet and Scramjet put the details in a script inside their page
// (`errorTrace.value = "..."; fetchedURL.textContent = "..."`); Scramjet 2 sends plain text.
async function fluxErrors(request, pending, engine) {
	const res = await pending;
	if (res.status !== 500 || request.mode !== "navigate") return res;
	const body = await res.clone().text().catch(() => "");
	let trace = "";
	let url = "";
	const script = /<script src="data:application\/javascript,([^"]*)"/.exec(body);
	if (script) {
		const code = decodeURIComponent(script[1]);
		const field = (name) => {
			const m = new RegExp(name + ' = ("(?:[^"\\\\]|\\\\.)*")').exec(code);
			return m ? JSON.parse(m[1]) : "";
		};
		trace = field("errorTrace.value");
		url = field("fetchedURL.textContent");
	} else if (/^Internal Service Worker Error/.test(body)) {
		trace = body;
		// Scramjet 2 doesn't say which address failed, but its own: sj2/<controller>/<frame>/<encoded URL>.
		const encoded = new URL(request.url).pathname.split("/sj2/")[1]?.split("/").slice(2).join("/");
		if (encoded) url = decodeURIComponent(encoded);
	} else {
		return res; // a real 500 from the site itself: show it as it is
	}
	const headers = { "content-type": "text/html" };
	if (self.crossOriginIsolated) headers["Cross-Origin-Embedder-Policy"] = "require-corp";
	return new Response(errorPage(url, trace, engine), { status: 500, headers });
}

function errorPage(url, trace, engine) {
	let host = "";
	try {
		host = new URL(url).hostname;
	} catch {
		// No address (Scramjet 2): the heading says "This page".
	}
	const data = JSON.stringify({ url, trace, engine, host }).replace(/</g, "\\u003c"); // no "</script>" can end the script early
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Couldn't load this page</title>
<style>
@font-face { font-family: "Geist"; src: url(${base}fonts/geist.woff2) format("woff2"); font-weight: 100 900; }
html { background: #0e0e11; }
body { max-width: 34rem; margin: 0; padding: 20vh 24px 48px max(24px, 12vw); color: #f5f6f8; font: 15px/1.6 "Geist", ui-sans-serif, system-ui, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
h1 { margin: 0; font-size: clamp(26px, 6vw, 36px); font-weight: 600; line-height: 1.15; letter-spacing: -0.025em; overflow-wrap: anywhere; }
.url { margin: 8px 0 0; overflow: hidden; color: #6b6b73; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.why { margin: 22px 0 26px; color: #9a9aa2; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 20px; }
button { font: inherit; cursor: pointer; }
#retry { height: 38px; padding: 0 18px; border: 0; border-radius: 6px; background: #f5f6f8; color: #0e0e11; font-weight: 550; }
#retry:hover { background: #fff; }
#copy { padding: 4px 0; border: 0; background: none; color: #9a9aa2; text-decoration: underline; text-decoration-color: #3a3a42; text-underline-offset: 4px; }
#copy:hover { color: #f5f6f8; text-decoration-color: currentColor; }
button:focus-visible, summary:focus-visible { outline: 2px solid #f5f6f8; outline-offset: 3px; }
details { margin-top: 40px; color: #6b6b73; font-size: 13px; }
summary { display: flex; align-items: center; gap: 8px; width: fit-content; cursor: pointer; list-style: none; transition: color 0.2s ease; }
summary::-webkit-details-marker { display: none; }
summary::before { content: ""; width: 6px; height: 6px; margin-top: -2px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1); }
details[open] summary::before { margin-top: -4px; transform: rotate(45deg); }
summary:hover { color: #9a9aa2; }
/* Opens and closes smoothly (Chrome 131+); older browsers just open instantly. */
:root { interpolate-size: allow-keywords; }
details::details-content { block-size: 0; overflow: hidden; opacity: 0; transition: block-size 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease, content-visibility 0.4s allow-discrete; }
details[open]::details-content { block-size: auto; opacity: 1; }
@media (prefers-reduced-motion: reduce) { details::details-content, summary::before { transition: none; } }
pre { max-height: 40vh; margin: 12px 0 0; padding: 0 0 0 14px; overflow: auto; border-left: 2px solid #26262d; color: #9a9aa2; font: 12px/1.6 ui-monospace, "Cascadia Code", Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
</head>
<body>
<h1 id="title">This page didn't load</h1>
<p class="url" id="url"></p>
<p class="why">The proxy got an error back instead of the page. Try again, or switch the proxy engine or Wisp server in Settings.</p>
<div class="actions"><button id="retry" type="button">Try again</button><button id="copy" type="button">Copy error</button></div>
<details><summary id="summary">Error details</summary><pre id="trace"></pre></details>
<script>
const d = ${data};
if (d.host) document.getElementById("title").textContent = d.host + " didn't load";
const url = document.getElementById("url");
if (d.url) {
	url.textContent = d.url;
	url.title = d.url;
} else {
	url.remove();
}
document.getElementById("summary").textContent = "Error details from " + d.engine;
document.getElementById("trace").textContent = d.trace || "The proxy gave no details.";
document.getElementById("retry").onclick = () => location.reload();
const copy = document.getElementById("copy");
copy.onclick = async () => {
	const text = (d.url ? d.url + "\\n" : "") + d.trace + "\\n(" + d.engine + ")";
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const box = Object.assign(document.createElement("textarea"), { value: text });
		document.body.append(box);
		box.select();
		document.execCommand("copy");
		box.remove();
	}
	copy.textContent = "Copied";
	setTimeout(() => (copy.textContent = "Copy error"), 1500);
};
</script>
</body>
</html>`;
}
