// Settings > Links: checks every Flux link from this device. The list (js/links.json) is written by
// flux_links.py on every publish. Each link opens as extra.svg?f3#check in a hidden frame, where the
// site only HEADs its own code and answers "flux-ready", so block pages, error pages and timeouts fail.
import { toast } from "./modal.js";

const TIMEOUT_MS = 10000;
const AFTER_LOAD_MS = 4000; // a page that loaded but stays quiet is a block or error page
const AT_ONCE = 8;

const $ = (id) => document.getElementById(id);
let rows = [];

function check(link) {
	return new Promise((resolve) => {
		const frame = document.createElement("iframe");
		const start = performance.now();
		const onMessage = (e) => e.source === frame.contentWindow && e.data === "flux-ready" && done(true);
		const done = (ok) => {
			clearTimeout(timer);
			removeEventListener("message", onMessage);
			frame.remove();
			resolve({ ok, ms: Math.round(performance.now() - start) });
		};
		let timer = setTimeout(() => done(false), TIMEOUT_MS);
		frame.onload = () => {
			clearTimeout(timer);
			timer = setTimeout(() => done(false), AFTER_LOAD_MS);
		};
		addEventListener("message", onMessage);
		frame.className = "lc-probe";
		frame.setAttribute("aria-hidden", "true");
		frame.tabIndex = -1;
		frame.src = link.split("#")[0] + "#check"; // the site only answers at exactly ?f3
		document.body.append(frame);
	});
}

function showRows(links) {
	rows = links.map((link) => {
		const row = document.createElement("li");
		const name = document.createElement("span");
		name.textContent = link;
		const status = document.createElement("small");
		row.append(name, status);
		return { link, row, status, ok: false };
	});
	$("lc-list").replaceChildren(...rows.map((r) => r.row));
}

async function checkAll() {
	$("lc-run").disabled = $("lc-copy").disabled = true;
	let finished = 0;
	let working = 0;
	const update = () => {
		const percent = rows.length ? (finished / rows.length) * 100 : 0;
		$("lc-fill").style.width = percent + "%";
		$("lc-fill").parentElement.setAttribute("aria-valuenow", Math.round(percent));
		$("lc-stats").textContent = `${finished} / ${rows.length} checked · ${working} working`;
	};
	for (const r of rows) {
		r.ok = false;
		r.row.className = "";
		r.status.textContent = "";
	}
	update();
	const queue = [...rows];
	const worker = async () => {
		for (let r; (r = queue.shift()); ) {
			r.row.className = "checking";
			const { ok, ms } = await check(r.link);
			r.ok = ok;
			r.row.className = ok ? "ok" : "bad";
			r.status.textContent = ok ? ms + " ms" : "Not working";
			finished++;
			if (ok) working++;
			update();
		}
	};
	await Promise.all(Array.from({ length: AT_ONCE }, worker));
	$("lc-run").disabled = false;
	$("lc-run").textContent = "Check again";
	$("lc-copy").disabled = working === 0;
}

export async function initLinkCheck() {
	$("lc-only").addEventListener("change", (e) => $("lc-list").classList.toggle("only-ok", e.target.checked));
	$("lc-copy").addEventListener("click", async () => {
		const links = rows.filter((r) => r.ok).map((r) => r.link);
		try {
			await navigator.clipboard.writeText(links.join("\n"));
			toast(`Copied ${links.length} working links`);
		} catch {
			toast("Couldn't copy. Turn on Working only and copy them from the list.");
		}
	});
	$("lc-run").addEventListener("click", checkAll);
	try {
		const reply = await fetch("js/links.json", { cache: "no-store" });
		showRows(await reply.json());
		$("lc-stats").textContent = `${rows.length} links. Checks which ones load on this device.`;
		$("lc-run").disabled = false;
	} catch {
		$("lc-stats").textContent = "Couldn't load the link list.";
	}
}
