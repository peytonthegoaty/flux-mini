// Websites added as games: a name, an address and a picture (one you upload, or a letter tile).
// Kept in this browser and played through the proxy, so the site works on networks that block it.
import { animateDialog, closeDialog, toast } from "./modal.js";

const KEY = "flux:sites";
const SIZE = 128; // pictures are stored at this size, so a big upload doesn't fill up storage

export let sites = [];
try {
	sites = JSON.parse(localStorage.getItem(KEY) || "[]");
} catch {
	// No saved websites.
}

function save() {
	try {
		localStorage.setItem(KEY, JSON.stringify(sites));
		return true;
	} catch {
		toast("This browser's storage is full, so the website wasn't saved.");
		return false;
	}
}

export function removeSite(id) {
	sites = sites.filter((s) => s.id !== id);
	save();
}

// Draws any image (PNG, ICO, SVG...) into a square, transparent PNG.
function squarePicture(blob) {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(blob);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			const canvas = Object.assign(document.createElement("canvas"), { width: SIZE, height: SIZE });
			const w = img.naturalWidth || SIZE;
			const h = img.naturalHeight || SIZE;
			const k = Math.min(SIZE / w, SIZE / h);
			canvas.getContext("2d").drawImage(img, (SIZE - w * k) / 2, (SIZE - h * k) / 2, w * k, h * k);
			resolve(canvas.toDataURL("image/png"));
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("That isn't a picture this browser can show."));
		};
		img.src = url;
	});
}

// A plain gray tile with the name's first letter, for sites with no icon.
function letterPicture(name) {
	const canvas = Object.assign(document.createElement("canvas"), { width: SIZE, height: SIZE });
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#26262b";
	ctx.fillRect(0, 0, SIZE, SIZE);
	ctx.fillStyle = "#fff";
	ctx.font = `600 ${SIZE * 0.5}px Geist, system-ui, sans-serif`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText((name.trim()[0] || "?").toUpperCase(), SIZE / 2, SIZE / 2 + SIZE * 0.03);
	return canvas.toDataURL("image/png");
}

let dialog = null;

// Asks for a website and adds it. Resolves with the new site, or null when cancelled.
export function addSiteDialog() {
	if (!dialog) {
		dialog = Object.assign(document.createElement("dialog"), { className: "modal ask site-add" });
		dialog.innerHTML =
			`<form method="dialog">` +
			`<h2>Add a website</h2>` +
			`<p>It's added to your games and opens through the proxy.</p>` +
			`<div class="site-fields">` +
			`<label>Address<input name="url" type="text" placeholder="example.com" spellcheck="false" autocomplete="off" required></label>` +
			`<label>Name<input name="name" type="text" placeholder="Taken from the address" spellcheck="false" autocomplete="off"></label>` +
			`</div>` +
			`<div class="site-pic">` +
			`<img alt="Icon preview" width="64" height="64">` +
			`<div><div class="site-pic-buttons"><button class="btn" type="button" data-act="upload">Upload icon</button></div>` +
			`<small class="site-pic-status">With no icon, it gets a tile with its first letter.</small></div>` +
			`<input type="file" accept="image/*" hidden>` +
			`</div>` +
			`<div class="ask-actions"><button class="btn" value="" type="submit" formnovalidate>Cancel</button><button class="btn primary" value="ok" type="submit">Add</button></div>` +
			`</form>`;
		document.body.append(dialog);
		animateDialog(dialog);
	}
	const form = dialog.querySelector("form");
	const [urlInput, nameInput] = form.querySelectorAll(".site-fields input");
	const preview = form.querySelector(".site-pic img");
	const status = form.querySelector(".site-pic-status");
	const file = form.querySelector("input[type=file]");
	let picture = null; // data: URL, once uploaded or found
	const showPicture = (src) => {
		picture = src;
		preview.src = src || "";
		preview.classList.toggle("empty", !src);
	};
	form.reset();
	showPicture(null);
	status.textContent = "With no icon, it gets a tile with its first letter.";

	const address = () => {
		const text = urlInput.value.trim();
		try {
			const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
			return url.hostname.includes(".") && !/\s/.test(text) ? url.href : null;
		} catch {
			return null;
		}
	};
	return new Promise((resolve) => {
		const onClick = (e) => {
			const act = e.target.closest("[data-act]")?.dataset.act;
			if (act === "upload") file.click();
		};
		const onFile = async () => {
			if (!file.files[0]) return;
			try {
				showPicture(await squarePicture(file.files[0]));
				status.textContent = "Using your picture.";
			} catch (err) {
				status.textContent = err.message;
			}
			file.value = "";
		};
		const done = (value) => {
			form.removeEventListener("click", onClick);
			form.removeEventListener("submit", onSubmit);
			file.removeEventListener("change", onFile);
			dialog.removeEventListener("close", onClose);
			resolve(value);
		};
		const onSubmit = (e) => {
			e.preventDefault();
			if (e.submitter?.value !== "ok") {
				closeDialog(dialog);
				return;
			}
			const url = address();
			if (!url) {
				status.textContent = "That doesn't look like a website address.";
				return urlInput.focus();
			}
			const name = nameInput.value.trim() || new URL(url).hostname.replace(/^www\./, "");
			const site = { id: `site-${Date.now().toString(36)}`, title: name, url, image: picture || letterPicture(name), site: true };
			sites.push(site);
			if (!save()) sites.pop();
			else done(site);
			closeDialog(dialog);
		};
		const onClose = () => done(null);
		form.addEventListener("click", onClick);
		form.addEventListener("submit", onSubmit);
		file.addEventListener("change", onFile);
		dialog.addEventListener("close", onClose);
		dialog.showModal();
		urlInput.focus();
	});
}
