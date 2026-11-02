// Custom background image: either a link, or an uploaded picture kept in IndexedDB
// (localStorage is too small for images). js/boot.js applies a link before first paint.
const DB_NAME = "flux";
const STORE = "files";
const KEY = "background";
let objectUrl = "";

function store(mode, action) {
	return new Promise((resolve, reject) => {
		const open = indexedDB.open(DB_NAME, 1);
		open.onupgradeneeded = () => open.result.createObjectStore(STORE);
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const tx = open.result.transaction(STORE, mode);
			const request = action(tx.objectStore(STORE));
			tx.oncomplete = () => resolve(request.result);
			tx.onerror = () => reject(tx.error);
		};
	});
}

export const saveUpload = (file) => store("readwrite", (s) => s.put(file, KEY));
export const clearUpload = () => store("readwrite", (s) => s.delete(KEY));
const loadUpload = () => store("readonly", (s) => s.get(KEY));

// Resolves once the image has actually loaded, so a bad link or file is caught.
export function checkImage(url) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = resolve;
		img.onerror = () => reject(new Error("That image couldn't be loaded."));
		img.src = url;
	});
}

export function applyBackground(url) {
	const root = document.documentElement;
	root.classList.toggle("has-bg", !!url);
	if (url) root.style.setProperty("--bg-image", `url("${url.replace(/["\\]/g, "\\$&")}")`);
	else root.style.removeProperty("--bg-image");
}

let latest = 0;
// mode: "" (none) | "link" | "upload". Quick switching only shows the last pick.
export async function showBackground(mode, link) {
	const pick = ++latest;
	let url = mode === "link" ? link : "";
	let upload = "";
	if (mode === "upload") {
		const file = await loadUpload().catch(() => null);
		if (file) url = upload = URL.createObjectURL(file);
	}
	// Decode first (off the main thread), so swapping a big image doesn't freeze the page.
	if (url) {
		const img = new Image();
		img.src = url;
		await img.decode().catch(() => {});
	}
	if (pick !== latest) return upload && URL.revokeObjectURL(upload);
	if (objectUrl) URL.revokeObjectURL(objectUrl);
	objectUrl = upload;
	applyBackground(url);
}
