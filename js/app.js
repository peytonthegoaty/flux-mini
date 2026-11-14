/*global $scramjetLoadController, BareMux, __uv$config*/
// The tabbed web proxy (Scramjet or Ultraviolet over bare-mux). Its ~5 MB of
// scripts load the first time it's used, so the rest of the site starts fast.
import { store } from "./background.js";
import { debug } from "./log.js";
import { toUrl } from "./search.js";
import { saveSettings, settings } from "./settings.js";
import { SERVERS, checkWisp, pickWisp } from "./wisp.js";

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
// The engine and Wisp server Auto combination last got a page through with; used while it's on.
let found = null;
const pinned = () => (settings.autoCombo ? found : null);
const engineNow = () => pinned()?.engine || settings.engine;
const wispNow = async () => pinned()?.wisp || (await pickWisp(settings.wisp));

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
	const wisp = await wispNow();
	const transport = TRANSPORTS[settings.transport] || TRANSPORTS.epoxy;
	if (transportKey === transport.path + wisp) return;
	if (transport === TRANSPORTS.epoxy) await connection.setManualTransport(selfHealingSource(transport.path), [transport.options(wisp)]);
	else await connection.setTransport(transport.path, [transport.options(wisp)]);
	transportKey = transport.path + wisp;
	debug(`Transport ${transport.path} set, using ${wisp}`);
}

let ready = null;
// step(text, from %, to %) reports progress to a loading screen (TV uses it).
function prepare(step = () => {}) {
	step("Starting the proxy", 2, 45);
	ready ??= Promise.all([registerServiceWorker(), scramjet || loadEngines()]).catch((err) => {
		ready = null;
		throw err;
	});
	return ready.then(() => (step("Finding a proxy server", 45, 70), setupTransport()));
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
		const wisp = await wispNow();
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
	const wisp = await wispNow();
	if (wisp !== sj2Wisp) {
		controller.setTransport(new controller.Transport({ wisp }));
		sj2Wisp = wisp;
	}
	return controller;
}

// The Ultraviolet address for a URL, for site sections outside the browser tabs (media.html).
export async function uvUrl(url, step) {
	await prepare(step);
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
	showLoad();
	syncDevtools();
	renderTabs();
}

function closeTab(tab) {
	const index = tabs.indexOf(tab);
	tab.el.remove();
	Object.assign(tab, { run: (tab.run || 0) + 1, load: null }); // stops its loading and Auto combination
	tabs.splice(index, 1);
	if (!tabs.length) newTab();
	else if (tab === active) select(tabs[Math.min(index, tabs.length - 1)]);
	else renderTabs();
}

