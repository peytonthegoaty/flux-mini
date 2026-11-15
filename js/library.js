// Game library (from edulist.txt) and the game player.
import { uvUrl } from "./app.js";
import { debug } from "./log.js";
import { ask, toast } from "./modal.js";
import { addSiteDialog, removeSite, sites } from "./sites.js";
import { enhanceSelect } from "./select.js";
import { volumeControl } from "./volume.js";

const FAVS_KEY = "flux:favs";
const $ = (id) => document.getElementById(id);
const grid = $("grid");
const search = $("game-search");
const empty = $("no-results");
const frame = $("game-frame");
const favsButton = $("show-favs");
const playerStar = $("player-fav");

const byId = new Map();
let favs = new Set();
let onlyFavs = false;
let current = null;
let showView = () => {};

try {
	favs = new Set(JSON.parse(localStorage.getItem(FAVS_KEY) || "[]"));
} catch {
	// No saved favorites.
}

function saveFavs() {
	try {
		localStorage.setItem(FAVS_KEY, JSON.stringify([...favs]));
	} catch {
		// Favorites last for this page load only.
	}
}

// edulist.txt paths were written for a site at the domain root ("/visuals/x.png",
// "../../EmulatorJS-main/..."); resolve them inside this site's folder instead.
const sitePath = (path) => new URL(path.replace(/^(\.\.\/|\/)+/, ""), document.baseURI).href;

const esc = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Symbols first, then numbers, then letters (same order as Flux V2).
function sortGames(list) {
	const group = (title) => {
		const c = title.charCodeAt(0);
		return c < 48 ? 0 : c <= 57 ? 1 : 2;
	};
	return list.sort(
		(a, b) =>
			group(a.title) - group(b.title) ||
			a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" })
	);
}

let localGames = [];
let gnGames = [];

export async function loadGames() {
	const res = await fetch("edulist.txt");
	if (!res.ok) throw new Error(`Couldn't load edulist.txt (HTTP ${res.status})`);
	// edulist.txt is a list of JS object literals (not JSON); Flux V2 read it the same way.
	const list = Function(`"use strict"; return [${await res.text()}]`)();
	// In the OS style the Eaglercraft Launcher is its own app (js/os.js), not a game.
	const os = document.documentElement.classList.contains("os");
	localGames = list.filter((g) => !(os && g.id === "EaglercraftLauncher")).map((g) => ({ ...g, title: g.title.replace(/[‎‏]/g, "").trim() }));
	render();
	return localGames.length;
}

// The list the dropdown at the top shows: "flux" (edulist.txt) or "gn" (gn-math).
const source = $("game-source");
const sourceName = () => source.selectedOptions[0].text;

function render() {
	byId.clear();
	for (const g of [...localGames, ...sites, ...gnGames]) byId.set(g.id, g);
	const games = sortGames(source.value === "gn" ? [...gnGames] : [...localGames, ...sites]);
	grid.innerHTML = games
		.map((g) => {
			const title = esc(g.title);
			return (
				`<div class="card" data-id="${esc(g.id)}" data-title="${(title + (g.tags ? " " + esc(g.tags) : "")).toLowerCase()}">` +
				`<button class="card-play" type="button" title="${title}">` +
				`<span class="card-art"><img src="${esc(sitePath(g.image))}" alt="" loading="lazy" decoding="async" width="160" height="160"></span>` +
				`<span class="card-title">${title}</span></button>` +
				`<button class="card-star${favs.has(g.id) ? " on" : ""}" type="button" aria-label="Favorite ${title}" aria-pressed="${favs.has(g.id)}">` +
				`<svg class="i"><use href="#i-star"/></svg></button>` +
				(g.site ? `<button class="card-del" type="button" aria-label="Remove ${title}" title="Remove website"><svg class="i"><use href="#i-x"/></svg></button>` : "") +
				`</div>`
			);
		})
		.join("");
	if (query() || onlyFavs) filter();
	else {
		empty.hidden = games.length > 0;
		showCount(games.length);
	}
}

// gn-math (gn-math.dev) ---------------------------------------------------------
// gn-math reads its game list from zones.json on jsDelivr and each game from freebuisness/html,
// whose pages carry a <base> pointing at the game's files on jsDelivr. jsDelivr serves those pages
// as text/plain, so they're fetched and shown from a blob. Where jsDelivr is blocked, the list,
// covers and games all come through Ultraviolet instead (the Wisp server pickWisp finds).
const GN = "https://cdn.jsdelivr.net/gh/freebuisness/";
const gnUrl = (u) => u.replace("{COVER_URL}", GN + "covers@main").replace("{HTML_URL}", GN + "html@main");
let gnProxy = false;

// This site's Ultraviolet address for a URL, usable from this page as well as from frames.
export async function viaProxy(url) {
	const path = await uvUrl(url);
	// The service worker only sees this page's own requests (list, covers) once it controls the page.
	if (!navigator.serviceWorker.controller) {
		const claimed = new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
		(await navigator.serviceWorker.ready).active.postMessage("claim");
		await claimed;
	}
	return new URL(path, location.href).href;
}

