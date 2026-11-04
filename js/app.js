/*global $scramjetLoadController, BareMux, __uv$config*/
// The tabbed web proxy (Scramjet or Ultraviolet over bare-mux). Its ~5 MB of
// scripts load the first time it's used, so the rest of the site starts fast.
import { debug } from "./log.js";
import { toUrl } from "./search.js";
import { settings } from "./settings.js";
import { pickWisp } from "./wisp.js";

// Paths inside the site's folder. The site may live in a sub-folder (e.g. on S3), and
// these are handed to workers, so they must be absolute, not relative to the worker.
const sitePath = (path) => new URL(path, document.baseURI).pathname;

const TRANSPORTS = {
	libcurl: { path: sitePath("libcurl/index.mjs"), options: (wisp) => ({ websocket: wisp }) },
	epoxy: { path: sitePath("epoxy/index.mjs"), options: (wisp) => ({ wisp }) },
};

// Engine scripts, in execution order (they download in parallel).
const VENDOR_SCRIPTS = ["scram/scramjet.all.js", "baremux/index.js", "uv/uv.bundle.js", "uv/uv.config.js"];

const $ = (id) => document.getElementById(id);
const status = $("status");
const addressInput = $("address-input");
const strip = $("tabs");
const frames = $("frames");

let scramjet, connection;
const ENGINE_NAMES = { scramjet: "Scramjet", scramjet2: "Scramjet 2 (beta)", uv: "Ultraviolet" };
let transportKey = "";

function showStatus(message, isError = false) {
	status.textContent = message;
	status.classList.toggle("error", isError);
	status.hidden = !message;
}

async function registerServiceWorker() {
	if (!("serviceWorker" in navigator)) {
		throw new Error("Your browser doesn't support service workers, which the proxy needs.");
	}
	if (!window.isSecureContext) {
		throw new Error("This site must be opened over HTTPS for the proxy to work.");
	}
	await navigator.serviceWorker.register("sw.js", { scope: "./" });
	const registration = await navigator.serviceWorker.ready;
	debug(`Service worker ready (scope ${registration.scope})`);
}

function loadScript(src) {
	return new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = src;
		script.async = false; // keep execution order while downloading in parallel
		script.onload = resolve;
		script.onerror = () => reject(new Error(`Couldn't load ${src}. Try reloading the page.`));
		document.head.append(script);
	});
}

async function loadEngines() {
	await Promise.all(VENDOR_SCRIPTS.map(loadScript));
	const { ScramjetController } = $scramjetLoadController();
	const controller = new ScramjetController({
		prefix: sitePath("scramjet/"),
		files: {
			wasm: sitePath("scram/scramjet.wasm.wasm"),
			all: sitePath("scram/scramjet.all.js"),
			sync: sitePath("scram/scramjet.sync.js"),
		},
	});
	await controller.init();
	connection = new BareMux.BareMuxConnection(sitePath("baremux/worker.js"));
	scramjet = controller;
	debug("Scramjet, Ultraviolet and bare-mux ready");
}

// Two fixes on top of epoxy, for every engine. Self-contained: bare-mux runs it from source.
// 1. Epoxy keeps one Wisp socket and never reopens it once the server drops it, so from then on
//    every request (browser, TV, games) fails at once with "Wisp: MuxTaskEnded". Reopen and retry.
// 2. Google resets HTTP/2 requests from Wisp servers it has flagged (PROTOCOL_ERROR). Retrying gets
//    most of them through, so the page shows instead of a proxy error (at worst Google's robot check).
function selfHealing(Transport) {
	let reconnecting = null;
	return class SelfHealing extends Transport {
		async request(remote, method, body, headers, signal) {
			for (let attempt = 1; ; attempt++) {
				try {
					return await super.request(remote, method, body, headers, signal);
				} catch (err) {
					if (body instanceof ReadableStream) throw err; // already sent; can't send it again
					if (/PROTOCOL_ERROR/.test(String(err)) && attempt < 8) continue;
					if (!/MuxTaskEnded|Multiplexor/.test(String(err)) || attempt > 1) throw err;
					console.warn("Wisp connection dropped; reconnecting");
					reconnecting ??= this.init().finally(() => (reconnecting = null));
					await reconnecting;
				}
			}
		}
	};
}

// The same, as source for bare-mux's shared worker, where the transport runs for Scramjet and Ultraviolet.
const selfHealingSource = (path) => `
	const { default: Transport } = await import(${JSON.stringify(path)});
	return [(${selfHealing})(Transport), ${JSON.stringify(path)}];`;