function onTabLoad(tab) {
	if (tab === active) syncDevtools();
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

// Page loading screen over the browser tabs (styled like TV's): what's happening, a bar and a
// percentage. Each step sets a range; the bar eases toward its top while the step runs.
const pageLoad = $("page-load");
let loadTimer = 0;
function paintLoad() {
	const load = active?.load;
	if (!load) return;
	load.pct += Math.max(0, load.to - load.pct) * 0.05; // never backwards
	$("page-load-fill").style.transform = `scaleX(${load.pct / 100})`;
	$("page-load-pct").textContent = `${Math.floor(load.pct)}%`;
	$("page-load-step").textContent = load.text;
}
function showLoad() {
	const loading = !!active?.load;
	if (loading) {
		pageLoad.hidden = false;
		pageLoad.classList.remove("done");
		paintLoad();
	} else if (!pageLoad.hidden && !pageLoad.classList.contains("done")) {
		pageLoad.classList.add("done");
		setTimeout(() => pageLoad.classList.contains("done") && (pageLoad.hidden = true), 400);
	}
	clearInterval(loadTimer);
	if (tabs.some((t) => t.load)) loadTimer = setInterval(paintLoad, 50);
}
function loadStep(tab, text, from, to) {
	tab.load = { text, pct: Math.max(tab.load?.pct || 0, from), to };
	if (tab === active) showLoad();
}
function loadDone(tab) {
	if (!tab.load) return;
	tab.load = null;
	if (tab !== active) return showLoad();
	$("page-load-fill").style.transform = "scaleX(1)";
	$("page-load-pct").textContent = "100%";
	showLoad();
}

async function navigate(tab, input) {
	const url = toUrl(input, settings.search);
	const run = (tab.run = (tab.run || 0) + 1); // a newer navigation in this tab stops an older one
	Object.assign(tab, { url, title: new URL(url).hostname, loading: true });
	if (tab === active) select(tab);
	debug(`Opening ${url} with ${ENGINE_NAMES[engineNow()] || ENGINE_NAMES.scramjet}`);
	showStatus("");
	loadStep(tab, "Starting the proxy", 2, 40);
	try {
		await prepare((text, from, to) => tab.run === run && loadStep(tab, text, from, to));
	} catch (err) {
		debug(`Startup failed: ${err.message || err}`, true);
		showStatus(err.message || String(err), true);
		tab.loading = false;
		loadDone(tab);
		renderTabs();
		return;
	}
	if (tab.run !== run) return;
	if (settings.autoCombo) return autoCombo(tab, url, run);
	loadStep(tab, `Loading ${new URL(url).hostname}`, 70, 95);
	try {
		await open(tab, url, engineNow());
		await outcome(tab.el, 30000);
	} catch (err) {
		showStatus(err.message, true);
		tab.loading = false;
		renderTabs();
	}
	if (tab.run === run) loadDone(tab);
}

// Starts loading url in target ({ el, sj, sj2 }: a tab, or one of Auto combination's tries).
async function open(target, url, engine) {
	if (engine === "uv") {
		target.el.src = __uv$config.prefix + __uv$config.encodeUrl(url);
	} else if (engine === "scramjet2") {
		try {
			(target.sj2 ??= (await scramjet2()).createFrame(target.el)).go(url);
		} catch (err) {
			debug(`Scramjet 2 failed to start: ${err.message || err}`, true);
			throw new Error(`Scramjet 2 (beta) couldn't start: ${err.message || err}`);
		}
	} else {
		(target.sj ??= scramjet.createFrame(target.el)).go(url);
	}
	if (target.el === active?.el) $("engine-badge").textContent = ENGINE_NAMES[engine] || ENGINE_NAMES.scramjet;
}

// Auto combination, in hidden frames behind the loading screen: the usual engine and server first
// (while every other server is tested); if that fails, every engine at once on each server in turn.
// Engines run in parallel because they share a server; servers can't, since Scramjet and
// Ultraviolet use one connection for the whole site. The first page that loads is moved into the tab.
async function autoCombo(tab, url, run) {
	const host = new URL(url).hostname;
	const first = { engine: engineNow(), wisp: await wispNow() };
	const live = Promise.all(SERVERS.map((w) => (w === first.wisp ? false : checkWisp(w))));
	const engines = [first.engine, ...Object.keys(ENGINE_NAMES).filter((e) => e !== first.engine)];
	const serverName = (w) => (SERVERS.includes(w) ? `Server ${SERVERS.indexOf(w) + 1}` : "your server");
	let rounds = [[first]];
	let tried = 0;
	let lastError = null;
	for (let r = 0; r < rounds.length; r++) {
		const combos = rounds[r];
		const total = rounds.length > 1 ? rounds.reduce((n, x) => n + x.length, 0) : engines.length * (SERVERS.length + 1);
		if (r === 0) loadStep(tab, `Loading ${host}`, 70, 85);
		else loadStep(tab, `Trying ${combos.length} engines on ${serverName(combos[0].wisp)} (${tried}/${total})`, 86 + (12 * (r - 1)) / (rounds.length - 1), 86 + (12 * r) / (rounds.length - 1));
		found = combos[0];
		// Scramjet and Ultraviolet share one connection: set it once for the round, never twice at the same time.
		const shared = combos.some((c) => c.engine !== "scramjet2") ? limit(setupTransport(), 15000).catch((err) => err) : null;
		const tries = combos.map((combo) => ({ combo, el: makeFrame(tab), sj: null, sj2: null }));
		for (const t of tries) t.el.hidden = true;
		const results = tries.map(async (t) => {
			let result;
			try {
				if (t.combo.engine !== "scramjet2") {
					const err = await shared;
					if (err) throw err;
				}
				await limit(open(t, url, t.combo.engine), 15000);
				result = await outcome(t.el, 15000);
			} catch (err) {
				result = err.message || String(err);
			}
			if (tab.run === run && t.el.isConnected) debug(`Auto combination: ${ENGINE_NAMES[t.combo.engine]} on ${t.combo.wisp}: ${result}`, result !== "ok");
			if (result !== "ok") throw t;
			return t;
		});
		const winner = await Promise.any(results).catch(() => null);
		tried += combos.length;
		if (tab.run !== run) return tries.forEach((t) => t.el.remove());
		// Keep one failed try (Flux's error page) to show if nothing works.
		const shown = winner ? null : tries.find((t) => t.el.contentDocument?.title === "Couldn't load this page") || tries[0];
		for (const t of tries) if (t !== winner && t !== shown) t.el.remove();
		if (winner) {
			found = winner.combo;
			lastError?.el.remove();
			return adopt(tab, winner);
		}
		lastError?.el.remove();
		lastError = shown;
		if (r === 0) {
			loadStep(tab, "Finding proxy servers that answer", 70, 72);
			const ok = await live;
			if (tab.run !== run) return lastError.el.remove();
			const wisps = [first.wisp, ...SERVERS.filter((w, n) => ok[n])];
			const rest = wisps.map((wisp) => engines.map((engine) => ({ engine, wisp })).filter((c) => !(c.engine === first.engine && c.wisp === first.wisp)));
			rounds = [[first], ...rest.filter((x) => x.length)];
		}
	}
	found = first;
	adopt(tab, lastError); // the error page says what went wrong
	debug(`Auto combination: none of ${tried} engine and server combinations could load ${url}`, true);
}

// Rejects if promise takes longer than ms, so one stuck try can't stall Auto combination.
const limit = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms))]);

