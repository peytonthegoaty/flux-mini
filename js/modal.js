let toastTimer;
// Short message that slides up from the bottom, then hides itself.
export function toast(message) {
	const el = document.getElementById("toast");
	el.textContent = message;
	el.classList.add("show");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

// Plays the popup's pop-in backwards, then closes it.
export function closeDialog(dialog) {
	if (!dialog.open || dialog.classList.contains("closing")) return;
	const finish = () => {
		clearTimeout(fallback);
		dialog.removeEventListener("animationend", onEnd);
		dialog.classList.remove("closing");
		dialog.close();
	};
	// animationend bubbles from children too, so only the dialog's own counts.
	const onEnd = (e) => e.target === dialog && finish();
	const fallback = setTimeout(finish, 400); // perf mode / reduced motion: no animation runs
	dialog.addEventListener("animationend", onEnd);
	dialog.classList.add("closing");
}

// Esc and clicks on the dimmed backdrop close with the same animation.
export function animateDialog(dialog) {
	dialog.addEventListener("cancel", (e) => {
		e.preventDefault();
		closeDialog(dialog);
	});
	// The backdrop counts as the dialog element itself.
	dialog.addEventListener("click", (e) => e.target === dialog && closeDialog(dialog));
}

// In-page replacement for prompt()/confirm(): resolves with the field values
// (an empty array when there are no fields), or null when cancelled.
const $ = (id) => document.getElementById(id);
const dialog = $("ask");
const form = dialog.querySelector("form");
animateDialog(dialog);

export function ask({ title, message = "", fields = [], ok = "OK", danger = false }) {
	$("ask-title").textContent = title;
	$("ask-message").textContent = message;
	$("ask-message").hidden = !message;
	$("ask-ok").textContent = ok;
	$("ask-ok").classList.toggle("danger", danger);
	$("ask-fields").replaceChildren(
		...fields.map(({ label, value = "", placeholder = "" }) => {
			const row = document.createElement("label");
			const input = document.createElement("input");
			Object.assign(input, { type: "text", value, placeholder, spellcheck: false, required: true });
			row.append(label, input);
			return row;
		})
	);
	dialog.showModal();
	return new Promise((resolve) => {
		const done = (value) => {
			form.removeEventListener("submit", onSubmit);
			dialog.removeEventListener("close", onClose);
			resolve(value);
		};
		const onSubmit = (e) => {
			e.preventDefault(); // close with the animation instead of instantly
			done(e.submitter?.value === "ok" ? [...$("ask-fields").querySelectorAll("input")].map((i) => i.value.trim()) : null);
			closeDialog(dialog);
		};
		const onClose = () => done(null); // Esc or click outside
		form.addEventListener("submit", onSubmit);
		dialog.addEventListener("close", onClose);
	});
}
