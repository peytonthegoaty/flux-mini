// OS style (Settings > Appearance > Website style): a desktop with draggable, resizable windows,
// a taskbar and a start menu. The apps are the site's real parts (the browser view, the settings
// panels, the wallpaper grid) moved into windows, so they behave exactly as in the default style.
// js/boot.js sets html.os before the first paint; CSS hides .shell and shows #os.
import { newTab, resumeTabs, suspendTabs, warmProxy } from "./app.js";
import { addFile, files, filesReady, htmlUrl, removeFile, saveFiles } from "./files.js";
import { gameList, play, quitFrame, stopGame } from "./library.js";
import { animateDialog, ask, closeDialog, toast } from "./modal.js";
import { saveSettings, settings } from "./settings.js";

const root = document.documentElement;
export const osMode = root.classList.contains("os");

const $ = (id) => document.getElementById(id);
const desk = $("os-desk");
const tasks = $("os-tasks");
const start = $("os-start");
const startBtn = $("os-start-btn");
const MIN_W = 340;
const MIN_H = 220;
const TITLE_H = 38;

// size: pixels, or a fraction of the desktop when below 1.
const APPS = {
	browser: { title: "Browser", icon: "i-globe", size: [0.74, 0.8], content: () => $("view-browser"), onOpen: resumeTabs, onClose: suspendTabs },
	settings: { title: "Settings", icon: "i-settings", size: [840, 580], content: () => document.querySelector("#settings .s-layout") },
	wallpaper: { title: "Wallpaper", icon: "i-image", size: [620, 470], content: () => $("os-wallpaper") },
	eagler: {
		title: "Eaglercraft",
		img: "edutools/launcher/minecraft-icon.jpg",
		size: [0.72, 0.82],
		content: () => Object.assign(document.createElement("iframe"), { className: "os-run", title: "Eaglercraft", allow: "fullscreen; autoplay; gamepad; pointer-lock; clipboard-read; clipboard-write; keyboard-map", allowFullscreen: true }),
		onOpen: () => {
			const frame = wins.eagler.el.querySelector("iframe");
			if (!frame.getAttribute("src") || frame.getAttribute("src") === "about:blank") frame.src = "edutools/launcher/index.html";
		},
		onClose: () => quitFrame(wins.eagler.el.querySelector("iframe")),
	},
	html: { title: "HTML", icon: "i-code", size: [760, 620], content: () => $("view-html") },
	games: {
		title: "Games",
		icon: "i-games",
		size: [0.7, 0.8],
		content: () => [$("view-games"), $("view-player")],
		onClose: () => {
			stopGame();
			$("view-player").hidden = true;
			$("view-games").hidden = false;
		},
	},
	// TV: the TV view itself; js/ui.js starts and guards it the same way as in the default style.
	tv: {
		title: "TV",
		icon: "i-tv",
		size: [0.76, 0.82],
		content: () => $("view-tv"),
		onOpen: () => document.dispatchEvent(new Event("flux:tv-open")),
		onClose: () => {
			quitFrame($("tv-frame"));
			document.dispatchEvent(new Event("flux:tv-close"));
		},
	},
};
const appIcon = (app) => (app.img ? `<img class="i" src="${app.img}" alt="">` : `<svg class="i"><use href="#${app.icon}"/></svg>`);
const wins = {};
let top = 10;
let opened = 0;

const area = () => ({ w: desk.clientWidth, h: desk.clientHeight });
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), Math.max(lo, hi));
const phone = () => innerWidth < 700;

// Geometry is applied as width/height plus a GPU transform, so dragging never re-lays out the page.
function place(win) {
	const { el } = win;
	el.style.width = `${win.w}px`;
	el.style.height = `${win.h}px`;
	el.style.transform = `translate3d(${win.x}px, ${win.y}px, 0)`;
}