// Moves a finished try into the tab, replacing the tab's frame.
function adopt(tab, t) {
	tab.el.remove();
	Object.assign(tab, { el: t.el, sj: t.sj, sj2: t.sj2 });
	t.el.hidden = false;
	if (tab === active) select(tab);
	onTabLoad(tab);
	if (t.combo && tab === active) $("engine-badge").textContent = ENGINE_NAMES[t.combo.engine];
	tab.loading = false;
	loadDone(tab);
	renderTabs();
}

// "ok" once a page shows in the frame, "error" for Flux's proxy error page, "timeout" if neither in ms.
function outcome(el, ms) {
	const start = Date.now();
	return new Promise((resolve) => {
		const timer = setInterval(() => {
			let result = Date.now() - start > ms || !el.isConnected ? "timeout" : "";
			try {
				const doc = el.contentDocument;
				if (el.contentWindow.location.href !== "about:blank" && doc.readyState !== "loading") {
					result = doc.title === "Couldn't load this page" ? "error" : "ok"; // sw.js errorPage()
				}
			} catch {
				// Mid-navigation.
			}
			if (result) {
				clearInterval(timer);
				resolve(result);
			}
		}, 250);
	});
}

// Opens a new tab, optionally loading a URL or search in it. A blank current tab is reused.
// A fresh frame for a tab (new tabs, and tabs waking up after the Browser was left).
function addFrame(tab) {
	Object.assign(tab, { el: makeFrame(tab), sj: null, sj2: null });
}
function makeFrame(tab) {
	const el = document.createElement("iframe");
	Object.assign(el, { className: "frame", title: "Browser tab", allow: "fullscreen; autoplay; clipboard-write; pointer-lock; gamepad" });
	el.addEventListener("load", () => tab.el === el && onTabLoad(tab));
	frames.append(el);
	return el;
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
		Object.assign(tab, { asleep: true, loading: false, run: (tab.run || 0) + 1, load: null });
		tab.el.remove();
	}
	showLoad();
}
export const resumeTabs = () => active?.asleep && wake(active);
function wake(tab) {
	tab.asleep = false;
	addFrame(tab);
	navigate(tab, tab.url);
}

// Devtools: Eruda (Elements with a picker, and a Console) runs inside the tab's page, but draws in
// its own small HTML frame in the panel beside it (on S3 Flux is an SVG page, where Eruda can't draw).
// The Console's input is Monaco (the HTML section's editor), right after the last log, like Chrome's.
const devPane = $("devtools-pane");
const devEmpty = $("devtools-empty");
const FLUX_THEME = {
	background: "--bg2", darkerBackground: "--field", contrast: "--bg", foreground: "--fg-m",
	selectForeground: "--fg", textColor: "--fg", primary: "--fg", accent: "--accent", highlight: "--field-hover",
	border: "#2a2a31", varColor: "#e36eec", stringColor: "#f29766", keywordColor: "#9980ff", numberColor: "#9980ff",
	operatorColor: "#7f7f7f", linkColor: "#ababab", tagNameColor: "#5db0d7", functionColor: "#d5d5d5",
	attributeNameColor: "#9bbbdc", commentColor: "#747474",
	consoleWarnBackground: "#2a2410", consoleWarnForeground: "#ffcb6b", consoleWarnBorder: "#4a3f12",
	consoleErrorBackground: "#2a1214", consoleErrorForeground: "#ff8a8a", consoleErrorBorder: "#4d1c20",
	light: "#ccc", dark: "#aaa",
};
const SPLIT = 500; // px: from this panel width, the element tree and its styles sit side by side
let erudaCode;
let erudaFonts = "";
function splitDevtools() {
	const query = devPane.doc?.defaultView?.eruda?.get("elements")?._splitMediaQuery;
	if (!query) return;
	const wide = devPane.offsetWidth >= SPLIT;
	if (query.isMatch() === wide) return;
	query.setQuery(wide ? "all" : "not all");
	query.emit(wide ? "match" : "unmatch");
}
new ResizeObserver(splitDevtools).observe(devPane);

