/*global $scramjetLoadController, BareMux, __uv$config*/
// The tabbed web proxy (Scramjet or Ultraviolet over bare-mux). Its ~5 MB of
// scripts load the first time it's used, so the rest of the site starts fast.
import { debug } from "./log.js";
import { toUrl } from "./search.js";
import { settings } from "./settings.js";
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

$("browser-newtab").addEventListener("click", () => {
	if (active?.url) window.open(active.el.src, "_blank", "noopener");
});

newTab();
