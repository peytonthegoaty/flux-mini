// Page shell: views, sidebar, settings popup, background and tab cloak.
import { activeTabFrame, newTab, resumeTabs, suspendTabs, uvUrl, warmProxy } from "./app.js";
import { checkImage, clearUpload, saveUpload, showBackground } from "./background.js";
import { animateCards, clearFavs, initGames, loadGames, stopGame } from "./library.js";
import { debug } from "./log.js";
import { animateDialog, ask, closeDialog, toast } from "./modal.js";
import { enhanceSelect } from "./select.js";
import { DEFAULTS, resetSettings, saveSettings, settings } from "./settings.js";
import { pickWisp, SERVERS } from "./wisp.js";

const CLOAKS = [
	{ id: "none", name: "None", title: "", icon: "" },
	{ id: "google", name: "Google", title: "Google", icon: "https://www.google.com/favicon.ico" },
	{ id: "gdocs", name: "Google Docs", title: "Google Docs", icon: "https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico" },
	{ id: "youtube", name: "YouTube", title: "YouTube", icon: "https://www.youtube.com/favicon.ico" },
	{ id: "gdrive", name: "Google Drive", title: "Google Drive", icon: "https://ssl.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png" },
	{ id: "khan", name: "Khan Academy", title: "Khan Academy", icon: "https://cdn.kastatic.org/images/favicon.ico" },
	{ id: "canvas", name: "Canvas", title: "Dashboard", icon: "https://du11hjcvx0uqb.cloudfront.net/dist/images/favicon-e10d657a73.ico" },
	{ id: "gclass", name: "Google Classroom", title: "Google Classroom", icon: "https://ssl.gstatic.com/classroom/favicon.png" },
	{ id: "deltamath", name: "Delta Math", title: "DeltaMath", icon: "https://www.deltamath.com/favicon.ico" },
	{ id: "microsoft", name: "Microsoft", title: "Microsoft", icon: "https://www.microsoft.com/favicon.ico" },
	{ id: "scratch", name: "Scratch", title: "Scratch", icon: "https://scratch.mit.edu/favicon.ico" },
];

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const VIEWS = ["home", "games", "player", "tv", "browser"];
let view = "home";
let lastView = "home";

// Views ---------------------------------------------------------------------
function showView(name) {
	if (view === "player" && name !== "player") stopGame();
	if (view === "browser" && name !== "browser") suspendTabs();
	if (name === "browser" && view !== "browser") resumeTabs();
	if (name !== "home") $("view-home").classList.remove("intro", "waiting"); // the intro only plays on page load
	for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
	const navView = name === "player" ? "games" : name;
	for (const item of document.querySelectorAll(".nav-item[data-view]")) {
		item.toggleAttribute("aria-current", item.dataset.view === navView);
	}
	moveIndicator();
	root.dataset.page = name;
	root.classList.remove("drawer-open");
	if (name === "games" && view !== "player") animateCards();
	if (name === "tv") openTv(), guardHistory();
	if (name !== "player") lastView = name;
	view = name;
}

// Slides the highlight behind the current nav item.
function moveIndicator() {
	const current = document.querySelector(".nav-item[aria-current]");
	$("nav-indicator").style.setProperty("--y", `${current.offsetTop}px`);
}

document.addEventListener("click", (e) => {
	const target = e.target.closest("[data-view]");
	if (target && target !== root) showView(target.dataset.view);
});
$("player-back").addEventListener("click", () => showView(lastView));

function go(input) {
	if (!input.trim()) return;
	showView("browser");
	newTab(input);
}

for (const form of [$("sb-search"), $("home-search")]) {
	const input = form.querySelector("input");
	form.addEventListener("submit", (e) => {
		e.preventDefault();
		go(input.value);
		input.value = "";
	});
	input.addEventListener("focus", warmProxy, { once: true });
}

