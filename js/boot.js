// Runs before the first paint (tiny and blocking on purpose) so
// performance mode, sidebar state, background link and tab cloak never flash. Reads js/settings.js's key.
(() => {
	let s = {};
	try {
		s = JSON.parse(localStorage.getItem("flux:settings") || "{}");
	} catch {
		// Defaults.
	}
	// Wallpapers are saved as full addresses, and every bucket shares these settings: keep them on this site.
	const stale = /^https:\/\/s3\.amazonaws\.com\/[^/]+\/backgrounds\//;
	if (stale.test(s.bgLink)) {
		s.bgLink = s.bgLink.replace(stale, new URL("backgrounds/", document.baseURI).href);
		try {
			localStorage.setItem("flux:settings", JSON.stringify(s));
		} catch {
			// It's corrected again next load.
		}
	}
	const root = document.documentElement;
	root.classList.toggle("perf", !!s.perf);
	root.classList.toggle("sb-collapsed", !!s.collapsed);
	root.classList.toggle("os", s.style === "os");
	if (s.bg === "link" && s.bgLink) {
		root.classList.add("has-bg");
		root.style.setProperty("--bg-image", `url("${s.bgLink.replace(/["\\]/g, "\\$&")}")`);
	}
	if (s.cloakTitle) document.title = s.cloakTitle;
	if (s.cloakIcon) document.getElementById("favicon").href = s.cloakIcon;
})();