// While open, it follows whatever page the tab shows, attaching as soon as a new page starts (so its
// logs show from the start) and showing nothing while there's no page.
setInterval(() => !devPane.hidden && syncDevtools(), 100);
// Scramjet wraps the page's console methods in getters Eruda can't replace, so they become plain ones
// here, which also keep what the page logs before Eruda is in (it's shown once it is).
const LOGGERS = ["log", "info", "warn", "error", "debug", "dir", "table", "trace"];
function holdLogs(w, held = []) {
	let names = [];
	try {
		names = Object.getOwnPropertyNames(w.console);
	} catch {
		// Its console can't be read: logs show from when Eruda is in.
	}
	for (const key of names) {
		try {
			const prop = Object.getOwnPropertyDescriptor(w.console, key);
			if (prop.value?.fluxHeld) continue;
			const real = prop.get ? prop.get.call(w.console) : prop.value;
			if (typeof real !== "function") continue;
			let value = real;
			if (LOGGERS.includes(key)) {
				value = function (...args) {
					if (!held.done) held.push([key, args]);
					return real.apply(this, args);
				};
				value.fluxHeld = true;
			}
			Object.defineProperty(w.console, key, { value, writable: true, configurable: true });
		} catch {
			// This one stays as it is.
		}
	}
	return held;
}
async function syncDevtools() {
	const w = active?.url ? active.el.contentWindow : null;
	let doc = null;
	try {
		if (w && w.location.href !== "about:blank") doc = w.document;
	} catch {
		// Mid-navigation.
	}
	if (devPane.hidden) return;
	if (doc !== devPane.doc) {
		devPane.doc = doc;
		devPane.attached = false;
		devPane.querySelector(".devtools-frame")?.remove();
		devEmpty.textContent = "Open a page to inspect it.";
		devEmpty.hidden = !!doc;
		if (doc) devPane.held = holdLogs(w);
	}
	// Eruda needs the page's <body>; until then the page's logs are held for it.
	if (!doc || devPane.attached || doc.readyState === "loading") return;
	devPane.attached = true;
	try {
		// Eruda lays Elements out side by side by the screen width; in its frame that's the panel's width.
		erudaCode ??= fetch("js/eruda.js").then(async (r) => (await r.text()).replace(/@media screen and \(min-width:680px\)/g, `@media (min-width:${SPLIT}px)`));
		const code = await erudaCode;
		if (devPane.doc !== doc) return;
		holdLogs(w, devPane.held); // again: Scramjet can put its getters back while the page loads
		if (!w.eruda) w.eval(code);
		const frame = devPane.appendChild(Object.assign(document.createElement("iframe"), { className: "devtools-frame", title: "Devtools" }));
		const ui = frame.contentDocument;
		const flux = getComputedStyle(document.documentElement);
		const theme = Object.fromEntries(Object.entries(FLUX_THEME).map(([k, v]) => [k, v.startsWith("--") ? flux.getPropertyValue(v).trim() : v]));
		// Eruda's icon fonts go in the page's <head> (fonts don't load from a shadow root), where the proxy
		// mangles their data: URLs. Its frame gets them straight from Eruda's code.
		erudaFonts ||= [...code.matchAll(/@font-face\{font-family:([\w-]+);src:url\(\\?'(data:[^'\\]+)/g)].map(([, name, src]) => `@font-face{font-family:${name};src:url('${src}') format('woff')}`).join("");
		ui.head.append(Object.assign(ui.createElement("style"), { textContent: `${erudaFonts}html,body{margin:0;height:100%;background:${theme.background};color-scheme:dark}body>div{height:100%}` }));
		w.eruda.init({ container: ui.body.appendChild(ui.createElement("div")), inline: true, tool: ["elements", "console"], defaults: { theme: "Dark" } });
		w.eruda.util.evalCss.setTheme(theme);
		const held = devPane.held;
		held.done = true;
		for (const [key, args] of held) w.console[key](...args);
		w.eruda.util.evalCss(`#_console ._js-input{display:none!important}#_console{padding-bottom:0!important}
.flux-prompt{position:relative;padding-left:22px;min-height:40px;cursor:text}
.flux-prompt::before{content:"›";position:absolute;left:9px;top:0;color:${theme.accent};font:15px/20px ui-monospace,Consolas,monospace}
.flux-prompt iframe{display:block;width:100%;height:20px;border:0}`);
		ui.defaultView.fluxConsoleReady = fluxConsoleReady; // Monaco (monaco/editor.html?console) reports in here
		w.eruda.util.evalCss(INJECTOR_CSS + EDIT_CSS);
		addInjector(w, ui);
		addEditing(w, ui);
		w.eruda.remove("settings"); // only Eruda's own look, which Flux sets
		const tools = w.eruda.get();
		tools.on("showTool", (name) => name === "console" && addPrompt(w, ui));
		// Eruda selects <body> on open, which outlines it on the page; Chrome only outlines on hover.
		setTimeout(() => w.eruda?.chobitsu.domain("Overlay").hideHighlight(), 100);
		splitDevtools();
	} catch (err) {
		devPane.querySelector(".devtools-frame")?.remove();
		devEmpty.textContent = "Devtools can't open on this page.";
		devEmpty.hidden = false;
		debug(`Devtools couldn't open on this page: ${err.message || err}`, true);
	}
}