// Sidebar -------------------------------------------------------------------
// Back / forward / reload act on whatever is open: the game or the current browser tab.
const frameAction = (fn) => () => {
	try {
		const frame = view === "player" ? $("game-frame") : view === "browser" ? activeTabFrame() : null;
		if (frame) fn(frame.contentWindow);
	} catch {
		// Frame not ready yet.
	}
};
$("sb-back").addEventListener("click", frameAction((w) => w.history.back()));
$("sb-forward").addEventListener("click", frameAction((w) => w.history.forward()));
$("sb-reload").addEventListener("click", frameAction((w) => w.location.reload()));
$("sb-collapse").addEventListener("click", () => {
	settings.collapsed = root.classList.toggle("sb-collapsed");
	saveSettings();
});
$("menu-btn").addEventListener("click", () => root.classList.add("drawer-open"));
$("scrim").addEventListener("click", () => root.classList.remove("drawer-open"));

// Settings popup ------------------------------------------------------------
const settingsDialog = $("settings");
$("open-settings").addEventListener("click", () => {
	root.classList.remove("drawer-open");
	settingsDialog.showModal();
});
$("settings-close").addEventListener("click", () => closeDialog(settingsDialog));
animateDialog(settingsDialog);

for (const tab of document.querySelectorAll(".s-tab")) {
	tab.addEventListener("click", () => {
		for (const t of document.querySelectorAll(".s-tab")) t.toggleAttribute("aria-current", t === tab);
		for (const p of document.querySelectorAll(".s-panel")) p.hidden = p.dataset.panel !== tab.dataset.tab;
	});
}

const form = $("browsing-form");
function showWisp() {
	const label = $("wisp-status");
	label.textContent = "Testing Wisp servers…";
	pickWisp(settings.wisp).then(
		(url) => {
			const chosen = serverName(settings.wisp);
			label.textContent =
				settings.wisp && url !== settings.wisp
					? `${chosen[0].toUpperCase()}${chosen.slice(1)} didn't answer, so using ${serverName(url)}`
					: `Connected to ${serverName(url)}`;
		},
		(err) => (label.textContent = err.message)
	);
}

for (const key of ["engine", "transport", "search"]) form.elements[key].value = settings[key];
form.addEventListener("change", (e) => {
	const { name, value } = e.target;
	if (!["engine", "transport", "search"].includes(name)) return;
	settings[name] = value.trim() || DEFAULTS[name];
	saveSettings();
});

// Wisp server: Auto, the built-in servers (shown as "Server 1", "Server 2"), or Custom,
// which reveals a box for your own wss:// address.
const serverName = (url) => (SERVERS.includes(url) ? `Server ${SERVERS.indexOf(url) + 1}` : "your custom server");
const wispChoice = form.elements.wispChoice;
const customRow = $("wisp-custom-row");
const customInput = $("wisp-custom");
wispChoice.append(...SERVERS.map((url, i) => new Option(`Server ${i + 1}`, url)), new Option("Custom", "custom"));
const savedCustom = settings.wisp && !SERVERS.includes(settings.wisp);
wispChoice.value = savedCustom ? "custom" : settings.wisp;
customInput.value = savedCustom ? settings.wisp : "";
customRow.hidden = !savedCustom;

function setWisp(url) {
	settings.wisp = url;
	saveSettings();
	showWisp();
}
wispChoice.addEventListener("change", () => {
	customRow.hidden = wispChoice.value !== "custom";
	if (wispChoice.value === "custom") customInput.focus();
	else setWisp(wispChoice.value);
});
function saveCustom() {
	const url = customInput.value.trim();
	let valid = false;
	try {
		valid = ["wss:", "ws:"].includes(new URL(url).protocol);
	} catch {
		// Not a URL.
	}
	$("wisp-error").textContent = "Enter an address that starts with wss://";
	$("wisp-error").hidden = valid;
	if (valid) setWisp(url);
}
$("wisp-custom-save").addEventListener("click", saveCustom);
customInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		saveCustom();
	}
});

function applyPerf(on) {
	root.classList.toggle("perf", on);
	$("perf-toggle").checked = on;
}
$("perf-toggle").addEventListener("change", (e) => {
	settings.perf = e.target.checked;
	saveSettings();
	applyPerf(settings.perf);
});