async function setupTransport() {
	const wisp = await pickWisp(settings.wisp);
	const transport = TRANSPORTS[settings.transport] || TRANSPORTS.epoxy;
	if (transportKey === transport.path + wisp) return;
	if (transport === TRANSPORTS.epoxy) await connection.setManualTransport(selfHealingSource(transport.path), [transport.options(wisp)]);
	else await connection.setTransport(transport.path, [transport.options(wisp)]);
	transportKey = transport.path + wisp;
	debug(`Transport ${transport.path} set, using ${wisp}`);
}

let ready = null;
function prepare() {
	ready ??= Promise.all([registerServiceWorker(), scramjet || loadEngines()]).catch((err) => {
		ready = null;
		throw err;
	});
	return ready.then(setupTransport);
}

// Coming back to this tab: while it was hidden the browser may have frozen it and the Wisp
// server may have dropped the idle socket, which the transport never reopens. Start a fresh one.
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
	if (document.hidden) return void (hiddenAt ||= Date.now());
	const away = Date.now() - hiddenAt;
	hiddenAt = 0;
	if (!connection || away < 15000) return;
	connection = new BareMux.BareMuxConnection(sitePath("baremux/worker.js"));
	transportKey = "";
	setupTransport().then(
		() => debug("Proxy reconnected after the tab was in the background"),
		(err) => debug(`Reconnect failed: ${err.message || err}`, true)
	);
});

// Scramjet 2 (beta): no bare-mux; its controller runs the transport (epoxy 3) in this page and
// the service worker hands it every request under sj2/.
const SJ2 = sitePath("sj2/");
let sj2 = null;
let sj2Wisp = "";
async function scramjet2() {
	sj2 ??= (async () => {
		await Promise.all(["scram2/scramjet.js", "scram2/controller.api.js"].map(loadScript));
		const { default: Epoxy } = await import(sitePath("epoxy3/index.mjs"));
		const Transport = selfHealing(Epoxy);
		const wisp = await pickWisp(settings.wisp);
		const controller = new $scramjetController.Controller({
			serviceworker: (await navigator.serviceWorker.ready).active,
			transport: new Transport({ wisp }),
			config: {
				prefix: SJ2,
				scramjetPath: sitePath("scram2/scramjet.js"),
				injectPath: sitePath("scram2/controller.inject.js"),
				wasmPath: sitePath("scram2/scramjet.wasm"),
			},
		});
		await controller.wait();
		controller.Transport = Transport;
		sj2Wisp = wisp;
		debug(`Scramjet 2 ready, using ${wisp}`);
		return controller;
	})().catch((err) => {
		sj2 = null;
		throw err;
	});
	const controller = await sj2;
	const wisp = await pickWisp(settings.wisp);
	if (wisp !== sj2Wisp) {
		controller.setTransport(new controller.Transport({ wisp }));
		sj2Wisp = wisp;
	}
	return controller;
}

// The Ultraviolet address for a URL, for site sections outside the browser tabs (media.html).
export async function uvUrl(url) {
	await prepare();
	return __uv$config.prefix + __uv$config.encodeUrl(url);
}

// Starts loading the proxy early (e.g. when a URL box gets focus); errors surface on use.
export function warmProxy() {
	prepare().catch(() => {});
}

