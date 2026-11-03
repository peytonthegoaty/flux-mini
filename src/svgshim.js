// Runs first inside extra.svg. The site's code expects a normal HTML page, but an SVG page has no
// document.body, makes plain createElement elements, parses innerHTML as strict XML and keeps tag names
// lowercase, so this makes the <html> inside the foreignObject act like the page.
(() => {
	const svg = document.documentElement;
	const XHTML = "http://www.w3.org/1999/xhtml";
	const page = document.getElementsByTagNameNS(XHTML, "html")[0];
	// Without ?f3 only the picture shows: the site is dropped before any of its scripts or styles load.
	if (location.search !== "?f3") {
		page.parentNode.remove();
		return;
	}
	document.getElementById("decoy").remove();
	svg.style.background = "#000";
	document.title = "Flux";

	const getter = (get) => ({ get, configurable: true });
	Object.defineProperties(document, {
		documentElement: getter(() => page),
		head: getter(() => page.getElementsByTagNameNS(XHTML, "head")[0]),
		body: getter(() => page.getElementsByTagNameNS(XHTML, "body")[0]),
	});

	const create = Document.prototype.createElement;
	Document.prototype.createElement = function (name, options) {
		return this === document ? this.createElementNS(XHTML, name.toLowerCase(), options) : create.call(this, name, options);
	};

	const html = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
	Object.defineProperty(Element.prototype, "innerHTML", {
		...html,
		set(value) {
			if (this.ownerDocument !== document) return html.set.call(this, value);
			const parsed = new DOMParser().parseFromString(`<!doctype html><body>${value}`, "text/html");
			this.replaceChildren(...[...parsed.body.childNodes].map((n) => document.importNode(n, true)));
		},
	});

	const tag = Object.getOwnPropertyDescriptor(Element.prototype, "tagName");
	Object.defineProperty(Element.prototype, "tagName", {
		...tag,
		get() {
			const name = tag.get.call(this);
			return this.namespaceURI === XHTML ? name.toUpperCase() : name;
		},
	});

	// Browsers ignore <script type="module"> in SVG pages, but import() still works.
	// Once the site's code has loaded, tell a parent frame (the link checker) that this link really works.
	addEventListener("DOMContentLoaded", () => import("./js/ui.js").then(() => parent !== window && parent.postMessage("flux-ready", "*")));
})();