let pending = new Set();
function schedule(win) {
	if (!pending.size) requestAnimationFrame(() => (pending.forEach(place), pending.clear()));
	pending.add(win);
}

function build(id) {
	const app = APPS[id];
	const el = document.createElement("section");
	el.className = id === "settings" ? "os-win modal" : "os-win";
	el.dataset.app = id;
	el.setAttribute("aria-label", app.title);
	el.innerHTML =
		`<header class="os-title">${appIcon(app)}<span>${app.title}</span>` +
		`<button class="icon-btn sm" type="button" data-act="min" aria-label="Minimize"><svg class="i"><use href="#i-minus"/></svg></button>` +
		`<button class="icon-btn sm" type="button" data-act="full" aria-label="Fullscreen"><svg class="i"><use href="#i-max"/></svg></button>` +
		`<button class="icon-btn sm" type="button" data-act="max" aria-label="Maximize"><svg class="i"><use href="#i-square"/></svg></button>` +
		`<button class="icon-btn sm os-close" type="button" data-act="close" aria-label="Close"><svg class="i"><use href="#i-x"/></svg></button></header>` +
		`<div class="os-body"></div>` +
		["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((d) => `<i class="os-rz" data-dir="${d}"></i>`).join("");
	const body = el.querySelector(".os-body");
	const [first, ...rest] = [].concat(app.content());
	first.hidden = false;
	body.append(first, ...rest);
	// Browser: the tabs sit in the title bar, like Chrome, instead of a row of their own.
	if (id === "browser") el.querySelector(".os-title > span").replaceWith(el.querySelector("#tabs"));
	desk.append(el);

	const { w: dw, h: dh } = area();
	const w = Math.round(clamp(app.size[0] < 1 ? dw * app.size[0] : app.size[0], MIN_W, dw - 24));
	const h = Math.round(clamp(app.size[1] < 1 ? dh * app.size[1] : app.size[1], MIN_H, dh - 24));
	const step = (opened++ % 6) * 28; // cascade new windows
	const win = { id, el, w, h, x: Math.round((dw - w) / 2) + step - 56, y: Math.max(12, Math.round((dh - h) / 2.6)) + step - 28, max: false, min: false };
	win.x = clamp(win.x, 0, dw - w);
	win.y = clamp(win.y, 0, dh - h);
	place(win);
	wins[id] = win;

	el.addEventListener("pointerdown", () => focus(id), true);
	el.querySelector(".os-title").addEventListener("pointerdown", (e) => drag(win, e));
	el.querySelector(".os-title").addEventListener("dblclick", (e) => !e.target.closest("button, .tab") && toggleMax(win));
	el.addEventListener("pointerdown", (e) => e.target.classList.contains("os-rz") && resize(win, e, e.target.dataset.dir));
	el.querySelector(".os-title").addEventListener("click", (e) => {
		const act = e.target.closest("button")?.dataset.act;
		if (act === "min") minimize(win);
		else if (act === "max") toggleMax(win);
		else if (act === "close") close(win);
		else if (act === "full") el.requestFullscreen?.().then(() => focusPage(win), () => {});
		if (act === "max" || act === "full") focusPage(win);
	});
	el.querySelector(".os-title").addEventListener("pointerup", () => focusPage(win)); // after a drag or a title-bar click
	return win;
}

export function openApp(id) {
	closeStart();
	const win = wins[id] || build(id);
	const wasShut = win.el.hidden || !win.el.isConnected || win.shut;
	win.shut = false;
	win.el.hidden = false;
	win.el.classList.remove("closing");
	if (wasShut || !win.opened) {
		win.opened = true;
		win.el.classList.remove("opening");
		void win.el.offsetWidth;
		win.el.classList.add("opening");
		if (phone() && !win.max) toggleMax(win, false);
		APPS[id].onOpen?.();
	}
	if (win.min) restore(win);
	focus(id);
	renderTasks();
	requestAnimationFrame(() => focusPage(win));
	return win;
}

// Keys go to whatever has focus, and after a click on a window's title bar, the dock or the start
// menu that's Flux, not the game, so WASD did nothing. Hand focus back to the window's page
// (the player does the same in js/library.js). Only windows that run a page: games, Eaglercraft, files.
function focusPage(win) {
	let frame = win.el.querySelector(".os-run, #game-frame, #tv-frame");
	if (!frame || win.min || win.shut) return;
	// With Launch With Proxy the game is one frame deeper, in the launcher's iframe.game.
	for (; frame; frame = frame.contentDocument?.querySelector("iframe.game")) {
		frame.focus();
		try {
			frame.contentWindow.focus();
		} catch {
			break; // not loaded yet
		}
	}
}

function focus(id) {
	const win = wins[id];
	if (!win) return;
	win.el.style.zIndex = ++top;
	for (const w of Object.values(wins)) w.el.classList.toggle("active", w === win);
	renderTasks();
}

function minimize(win) {
	win.min = true;
	win.el.classList.add("min");
	win.el.classList.remove("active");
	renderTasks();
}
function restore(win) {
	win.min = false;
	win.el.classList.remove("min");
}

function close(win) {
	win.shut = true;
	win.el.classList.remove("opening");
	win.el.classList.add("closing");
	APPS[win.id].onClose?.();
	setTimeout(() => win.shut && (win.el.hidden = true), root.classList.contains("perf") ? 0 : 200);
	renderTasks();
}

// Maximize fills the desktop above the taskbar; the change animates once, then sticks.
function toggleMax(win, animate = true) {
	win.max = !win.max;
	const { el } = win;
	if (animate && !root.classList.contains("perf")) {
		el.classList.add("anim");
		setTimeout(() => el.classList.remove("anim"), 300);
	}
	el.classList.toggle("max", win.max);
	el.querySelector('[data-act="max"] use').setAttribute("href", win.max ? "#i-restore" : "#i-square");
	el.querySelector('[data-act="max"]').setAttribute("aria-label", win.max ? "Restore" : "Maximize");
}

// While dragging or resizing, frames ignore the pointer so they can't swallow the movement.
function track(e, target, onMove, onEnd) {
	e.preventDefault();
	target.setPointerCapture(e.pointerId);
	root.classList.add("os-busy");
	const move = (ev) => onMove(ev);
	const end = (ev) => {
		target.removeEventListener("pointermove", move);
		target.removeEventListener("pointerup", end);
		target.removeEventListener("pointercancel", end);
		root.classList.remove("os-busy");
		onEnd?.(ev);
	};
	target.addEventListener("pointermove", move);
	target.addEventListener("pointerup", end);
	target.addEventListener("pointercancel", end);
}

function drag(win, e) {
	if (e.button || e.target.closest("button, .tab")) return;
	const { w: dw, h: dh } = area();
	if (win.max) {
		// Pull a maximized window off the top: it restores under the cursor at the same relative spot.
		const ratio = e.clientX / dw;
		toggleMax(win, false);
		win.x = clamp(e.clientX - win.w * ratio, 0, dw - win.w);
		win.y = 0;
		place(win);
	}
	const offX = e.clientX - win.x;
	const offY = e.clientY - win.y;
	track(
		e,
		e.currentTarget,
		(ev) => {
			win.x = clamp(ev.clientX - offX, -win.w + 80, dw - 80);
			win.y = clamp(ev.clientY - offY, 0, dh - TITLE_H);
			schedule(win);
		},
		(ev) => ev.clientY <= 2 && !win.max && toggleMax(win) // drop on the top edge to maximize
	);
}

function resize(win, e, dir) {
	if (e.button || win.max) return;
	const s = { x: win.x, y: win.y, w: win.w, h: win.h, px: e.clientX, py: e.clientY };
	const { w: dw, h: dh } = area();
	track(e, e.target, (ev) => {
		const dx = ev.clientX - s.px;
		const dy = ev.clientY - s.py;
		if (dir.includes("e")) win.w = clamp(s.w + dx, MIN_W, dw - s.x);
		if (dir.includes("s")) win.h = clamp(s.h + dy, MIN_H, dh - s.y);
		if (dir.includes("w")) {
			win.w = clamp(s.w - dx, MIN_W, s.x + s.w);
			win.x = s.x + s.w - win.w;
		}
		if (dir.includes("n")) {
			win.h = clamp(s.h - dy, MIN_H, s.y + s.h);
			win.y = s.y + s.h - win.h;
		}
		schedule(win);
	});
}

// Taskbar: every app, with a dot when it's open and a highlight when it's in front.
function renderTasks() {
	tasks.innerHTML = Object.entries(APPS)
		.filter(([id, app]) => !app.file || (wins[id] && !wins[id].shut))
		.map(([id, app]) => {
			const win = wins[id];
			const open = win && !win.shut;
			const front = open && !win.min && win.el.classList.contains("active");
			return `<button class="os-task${open ? " open" : ""}${front ? " front" : ""}" type="button" data-task="${id}" aria-label="${app.title}" title="${app.title}">${appIcon(app)}</button>`;
		})
		.join("");
}
// Start menu --------------------------------------------------------------------
const fileKind = { html: "HTML page", text: "Text file", game: "Game" };
function renderStart() {
	const q = start.querySelector("input").value.trim().toLowerCase();
	const match = (name) => !q || name.toLowerCase().includes(q);
	const apps = Object.entries(APPS).filter(([, app]) => !app.file && match(app.title));
	const recent = files.slice(-4).reverse().filter((f) => match(f.name));
	$("os-start-apps").innerHTML = apps.map(([id, app]) => `<button type="button" data-app="${id}"><span class="os-tile">${appIcon(app)}</span>${app.title}</button>`).join("");
	$("os-recent").replaceChildren(
		...recent.map((f) => {
			const b = Object.assign(document.createElement("button"), { type: "button" });
			b.dataset.file = f.id;
			b.innerHTML = `<span class="os-tile">${fileIcon(f)}</span><span></span><small>${fileKind[f.type]}</small>`;
			b.children[1].textContent = f.name;
			return b;
		})
	);
	$("os-recent-label").hidden = !recent.length;
	$("os-start-empty").hidden = !!(apps.length || recent.length);
	$("os-start-apps").previousElementSibling.hidden = !apps.length;
}

function closeStart() {
	if (start.hidden) return;
	start.hidden = true;
	startBtn.setAttribute("aria-expanded", "false");
}

// Event wiring, only in OS mode.
function wire() {
	desk.addEventListener("pointerdown", selectBox);
	desk.addEventListener("pointerdown", dragIcon);
	desk.addEventListener("contextmenu", deskMenu);
	document.addEventListener("pointerdown", (e) => !e.target.closest("#os-menu") && closeMenu());
	document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
	addEventListener("blur", closeMenu);
	document.addEventListener("flux:files", () => (renderDesk(), renderTasks()));
	filesReady.then(renderDesk);
	tasks.addEventListener("click", (e) => {
		const id = e.target.closest("[data-task]")?.dataset.task;
		if (!id) return;
		const win = wins[id];
		if (win && !win.shut && !win.min && win.el.classList.contains("active")) minimize(win);
		else openApp(id);
	});

	startBtn.addEventListener("click", () => {
		if (!start.hidden) return closeStart();
		start.querySelector("input").value = "";
		renderStart();
		start.hidden = false;
		startBtn.setAttribute("aria-expanded", "true");
		start.querySelector("input").focus();
	});
	document.addEventListener("pointerdown", (e) => !start.contains(e.target) && !startBtn.contains(e.target) && closeStart());
	document.addEventListener("keydown", (e) => e.key === "Escape" && closeStart());
	$("os-search").addEventListener("input", renderStart);
	$("os-search").addEventListener("submit", (e) => {
		e.preventDefault();
		const input = e.target.querySelector("input");
		const text = input.value.trim();
		if (!text) return;
		const top = start.querySelector(".os-start-apps button, .os-recent button");
		if (top && !/[./:]/.test(text)) return top.click();
		openApp("browser");
		newTab(text);
	});
	$("os-search").querySelector("input").addEventListener("focus", warmProxy, { once: true });
	$("os-leave").addEventListener("click", () => {
		settings.style = "default";
		saveSettings();
		location.reload();
	});

	// Desktop icons and start menu entries open their app (desktop icons take a double-click with a mouse).
	document.addEventListener("click", (e) => {
		const item = e.target.closest("#os button[data-app], #os button[data-file]");
		if (!item) return;
		if (item.dataset.dragged) return delete item.dataset.dragged;
		if (item.classList.contains("os-icon") && e.detail === 1 && matchMedia("(hover: hover)").matches) return;
		if (item.dataset.app) openApp(item.dataset.app);
		else openFile(files.find((f) => f.id === item.dataset.file));
	});

	// Clicking into a page inside a window (an iframe) brings that window to the front.
	addEventListener("blur", () =>
		setTimeout(() => {
			const win = document.activeElement?.closest?.(".os-win");
			if (win) focus(win.dataset.app);
		})
	);

	// Keep windows on screen when the browser window shrinks.
	addEventListener("resize", () => {
		layoutIcons();
		const { w: dw, h: dh } = area();
		for (const win of Object.values(wins)) {
			win.w = Math.min(win.w, dw);
			win.h = Math.min(win.h, dh);
			win.x = clamp(win.x, -win.w + 80, dw - 80);
			win.y = clamp(win.y, 0, dh - TITLE_H);
			place(win);
		}
	});
}

// Files ---------------------------------------------------------------------------
// Each text or HTML file opens in its own window: a notepad, or the page running in a frame.
function fileApp(file) {
	if (file.type === "text") {
		const area = Object.assign(document.createElement("textarea"), { className: "os-notes", value: file.text || "", spellcheck: false, placeholder: "Start typing…" });
		let timer;
		area.addEventListener("input", () => {
			file.text = area.value;
			clearTimeout(timer);
			timer = setTimeout(saveFiles, 400);
		});
		return { title: file.name, icon: "i-file", size: [540, 440], content: () => area, file };
	}
	const frame = Object.assign(document.createElement("iframe"), { className: "os-run", title: file.name, allowFullscreen: true });
	frame.allow = "fullscreen; autoplay; gamepad; pointer-lock; clipboard-write";
	const app = {
		title: file.name,
		icon: "i-code",
		size: [0.62, 0.72],
		content: () => frame,
		file,
		onOpen: async () => {
			URL.revokeObjectURL(frame.src);
			try {
				frame.src = await htmlUrl(app.file);
			} catch {
				toast("Couldn't start the proxy. Try again, or turn Load with proxy off.");
			}
		},
		onClose: () => quitFrame(frame),
	};
	return app;
}

// Closes a file's window for good (its file was deleted, or an unsaved page is replaced).
function removeApp(id) {
	const win = wins[id];
	if (win) {
		APPS[id].onClose?.();
		win.el.remove();
		delete wins[id];
	}
	delete APPS[id];
	renderTasks();
}

export function openFile(file) {
	if (file.type === "game") {
		openApp("games");
		return play(file.gameId);
	}
	const id = `file-${file.id || "unsaved"}`;
	if (APPS[id] && APPS[id].file !== file) removeApp(id);
	APPS[id] ??= fileApp(file);
	openApp(id);
}

const fileIcon = (f) =>
	f.type === "game" && f.image ? `<img src="${f.image.replace(/"/g, "&quot;")}" alt="" loading="lazy">` : `<svg class="i"><use href="#${f.type === "text" ? "i-file" : "i-code"}"/></svg>`;
function renderDesk() {
	for (const el of desk.querySelectorAll(".os-icon")) el.remove();
	const first = desk.querySelector(".os-win");
	const add = (key, value, art, label) => {
		const icon = Object.assign(document.createElement("button"), { className: "os-icon", type: "button" });
		icon.dataset[key] = value;
		icon.innerHTML = `<span>${art}</span><b></b>`;
		icon.lastChild.textContent = label;
		desk.insertBefore(icon, first);
	};
	// Every app in the start menu, then your files.
	for (const [id, app] of Object.entries(APPS)) if (!app.file) add("app", id, appIcon(app), app.title);
	for (const f of files) add("file", f.id, fileIcon(f), f.name);
	layoutIcons();
}

// Add game: type to filter, then pick one of the cards (3 across).
let picker = null;
function addGame() {
	if (!picker) {
		picker = Object.assign(document.createElement("dialog"), { className: "modal os-pick" });
		picker.innerHTML =
			`<div class="os-pick-head"><h2>Add a game</h2><button class="icon-btn" type="button" aria-label="Close"><svg class="i"><use href="#i-x"/></svg></button></div>` +
			`<input class="os-pick-search" type="search" placeholder="Type a game name" aria-label="Game name" spellcheck="false" autocomplete="off">` +
			`<div class="os-pick-grid"></div><p class="os-pick-empty" hidden>No games match that.</p>`;
		$("os").append(picker);
		animateDialog(picker);
		picker.querySelector(".os-pick-head button").addEventListener("click", () => closeDialog(picker));
		picker.querySelector("input").addEventListener("input", showPicks);
		picker.querySelector(".os-pick-grid").addEventListener("click", (e) => {
			const game = gameList().find((g) => g.id === e.target.closest("[data-id]")?.dataset.id);
			if (!game) return;
			addFile({ type: "game", name: game.title, gameId: game.id, image: game.image });
			toast(`Added ${game.title} to the desktop`);
			closeDialog(picker);
		});
	}
	picker.querySelector("input").value = "";
	showPicks();
	picker.showModal();
	picker.querySelector("input").focus();
}
function showPicks() {
	const q = picker.querySelector("input").value.trim().toLowerCase();
	const games = gameList().filter((g) => g.title.toLowerCase().includes(q)).slice(0, 60); // shortcut: first 60 matches, type more to narrow
	picker.querySelector(".os-pick-grid").replaceChildren(
		...games.map((g) => {
			const card = Object.assign(document.createElement("button"), { type: "button", className: "os-pick-card" });
			card.dataset.id = g.id;
			card.append(Object.assign(document.createElement("img"), { src: g.image, alt: "", loading: "lazy" }), Object.assign(document.createElement("span"), { textContent: g.title }));
			return card;
		})
	);
	picker.querySelector(".os-pick-empty").hidden = games.length > 0;
}
async function newText() {
	const answer = await ask({ title: "New text file", fields: [{ label: "Name", value: "Notes" }], ok: "Create" });
	if (answer) openFile(addFile({ type: "text", name: answer[0], text: "" }));
}
async function renameFile(file) {
	const answer = await ask({ title: "Rename", fields: [{ label: "Name", value: file.name }], ok: "Rename" });
	if (!answer) return;
	file.name = answer[0];
	saveFiles();
	const id = `file-${file.id}`;
	if (APPS[id]) {
		APPS[id].title = file.name;
		const label = wins[id]?.el.querySelector(".os-title > span");
		if (label) label.textContent = file.name;
	}
}
async function deleteFile(file) {
	if (!(await ask({ title: `Delete ${file.name}?`, message: "It's removed from this browser. This can't be undone.", ok: "Delete", danger: true }))) return;
	removeApp(`file-${file.id}`);
	delete spots[`file:${file.id}`];
	removeFile(file.id);
}

// Right-click menu ----------------------------------------------------------------
const closeMenu = () => $("os-menu")?.remove();
function showMenu(e, items) {
	e.preventDefault();
	closeMenu();
	const menu = Object.assign(document.createElement("div"), { className: "os-menu", id: "os-menu" });
	menu.setAttribute("role", "menu");
	for (const item of items) {
		if (!item) {
			menu.append(document.createElement("hr"));
			continue;
		}
		const button = Object.assign(document.createElement("button"), { type: "button", textContent: item[0] });
		button.setAttribute("role", "menuitem");
		button.addEventListener("click", () => (closeMenu(), item[1]()));
		menu.append(button);
	}
	$("os").append(menu);
	menu.style.left = `${Math.min(e.clientX, innerWidth - menu.offsetWidth - 8)}px`;
	menu.style.top = `${Math.min(e.clientY, innerHeight - menu.offsetHeight - 8)}px`;
	menu.querySelector("button").focus();
}
function deskMenu(e) {
	if (e.target.closest(".os-win")) return; // pages in windows keep their own menu
	const fileEl = e.target.closest(".os-icon[data-file]");
	const appEl = e.target.closest(".os-icon[data-app]");
	if (fileEl) {
		const file = files.find((f) => f.id === fileEl.dataset.file);
		return showMenu(e, [["Open", () => openFile(file)], ["Rename", () => renameFile(file)], null, ["Delete", () => deleteFile(file)]]);
	}
	if (appEl) return showMenu(e, [["Open", () => openApp(appEl.dataset.app)]]);
	showMenu(e, [["Add game", addGame], ["New text file", newText], ["Add HTML file or code", () => openApp("html")], null, ["Change wallpaper", () => openApp("wallpaper")]]);
}

// Desktop icons -------------------------------------------------------------------
// Each icon sits in a grid cell. Dragged icons keep their cell (saved); the rest fill the free
// cells top to bottom, column by column, like Windows.
const CELL_W = 96;
const CELL_H = 104;
const PAD = 12;
const SPOTS_KEY = "flux:icon-spots";
let spots = {};
try {
	spots = JSON.parse(localStorage.getItem(SPOTS_KEY) || "{}");
} catch {
	// Icons start in their default places.
}
const iconKey = (el) => (el.dataset.app ? `app:${el.dataset.app}` : `file:${el.dataset.file}`);
const rows = () => Math.max(1, Math.floor((desk.clientHeight - PAD) / CELL_H));
const at = (el, c, r) => (el.style.transform = `translate3d(${PAD + c * CELL_W}px, ${PAD + r * CELL_H}px, 0)`);

function layoutIcons() {
	const icons = [...desk.querySelectorAll(".os-icon")];
	const taken = new Set(icons.map((el) => spots[iconKey(el)]).filter(Boolean).map(String));
	let next = 0;
	for (const el of icons) {
		let spot = spots[iconKey(el)];
		if (!spot) {
			do spot = [Math.floor(next / rows()), next++ % rows()];
			while (taken.has(String(spot)));
			taken.add(String(spot));
		}
		at(el, Math.min(spot[0], Math.floor((desk.clientWidth - PAD) / CELL_W) - 1), Math.min(spot[1], rows() - 1));
		el.dataset.cell = spot;
	}
}

function dragIcon(e) {
	const el = e.target.closest(".os-desk > .os-icon");
	if (!el || e.button) return;
	const [c0, r0] = el.dataset.cell.split(",").map(Number);
	const x0 = PAD + c0 * CELL_W;
	const y0 = PAD + r0 * CELL_H;
	let moved = false;
	track(
		e,
		el,
		(ev) => {
			const dx = ev.clientX - e.clientX;
			const dy = ev.clientY - e.clientY;
			if (!moved && Math.hypot(dx, dy) < 5) return; // a click, not a drag
			moved = true;
			el.classList.add("dragging");
			el.style.transform = `translate3d(${x0 + dx}px, ${y0 + dy}px, 0)`;
		},
		(ev) => {
			if (!moved) return;
			el.classList.remove("dragging");
			el.dataset.dragged = "1";
			setTimeout(() => delete el.dataset.dragged, 0); // only swallows this drag's own click
			const c = clamp(Math.round((x0 + ev.clientX - e.clientX - PAD) / CELL_W), 0, Math.floor((desk.clientWidth - PAD) / CELL_W) - 1);
			const r = clamp(Math.round((y0 + ev.clientY - e.clientY - PAD) / CELL_H), 0, rows() - 1);
			// Every icon keeps the cell it's in now, so the others don't shift into the gap.
			for (const o of desk.querySelectorAll(".os-icon")) spots[iconKey(o)] = o.dataset.cell.split(",").map(Number);
			// Dropped on another icon: they swap places.
			const other = [...desk.querySelectorAll(".os-icon")].find((o) => o !== el && o.dataset.cell === `${c},${r}`);
			if (other) spots[iconKey(other)] = [c0, r0];
			spots[iconKey(el)] = [c, r];
			try {
				localStorage.setItem(SPOTS_KEY, JSON.stringify(spots));
			} catch {
				// Placed for this visit only.
			}
			layoutIcons();
		}
	);
}

// Desktop: drag on empty space to draw a selection box over the icons, like Windows.
function selectBox(e) {
	if (e.button || e.target !== desk) return;
	const icons = [...desk.querySelectorAll(".os-icon")];
	for (const icon of icons) icon.classList.remove("selected");
	const box = document.createElement("div");
	box.className = "os-sel";
	desk.append(box);
	const sx = e.clientX;
	const sy = e.clientY;
	track(
		e,
		desk,
		(ev) => {
			const l = Math.min(sx, ev.clientX), t = Math.min(sy, ev.clientY);
			const r = Math.max(sx, ev.clientX), b = Math.max(sy, ev.clientY);
			box.style.cssText = `left:${l}px;top:${t}px;width:${r - l}px;height:${b - t}px`;
			for (const icon of icons) {
				const ir = icon.getBoundingClientRect();
				icon.classList.toggle("selected", ir.left < r && ir.right > l && ir.top < b && ir.bottom > t);
			}
		},
		() => box.remove()
	);
}

// Boot screen: covers the first seconds of work (game list, proxy scripts) and builds every
// window ahead of time, so the first drag of each window is already smooth.
export async function bootOS(gamesReady) {
	const boot = $("os-boot");
	const say = (text, done) => {
		$("os-boot-text").textContent = text;
		$("os-boot-fill").style.transform = `scaleX(${done})`;
	};
	const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	const upTo = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(r, ms))]);
	say("Loading apps", 0.15);
	await settle();
	for (const id of Object.keys(APPS)) {
		if (wins[id]) continue; // already opened (a link in the address opens the browser right away)
		const win = build(id);
		Object.assign(win, { shut: true, opened: false });
		win.el.hidden = true;
	}
	renderTasks();
	await upTo(filesReady, 3000); // your desktop files are there when the boot screen lifts
	renderDesk();
	say("Loading games", 0.4);
	await upTo(gamesReady, 8000);
	say("Caching proxy data", 0.7);
	warmProxy();
	await upTo(document.fonts.ready, 3000);
	say("Starting", 1);
	await settle();
	await new Promise((r) => setTimeout(r, 250));
	boot.classList.add("done");
	setTimeout(() => boot.remove(), 500);
}

function tick() {
	const now = new Date();
	$("os-clock").textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	$("os-clock").dateTime = now.toISOString();
}

if (osMode) {
	wire();
	tick();
	setInterval(tick, 15000);
	renderTasks();
}
