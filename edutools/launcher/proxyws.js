// Launch With Proxy: gives a game window a WebSocket that runs through Flux's Wisp proxy, so servers and
// relays connect even on networks that block them. Game files still load directly.
//
// Epoxy (2 and 3) holds back the newest WebSocket message until another one arrives, which stalls a
// game's login. Its raw TLS/TCP streams don't, so this speaks the WebSocket protocol (RFC 6455) itself
// over those streams.

const EPOXY = new URL("../../epoxy3/index.mjs", import.meta.url).href;
let wispUrl = "";
let client = null;

// Epoxy shares one wasm instance, which crashes if several clients start at the same moment: start them one at a time.
let starting = Promise.resolve();
function newClient(wisp = wispUrl) {
	const next = starting.then(async () => {
		const { default: Epoxy } = await import(EPOXY);
		const transport = new Epoxy({ wisp });
		await transport.init();
		return transport.client;
	});
	starting = next.catch(() => {});
	return next;
}

// Sets up the Wisp connection every proxied socket shares.
export async function startProxy(wisp) {
	wispUrl = wisp;
	client = newClient();
	await client;
}

// Can this Wisp server reach a WebSocket (like an Eaglercraft relay)? Opens its own connection and
// does the WebSocket handshake; true only if the server at the far end accepts it.
// shortcut: a probe that times out keeps its Wisp socket until the page closes; fine for one launch.
export function reaches(wisp, url, ms = 8000) {
	const u = new URL(url);
	const probe = (async () => {
		const c = await newClient(wisp);
		const io = await c.connect_tls(`wss://${u.hostname}:${u.port || 443}`);
		const writer = io.write.getWriter();
		const reader = io.read.getReader();
		const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
		await writer.write(
			enc.encode(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
				`Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${location.origin}\r\n\r\n`)
		);
		let head = "";
		while (!head.includes("\r\n\r\n")) {
			const { value, done } = await reader.read();
			if (done) break;
			head += dec.decode(value);
		}
		writer.close().catch(() => {});
		return /^HTTP\/1\.1 101/.test(head);
	})();
	return Promise.race([probe.catch(() => false), new Promise((r) => setTimeout(() => r(false), ms))]);
}

// Opens a TLS or TCP stream; if the shared Wisp socket was dropped, reconnects once and retries.
async function openStream(secure, host, port) {
	const target = `${secure ? "wss" : "ws"}://${host}:${port}`;
	for (let attempt = 1; ; attempt++) {
		try {
			const c = await client;
			return await (secure ? c.connect_tls(target) : c.connect_tcp(target));
		} catch (err) {
			if (attempt > 1) throw err;
			console.warn("[flux] proxy connection dropped; reconnecting", err);
			client = newClient();
		}
	}
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const OP = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 };

function frame(opcode, payload) {
	const n = payload.length;
	const head = n < 126 ? 2 : n < 65536 ? 4 : 10;
	const out = new Uint8Array(head + 4 + n);
	out[0] = 0x80 | opcode;
	if (n < 126) out[1] = 0x80 | n;
	else if (n < 65536) {
		out[1] = 0x80 | 126;
		out[2] = n >> 8;
		out[3] = n & 255;
	} else {
		out[1] = 0x80 | 127;
		new DataView(out.buffer).setBigUint64(2, BigInt(n));
	}
	const mask = crypto.getRandomValues(new Uint8Array(4));
	out.set(mask, head);
	for (let i = 0; i < n; i++) out[head + 4 + i] = payload[i] ^ mask[i & 3];
	return out;
}

