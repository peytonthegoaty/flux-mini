// Your own files: HTML pages, text notes and game shortcuts, kept in IndexedDB (pages can be large).
// The HTML section and the OS desktop share them; a "flux:files" event fires after every change.
import { store } from "./background.js";
import { toast } from "./modal.js";
import { settings } from "./settings.js";
import { pickWisp } from "./wisp.js";

const KEY = "files";
export const files = [];
export const filesReady = store("readonly", (s) => s.get(KEY)).then(
	(list) => Array.isArray(list) && files.push(...list),
	() => {} // no IndexedDB: files last for this page load
);

export function saveFiles() {
	document.dispatchEvent(new Event("flux:files"));
	store("readwrite", (s) => s.put(files, KEY)).catch(() => toast("Couldn't save your files in this browser."));
}

export function addFile(file) {
	file.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
	files.push(file);
	saveFiles();
	return file;
}

export function removeFile(id) {
	const i = files.findIndex((f) => f.id === id);
	if (i >= 0) files.splice(i, 1);
	saveFiles();
}

// Launch With Proxy, the same way as the Eaglercraft Launcher: the page's WebSockets go through Wisp.
let proxyReady = null;
function proxy() {
	proxyReady ??= Promise.all([pickWisp(settings.wisp), import("../edutools/launcher/proxyws.js")])
		.then(async ([wisp, { startProxy, proxySockets }]) => {
			await startProxy(wisp);
			window.__fluxProxySockets = proxySockets;
		})
		.catch((err) => {
			proxyReady = null;
			throw err;
		});
	return proxyReady;
}

// With the proxy on, a first script (right after the doctype, so the page keeps its rendering mode)
// swaps in the proxied WebSocket before the page's own scripts run.
const withProxy = (code) => code.replace(/^(\s*<!doctype[^>]*>)?/i, (doctype) => doctype + "<script>parent.__fluxProxySockets(window)</script>");

// The address that runs a page: a blob: for pasted code or a single file, or a zipped site served
// by sw.js from the cache. Single pages can't load files they link to; zip sites can.
export async function htmlUrl(file) {
	if (file.proxy) await proxy();
	if (file.zip) return zipUrl(file);
	return URL.createObjectURL(new Blob([file.proxy ? withProxy(file.code) : file.code], { type: "text/html" }));
}

// Zip sites ----------------------------------------------------------------------------------
// No server: the zip is unpacked here into Cache Storage under <site>/zipsite/<file id>/, and sw.js
// answers requests for that folder from the cache, so the site's relative links all work.
// shortcut: no ZIP64 or encrypted zips, and root-absolute links ("/style.css") leave the zip.
const ZIP_CACHE = "flux-zipsite";
const TYPES = {
	html: "text/html", htm: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json",
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon",
	wasm: "application/wasm", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", mp4: "video/mp4", webm: "video/webm",
	woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", txt: "text/plain", xml: "application/xml",
};

// Lists a zip's files from its central directory. Each entry is stored (0) or deflated (8).
export async function readZip(blob) {
	const buf = new Uint8Array(await blob.arrayBuffer());
	const dv = new DataView(buf.buffer);
	let end = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
		if (dv.getUint32(i, true) === 0x06054b50) {
			end = i;
			break;
		}
	}
	if (end < 0) throw new Error("That file isn't a zip.");
	const names = new TextDecoder();
	const entries = [];
	for (let n = dv.getUint16(end + 10, true), at = dv.getUint32(end + 16, true); n > 0; n--) {
		if (dv.getUint32(at, true) !== 0x02014b50) throw new Error("That zip looks damaged.");
		const method = dv.getUint16(at + 10, true);
		const size = dv.getUint32(at + 20, true);
		const nameLen = dv.getUint16(at + 28, true);
		const local = dv.getUint32(at + 42, true);
		const name = names.decode(buf.subarray(at + 46, at + 46 + nameLen));
		at += 46 + nameLen + dv.getUint16(at + 30, true) + dv.getUint16(at + 32, true);
		if (name.endsWith("/") || name.startsWith("__MACOSX/")) continue;
		if (method !== 0 && method !== 8) throw new Error(`${name} uses a kind of compression this can't open.`);
		const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
		entries.push({ name, method, data: buf.subarray(start, start + size) });
	}
	// A zipped folder ("site/index.html", "site/app.js"): serve what's inside it.
	const top = entries[0]?.name.split("/")[0] + "/";
	if (!entries.some((e) => e.name === "index.html") && entries.every((e) => e.name.startsWith(top))) {
		for (const e of entries) e.name = e.name.slice(top.length);
	}
	const pages = entries.filter((e) => /\.html?$/i.test(e.name)).sort((a, b) => a.name.split("/").length - b.name.split("/").length);
	const entry = entries.find((e) => e.name === "index.html") || pages[0];
	if (!entry) throw new Error("There's no .html page in that zip.");
	return { entries, entry: entry.name };
}

async function swReady() {
	if (!("serviceWorker" in navigator) || !window.caches) throw new Error("This browser can't run zip sites.");
	const reg = await navigator.serviceWorker.register("sw.js", { scope: "./" });
	await reg.update().catch(() => {}); // an older worker without zip support gets replaced first
	const next = reg.installing || reg.waiting;
	if (next && next.state !== "activated") await new Promise((r) => next.addEventListener("statechange", () => next.state === "activated" && r()));
	await navigator.serviceWorker.ready;
}

async function zipUrl(file) {
	await swReady();
	const { entries, entry } = await readZip(file.zip);
	const root = new URL(`zipsite/${file.id || "unsaved"}/`, document.baseURI).href;
	const path = (name) => root + name.split("/").map(encodeURIComponent).join("/");
	const cache = await caches.open(ZIP_CACHE);
	for (const req of await cache.keys()) if (req.url.startsWith(root)) await cache.delete(req);
	await Promise.all(
		entries.map(async (e) => {
			let body = new Blob([e.data]);
			if (e.method === 8) body = await new Response(body.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
			const ext = e.name.split(".").pop().toLowerCase();
			if (file.proxy && (ext === "html" || ext === "htm")) body = new Blob([withProxy(await body.text())]);
			await cache.put(path(e.name), new Response(body, { headers: { "content-type": TYPES[ext] || "application/octet-stream" } }));
		})
	);
	return path(entry);
}
