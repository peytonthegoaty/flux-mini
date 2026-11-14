// Per-app volume: a slider that scales every sound the pages inside one element make (their
// <audio>/<video> and Web Audio), frames inside frames included. Reaches every frame on this site:
// games, HTML files, and proxied pages (Ultraviolet and Scramjet serve them from this site too).
// shortcut: Web Audio already wired up before the page was hooked (it's hooked within half a second
// of loading) keeps full volume; hook earlier if a game turns out to ignore the slider.
const levels = new Map(); // element -> volume, 0..1
let timer = 0;

export function volumeControl(root, key) {
	const el = document.createElement("div");
	el.className = "vol";
	el.innerHTML =
		`<button class="icon-btn sm" type="button" aria-label="Mute"><svg class="i"><use href="#i-volume"/></svg></button>` +
		`<input type="range" min="0" max="100" step="1" aria-label="Volume of this app">`;
	const [button, range] = el.children;
	const storeKey = `flux:vol:${key}`;
	let before = 100; // where unmuting goes back to
	const set = (value, save = true) => {
		range.value = value;
		range.style.setProperty("--fill", `${value}%`);
		button.firstChild.firstChild.setAttribute("href", value > 0 ? "#i-volume" : "#i-volume-x");
		button.setAttribute("aria-label", value > 0 ? "Mute" : "Unmute");
		el.title = `Volume ${value}%`;
		levels.set(root, value / 100);
		applyAll();
		if (save) {
			try {
				localStorage.setItem(storeKey, value);
			} catch {
				// Remembered for this visit only.
			}
		}
	};
	let saved = 100;
	try {
		saved = Number(localStorage.getItem(storeKey) ?? 100);
	} catch {
		// Starts at full volume.
	}
	set(Number.isFinite(saved) ? Math.min(100, Math.max(0, saved)) : 100, false);
	range.addEventListener("input", () => set(Number(range.value)));
	button.addEventListener("click", () => {
		if (Number(range.value) > 0) {
			before = Number(range.value);
			set(0);
		} else set(before || 100);
	});
	timer ||= setInterval(applyAll, 500); // pages load and navigate on their own; catch new ones
	return el;
}

function applyAll() {
	for (const [root, volume] of levels) {
		if (!root.isConnected) continue;
		for (const frame of root.querySelectorAll("iframe")) reach(frame, volume);
	}
}

function reach(frame, volume) {
	let win;
	try {
		win = frame.contentWindow;
		if (!win?.document?.documentElement) return;
		hook(win);
	} catch {
		return; // another site's frame (an ad, an embed): the browser keeps us out
	}
	if (win.__fluxVol !== volume) {
		win.__fluxVol = volume;
		win.__fluxVolSync();
	}
	for (const inner of win.document.querySelectorAll("iframe")) reach(inner, volume);
}

// Once per page: route Web Audio through a gain node, and scale media elements' volume.
function hook(win) {
	if (win.__fluxVolSync) return;
	const level = () => win.__fluxVol ?? 1;
	const gains = new Set();
	const media = new Set();

	const Base = win.BaseAudioContext || win.AudioContext;
	const destination = Base && Object.getOwnPropertyDescriptor(Base.prototype, "destination");
	if (destination?.get) {
		const made = new WeakMap();
		Object.defineProperty(Base.prototype, "destination", {
			configurable: true,
			get() {
				let gain = made.get(this);
				if (!gain) {
					const real = destination.get.call(this);
					gain = this.createGain();
					gain.connect(real);
					gain.gain.value = level();
					Object.defineProperty(gain, "maxChannelCount", { get: () => real.maxChannelCount });
					made.set(this, gain);
					gains.add(gain);
				}
				return gain;
			},
		});
	}

	const proto = win.HTMLMediaElement.prototype;
	const volume = Object.getOwnPropertyDescriptor(proto, "volume");
	const wanted = new WeakMap(); // the volume the page asked for
	const scale = (el) => {
		if (!wanted.has(el)) wanted.set(el, volume.get.call(el));
		media.add(el);
		volume.set.call(el, wanted.get(el) * level());
	};
	Object.defineProperty(proto, "volume", {
		configurable: true,
		get() {
			return wanted.has(this) ? wanted.get(this) : volume.get.call(this);
		},
		set(value) {
			wanted.set(this, value);
			scale(this);
		},
	});
	const play = proto.play;
	proto.play = function (...args) {
		scale(this);
		return play.apply(this, args);
	};

	win.__fluxVolSync = () => {
		for (const gain of gains) gain.gain.value = level();
		for (const el of win.document.querySelectorAll("audio, video")) media.add(el);
		for (const el of media) scale(el);
	};
}

// Self-check: a hooked page's media volume follows the level. Run from the console: __fluxVolTest()
window.__fluxVolTest = () => {
	const frame = document.body.appendChild(document.createElement("iframe"));
	hook(frame.contentWindow);
	const audio = frame.contentDocument.createElement("audio");
	audio.volume = 0.5;
	frame.contentWindow.__fluxVol = 0.4;
	frame.contentWindow.__fluxVolSync();
	const ok = Math.abs(Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume").get.call(audio) - 0.2) < 1e-6 && audio.volume === 0.5;
	frame.remove();
	return ok;
};
