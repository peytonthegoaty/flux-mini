// Custom background: a link (ours or any image/MP4), or an uploaded picture or video kept in
// IndexedDB (localStorage is too small). js/boot.js applies an image link before first paint.
import { settings } from "./settings.js";

const DB_NAME = "flux";
const STORE = "files";
const KEY = "background";
let objectUrl = "";

export function store(mode, action) {
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

// Resolves with the video's width / height once its details have loaded.
export function checkVideo(url) {
	return new Promise((resolve, reject) => {
		const video = Object.assign(document.createElement("video"), { muted: true, preload: "metadata" });
		video.onloadedmetadata = () => resolve(video.videoWidth / video.videoHeight);
		video.onerror = () => reject(new Error("That video couldn't be played. Try an MP4."));
		video.src = url;
	});
}

export const isVideoLink = (link) => /\.mp4(\?|$)/i.test(link || "");

// Video wallpapers are a muted, looping <video> behind the page, paused in performance mode.
// Crop fills the screen and trims the edges; Stretch shows all of it, distorted to fit.
export function applyFit() {
	const video = document.getElementById("bg-video");
	if (video) video.style.objectFit = settings.bgFit === "stretch" ? "fill" : "cover";
}
export function playVideo(on) {
	const video = document.getElementById("bg-video");
	if (video) on ? video.play().catch(() => {}) : video.pause();
}

export function applyBackground(url, isVideo = false) {
	const root = document.documentElement;
	root.classList.toggle("has-bg", !!url);
	root.classList.toggle("has-video", !!url && isVideo);
	let video = document.getElementById("bg-video");
	if (url && isVideo) {
		root.style.removeProperty("--bg-image");
		video ??= Object.assign(document.createElement("video"), { id: "bg-video", muted: true, loop: true, playsInline: true });
		video.setAttribute("aria-hidden", "true");
		if (!video.isConnected) document.body.prepend(video);
		if (video.src !== url) video.src = url;
		applyFit();
		playVideo(!root.classList.contains("perf"));
		return;
	}
	video?.remove();
	if (url) root.style.setProperty("--bg-image", `url("${url.replace(/["\\]/g, "\\$&")}")`);
	else root.style.removeProperty("--bg-image");
}

let latest = 0;
// mode: "" (none) | "link" | "upload". Quick switching only shows the last pick.
export async function showBackground(mode, link) {
	const pick = ++latest;
	let url = mode === "link" ? link : "";
	let upload = "";
	let video = mode === "link" && isVideoLink(link);
	if (mode === "upload") {
		const file = await loadUpload().catch(() => null);
		if (file) url = upload = URL.createObjectURL(file);
		video = !!file?.type.startsWith("video/");
	}
	// Decode first (off the main thread), so swapping a big image doesn't freeze the page.
	if (url && !video) {
		const img = new Image();
		img.src = url;
		await img.decode().catch(() => {});
	}
	if (pick !== latest) return upload && URL.revokeObjectURL(upload);
	if (objectUrl) URL.revokeObjectURL(objectUrl);
	objectUrl = upload;
	applyBackground(url, video);
}