function realUrl(href) {
	const url = new URL(href, location.href);
	// Scramjet 2 addresses are sj2/<controller id>/<frame id>/<encoded URL>.
	if (url.pathname.startsWith(SJ2)) return decodeURIComponent(url.pathname.slice(SJ2.length).replace(/^[^/]*\/[^/]*\//, ""));
	if (url.pathname.startsWith(__uv$config.prefix)) {
		return __uv$config.decodeUrl(url.pathname.slice(__uv$config.prefix.length)) + url.search + url.hash;
	}
	try {
		return scramjet.decodeUrl(url.href);
	} catch {
		return url.href;
	}
}

// Tabs ------------------------------------------------------------------------
let tabs = [];
let active = null;
let nextId = 1;
let justOpened = 0;

function renderTabs() {
	$("browser-bar").classList.toggle("loading", !!active?.loading);
	strip.replaceChildren(
		...tabs.map((tab) => {
			const el = document.createElement("div");
			el.className = tab.id === justOpened ? "tab new" : "tab";
			el.role = "tab";
			el.dataset.id = tab.id;
			el.setAttribute("aria-selected", tab === active);
			el.title = tab.url || "New tab";
			el.innerHTML = `<span class="tab-title"></span><button class="tab-close" type="button" aria-label="Close tab"><svg class="i"><use href="#i-x"/></svg></button>`;
			el.firstChild.textContent = tab.title;
			return el;
		}),
		Object.assign(document.createElement("button"), {
			className: "icon-btn tab-add",
			type: "button",
			innerHTML: `<svg class="i"><use href="#i-plus"/></svg>`,
			ariaLabel: "New tab",
		})
	);
	justOpened = 0;
}

function select(tab) {
	active = tab;
	if (tab.asleep) return wake(tab);
	for (const t of tabs) t.el.hidden = t !== tab || !t.url;
	$("newtab-page").hidden = !!tab.url;
	addressInput.value = tab.url;
	renderTabs();
}

function closeTab(tab) {
	const index = tabs.indexOf(tab);
	tab.el.remove();
	tabs.splice(index, 1);
	if (!tabs.length) newTab();
	else if (tab === active) select(tabs[Math.min(index, tabs.length - 1)]);
	else renderTabs();
}

function onTabLoad(tab) {
	try {
		const href = tab.el.contentWindow.location.href;
		if (!href || href === "about:blank") return;
		tab.url = realUrl(href);
		tab.title = tab.el.contentDocument.title || new URL(tab.url).hostname;
		tab.loading = false;
		debug(`Loaded ${tab.url}`);
	} catch {
		return; // Cross-origin frame (shouldn't happen while proxied).
	}
	if (tab === active) addressInput.value = tab.url;
	renderTabs();
}

async function navigate(tab, input) {
	const url = toUrl(input, settings.search);
	Object.assign(tab, { url, title: new URL(url).hostname, loading: true });
	if (tab === active) select(tab);
	debug(`Opening ${url} with ${ENGINE_NAMES[settings.engine] || ENGINE_NAMES.scramjet}`);
	showStatus("Starting proxy…");
	try {
		await prepare();
	} catch (err) {
		debug(`Startup failed: ${err.message || err}`, true);
		showStatus(err.message || String(err), true);
		tab.loading = false;
		renderTabs();
		return;
	}
	showStatus("");
	$("engine-badge").textContent = ENGINE_NAMES[settings.engine] || ENGINE_NAMES.scramjet;
	if (settings.engine === "uv") {
		tab.el.src = __uv$config.prefix + __uv$config.encodeUrl(url);
	} else if (settings.engine === "scramjet2") {
		try {
			(tab.sj2 ??= (await scramjet2()).createFrame(tab.el)).go(url);
		} catch (err) {
			debug(`Scramjet 2 failed to start: ${err.message || err}`, true);
			showStatus(`Scramjet 2 (beta) couldn't start: ${err.message || err}`, true);
			tab.loading = false;
			renderTabs();
		}
	} else {
		(tab.sj ??= scramjet.createFrame(tab.el)).go(url);
	}
}

// Opens a new tab, optionally loading a URL or search in it. A blank current tab is reused.
// A fresh frame for a tab (new tabs, and tabs waking up after the Browser was left).
function addFrame(tab) {
	const el = document.createElement("iframe");
	Object.assign(el, { className: "frame", title: "Browser tab", allow: "fullscreen; autoplay; clipboard-write" });
	el.addEventListener("load", () => onTabLoad(tab));
	Object.assign(tab, { el, sj: null, sj2: null });
	frames.append(el);
}

export function newTab(input) {
	if (input?.trim() && active && !active.url) return navigate(active, input);
	const tab = { id: nextId++, url: "", title: "New tab", loading: false };
	addFrame(tab);
	tabs.push(tab);
	justOpened = tab.id;
	select(tab);
	if (input?.trim()) navigate(tab, input);
	else addressInput.focus();
}

strip.addEventListener("click", (e) => {
	if (e.target.closest(".tab-add")) return newTab();
	const tab = tabs.find((t) => t.id === Number(e.target.closest(".tab")?.dataset.id));
	if (!tab) return;
	if (e.target.closest(".tab-close")) closeTab(tab);
	else select(tab);
});
strip.addEventListener("auxclick", (e) => {
	const tab = tabs.find((t) => t.id === Number(e.target.closest(".tab")?.dataset.id));
	if (e.button === 1 && tab) closeTab(tab);
});

$("address-form").addEventListener("submit", (e) => {
	e.preventDefault();
	if (addressInput.value.trim()) navigate(active, addressInput.value);
});

export const activeTabFrame = () => (active?.url ? active.el : null);

// Leaving the Browser section unloads its pages, so they stop using CPU, audio and data;
// each tab reloads its page the next time it's shown. The frame is removed rather than
// pointed at about:blank: Scramjet fails to load a page into a frame that was blanked.
export function suspendTabs() {
	for (const tab of tabs) {
		if (!tab.url || tab.asleep) continue;
		Object.assign(tab, { asleep: true, loading: false });
		tab.el.remove();
	}
}
export const resumeTabs = () => active?.asleep && wake(active);
function wake(tab) {
	tab.asleep = false;
	addFrame(tab);
	navigate(tab, tab.url);
}

$("browser-newtab").addEventListener("click", () => {
	if (active?.url) window.open(active.el.src, "_blank", "noopener");
});

newTab();
