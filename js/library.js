// Game library (from edulist.txt) and the game player.
import { toast } from "./modal.js";

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

export async function loadGames() {
	const res = await fetch("edulist.txt");
	if (!res.ok) throw new Error(`Couldn't load edulist.txt (HTTP ${res.status})`);
	// edulist.txt is a list of JS object literals (not JSON); Flux V2 read it the same way.
	const list = Function(`"use strict"; return [${await res.text()}]`)();
	// In the OS style the Eaglercraft Launcher is its own app (js/os.js), not a game.
	const os = document.documentElement.classList.contains("os");
	const games = sortGames(list.filter((g) => !(os && g.id === "EaglercraftLauncher")).map((g) => ({ ...g, title: g.title.replace(/[‎‏]/g, "").trim() })));

	grid.innerHTML = games
		.map((g) => {
			byId.set(g.id, g);
			const title = esc(g.title);
			return (
				`<div class="card" data-id="${esc(g.id)}" data-title="${(title + (g.tags ? " " + esc(g.tags) : "")).toLowerCase()}">` +
				`<button class="card-play" type="button" title="${title}">` +
				`<span class="card-art"><img src="${esc(sitePath(g.image))}" alt="" loading="lazy" decoding="async" width="160" height="160"></span>` +
				`<span class="card-title">${title}</span></button>` +
				`<button class="card-star${favs.has(g.id) ? " on" : ""}" type="button" aria-label="Favorite ${title}" aria-pressed="${favs.has(g.id)}">` +
				`<svg class="i"><use href="#i-star"/></svg></button></div>`
			);
		})
		.join("");
	showCount(games.length);
	return games.length;
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
	$("games-heading").textContent = onlyFavs ? "Favorites" : query() ? "Results" : "All games";
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
	frame.src = sitePath(game.url);
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

// Every game with its picture's full address (for the OS "Add game" picker).
export const gameList = () => [...byId.values()].map((g) => ({ id: g.id, title: g.title, image: sitePath(g.image) }));

// Fully quits whatever a frame is running. Taking it off the page ends the page with everything it
// started (workers, sockets, audio) and skips "Leave site?" prompts, which Eaglercraft 26.x shows;
// the same, now empty, frame goes straight back.
export function quitFrame(el) {
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
		else play(card.dataset.id);
	});
	search.addEventListener("input", filter);
	favsButton.addEventListener("click", () => {
		onlyFavs = !onlyFavs;
		favsButton.setAttribute("aria-pressed", onlyFavs);
		filter();
	});
	$("random-game").addEventListener("click", () => {
		const ids = [...byId.keys()];
		play(ids[Math.floor(Math.random() * ids.length)]);
	});
	playerStar.addEventListener("click", () => current && toggleFavWithToast(current.id));
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
