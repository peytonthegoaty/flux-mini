// Offline: Flux keeps working with no internet.
// - Flux's own files (page, scripts, styles, fonts, game list) are kept on every visit.
// - A game you save keeps all its files. offline.json (built by build_svg.py) lists each game
//   folder's files and sizes, so the size is known before you agree.
// - Your HTML files, notes, favorites and settings already live in this browser.
// sw.js serves the kept copies while the browser says it's offline.
import { ask, toast } from "./modal.js";

const KEY = "flux:offline";
const GAMES = "flux-offline"; // saved games' files
const SHELL = "flux-shell"; // Flux's own files
const $ = (id) => document.getElementById(id);

let saved = {}; // game id -> { title, folder, bytes }
try {
	saved = JSON.parse(localStorage.getItem(KEY) || "{}");
} catch {
	// Nothing saved.
}
const keep = () => {
	try {
		localStorage.setItem(KEY, JSON.stringify(saved));
	} catch {
		// The files are saved; only the list of them couldn't be.
	}
	document.dispatchEvent(new Event("flux:offline"));
};

export const isSaved = (id) => id in saved;
const folderOf = (game) => /(?:^|\/)edutools\/([^/]+)\//.exec(game.url || "")?.[1];
// Flux's own games only: GN-Math games and added websites come from other sites.
export const canSave = (game) => !game.gn && !game.site && !!folderOf(game);

export const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`);
const space = async () => (await navigator.storage?.estimate?.().catch(() => null)) || {};
const folderUrl = (folder) => new URL(`edutools/${folder}/`, document.baseURI).href;
// The same address the game asks for: the browser escapes everything but these when it requests a file.
const fileUrl = (folder, path) => new URL(path.split("/").map((part) => part.replace(/[%#?]/g, encodeURIComponent)).join("/"), folderUrl(folder)).href;

let manifest = null;
async function filesOf(folder) {
	manifest ??= fetch("offline.json", { cache: "no-cache" })
		.then((res) => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json();
		})
		.catch((err) => {
			manifest = null;
			throw err;
		});
	const all = await manifest;
	const name = folder in all ? folder : Object.keys(all).find((f) => f.toLowerCase() === folder.toLowerCase());
	return name ? { folder: name, list: all[name] } : null;
}

// Asks first (with the size and the space left), then downloads every file of the game and its picture.
export async function saveGame(game, picture) {
	if (!navigator.onLine) return toast("Connect to the internet to save games for offline.");
	let found;
	try {
		found = await filesOf(folderOf(game));
	} catch {
		return toast("Couldn't get this game's file list. Try again in a moment.");
	}
	if (!found?.list.length) return toast(`${game.title} can't be saved for offline.`);
	const { folder, list } = found;
	const bytes = list.reduce((n, [, b]) => n + b, 0);
	const { usage = 0, quota = 0 } = await space();
	const free = quota - usage;
	if (quota && bytes > free) {
		await ask({ title: "Not enough space", message: `${game.title} needs ${size(bytes)}, but this browser only has ${size(free)} left for Flux. Remove saved games in Settings, Offline, to make room.`, ok: "OK" });
		return;
	}
	const room = quota ? ` This browser has ${size(free)} of ${size(quota)} left for Flux.` : "";
	if (!(await ask({ title: `Save ${game.title} for offline?`, message: `It takes ${size(bytes)}.${room} You can remove it any time in Settings, Offline.`, ok: "Save" }))) return;
	await navigator.storage?.persist?.().catch(() => {}); // asks the browser not to clear saved games when the device runs low

	const cache = await caches.open(GAMES);
	const urls = list.map(([path]) => fileUrl(folder, path));
	if (picture) urls.push(picture);
	const total = urls.length;
	let done = 0;
	let failed = 0;
	let shown = -1;
	const step = async () => {
		for (let url; (url = urls.shift()); ) {
			try {
				const res = await fetch(url, { cache: "no-cache" });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				await cache.put(url, res);
			} catch {
				failed++;
			}
			const percent = Math.floor((++done / total) * 100);
			if (percent !== shown && percent % 5 === 0) toast(`Saving ${game.title} for offline… ${(shown = percent)}%`);
		}
	};
	await Promise.all(Array.from({ length: 6 }, step)); // six at a time, like the browser does
	saved[game.id] = { title: game.title, folder, bytes };
	keep();
	toast(failed ? `Saved ${game.title}, but ${failed} of ${total} files didn't download. Parts may not work offline.` : `${game.title} works offline now.`);
}

