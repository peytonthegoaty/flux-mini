// Connection log shown in Settings > Browsing, mirrored to the console.
export function debug(message, isError = false) {
	const log = document.getElementById("debug-log");
	const line = document.createElement("div");
	line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
	line.classList.toggle("error", isError);
	log.append(line);
	log.scrollTop = log.scrollHeight;
	(isError ? console.error : console.log)("[flux]", message);
}

window.addEventListener("error", (e) => debug(`Error: ${e.message}`, true));
window.addEventListener("unhandledrejection", (e) => debug(`Error: ${e.reason?.message || e.reason}`, true));
