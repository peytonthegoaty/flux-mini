// Turns whatever the user typed into a URL: a full URL is used as-is,
// something that looks like a hostname gets https://, anything else is searched.
export function toUrl(input, template) {
	const text = input.trim();
	try {
		const url = new URL(text);
		if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
	} catch {
		// Not a full URL.
	}
	if (!/\s/.test(text)) {
		try {
			const url = new URL("https://" + text);
			if (url.hostname.includes(".")) return url.toString();
		} catch {
			// Not a hostname either.
		}
	}
	return template.replace("%s", encodeURIComponent(text));
}
