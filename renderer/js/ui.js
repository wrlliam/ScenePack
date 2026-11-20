/* Shared helpers and small components. Everything hangs off window.SP. */
window.SP = window.SP || {};

(function (SP) {
  // ---------------------------------------------------------------- elements
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "html") el.innerHTML = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const PATHS = {
    queue: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    tv: '<rect x="2" y="7" width="20" height="14" rx="2.5"/><path d="M17 2l-5 5-5-5"/>',
    ai: '<path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/><path d="M19 15v5M16.5 17.5h5"/>',
    settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    about: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/>',
    pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    film: '<rect x="2" y="4" width="20" height="16" rx="2.5"/><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    external: '<path d="M14 3h7v7M10 14L21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    library: '<rect x="3" y="8" width="18" height="13" rx="2.5"/><path d="M6 8V5.5A1.5 1.5 0 0 1 7.5 4h9A1.5 1.5 0 0 1 18 5.5V8M9 12.5l4 2.5-4 2.5z"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    gpu: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="9" cy="12" r="2.5"/><path d="M15 10h4M15 14h4M6 18v3M18 18v3"/>',
  };
  function icon(name, cls = "w-5 h-5") {
    const span = document.createElement("span");
    span.className = "inline-flex shrink-0";
    span.innerHTML = `<svg viewBox="0 0 24 24" class="${cls}" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] || ""}</svg>`;
    return span;
  }

  function fileUrl(p) {
    if (!p) return "";
    const parts = p.replace(/\\/g, "/").split("/");
    return "file:///" + [parts[0], ...parts.slice(1).map(encodeURIComponent)].join("/");
  }
  function plural(n, word, many) {
    return `${n} ${n === 1 ? word : many || word + "s"}`;
  }
  function shortPath(p, max = 46) {
    if (!p || p.length <= max) return p || "";
    return p.slice(0, 14) + " ... " + p.slice(-(max - 19));
  }

  // ---------------------------------------------------------------- controls
  function Switch(checked, onChange, opts = {}) {
    const el = h("button", { class: "switch", role: "switch", "aria-checked": String(!!checked), title: opts.title });
    el.addEventListener("click", () => {
      if (el.getAttribute("aria-disabled") === "true") return;
      const v = el.getAttribute("aria-checked") !== "true";
      el.setAttribute("aria-checked", String(v));
      onChange(v);
    });
    el.set = (v) => el.setAttribute("aria-checked", String(!!v));
    el.disable = (d) => el.setAttribute("aria-disabled", String(!!d));
    if (opts.disabled) el.disable(true);
    return el;
  }

  function Seg(options, value, onChange) {
    const thumb = h("div", { class: "seg-thumb sticker-sm" });
    const el = h("div", { class: "seg" }, thumb);
    const buttons = options.map(([label, v]) => {
      const b = h("button", { "aria-pressed": "false" }, label);
      b.addEventListener("click", () => {
        if (el.value === v) return;
        el.set(v);
        onChange(v);
      });
      el.appendChild(b);
      return b;
    });
    el.set = (v) => {
      el.value = v;
      const i = Math.max(0, options.findIndex((o) => o[1] === v));
      buttons.forEach((b, j) => b.setAttribute("aria-pressed", String(j === i)));
      thumb.style.width = `calc((100% - 6px) / ${options.length})`;
      thumb.style.transform = `translateX(${i * 100}%)`;
    };
    el.set(value);
    return el;
  }

  function Stepper(value, { min = 0, max = 999, step = 1, decimals = 0 } = {}, onChange) {
    const input = h("input", { value: Number(value).toFixed(decimals), inputmode: "decimal" });
    const clamp = (v) => Math.min(max, Math.max(min, Math.round(v / step) * step));
    const commit = (v) => {
      v = clamp(isNaN(v) ? min : v);
      input.value = v.toFixed(decimals);
      onChange(Number(v.toFixed(decimals)));
    };
    input.addEventListener("change", () => commit(parseFloat(input.value)));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp") commit(parseFloat(input.value) + step), e.preventDefault();
      if (e.key === "ArrowDown") commit(parseFloat(input.value) - step), e.preventDefault();
    });
    const el = h("div", { class: "stepper" },
      h("button", { onclick: () => commit(parseFloat(input.value) - step), "aria-label": "Less" }, "-"),
      input,
      h("button", { onclick: () => commit(parseFloat(input.value) + step), "aria-label": "More" }, "+"));
    el.input = input;
    el.set = (v) => (input.value = Number(v).toFixed(decimals));
    el.disable = (d) => {
      el.style.opacity = d ? 0.4 : 1;
      el.style.pointerEvents = d ? "none" : "";
    };
    return el;
  }

  function Range(value, onInput, onChange) {
    const el = h("input", { type: "range", class: "range", min: 0, max: 1, step: 0.01, value });
    const paint = () => {
      el.style.setProperty("--p", el.value);
    };
    el.addEventListener("input", () => (paint(), onInput && onInput(Number(el.value))));
    el.addEventListener("change", () => onChange && onChange(Number(el.value)));
    paint();
    return el;
  }

  function Bar() {
    const fill = h("div", { class: "bar-fill", style: { width: "0%" } });
    const el = h("div", { class: "bar" }, fill);
    el.set = (p, state = "", working = false) => {
      fill.style.width = `${Math.max(0, Math.min(1, p)) * 100}%`;
      fill.dataset.state = state;
      fill.dataset.working = String(!!working);
    };
    return el;
  }

  function Spinner(cls = "w-4 h-4") {
    return h("span", { class: `inline-block ${cls} rounded-full border-2 border-line border-t-accent anim-spin` });
  }

  // The fanned stack of cream cards used for empty states and the About page.
  function CardFan(size = 1, glyph = "film") {
    const w = 84 * size, hgt = 112 * size;
    const card = (r, x, y, extra) =>
      h("div", {
        class: `absolute rounded-[12%] bg-card sticker-lg flex items-center justify-center text-accent anim-bob ${extra || ""}`,
        style: { width: `${w}px`, height: `${hgt}px`, left: `${x}px`, top: `${y}px`, "--r": `${r}deg`, transform: `rotate(${r}deg)`, animationDelay: `${(x / 40).toFixed(2)}s` },
      });
    const front = card(7, 92 * size, 10 * size);
    front.appendChild(icon(glyph, `w-[${Math.round(34 * size)}px] h-[${Math.round(34 * size)}px]`));
    front.firstChild.firstChild.setAttribute("width", 34 * size);
    front.firstChild.firstChild.setAttribute("height", 34 * size);
    return h("div", { class: "relative", style: { width: `${200 * size}px`, height: `${140 * size}px` } },
      card(-14, 8 * size, 18 * size, "opacity-60"), card(-4, 50 * size, 8 * size, "opacity-85"), front);
  }

  function Empty(title, body, actions = []) {
    return h("div", { class: "h-full min-h-[420px] rounded-tile border-2 border-dashed border-line flex flex-col items-center justify-center text-center px-8 anim-rise" },
      CardFan(1, "film"),
      h("h2", { class: "font-display text-[28px] mt-8" }, title),
      h("p", { class: "text-muted mt-2 max-w-md leading-snug" }, body),
      actions.length ? h("div", { class: "flex gap-3 mt-6" }, actions) : null);
  }

  function Button(label, onClick, { kind = "secondary", size = "", iconName = null, cls = "" } = {}) {
    const b = h("button", { class: `btn btn-${kind} ${size ? "btn-" + size : ""} sticker ${cls}` },
      iconName ? icon(iconName, size === "sm" ? "w-4 h-4" : "w-[18px] h-[18px]") : null, h("span", {}, label));
    b.addEventListener("click", onClick);
    b.setLabel = (t) => (b.lastChild.textContent = t);
    return b;
  }

  // ---------------------------------------------------------------- toasts
  function toast(title, body = "", tone = "accent") {
    const box = document.getElementById("toasts");
    const dot = { accent: "bg-accent", up: "bg-up", alert: "bg-alert", warn: "bg-warn" }[tone] || "bg-accent";
    const t = h("div", { class: "toast-in pointer-events-auto max-w-sm rounded-mat bg-toast text-on-toast sticker-lg px-4 py-3 flex gap-3 items-start" },
      h("span", { class: `mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${dot}` }),
      h("div", {}, h("div", { class: "font-bold leading-tight" }, title), body ? h("div", { class: "text-sm opacity-75 mt-0.5 leading-snug" }, body) : null));
    box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => {
      t.classList.replace("toast-in", "toast-out");
      setTimeout(() => t.remove(), 260);
    }, 4200);
  }

  function errorText(e) {
    return String((e && e.message) || e).replace(/^Error invoking remote method 'call': Error: /, "");
  }

  // Mark a control as showing a setting, so every copy of it updates when the setting changes anywhere.
  function bind(el, key) {
    el.dataset.setting = key;
    return el;
  }

  Object.assign(SP, { bind, h, append, icon, fileUrl, plural, shortPath, Switch, Seg, Stepper, Range, Bar, Spinner, CardFan, Empty, Button, toast, errorText });
})(window.SP);