// JS Runner, a devtools tab beside Console: drop a .js file (or pick a preset) and run it in the page.
// Presets are scripts you saved, kept in this browser's IndexedDB (they can be megabytes).
const FILE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M10 13l-2 2 2 2M14 17l2-2-2-2"/></svg>`;
const PLAY_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>`;
const PRESETS_KEY = "injector-presets";
let presets = null; // [{ name, code }], once read
// Always in the list, loaded from Flux itself (injector/ on the site) when picked.
const BUILT_IN = [{ name: "X-Gui (Blooket)", url: "injector/x-gui.js" }];
let injectable = null; // the loaded script: { name, code }
const INJECTOR_CSS = `.inj{max-width:560px;padding:14px;height:100%;overflow:auto;box-sizing:border-box;color:var(--foreground);font-size:12px}
.inj svg{width:14px;height:14px;flex:none}
.inj-drop{display:flex;align-items:center;gap:12px;padding:14px;border:1px dashed var(--border);border-radius:10px;cursor:pointer;transition:border-color .2s,background .2s}
.inj-drop:hover,.inj-drop.over{border-color:var(--foreground);background:var(--darker-background)}
.inj-drop.ready{border-style:solid}
.inj-tile{display:grid;place-items:center;flex:none;width:40px;height:40px;border-radius:9px;background:var(--darker-background);border:1px solid var(--border);color:var(--select-foreground)}
.inj-tile svg{width:20px;height:20px}
.inj-drop span:not(.inj-tile){display:flex;flex-direction:column;gap:2px;min-width:0}
.inj-drop b{color:var(--select-foreground);font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.inj-row{display:flex;gap:6px;margin-top:10px}
.inj input[type=text]{flex:1;min-width:0;padding:7px 10px;border:1px solid var(--border);border-radius:7px;background:var(--darker-background);color:var(--select-foreground);font:inherit;outline:0;transition:border-color .2s}
.inj input[type=text]:focus{border-color:var(--foreground)}
.inj button{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 12px;border:1px solid var(--border);border-radius:7px;background:var(--darker-background);color:var(--select-foreground);font:inherit;cursor:pointer;transition:background .15s,opacity .15s}
.inj button:hover:not(:disabled){background:var(--highlight)}
.inj button:disabled{opacity:.4;cursor:default}
.inj .inj-go{width:100%;margin-top:8px;padding:9px;border:0;background:var(--select-foreground);color:var(--background);font-weight:600}
.inj .inj-go:hover:not(:disabled){background:var(--select-foreground);opacity:.85}
.inj-status{min-height:18px;margin:8px 0 0;color:var(--foreground)}
.inj-status.bad{color:var(--console-error-foreground)}
.inj-head{margin:16px 0 8px;color:var(--foreground);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em}
.inj-preset{display:flex;align-items:stretch;gap:6px;margin-bottom:6px}
.inj .inj-preset .inj-load{flex:1;min-width:0;justify-content:flex-start;gap:10px;padding:8px 10px;text-align:left}
.inj .inj-preset .inj-load.on{border-color:var(--foreground)}
.inj .inj-load .inj-badge{flex:none;padding:2px 5px;border-radius:4px;background:var(--highlight);color:var(--select-foreground);font:600 10px/1.2 ui-monospace,Consolas,monospace}
.inj-load span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.inj-preset small{color:var(--foreground)}
.inj .inj-del{padding:0 10px;color:var(--foreground)}
.inj .inj-del:hover{color:var(--console-error-foreground)}
.inj-empty{color:var(--foreground)}`;

function addInjector(w, ui) {
	w.eruda.add({
		name: "JS Runner",
		init($el) {
			this.$el = $el;
			$el.get(0).append(injectorPanel(w, ui));
		},
		show() {
			this.$el.show();
			return this;
		},
		hide() {
			this.$el.hide();
			return this;
		},
		destroy() {},
	});
}

function injectorPanel(w, ui) {
	const el = ui.createElement("div");
	el.className = "inj";
	el.innerHTML = `<label class="inj-drop"><input type="file" accept=".js,.mjs,.txt,text/javascript" hidden /><span class="inj-tile">${FILE_ICON}</span><span><b class="inj-file">Drop a .js file here</b><span class="inj-meta">or click to choose one</span></span></label>
<div class="inj-row"><input type="text" class="inj-name" placeholder="Name" spellcheck="false" /><button type="button" class="inj-save" disabled>Save as preset</button></div>
<button type="button" class="inj-go" disabled>${PLAY_ICON}Run in page</button>
<p class="inj-status" role="status"></p>
<div class="inj-head">Presets</div>
<div class="inj-list"></div>`;
	const $ = (s) => el.querySelector(s);
	const drop = $(".inj-drop");
	const status = (text, bad = false) => (($(".inj-status").textContent = text), $(".inj-status").classList.toggle("bad", bad));
	const load = async (script) => {
		if (script.url && script.code == null) {
			// Built-in presets live on Flux and are fetched the first time they're picked.
			status(`Loading "${script.name}"…`);
			try {
				const res = await fetch(sitePath(script.url), { cache: "no-cache" });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				script.code = await res.text();
			} catch (err) {
				return status(`Couldn't load "${script.name}": ${err.message || err}`, true);
			}
		}
		injectable = script;
		$(".inj-file").textContent = script.name;
		$(".inj-meta").textContent = `${size(script.code.length)}, ${script.code.split("\n").length} lines`;
		$(".inj-name").value = script.name;
		$(".inj-go").disabled = $(".inj-save").disabled = false;
		drop.classList.add("ready");
		for (const b of el.querySelectorAll(".inj-load")) b.classList.toggle("on", b.preset === script);
		status("");
	};
	const readFile = async (file) => file && load({ name: file.name.replace(/\.(m?js|txt)$/i, ""), code: await file.text() });
	const savePresets = () => store("readwrite", (s) => s.put(presets, PRESETS_KEY)).catch(() => status("Couldn't save presets in this browser.", true));
	const render = () => {
		const list = $(".inj-list");
		list.replaceChildren();
		for (const preset of [...BUILT_IN, ...presets]) {
			const row = ui.createElement("div");
			row.className = "inj-preset";
			const builtIn = BUILT_IN.includes(preset);
			row.innerHTML = `<button type="button" class="inj-load"><span class="inj-badge">JS</span><span></span><small>${builtIn ? "Flux" : size(preset.code.length)}</small></button><button type="button" class="inj-del" aria-label="Delete preset" title="Delete">✕</button>`;
			row.querySelector("span + span").textContent = preset.name;
			const button = row.querySelector(".inj-load");
			button.preset = preset;
			button.classList.toggle("on", preset === injectable);
			button.addEventListener("click", () => load(preset));
			if (builtIn) row.querySelector(".inj-del").remove();
			row.querySelector(".inj-del")?.addEventListener("click", () => {
				presets.splice(presets.indexOf(preset), 1);
				savePresets();
				render();
			});
			list.append(row);
		}
	};
	(presets ? Promise.resolve() : store("readonly", (s) => s.get(PRESETS_KEY)).then((list) => (presets = Array.isArray(list) ? list : []), () => (presets = []))).then(render);

	$("input[type=file]").addEventListener("change", (e) => readFile(e.target.files[0]));
	// Dropping a file anywhere in devtools would open it in place of devtools; only the drop area takes it.
	for (const type of ["dragover", "drop"]) ui.addEventListener(type, (e) => e.preventDefault());
	drop.addEventListener("dragover", () => drop.classList.add("over"));
	drop.addEventListener("dragleave", () => drop.classList.remove("over"));
	drop.addEventListener("drop", (e) => (drop.classList.remove("over"), readFile(e.dataTransfer.files[0])));
	$(".inj-save").addEventListener("click", () => {
		const name = $(".inj-name").value.trim() || injectable.name;
		const preset = { name, code: injectable.code };
		const same = presets.findIndex((p) => p.name === name);
		if (same >= 0) presets[same] = preset;
		else presets.push(preset);
		savePresets();
		render();
		load(preset);
		status(`Saved "${name}".`);
	});
	$(".inj-go").addEventListener("click", () => {
		const name = $(".inj-name").value.trim() || injectable.name;
		try {
			w.eval(`${injectable.code}\n//# sourceURL=${encodeURIComponent(name)}.js`);
			status(`Ran "${name}".`);
			w.console.info(`Ran ${name}`);
		} catch (err) {
			status(`${name}: ${err.message || err}`, true);
			w.console.error(err);
		}
	});
	return el;
}

