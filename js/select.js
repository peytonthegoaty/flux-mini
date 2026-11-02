// Swaps a native <select> popup (which can't be styled or animated) for an in-page
// menu. The real <select> stays in the DOM, hidden, holding the value, and still fires
// "change", so code that reads or listens to it keeps working.
export function enhanceSelect(select) {
	const wrap = document.createElement("div");
	wrap.className = "dd";
	wrap.innerHTML =
		`<button class="dd-button" type="button" aria-haspopup="listbox" aria-expanded="false">` +
		`<span class="dd-value"></span><svg class="i dd-chev"><use href="#i-chevron-down"/></svg></button>` +
		`<div class="dd-list" role="listbox"></div>`;
	const [button, list] = wrap.children;
	select.after(wrap);
	wrap.prepend(select);
	select.hidden = true;

	list.append(
		...[...select.options].map((option) => {
			const el = document.createElement("div");
			el.className = "dd-option";
			el.role = "option";
			el.dataset.value = option.value;
			el.textContent = option.text;
			return el;
		})
	);

	const sync = () => {
		button.firstChild.textContent = select.selectedOptions[0]?.text ?? "";
		for (const el of list.children) el.setAttribute("aria-selected", el.dataset.value === select.value);
	};
	const open = (state) => {
		wrap.classList.toggle("open", state);
		button.setAttribute("aria-expanded", state);
		if (state) list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	};
	const choose = (value) => {
		if (value !== select.value) {
			select.value = value;
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}
		sync();
	};

	button.addEventListener("click", () => open(!wrap.classList.contains("open")));
	list.addEventListener("click", (e) => {
		const option = e.target.closest(".dd-option");
		if (!option) return;
		choose(option.dataset.value);
		open(false);
		button.focus();
	});
	button.addEventListener("keydown", (e) => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const next = select.options[select.selectedIndex + (e.key === "ArrowDown" ? 1 : -1)];
			if (next) choose(next.value);
		} else if (e.key === "Escape" && wrap.classList.contains("open")) {
			e.preventDefault(); // close just the menu, not the settings popup
			open(false);
		}
	});
	document.addEventListener("click", (e) => wrap.contains(e.target) || open(false));
	select.addEventListener("change", sync); // also reflect changes made by code
	sync();
}