// Replaces win.WebSocket. Everything handed to the game is made in the game's own window, so its
// `instanceof ArrayBuffer` / `instanceof Blob` checks still pass.
export function proxySockets(win) {
	const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
	const own = (bytes) => win.Uint8Array.from(bytes).buffer;
	const bytesOf = (data) => {
		if (typeof data === "string") return enc.encode(data);
		if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
		return new Uint8Array(data).slice();
	};

	class ProxyWebSocket extends win.EventTarget {
		constructor(url, protocols = []) {
			super();
			const u = new URL(url, win.location.href);
			if (u.protocol === "https:") u.protocol = "wss:";
			if (u.protocol === "http:") u.protocol = "ws:";
			if (u.protocol !== "wss:" && u.protocol !== "ws:") throw new win.DOMException(`The URL's scheme must be either 'ws' or 'wss'. '${u.protocol}' is not allowed.`, "SyntaxError");
			this.url = u.href;
			this.readyState = CONNECTING;
			this.binaryType = "blob";
			this.bufferedAmount = 0;
			this.extensions = "";
			this.protocol = "";
			this.onopen = this.onmessage = this.onclose = this.onerror = null;
			this.run(u, typeof protocols === "string" ? [protocols] : [...protocols]).catch((err) => {
				console.warn("[flux] proxied WebSocket failed:", this.url, err);
				if (this.readyState !== CLOSED) {
					if (this.readyState === CONNECTING) this.fire(new win.Event("error"));
					this.finish(1006, "");
				}
			});
		}

		async run(u, protocols) {
			const secure = u.protocol === "wss:";
			const port = u.port || (secure ? 443 : 80);
			const io = await openStream(secure, u.hostname, port);
			if (this.readyState === CLOSED) return io.write.abort?.();
			this.writer = io.write.getWriter();
			const reader = io.read.getReader();
			const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
			const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
			let request = `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
				`Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${win.location.origin}\r\nUser-Agent: ${navigator.userAgent}\r\n`;
			if (protocols.length) request += `Sec-WebSocket-Protocol: ${protocols.join(", ")}\r\n`;
			this.writer.write(enc.encode(request + "\r\n"));

			// Read the HTTP response, then frames, from one growing buffer.
			let buf = new Uint8Array(0);
			const more = async () => {
				const { value, done } = await reader.read();
				if (done) return false;
				const next = new Uint8Array(buf.length + value.length);
				next.set(buf);
				next.set(value, buf.length);
				buf = next;
				return true;
			};
			let end;
			while ((end = indexOfHeaderEnd(buf)) < 0) if (!(await more())) throw new Error("connection closed during handshake");
			const head = dec.decode(buf.subarray(0, end));
			buf = buf.slice(end + 4);
			if (!/^HTTP\/1\.1 101/.test(head)) throw new Error("server refused the WebSocket: " + head.split("\r\n")[0]);
			this.protocol = /^sec-websocket-protocol:\s*(.*)$/im.exec(head)?.[1].trim() || "";
			if (this.readyState === CLOSED) return;
			if (this.readyState === CONNECTING) {
				this.readyState = OPEN;
				this.fire(new win.Event("open"));
			}

			let parts = [], partOp = 0;
			for (;;) {
				// header
				while (buf.length < 2) if (!(await more())) return this.finish(1006, "");
				const fin = buf[0] & 0x80, op = buf[0] & 15;
				let len = buf[1] & 127, at = 2;
				if (len === 126) {
					while (buf.length < 4) if (!(await more())) return this.finish(1006, "");
					len = (buf[2] << 8) | buf[3];
					at = 4;
				} else if (len === 127) {
					while (buf.length < 10) if (!(await more())) return this.finish(1006, "");
					len = Number(new DataView(buf.buffer, buf.byteOffset).getBigUint64(2));
					at = 10;
				}
				const masked = buf[1] & 0x80;
				const maskAt = at;
				if (masked) at += 4;
				while (buf.length < at + len) if (!(await more())) return this.finish(1006, "");
				let payload = buf.slice(at, at + len);
				if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskAt + (i & 3)];
				buf = buf.slice(at + len);

				if (op === OP.ping) this.raw(OP.pong, payload);
				else if (op === OP.pong) continue;
				else if (op === OP.close) {
					const code = len >= 2 ? (payload[0] << 8) | payload[1] : 1005;
					const reason = len > 2 ? dec.decode(payload.subarray(2)) : "";
					if (this.readyState === OPEN) this.raw(OP.close, payload.subarray(0, 2));
					return this.finish(code, reason);
				} else {
					if (op !== OP.continuation) partOp = op;
					parts.push(payload);
					if (!fin) continue;
					const whole = parts.length === 1 ? parts[0] : concat(parts);
					parts = [];
					if (this.readyState !== OPEN) continue;
					const data = partOp === OP.text ? dec.decode(whole) : this.binaryType === "blob" ? new win.Blob([whole]) : own(whole);
					this.fire(new win.MessageEvent("message", { data, origin: new URL(this.url).origin }));
				}
			}
		}

		raw(opcode, payload) {
			this.writer?.write(frame(opcode, payload)).catch(() => {});
		}

		finish(code, reason) {
			if (this.readyState === CLOSED) return;
			this.readyState = CLOSED;
			this.writer?.close().catch(() => {});
			this.fire(new win.CloseEvent("close", { code, reason, wasClean: code !== 1006 }));
		}

		fire(event) {
			this.dispatchEvent(event);
			const handler = this["on" + event.type];
			if (typeof handler === "function") handler.call(this, event);
		}

		send(data) {
			if (this.readyState === CONNECTING) throw new win.DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", "InvalidStateError");
			if (this.readyState !== OPEN) return;
			if (data instanceof win.Blob || data instanceof Blob) {
				data.arrayBuffer().then((b) => this.readyState === OPEN && this.raw(OP.binary, new Uint8Array(b)));
				return;
			}
			this.raw(typeof data === "string" ? OP.text : OP.binary, bytesOf(data));
		}

		close(code = 1000, reason = "") {
			if (this.readyState >= CLOSING) return;
			if (this.readyState === CONNECTING) return this.finish(1006, "");
			this.readyState = CLOSING;
			const why = enc.encode(reason);
			const payload = new Uint8Array(2 + why.length);
			payload[0] = code >> 8;
			payload[1] = code & 255;
			payload.set(why, 2);
			this.raw(OP.close, payload);
			setTimeout(() => this.finish(code, reason), 3000); // if the server never answers the close
		}
	}
	for (const [name, value] of Object.entries({ CONNECTING, OPEN, CLOSING, CLOSED })) {
		ProxyWebSocket[name] = ProxyWebSocket.prototype[name] = value;
	}
	win.WebSocket = ProxyWebSocket;
	win.__fluxProxy = true;
}

function indexOfHeaderEnd(buf) {
	for (let i = 0; i + 3 < buf.length; i++) {
		if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
	}
	return -1;
}

function concat(parts) {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}