// Editing in Elements, like Chrome's: double-click an attribute's value or name, or a text node, to
// change it in place (Enter saves, Esc cancels); double-click a tag to edit the element as HTML; and
// double-click "element.style" or a value in Attributes to change them.
const EDIT_CSS = `[contenteditable=plaintext-only]{outline:1px solid var(--accent);background:var(--darker-background);color:var(--select-foreground);white-space:pre-wrap;cursor:text}
.flux-edit{position:absolute;inset:0;z-index:1000;display:flex;flex-direction:column;background:var(--background)}
.flux-edit-head{display:flex;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border);font-size:12px;color:var(--foreground)}
.flux-edit-head b{color:var(--select-foreground);font-weight:500}
.flux-edit-head .bad{color:var(--console-error-foreground)}
.flux-edit textarea{flex:1;margin:0;padding:10px 12px;border:0;outline:0;resize:none;background:var(--background);color:var(--select-foreground);font:12px/1.6 ui-monospace,Consolas,monospace;tab-size:2;white-space:pre}`;

function addEditing(w, ui) {
	const root = ui.body.firstChild.shadowRoot;
	const elements = w.eruda.get("elements");
	const refresh = () => root.querySelector(".eruda-detail .eruda-refresh")?.click();
	root.addEventListener("dblclick", (e) => {
		// The selected row's highlight lies over its text, so look under it for what was double-clicked.
		const hit = root.elementsFromPoint(e.clientX, e.clientY).find((el) => !el.matches(".luna-dom-viewer-selection")) || e.target;
		const at = (s) => hit.closest?.(s);
		const node = elements._curNode;
		if (at("[contenteditable=plaintext-only]") || at(".flux-edit")) return;
		if (at(".luna-dom-viewer")) {
			if (!node) return;
			e.preventDefault();
			const attr = at(".luna-dom-viewer-attribute");
			const name = attr?.querySelector(".luna-dom-viewer-attribute-name")?.textContent;
			if (at(".luna-dom-viewer-attribute-value")) {
				return editInline(ui, at(".luna-dom-viewer-attribute-value"), node.getAttribute(name), (v) => node.setAttribute(name, v));
			}
			if (attr) {
				return editInline(ui, attr, `${name}="${node.getAttribute(name)}"`, (text) => {
					node.removeAttribute(name);
					for (const [, n, v] of text.matchAll(/([^\s="]+)(?:\s*=\s*"([^"]*)")?/g)) node.setAttribute(n, v ?? "");
				});
			}
			if (node.nodeType === Node.TEXT_NODE) {
				const line = at(".luna-dom-viewer-text-node") || at(".luna-dom-viewer-tree-item");
				return editInline(ui, line, node.nodeValue, (v) => (node.nodeValue = v));
			}
			if (node.nodeType === Node.ELEMENT_NODE) {
				return editModal(root, ui, `Edit <${node.localName}> as HTML`, node.outerHTML, (html) => {
					const tpl = w.document.createElement("template");
					tpl.innerHTML = html;
					const nodes = [...tpl.content.childNodes];
					node.replaceWith(...nodes);
					elements.select(nodes.find((n) => n.nodeType === Node.ELEMENT_NODE) || node.parentNode || w.document.body);
				});
			}
		}
		const rules = at(".eruda-style-rules");
		if (rules && node?.nodeType === Node.ELEMENT_NODE && rules === root.querySelector(".eruda-style-rules")) {
			const style = (node.getAttribute("style") || "").split(";").map((s) => s.trim()).filter(Boolean).join(";\n");
			return editModal(root, ui, "Edit element.style", style && `${style};`, (css) => {
				node.setAttribute("style", css.replace(/\s*\n\s*/g, " ").trim());
				refresh();
			});
		}
		const cell = at(".eruda-attributes td");
		if (cell && cell.cellIndex === 1 && node?.nodeType === Node.ELEMENT_NODE) {
			const name = cell.parentElement.cells[0].textContent;
			return editInline(ui, cell, node.getAttribute(name), (v) => (node.setAttribute(name, v), refresh()));
		}
	});
}

// Turns el into an editable box holding text; save(newText) runs on Enter or leaving it, Esc puts it back.
function editInline(ui, el, text, save) {
	const before = el.innerHTML;
	el.textContent = text ?? "";
	el.contentEditable = "plaintext-only";
	el.focus();
	const range = ui.createRange();
	range.selectNodeContents(el);
	ui.getSelection().removeAllRanges();
	ui.getSelection().addRange(range);
	let done = false;
	const finish = (keep) => {
		if (done) return;
		done = true;
		el.removeAttribute("contenteditable");
		const value = el.textContent;
		el.innerHTML = before; // Eruda redraws the line itself once the page changes
		if (keep && value !== text) {
			try {
				save(value);
			} catch {
				// Not valid there (a bad attribute name, say): nothing changes.
			}
		}
	};
	el.addEventListener("keydown", (e) => {
		e.stopPropagation(); // Eruda's tree uses arrows, Delete and Enter itself
		if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), finish(true));
		if (e.key === "Escape") finish(false);
	});
	el.addEventListener("blur", () => finish(true), { once: true });
}

// A full-panel editor for bigger edits (an element's HTML, element.style). Ctrl+Enter saves, Esc cancels.
function editModal(root, ui, title, text, save) {
	const box = ui.createElement("div");
	box.className = "flux-edit";
	box.innerHTML = `<div class="flux-edit-head"><b></b><span>Ctrl+Enter to save, Esc to cancel</span></div><textarea spellcheck="false"></textarea>`;
	box.querySelector("b").textContent = title;
	const area = box.querySelector("textarea");
	area.value = text;
	(root.querySelector(".eruda-dev-tools") || root.firstElementChild).append(box);
	area.focus();
	area.addEventListener("keydown", (e) => {
		e.stopPropagation();
		if (e.key === "Escape") box.remove();
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			try {
				save(area.value);
				box.remove();
			} catch (err) {
				const hint = box.querySelector(".flux-edit-head span");
				hint.textContent = err.message || String(err);
				hint.className = "bad";
			}
		}
		if (e.key === "Tab") {
			e.preventDefault();
			area.setRangeText("\t", area.selectionStart, area.selectionEnd, "end");
		}
	});
}