async function gnText(url) {
	if (!gnProxy) {
		const stop = new AbortController();
		const timer = setTimeout(() => stop.abort(), 8000);
		try {
			const res = await fetch(url, { signal: stop.signal });
			clearTimeout(timer);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.text();
		} catch (err) {
			if (err.message?.startsWith("HTTP")) throw err; // jsDelivr answered; the file is the problem
			gnProxy = true;
			debug(`gn-math: jsDelivr didn't answer (${err.message || err}); loading gn-math through the proxy`, true);
		}
	}
	const res = await fetch(await viaProxy(url));
	if (!res.ok) throw new Error(`HTTP ${res.status} through the proxy`);
	return res.text();
}

let gnLoading = null;
export const loadGnMath = () => (gnLoading ??= fetchGnMath());
async function fetchGnMath() {
	empty.textContent = "Loading GN-Math games…";
	try {
		const zones = JSON.parse(await gnText(GN + "assets@main/zones.json"));
		gnGames = await Promise.all(
			zones
				.filter((z) => z.url.startsWith("{HTML_URL}")) // the rest are links (their Discord)
				.map(async (z) => ({
					id: `gn-${z.id}`,
					title: z.name,
					gn: gnUrl(z.url),
					image: gnProxy ? await viaProxy(gnUrl(z.cover)) : gnUrl(z.cover),
				}))
		);
		render();
		debug(`gn-math: ${gnGames.length} games${gnProxy ? " through the proxy" : ""}`);
	} catch (err) {
		gnLoading = null; // try again next time the list is picked
		debug(`gn-math games didn't load: ${err.message || err}`, true);
		if (source.value === "gn") empty.textContent = "Couldn't load the GN-Math games. Switch to Flux Games and back to try again.";
	}
}