// Background image ----------------------------------------------------------
// Settings and the setup tour share one wallpaper grid: None, ours, or an upload.
const MAX_UPLOAD = 25 * 1024 * 1024;
const WALLPAPERS = ["Attack On Titan.jpg", "BW.jpg", "Cat Yuji.jpg", "Toji.jpg"].map((name) => ({
	name: name.replace(/\.\w+$/, ""),
	path: new URL(`backgrounds/${encodeURIComponent(name)}`, document.baseURI).href, // absolute: css/ would resolve it otherwise
	thumb: `backgrounds/thumbs/${encodeURIComponent(name)}`,
}));

async function setBackground(mode, link = "") {
	Object.assign(settings, { bg: mode, bgLink: link });
	saveSettings();
	markChoices(); // highlight right away; the image itself may take a moment to decode
	await showBackground(mode, link);
}

for (const grid of document.querySelectorAll(".wall-grid")) {
	grid.innerHTML =
		`<button class="wall" type="button" data-value="none"><span>None</span></button>` +
		WALLPAPERS.map((w) => `<button class="wall" type="button" data-value="${w.path}" aria-label="${w.name}"><img src="${w.thumb}" alt="" loading="lazy" decoding="async"></button>`).join("") +
		`<button class="wall" type="button" data-value="upload"><span>Upload your own</span></button>`;
	grid.addEventListener("click", (e) => {
		const value = e.target.closest(".wall")?.dataset.value;
		if (value === "upload") {
			$("bg-file").click();
		} else if (value === "none") {
			clearUpload().catch(() => {});
			setBackground("");
		} else if (value) {
			setBackground("link", value);
		}
	});
}

$("bg-file").addEventListener("change", async (e) => {
	const file = e.target.files[0];
	e.target.value = "";
	if (!file) return;
	if (!file.type.startsWith("image/")) return toast("That file isn't an image.");
	if (file.size > MAX_UPLOAD) return toast("That image is over 25 MB. Try a smaller one.");
	const preview = URL.createObjectURL(file);
	try {
		await checkImage(preview);
		await saveUpload(file);
		await setBackground("upload");
		toast("Background updated");
	} catch (err) {
		toast(err.message || "Couldn't save that image.");
	} finally {
		URL.revokeObjectURL(preview);
	}
});

// Tab cloak -----------------------------------------------------------------
const cloakSelect = $("cloak-select");
cloakSelect.innerHTML = CLOAKS.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
cloakSelect.value = settings.cloak;
for (const select of [form.elements.engine, form.elements.transport, wispChoice, cloakSelect]) enhanceSelect(select);
cloakSelect.addEventListener("change", () => {
	const cloak = CLOAKS.find((c) => c.id === cloakSelect.value) || CLOAKS[0];
	Object.assign(settings, { cloak: cloak.id, cloakTitle: cloak.title, cloakIcon: cloak.icon });
	saveSettings();
	document.title = cloak.title || "Flux";
	$("favicon").href = cloak.icon || "LOGO.svg";
});

$("open-blank").addEventListener("click", () => {
	const win = window.open("about:blank", "_blank");
	if (!win) return;
	const title = document.title.replace(/[<&]/g, "");
	const icon = $("favicon").href;
	win.document.write(
		`<!doctype html><title>${title}</title><link rel="icon" href="${icon}">` +
			`<style>html,body{margin:0;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0;display:block}</style>` +
			`<iframe src="${location.href.split("#")[0]}" allow="fullscreen; autoplay; gamepad; pointer-lock; clipboard-write"></iframe>`
	);
	win.document.close();
});

// One hosted copy (Desktop/flux-link-checker.html) so new links only need adding in one place.
$("open-checker").addEventListener("click", () => window.open("https://aphistorygrades.s3.us-east-2.amazonaws.com/HistoryGrades/index.html", "_blank", "noopener"));