// Console input, like Chrome's: right after the last log; clicking the empty space below types there.
// Enter runs, Shift+Enter adds a line, Up/Down go through what ran before.
let consoleEditor;
const ranCode = [];
function addPrompt(w, ui) {
	const log = w.eruda.get("console")._$el.find(".luna-console").get(0); // the log's scrolling box
	if (!log || log.querySelector(".flux-prompt")) return consoleEditor?.focus();
	const prompt = ui.createElement("div");
	prompt.className = "flux-prompt";
	prompt.append(Object.assign(ui.createElement("iframe"), { title: "Console input", src: new URL("monaco/editor.html?console", location.href).href }));
	log.append(prompt);
	log.addEventListener("click", (e) => (e.target === log || e.target === prompt) && consoleEditor?.focus());
}
// Runs code in the page from the Console, echoing it the way Chrome does; a long script shows as its
// first lines and a count, so pasting one doesn't flood the log.
function runInPage(w, code) {
	const logger = w?.eruda?.get("console")._logger;
	if (!logger) return;
	const lines = code.split("\n");
	const echo = lines.length > 12 || code.length > 2000 ? `${lines.slice(0, 6).join("\n").slice(0, 600)}\n… (${lines.length} lines, ${size(code.length)})` : code;
	logger.insert({ type: "input", args: [echo], ignoreFilter: true });
	try {
		logger.output(logger.evalJs(code));
	} catch (err) {
		logger.insert({ type: "error", args: [err], ignoreFilter: true });
	}
}
const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function fluxConsoleReady(editor, monaco) {
	consoleEditor = editor;
	let at = ranCode.length;
	const frame = editor.getContainerDomNode().ownerDocument.defaultView.frameElement;
	const w = devPane.doc?.defaultView;
	const recall = (code) => (editor.setValue(code), editor.setPosition(editor.getModel().getFullModelRange().getEndPosition()));
	editor.addCommand(monaco.KeyCode.Enter, () => {
		const code = editor.getValue();
		if (!code.trim()) return;
		if (ranCode.at(-1) !== code) ranCode.push(code);
		at = ranCode.length;
		editor.setValue("");
		runInPage(w, code);
	}, "!suggestWidgetVisible");
	editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => editor.trigger("console", "type", { text: "\n" }));
	editor.addCommand(monaco.KeyCode.UpArrow, () => {
		if (editor.getPosition().lineNumber > 1 || !at) return editor.trigger("console", "cursorUp");
		recall(ranCode[--at]);
	}, "!suggestWidgetVisible");
	editor.addCommand(monaco.KeyCode.DownArrow, () => {
		if (editor.getPosition().lineNumber < editor.getModel().getLineCount() || at >= ranCode.length) return editor.trigger("console", "cursorDown");
		recall(ranCode[++at] ?? "");
	}, "!suggestWidgetVisible");
	// Long pasted scripts: the input stops growing at half the panel and scrolls, and a huge one isn't
	// wrapped (wrapping a minified megabyte freezes the editor).
	const fit = () => (frame.style.height = `${Math.min(editor.getContentHeight(), frame.ownerDocument.defaultView.innerHeight / 2)}px`);
	editor.onDidContentSizeChange(fit);
	editor.onDidChangeModelContent(() => editor.updateOptions({ wordWrap: editor.getModel().getValueLength() > 50000 ? "off" : "on" }));
	fit();
	editor.focus();
}

