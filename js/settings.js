// User settings, kept in localStorage. Every access is guarded so the site
// still works (with defaults) in private windows or when storage is blocked.
const STORAGE_KEY = "flux:settings"; // js/boot.js reads this key too

export const DEFAULTS = Object.freeze({
	engine: "scramjet", // "scramjet" | "uv"
	transport: "epoxy", // "epoxy" | "libcurl"
	wisp: "", // "" = Auto: use the first server in js/wisp.js that answers
	devtoolsWidth: 520, // px, the browser's devtools panel (js/app.js)
	autoCombo: false, // a page that won't load is retried with every engine and Wisp server (js/app.js)
	search: "https://duckduckgo.com/?q=%s",
	perf: false,
	collapsed: false,
	bg: "", // "" | "link" | "upload" (js/background.js)
	bgLink: "",
	bgVideo: false, // the uploaded background is a video
	bgFit: "crop", // video wallpapers: "crop" | "stretch" (js/background.js)
	cloak: "none",
	cloakTitle: "",
	cloakIcon: "",
	panicKey: "`",
	panicUrl: "https://classroom.google.com/",
	toured: false, // the first-visit setup tour (js/ui.js) has been shown
	style: "default", // "default" | "os" (the desktop in js/os.js; js/boot.js applies it)
});

// One shared, live object: modules read it and call saveSettings() after changing it.
export const settings = (() => {
	try {
		return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
	} catch {
		return { ...DEFAULTS };
	}
})();

export function saveSettings() {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// Storage unavailable: settings last for this page load only.
	}
}

export function resetSettings() {
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Nothing saved to remove.
	}
}