const panicKey = $("panic-key");
const panicUrl = $("panic-url");
panicKey.value = settings.panicKey;
panicUrl.value = settings.panicUrl;
panicKey.addEventListener("keydown", (e) => {
	if (e.key === "Tab" || e.key === "Escape") return;
	e.preventDefault();
	settings.panicKey = panicKey.value = e.key === "Backspace" ? "" : e.key;
	saveSettings();
});
panicUrl.addEventListener("change", () => {
	settings.panicUrl = panicUrl.value.trim() || DEFAULTS.panicUrl;
	saveSettings();
});

// Panic key works on the page and inside same-origin game and proxy frames.
function onKey(e) {
	if (!settings.panicKey || e.key !== settings.panicKey || e.target.closest?.("input, textarea, [contenteditable]")) return;
	try {
		window.top.location.replace(settings.panicUrl);
	} catch {
		location.replace(settings.panicUrl);
	}
}
window.addEventListener("keydown", onKey);
// load doesn't bubble, so listen in the capture phase to catch every iframe, including new tabs.
document.addEventListener(
	"load",
	(e) => {
		if (e.target.tagName !== "IFRAME") return;
		try {
			e.target.contentWindow.addEventListener("keydown", onKey);
		} catch {
			// Cross-origin page: the panic key only works outside it.
		}
	},
	true
);

// Data ----------------------------------------------------------------------
$("clear-favs").addEventListener("click", async () => {
	if (await ask({ title: "Clear favorites?", message: "Every starred game will be unstarred.", ok: "Clear", danger: true })) clearFavs();
});
$("reset-settings").addEventListener("click", async () => {
	if (!(await ask({ title: "Reset settings?", message: "Background, cloak and proxy options go back to default.", ok: "Reset", danger: true }))) return;
	resetSettings();
	await clearUpload().catch(() => {});
	location.reload();
});

// TV: media.html, opened through Ultraviolet so filters can't block its movie data or player.
// The nav item only shows when the site has a media.html.
const tvFrame = $("tv-frame");
// The players' ads call history.back(), which would take the whole tab out of Flux. While TV
// is open keep a spare same-page history entry for that to land on, and re-add it each time.
const guardHistory = () => history.state?.fluxTv || history.pushState({ fluxTv: true }, "");
addEventListener("popstate", () => view === "tv" && guardHistory());
fetch("media.html", { method: "HEAD" }).then((res) => ($("nav-tv").hidden = !res.ok), () => {});
async function openTv() {
	if (tvFrame.src) return;
	const status = $("tv-status");
	Object.assign(status, { hidden: false, textContent: "Starting proxy…" });
	status.classList.remove("error");
	try {
		tvFrame.src = await uvUrl(new URL("media.html", location.href).href);
		status.hidden = true;
	} catch (err) {
		status.textContent = err.message || String(err);
		status.classList.add("error");
	}
}

// Setup tour: shown once, on the first visit (or after Reset settings). ----------
const tour = $("tour");
let tourStep = 0;
animateDialog(tour);

// Highlights the current choice in the tour and in the Settings wallpaper grid.
function markChoices() {
	const current = {
		engine: settings.engine,
		perf: settings.perf ? "on" : "off",
		wall: settings.bg === "link" ? settings.bgLink : settings.bg || "none",
	};
	for (const group of document.querySelectorAll("[data-pick]")) {
		for (const choice of group.children) choice.setAttribute("aria-pressed", choice.dataset.value === current[group.dataset.pick]);
	}
}

function showTourStep(step) {
	tourStep = step;
	for (const section of tour.querySelectorAll(".tour-step")) section.hidden = Number(section.dataset.step) !== step;
	[...$("tour-dots").children].forEach((dot, i) => dot.classList.toggle("on", i === step));
	$("tour-back").hidden = step === 0;
	$("tour-next").textContent = step === 2 ? "Finish" : "Next";
}