// jsDelivr refuses some GitHub users' files ("User gn-math is blocked"); githack serves the same files.
// shortcut: the users found blocked on 2026-11-14; add any that a game's console shows as blocked.
const unblock = (html) =>
	html.replace(/https:\/\/cdn\.jsdelivr\.net\/gh\/(gn-math|genizy|NotRexed)\/([^/@"'\s]+)(?:@([^/"'\s]+))?/g, (_, user, repo, ref) => `https://raw.githack.com/${user}/${repo}/${!ref || ref === "latest" ? "HEAD" : ref}`);

// Loads a game into a frame: the game player's, or an OS window's. Every frame is on this site, so a
// game keeps its saves (and its proxied site's storage) wherever it's played.
export function startGame(game, el) {
	const run = (el.run = (el.run || 0) + 1);
	if (game.gn) playGn(game, el, () => run !== el.run);
	// A website you added: through the proxy, like a browser tab.
	else if (game.site) viaProxy(game.url).then((url) => run === el.run && (el.src = url), () => toast(`Couldn't start the proxy for ${game.title}.`));
	else el.src = sitePath(game.url);
}

async function playGn(game, frame, stale) {
	try {
		const html = unblock(await gnText(game.gn));
		if (stale()) return;
		if (!gnProxy) return void (frame.src = URL.createObjectURL(new Blob([html], { type: "text/html" })));
		// Through the proxy: open a small page in Ultraviolet, move it to the game's folder, then write
		// the game into it. Ultraviolet rewrites what's written, so the game's files load through the
		// proxy too. It resolves them against __uv.meta.base, which a written <base> doesn't update.
		const folder = new URL(html.match(/<base\s[^>]*href=["']?([^"' >]+)/i)?.[1] || ".", game.gn).href;
		frame.src = await viaProxy("https://example.com/");
		await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
		if (stale()) return;
		// Started by the frame's own timer: document.open() gives the page the address of the script
		// that started the call, which from here would be Flux's.
		const win = frame.contentWindow;
		win.setTimeout(new win.Function("url", "html", "history.replaceState(null, '', url); __uv.meta.base = new URL(url); document.open(); document.write(html); document.close();"), 0, folder, html);
	} catch (err) {
		if (stale()) return;
		debug(`gn-math: ${game.title}: ${err.message || err}`, true);
		toast(`Couldn't load ${game.title}.`);
	}
}

function filter() {
	const query = search.value.trim().toLowerCase();
	let shown = 0;
	for (const card of grid.children) {
		const match = (!query || card.dataset.title.includes(query)) && (!onlyFavs || favs.has(card.dataset.id));
		card.hidden = !match;
		if (match) shown++;
	}
	empty.hidden = shown > 0;
	empty.textContent = query ? `No games match "${search.value.trim()}".` : "No favorites yet. Tap the star on a game to add it.";
	showCount(shown);
	animateCards();
}

function showCount(shown) {
	$("games-heading").textContent = onlyFavs ? "Favorites" : query() ? "Results" : sourceName();
	$("games-shown").textContent = `${shown} game${shown === 1 ? "" : "s"}`;
}
const query = () => search.value.trim();

// Fades in the first screenful of visible cards one after another.
export function animateCards() {
	for (const card of grid.querySelectorAll(".enter")) card.classList.remove("enter");
	void grid.offsetWidth; // restart the animation on cards that had it
	let i = 0;
	for (const card of grid.children) {
		if (card.hidden) continue;
		card.style.setProperty("--d", i);
		card.classList.add("enter");
		if (++i === 30) break;
	}
}

function toggleFav(id) {
	if (favs.has(id)) favs.delete(id);
	else favs.add(id);
	saveFavs();
	const on = favs.has(id);
	const star = grid.querySelector(`[data-id="${CSS.escape(id)}"] .card-star`);
	star?.classList.toggle("on", on);
	star?.setAttribute("aria-pressed", on);
	if (current?.id === id) playerStar.classList.toggle("on", on);
	if (onlyFavs) filter();
	return on;
}

function toggleFavWithToast(id) {
	toast(toggleFav(id) ? `Added ${byId.get(id).title} to favorites` : `Removed ${byId.get(id).title} from favorites`);
}

export function clearFavs() {
	for (const id of [...favs]) toggleFav(id);
	toast("Favorites cleared");
}

export function play(id) {
	const game = byId.get(id);
	if (!game) return;
	current = game;
	playerStar.hidden = false;
	$("player-title").textContent = game.title;
	playerStar.classList.toggle("on", favs.has(id));
	startGame(game, frame);
	showView("player");
}

// Plays a page that isn't in the game list (the HTML section).
export function playUrl(title, url) {
	current = null;
	$("player-title").textContent = title;
	playerStar.hidden = true;
	frame.src = url;
	showView("player");
}

// Asks for a website and adds it to the games (Flux Games). Resolves with it, or null.
export async function addWebsite() {
	const site = await addSiteDialog();
	if (!site) return null;
	render();
	animateCards();
	toast(`Added ${site.title} to your games`);
	return site;
}

async function forgetSite(site) {
	if (!(await ask({ title: `Remove ${site.title}?`, message: "It's taken off your games in this browser.", ok: "Remove", danger: true }))) return;
	removeSite(site.id);
	favs.delete(site.id);
	saveFavs();
	render();
}

// Every game with its picture's full address (for the OS "Add game" picker). gn: from gn-math.
export const gameList = () => [...byId.values()].map((g) => ({ id: g.id, title: g.title, image: sitePath(g.image), gn: !!g.gn }));

// A game by id, loading the gn-math list first when it's one of theirs (an OS desktop icon).
export async function findGame(id) {
	if (id.startsWith("gn-")) await loadGnMath();
	return byId.get(id);
}

// Fully quits whatever a frame is running. Taking it off the page ends the page with everything it
// started (workers, sockets, audio) and skips "Leave site?" prompts, which Eaglercraft 26.x shows;
// the same, now empty, frame goes straight back.
export function quitFrame(el) {
	el.run = (el.run || 0) + 1; // a game still loading into it stops
	if (el.src.startsWith("blob:")) URL.revokeObjectURL(el.src);
	const [parent, next] = [el.parentNode, el.nextSibling];
	el.remove();
	el.removeAttribute("src");
	parent?.insertBefore(el, next);
}

// Unloads the game so it stops using CPU and audio.
export function stopGame() {
	current = null;
	quitFrame(frame);
}

export function initGames(show) {
	showView = show;
	// error doesn't bubble, so catch image failures in the capture phase.
	grid.addEventListener("error", (e) => e.target.tagName === "IMG" && e.target.parentElement.classList.add("broken"), true);
	grid.addEventListener("click", (e) => {
		const card = e.target.closest(".card");
		if (!card) return;
		if (e.target.closest(".card-star")) toggleFavWithToast(card.dataset.id);
		else if (e.target.closest(".card-del")) forgetSite(byId.get(card.dataset.id));
		else play(card.dataset.id);
	});
	search.addEventListener("input", filter);
	enhanceSelect(source);
	$("add-site").addEventListener("click", async () => {
		const site = await addWebsite();
		if (site && source.value !== "flux") {
			source.value = "flux";
			source.dispatchEvent(new Event("change"));
		}
	});
	source.addEventListener("change", () => {
		if (source.value === "gn") loadGnMath();
		render();
		animateCards();
	});
	favsButton.addEventListener("click", () => {
		onlyFavs = !onlyFavs;
		favsButton.setAttribute("aria-pressed", onlyFavs);
		filter();
	});
	$("random-game").addEventListener("click", () => {
		const ids = [...grid.children].map((card) => card.dataset.id);
		play(ids[Math.floor(Math.random() * ids.length)]);
	});
	playerStar.addEventListener("click", () => current && toggleFavWithToast(current.id));
	$("player-fav").before(volumeControl($("view-player"), "player"));
	// Keys go to whatever has focus, which after a click is the button, not the game; hand it back.
	const focusGame = () => {
		frame.focus();
		frame.contentWindow?.focus();
	};
	frame.addEventListener("load", () => current && focusGame());
	$("player-fullscreen").addEventListener("click", () => {
		frame.requestFullscreen?.().then(focusGame, () => {});
		focusGame();
	});
}