// Eruda scrolls what it selects into view, and the browser also scrolls Flux's own (overflow: hidden)
// layout to get there, pushing the sidebar and toolbar off screen. Flux's layout never scrolls, so undo it.
document.addEventListener("scroll", (e) => {
	const t = e.target === document ? document.scrollingElement : e.target;
	if (!devPane.hidden && t?.contains(devPane)) t.scrollTop = t.scrollLeft = 0;
}, true);

// Dragging the panel's left edge resizes it.
const devResize = $("devtools-resize");
devPane.style.width = `${settings.devtoolsWidth}px`;
devResize.addEventListener("pointerdown", (e) => {
	devResize.setPointerCapture(e.pointerId); // keeps the drag when the pointer is over a frame
	devPane.classList.add("resizing");
	const right = devPane.getBoundingClientRect().right;
	const move = (e) => (devPane.style.width = `${Math.min(Math.max(right - e.clientX, 240), right - 200)}px`);
	devResize.addEventListener("pointermove", move);
	devResize.addEventListener("lostpointercapture", () => {
		devResize.removeEventListener("pointermove", move);
		devPane.classList.remove("resizing");
		settings.devtoolsWidth = devPane.offsetWidth;
		saveSettings();
	}, { once: true });
});
$("browser-devtools").addEventListener("click", () => {
	devPane.hidden = !devPane.hidden;
	$("browser-devtools").classList.toggle("on", !devPane.hidden);
	syncDevtools();
});

$("browser-newtab").addEventListener("click", () => {
	if (active?.url) window.open(active.el.src, "_blank", "noopener");
});

newTab();
