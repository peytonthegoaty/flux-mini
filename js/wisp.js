// Picks a working Wisp server: tests every candidate at once and uses the first
// one in list order that answers. The winner is remembered for this session.
import { debug } from "./log.js";

export const SERVERS = [
	"wss://lolration.cfd/uu/",
	"wss://solara.bormaxnetwork.cl/wisp/",
	"wss://kidspreples.org/fairs/",
	"wss://studynestlab.org/wisp/",
	// Added 2026-10-28; each carried a real page through Scramjet and Ultraviolet. Fastest first.
	"wss://girlspreples.org/wi/",
	"wss://shop.kristenblackburnvolleyballcamps.com/wi/",
	"wss://actingoutdoor.com/socket/",
	"wss://boxcasa.net/wi/",
	"wss://johnsclasslearning.info/connection/",
	"wss://auth.johnsclasslearning.com/connection/",
	"wss://learn.southpadreislandkiteboarding.com/wi/",
	"wss://k12-na-east1-portal.johnsclasslearning.store/connection/",
	"wss://bananadogstore.com/socket/",
	"wss://aplusmartialarts-templehills.com/socket/",
	"wss://new-server.baylib.top/connection/",
	"wss://restorecounselingcenter.org/socket/",
	"wss://bikesense.org/wisp/",
];
const SESSION_KEY = "flux:wisp";

// Wisp servers send a packet right after connecting; servers that only allow
// certain sites accept the socket, then close it without one.
export function checkWisp(url, timeout = 6000) {
	return new Promise((resolve) => {
		let socket;
		let opened = false;
		const start = performance.now();
		const elapsed = () => `${Math.round(performance.now() - start)}ms`;
		const done = (ok) => {
			clearTimeout(timer);
			try {
				socket.onclose = null;
				socket.close();
			} catch {
				// Already closed.
			}
			resolve(ok);
		};
		const timer = setTimeout(() => {
			debug(`Wisp: ${url} gave no reply within ${timeout}ms`, true);
			done(false);
		}, timeout);
		try {
			socket = new WebSocket(url);
			socket.binaryType = "arraybuffer";
			socket.onopen = () => (opened = true);
			socket.onmessage = (e) => {
				const packet = new DataView(e.data);
				const type = packet.getUint8(0);
				const info = type === 3 ? `CONTINUE, buffer ${packet.getUint32(5, true)}` : `type ${type}`;
				debug(`Wisp: ${url} OK (${info}) in ${elapsed()}`);
				done(true);
			};
			socket.onclose = (e) => {
				const why = opened
					? `accepted the socket, then closed it without a Wisp packet; it may only allow certain websites (this one is ${location.origin})`
					: "couldn't connect (down, wrong URL, or blocked on this network)";
				debug(`Wisp: ${url} closed with code ${e.code} after ${elapsed()}: ${why}`, true);
				done(false);
			};
		} catch (err) {
			debug(`Wisp: ${url}: ${err.message}`, true);
			done(false);
		}
	});
}

const picks = new Map();

// preferred = the server chosen in Settings ("" = Auto); it is tried first.
export function pickWisp(preferred) {
	const key = preferred;
	if (!picks.has(key)) {
		picks.set(
			key,
			choose(preferred).catch((err) => {
				picks.delete(key);
				throw err;
			})
		);
	}
	return picks.get(key);
}

async function choose(preferred) {
	let saved = "";
	try {
		saved = sessionStorage.getItem(SESSION_KEY) || "";
	} catch {
		// No session storage: test from scratch.
	}
	// A custom server is only tried when it is the chosen one; other leftovers are ignored.
	const list = [...new Set([preferred, saved, ...SERVERS])].filter((url) => url && (SERVERS.includes(url) || url === preferred));
	debug(`Wisp: testing ${list.length} servers`);
	const checks = list.map((url) => checkWisp(url));
	for (const [i, url] of list.entries()) {
		if (await checks[i]) {
			try {
				sessionStorage.setItem(SESSION_KEY, url);
			} catch {
				// Not remembered; the next page load tests again.
			}
			debug(`Wisp: using ${url}`);
			return url;
		}
	}
	throw new Error("No Wisp server answered. Check your connection, or pick another server in Settings.");
}
