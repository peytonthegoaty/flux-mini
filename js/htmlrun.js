// HTML section, laid out like VS Code: write or open a page (or a zipped site), watch it in the live
// preview, and run it like a game.
// The editor is Monaco, loaded the first time the section is shown (monaco/editor.html); until then,
// or if it can't load, a plain text box does the job. Saved pages also show on the OS desktop.
import { addFile, files, filesReady, htmlUrl, readZip, removeFile, saveFiles } from "./files.js";
import { playUrl, quitFrame } from "./library.js";
import { ask, toast } from "./modal.js";
import { openFile, osMode } from "./os.js";

const $ = (id) => document.getElementById(id);
const plain = $("html-code");
const name = $("html-name");
const zipToggle = $("html-zip");
const BIG = 5 * 1024 * 1024;
let editor = null; // Monaco, once loaded
let held = ""; // a file over 5 MB, kept out of the editor until asked
let zip = null; // the chosen .zip (Blob) in zip mode
let editing = null; // the saved page that's open, so Save updates it

// Monaco -----------------------------------------------------------------------------------
const code = () => (held || (editor ? editor.getValue() : plain.value));
function setCode(text) {
	if (editor) editor.setValue(text);
	else plain.value = text;
}
window.fluxMonacoReady = (instance) => {
	editor = instance;
	editor.setValue(plain.value);
	plain.hidden = true;
	editor.onDidChangeModelContent(() => ((held = ""), schedulePreview()));
	editor.onDidChangeCursorPosition((e) => ($("html-status").textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`));
};
// Load it when the section first becomes visible (the main site's view or the OS window).
new ResizeObserver((entries, observer) => {
	if (!entries[0].contentRect.width) return;
	observer.disconnect();
	const frame = Object.assign(document.createElement("iframe"), { className: "vsc-monaco", title: "Code editor", src: "monaco/editor.html" });
	$("html-editor").append(frame);
}).observe($("html-editor"));
plain.addEventListener("input", () => ((held = ""), schedulePreview()));

// Live preview ------------------------------------------------------------------------------
// Shows the page as you type (half a second after you stop). No proxy here, so it's instant;
// Run uses the proxy when it's on.
const preview = $("html-preview-frame");
let previewTimer;
let previewing = true;
function schedulePreview() {
	clearTimeout(previewTimer);
	previewTimer = setTimeout(refreshPreview, 500);
}
async function refreshPreview() {
	if (!previewing) return;
	const page = current(true);
	quitFrame(preview);
	if (!page) return;
	try {
		preview.src = await htmlUrl({ ...page, proxy: false });
	} catch {
		// Nothing to show; the preview stays empty.
	}
}
// Leaving the section or closing its window (the pane drops to zero width) quits the preview; coming back reloads it.
let paneShown = false;
new ResizeObserver(([entry]) => {
	const shown = entry.contentRect.width > 0;
	if (shown === paneShown) return; // a resize, not a show/hide
	paneShown = shown;
	if (shown) return previewing && refreshPreview();
	clearTimeout(previewTimer);
	quitFrame(preview);
}).observe($("html-preview"));
$("html-preview-toggle").addEventListener("click", () => {
	previewing = !previewing;
	$("html-preview-toggle").setAttribute("aria-pressed", previewing);
	$("html-split").classList.toggle("no-preview", !previewing);
	if (previewing) refreshPreview();
	else quitFrame(preview);
});

// Opening files ----------------------------------------------------------------------------
function showBig(file) {
	$("html-big-text").textContent = `${file.name} is ${(file.size / 1048576).toFixed(1)} MB. Showing it in the editor might lag, but it runs fine without that.`;
	$("html-big").hidden = false;
}
$("html-big-load").addEventListener("click", () => {
	const text = held;
	held = "";
	setCode(text);
	$("html-big").hidden = true;
	schedulePreview();
});

function setZipMode(on) {
	zipToggle.checked = on;
	$("html-file").accept = on ? ".zip,application/zip" : ".html,.htm,text/html";
	$("html-editor").hidden = on;
	$("html-big").hidden = on || !held;
	$("html-zipinfo").hidden = !on;
	if (on) showZip();
	else $("html-status").textContent = "";
	schedulePreview();
}
zipToggle.addEventListener("change", () => setZipMode(zipToggle.checked));

async function showZip() {
	$("html-status").textContent = "Zip site";
	const list = $("html-zip-files");
	if (!zip) {
		$("html-zip-text").textContent = "Press Choose file and pick a .zip of a website. It runs like it's on a server: its pages, scripts, images and links all work.";
		return list.replaceChildren();
	}
	try {
		const { entries, entry } = await readZip(zip);
		$("html-zip-text").textContent = `${zip.name || "Your zip"}: ${entries.length} files, starting at ${entry}.`;
		list.replaceChildren(...entries.slice(0, 300).map((e) => Object.assign(document.createElement("li"), { textContent: e.name })));
	} catch (err) {
		$("html-zip-text").textContent = err.message;
		list.replaceChildren();
	}
}

$("html-pick").addEventListener("click", () => $("html-file").click());
$("html-file").addEventListener("change", async (e) => {
	const file = e.target.files[0];
	e.target.value = "";
	if (!file) return;
	editing = null;
	name.value = file.name.replace(/\.(html?|zip)$/i, "");
	if (zipToggle.checked || /\.zip$/i.test(file.name)) {
		zip = file;
		return setZipMode(true);
	}
	const text = await file.text();
	held = "";
	if (file.size > BIG) {
		setCode("");
		held = text;
		showBig(file);
	} else {
		$("html-big").hidden = true;
		setCode(text);
	}
	schedulePreview();
});

$("html-new").addEventListener("click", () => {
	editing = null;
	zip = null;
	held = "";
	name.value = "";
	setCode("");
	$("html-proxy").checked = false;
	setZipMode(false);
	$("html-big").hidden = true;
	(editor || plain).focus();
	schedulePreview();
});

// Running and saving ------------------------------------------------------------------------
// The page as it stands; quiet = no message when there's nothing yet (the preview asks often).
function current(quiet) {
	const page = { type: "html", name: name.value.trim() || "Untitled page", proxy: $("html-proxy").checked };
	if (zipToggle.checked) {
		if (!zip) return quiet || toast("Choose a .zip first."), null;
		return { ...page, zip };
	}
	if (!code().trim()) return quiet || toast("Write some HTML, paste it, or choose a file first."), null;
	return { ...page, code: code() };
}

export async function runFile(file) {
	if (osMode) return openFile(file);
	try {
		playUrl(file.name, await htmlUrl(file));
	} catch (err) {
		toast(file.proxy && !file.zip ? "Couldn't start the proxy. Try again, or turn Load with proxy off." : err.message);
	}
}

$("html-run").addEventListener("click", () => {
	const page = current();
	if (page) runFile(editing ? Object.assign(editing, page) : page);
});
$("html-save").addEventListener("click", () => {
	const page = current();
	if (!page) return;
	if (editing) {
		delete editing.code;
		delete editing.zip;
		Object.assign(editing, page);
		saveFiles();
	} else editing = addFile(page);
	toast(osMode ? `Saved ${page.name} to the desktop` : `Saved ${page.name}`);
});

// Explorer: saved pages open in the editor; the play button runs one, the bin deletes it.
const list = $("html-list");
function render() {
	const pages = files.filter((f) => f.type === "html");
	$("html-count").textContent = pages.length || "";
	list.replaceChildren(
		...pages.map((f) => {
			const li = document.createElement("li");
			li.dataset.id = f.id;
			li.classList.toggle("open", f === editing);
			li.innerHTML =
				`<button class="vsc-file" type="button" data-act="open"><svg class="i"><use href="#${f.zip ? "i-paperclip" : "i-code"}"/></svg><span></span></button>` +
				`<button class="vsc-mini" type="button" data-act="run" title="Run" aria-label="Run"><svg class="i"><use href="#i-play"/></svg></button>` +
				`<button class="vsc-mini" type="button" data-act="del" title="Delete" aria-label="Delete"><svg class="i"><use href="#i-trash"/></svg></button>`;
			li.querySelector("span").textContent = f.name;
			return li;
		})
	);
	if (!pages.length) list.innerHTML = `<li class="vsc-empty">Pages you save show up here.</li>`;
}
list.addEventListener("click", async (e) => {
	const act = e.target.closest("[data-act]")?.dataset.act;
	const file = files.find((f) => f.id === e.target.closest("li")?.dataset.id);
	if (!act || !file) return;
	if (act === "run") return runFile(file);
	if (act === "open") {
		editing = file;
		name.value = file.name;
		$("html-proxy").checked = !!file.proxy;
		held = "";
		$("html-big").hidden = true;
		zip = file.zip || null;
		if (!file.zip) setCode(file.code || "");
		setZipMode(!!file.zip);
		schedulePreview();
		return render();
	}
	if (await ask({ title: `Delete ${file.name}?`, message: "It's removed from this browser. This can't be undone.", ok: "Delete", danger: true })) {
		if (editing === file) editing = null;
		removeFile(file.id);
	}
});
document.addEventListener("flux:files", render);
filesReady.then(render);