export async function removeGame(id) {
	const entry = saved[id];
	if (!entry) return;
	delete saved[id];
	keep();
	// Another saved game in the same folder keeps the files.
	if (Object.values(saved).some((s) => s.folder === entry.folder)) return;
	const cache = await caches.open(GAMES);
	const prefix = folderUrl(entry.folder);
	await Promise.all((await cache.keys()).filter((req) => req.url.startsWith(prefix)).map((req) => cache.delete(req)));
}

// Keeps Flux's own files for offline use: the page and every script, style, font and icon it loaded.
// The browser's own cache answers most of these, so it costs little.
const SHELL_FILES = /^(js|css|fonts)\/|^(edulist\.txt|LOGO\.svg|favicon\.ico|sw\.js)$/;
async function keepShell() {
	const site = new URL("./", document.baseURI).href;
	const files = new Set([location.href]);
	for (const entry of performance.getEntriesByType("resource")) {
		const url = entry.name.split("#")[0];
		if (url.startsWith(site) && SHELL_FILES.test(url.slice(site.length).split("?")[0])) files.add(url);
	}
	const cache = await caches.open(SHELL);
	await Promise.all([...files].map((url) => cache.add(url).catch(() => {})));
}

// Settings, Offline: the space used and left, and every saved game with a Remove button.
async function showPanel() {
	const list = $("offline-list");
	if (!list) return;
	const { usage = 0, quota = 0 } = await space();
	$("offline-space").textContent = quota ? `Flux is using ${size(usage)}. This browser has ${size(quota - usage)} of ${size(quota)} left for it.` : "This browser doesn't say how much space it has.";
	const ids = Object.keys(saved).sort((a, b) => saved[a].title.localeCompare(saved[b].title));
	list.replaceChildren(
		...ids.map((id) => {
			const li = document.createElement("li");
			li.append(Object.assign(document.createElement("span"), { textContent: saved[id].title }), Object.assign(document.createElement("small"), { textContent: size(saved[id].bytes) }));
			const remove = Object.assign(document.createElement("button"), { className: "btn", type: "button", textContent: "Remove" });
			remove.addEventListener("click", async () => {
				const { title } = saved[id];
				remove.disabled = true;
				await removeGame(id);
				toast(`Removed ${title} from offline`);
			});
			li.append(remove);
			return li;
		})
	);
	$("offline-empty").hidden = ids.length > 0;
}

function showState() {
	document.documentElement.classList.toggle("offline", !navigator.onLine);
}

export function initOffline() {
	showState();
	addEventListener("offline", () => {
		showState();
		toast("You're offline. Games you saved for offline still work.");
	});
	addEventListener("online", () => {
		showState();
		toast("You're back online.");
	});
	document.addEventListener("flux:offline", showPanel);
	document.querySelector('.s-tab[data-tab="offline"]')?.addEventListener("click", showPanel);
	// The service worker serves the kept copies, so it's started on every visit, not only for the proxy.
	if (!("serviceWorker" in navigator) || !isSecureContext || !navigator.onLine) return;
	(window.requestIdleCallback || setTimeout)(() =>
		navigator.serviceWorker
			.register("sw.js", { scope: "./" })
			.then(() => navigator.serviceWorker.ready)
			.then(keepShell)
			.catch(() => {})
	);
}
