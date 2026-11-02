// Leaves the site when someone opens DevTools, and blocks the usual shortcuts to it.
// shortcut: a deterrent only. Every file is a public URL on S3 (and view-source: or turning
// off JavaScript gets around this), so nothing here is truly hidden.
(() => {
	const leave = () => {
		let url = "https://classroom.google.com/";
		try {
			url = JSON.parse(localStorage.getItem("flux:settings") || "{}").panicUrl || url;
		} catch {
			// Use the default.
		}
		window.close(); // only works in tabs a script opened, like the about:blank cloak
		try {
			top.location.replace(url);
		} catch {
			location.replace(url);
		}
	};

	// F12, Ctrl+Shift+I/J/C (DevTools) and Ctrl+U (view source).
	addEventListener(
		"keydown",
		(e) => {
			const key = e.key.toUpperCase();
			const ctrl = e.ctrlKey || e.metaKey;
			if (key === "F12" || (ctrl && e.shiftKey && ["I", "J", "C"].includes(key)) || (ctrl && key === "U")) e.preventDefault();
		},
		true
	);
	// No right-click "Inspect", except where people type or copy text.
	addEventListener("contextmenu", (e) => e.target.closest?.("input, textarea, .ai-log") || e.preventDefault());

	// DevTools pauses on `debugger`. Doing that here would freeze this page before it could
	// leave, so a worker runs it and pings twice a second; when the pings stop, DevTools is open.
	let worker;
	try {
		worker = new Worker(URL.createObjectURL(new Blob(["setInterval(() => { debugger; postMessage(0); }, 500);"], { type: "text/javascript" })));
	} catch {
		return; // no workers: shortcuts are still blocked
	}
	let lastPing = performance.now();
	let lastCheck = lastPing;
	worker.onmessage = () => (lastPing = performance.now());
	setInterval(() => {
		const now = performance.now();
		// Skip while hidden (timers are throttled) or right after this page itself was busy.
		if (document.hidden || now - lastCheck > 1500) lastPing = now;
		lastCheck = now;
		if (now - lastPing > 2000) leave();
	}, 500);
})();
