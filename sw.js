// One service worker for both engines, registered in the site's folder (the root
// locally, /<bucket>/ on S3). Ultraviolet handles <folder>uv/service/*, Scramjet handles
// <folder>scramjet/*, everything else (the site itself) passes through untouched.
const base = new URL("./", self.location.href).pathname;
importScripts("uv/uv.bundle.js", "uv/uv.config.js", "uv/uv.sw.js", "scram/scramjet.all.js");

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

// Only proxy traffic goes through the worker; games and site files load natively (faster, range requests work).
self.addEventListener("fetch", (event) => {
	const { pathname } = new URL(event.request.url);
	if (
		pathname.startsWith(__uv$config.prefix) ||
		pathname.startsWith(base + "scramjet/") ||
		pathname === base + "scram/scramjet.wasm.wasm"
	) {
		event.respondWith(handleRequest(event));
	}
});
