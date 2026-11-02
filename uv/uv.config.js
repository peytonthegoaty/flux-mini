/*global Ultraviolet*/
// Overrides the stock UV config so every file lives under <site folder>/uv/. The site
// folder is worked out from this file's own address (or the worker's), so the proxy
// also works when the site sits in a sub-folder, e.g. s3.amazonaws.com/<bucket>/.
// Wrapped in a function so nothing leaks into proxied pages, which load this file too.
(() => {
	const path = self.document ? new URL(document.currentScript.src).pathname : self.location.pathname;
	const uv = path.indexOf("/uv/");
	const base = uv >= 0 ? path.slice(0, uv + 1) : path.slice(0, path.lastIndexOf("/") + 1);
	self.__uv$config = {
		prefix: base + "uv/service/",
		encodeUrl: Ultraviolet.codec.xor.encode,
		decodeUrl: Ultraviolet.codec.xor.decode,
		handler: base + "uv/uv.handler.js",
		client: base + "uv/uv.client.js",
		bundle: base + "uv/uv.bundle.js",
		config: base + "uv/uv.config.js",
		sw: base + "uv/uv.sw.js",
	};
})();