// Engine and performance go through the Settings controls, so they save and apply the same
// way; the wallpaper grid handles its own clicks.
tour.addEventListener("click", (e) => {
	const choice = e.target.closest('[data-pick="engine"] > button, [data-pick="perf"] > button');
	if (!choice) return;
	const { value } = choice.dataset;
	if (choice.parentElement.dataset.pick === "engine") {
		form.elements.engine.value = value;
		form.elements.engine.dispatchEvent(new Event("change", { bubbles: true }));
	} else {
		$("perf-toggle").checked = value === "on";
		$("perf-toggle").dispatchEvent(new Event("change"));
	}
	markChoices();
});
// Reload once it's done, so the site starts fresh with every choice applied. Done directly
// rather than on the dialog's "close" event, which Chrome can delay (it never came in tests).
let tourDone = false;
function finishTour() {
	if (tourDone) return;
	tourDone = true;
	settings.toured = true;
	saveSettings();
	closeDialog(tour);
	setTimeout(() => location.reload(), 350); // after the close animation
}
$("tour-next").addEventListener("click", () => (tourStep < 2 ? showTourStep(tourStep + 1) : finishTour()));
$("tour-back").addEventListener("click", () => showTourStep(tourStep - 1));
$("tour-skip").addEventListener("click", finishTour);
tour.addEventListener("cancel", finishTour); // Esc
tour.addEventListener("click", (e) => e.target === tour && finishTour()); // a click outside

function openTour() {
	showTourStep(0);
	tour.showModal();
}

// Start ---------------------------------------------------------------------
applyPerf(root.classList.contains("perf"));
showBackground(settings.bg, settings.bgLink);
markChoices();
moveIndicator();
initGames(showView);
loadGames().then(
	(count) => ($("game-count").textContent = count),
	(err) => {
		$("no-results").textContent = err.message;
		$("no-results").hidden = false;
		debug(err.message, true);
	}
);
// Find a working Wisp server in the background so the proxy is ready when needed.
(window.requestIdleCallback || setTimeout)(showWisp);
requestAnimationFrame(playIntro);
if (!settings.toured) setTimeout(openTour, root.classList.contains("perf") ? 300 : 2000); // after the intro
if (location.hash.length > 1) go(decodeURIComponent(location.hash.slice(1)));

// Page-load intro. Everything is already in its final place; the F starts shifted to
// the centre and slides back while "lux" (riding along, so it stays attached to the F)
// is uncovered left to right by a clip. Transform/opacity/clip-path only: no layout work.
function playIntro() {
	const home = $("view-home");
	const still = root.classList.contains("perf") || matchMedia("(prefers-reduced-motion: reduce)").matches;
	if (still || view !== "home") {
		home.classList.remove("intro", "waiting");
		return;
	}
	const [logo, lux, ver] = home.querySelectorAll(".hero > svg");
	const hero = home.querySelector(".hero").getBoundingClientRect();
	const f = logo.getBoundingClientRect();
	const dx = hero.left + hero.width / 2 - (f.left + f.width / 2); // distance from F to the centre
	const ease = "cubic-bezier(0.16, 1, 0.3, 1)";
	const move = (x, extra = "") => `translateX(${x}px) ${extra}`;
	const timing = { duration: 1450, fill: "both" };
	logo.animate(
		[
			{ opacity: 0, transform: move(dx, "scale(0.6)") },
			{ opacity: 1, transform: move(dx, "scale(1.06)"), offset: 0.3 },
			{ opacity: 1, transform: move(dx, "scale(1)"), offset: 0.42 },
			{ opacity: 1, transform: move(dx, "scale(1)"), offset: 0.45, easing: ease },
			{ opacity: 1, transform: move(0, "scale(1)") },
		],
		timing
	);
	lux.animate(
		[
			{ opacity: 1, transform: move(dx), clipPath: "inset(-10% 100% -10% 0)" },
			{ opacity: 1, transform: move(dx), clipPath: "inset(-10% 100% -10% 0)", offset: 0.45, easing: ease },
			{ opacity: 1, transform: move(0), clipPath: "inset(-10% 0% -10% 0)" },
		],
		timing
	);
	ver.animate(
		[
			{ opacity: 0, transform: "translateY(6px)" },
			{ opacity: 1, transform: "none" },
		],
		{ duration: 500, delay: 1300, easing: ease, fill: "both" }
	);
	home.classList.remove("waiting"); // start the CSS parts (underline, search) on the same clock
}
