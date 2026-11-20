/* Queue page: every video waiting to be split, plus quick controls for detection and background work. */
(function (SP) {
  const { h, icon, Button, Seg, Stepper, Range, Switch, Bar, toast, shortPath, errorText } = SP;

  function header(title, sub, actions) {
    return h("div", { class: "flex items-end gap-4 px-8 pt-6 pb-5" },
      h("div", {}, h("h1", { class: "font-display text-[40px] leading-[1.05]" }, title), h("p", { class: "text-muted mt-1.5 text-[16px]" }, sub)),
      h("div", { class: "ml-auto flex gap-3 pb-1" }, actions));
  }
  function panelSection(title, ...body) {
    return h("div", { class: "px-5 py-4 border-b border-line last:border-0" }, h("div", { class: "label-caps mb-3" }, title), body);
  }
  function row(label, control) {
    return h("div", { class: "flex items-center justify-between gap-3 mt-3 first:mt-0" }, h("span", { class: "text-[15px]" }, label), control);
  }
  // Side panel: sections scroll if the window is short; the action area (if any) stays pinned at the bottom.
  function sidePanel(sections, footer) {
    return h("div", { class: "w-[340px] shrink-0 tile sticker self-start max-h-full flex flex-col overflow-hidden" },
      h("div", { class: "scroll min-h-0 flex-1" }, sections),
      footer ? h("div", { class: "p-5 bg-felt shrink-0" }, footer) : null);
  }
  SP.parts = { header, panelSection, row, sidePanel };

  function statusDot() {
    const el = h("div", { class: "relative w-6 h-6 shrink-0 flex items-center justify-center" });
    el.set = (state) => {
      if (el.dataset.state === state) return;
      const was = el.dataset.state;
      el.dataset.state = state;
      el.innerHTML = "";
      if (state === "waiting") el.append(h("span", { class: "w-3 h-3 rounded-full border-2 border-muted" }));
      else if (state === "scanning" || state === "exporting")
        el.append(h("span", { class: "absolute w-3 h-3 rounded-full bg-accent pulse-ring" }), h("span", { class: "relative w-3 h-3 rounded-full bg-accent" }));
      else {
        const color = { done: "bg-up", nocuts: "bg-warn" }[state] || "bg-alert";
        const inner = state === "done" ? icon("check", "w-3.5 h-3.5") : h("span", { class: "font-black text-[13px] leading-none" }, "!");
        el.append(h("span", { class: `w-6 h-6 rounded-full ${color} text-page flex items-center justify-center ${was ? "anim-pop" : ""}` }, inner));
      }
    };
    return el;
  }

  function Card(job) {
    const dot = statusDot();
    const title = h("div", { class: "font-display text-[19px] leading-tight truncate" });
    const sub = h("span", { class: "chip sticker-sm !font-semibold !text-muted shrink-0" });
    const status = h("div", { class: "text-[14px] mt-1 transition-colors duration-500" });
    const bar = Bar();
    const retry = Button("Retry", () => SP.call("queue.retry", { id: job.id }), { size: "sm" });
    const open = Button("Open folder", () => window.sp.openPath(card.job.folder), { size: "sm", iconName: "folder" });
    const remove = Button("Remove", () => removeJob(card.job), { size: "sm" });
    const el = h("div", { class: "collapsible" },
      h("div", { class: "tile sticker p-4 pl-5 mb-3.5 anim-card-in" },
        h("div", { class: "flex items-center gap-3" }, dot,
          h("div", { class: "min-w-0 flex-1" }, h("div", { class: "flex items-center gap-2.5 min-w-0" }, title, sub), status),
          h("div", { class: "flex gap-2 shrink-0" }, retry, open, remove)),
        h("div", { class: "mt-3.5" }, bar)));
    const card = { el, job };
    card.update = (j) => {
      card.job = j;
      title.textContent = j.title;
      sub.textContent = j.subtitle;
      sub.hidden = !j.subtitle;
      dot.set(j.state);
      const paused = !SP.state.jobs.running;
      let text, tone = "text-muted";
      if (j.state === "waiting") text = "Waiting in the queue";
      else if (j.state === "scanning") text = `Finding scene changes  ${Math.round(j.scan * 100)}%`;
      else if (j.state === "exporting") text = `Saving clip ${Math.min(j.done + 1, j.total)} of ${j.total}  ·  starts at ${j.current}${j.eta ? "  ·  " + j.eta : ""}`;
      else if (j.state === "done") (text = `Done  ·  ${SP.plural(j.total, "clip")} saved`), (tone = "text-up");
      else if (j.state === "nocuts") (text = 'No scene changes found. Move Scene detection towards "More cuts", then Retry.'), (tone = "text-warn");
      else (text = j.message || "Something went wrong."), (tone = "text-alert");
      if (paused && (j.state === "scanning" || j.state === "exporting")) text = "Paused  ·  " + text;
      status.textContent = text;
      status.className = `text-[14px] mt-1 transition-colors duration-500 ${tone}`;
      const finished = ["done", "nocuts", "error"].includes(j.state);
      bar.set(finished ? 1 : j.progress, j.state, !paused && (j.state === "scanning" || j.state === "exporting"));
      retry.hidden = !["nocuts", "error"].includes(j.state);
      open.hidden = !j.folder;
    };
    card.update(job);
    return card;
  }

  async function removeJob(job) {
    const active = job.state === "scanning" || job.state === "exporting";
    if (active && !confirm(`Stop and remove "${job.title}"?\n\nClips already saved are kept.`)) return;
    SP.call("queue.remove", { id: job.id });
  }

  SP.QueuePage = function () {
    const s = SP.state.settings;
    const cards = new Map();
    const list = h("div", { class: "flex-1 min-w-0 scroll pr-2 pb-4" });
    const listInner = h("div", {});
    const empty = SP.Empty("Drop films here", "Or click Add films. Add as many as you like, then press Start and carry on using your PC.", [
      Button("Add films", () => pick("films"), { kind: "primary", iconName: "plus" }),
      Button("Add folder", () => pick("folder"), { iconName: "folder" }),
    ]);
    list.append(listInner, empty);

    async function pick(kind) {
      const paths = await window.sp.pick(kind);
      if (paths.length) add(paths);
    }
    async function add(paths) {
      try {
        const r = await SP.call("queue.addFilms", { paths });
        if (r.added) toast(`${SP.plural(r.added, "film")} added`, SP.state.settings.auto_start || SP.state.jobs.running ? "Splitting starts right away." : "Press Start when you're ready.");
        else if (!r.found) toast("No videos found", "Those files aren't videos ScenePack can read.", "warn");
        else toast("Already in the queue", "", "warn");
      } catch (e) {
        toast("Couldn't add those", errorText(e), "alert");
      }
    }

    // ---- side panel
    const outLabel = h("div", { class: "text-[14px] break-all leading-snug" }, shortPath(s.output_dir, 60));
    const modeHint = h("p", { class: "text-muted text-[13px] mt-2.5 leading-snug" });
    const hints = {
      light: "Slowest. Stays out of the way so games and other apps run smoothly.",
      balanced: "Uses about half the processor and gives way to whatever you're doing.",
      full: "Fastest. The PC may feel slow while videos are processing.",
    };
    modeHint.textContent = hints[s.mode];
    const panel = sidePanel([
      panelSection("Save clips to", outLabel,
        h("div", { class: "flex gap-2 mt-3" },
          Button("Change", async () => {
            const [p] = await window.sp.pick("folder");
            if (p) (outLabel.textContent = shortPath(p, 60)), SP.save({ output_dir: p });
          }, { size: "sm" }),
          Button("Open", () => window.sp.openPath(SP.state.settings.output_dir), { size: "sm", iconName: "folder" }))),
      panelSection("Scene detection",
        Range(s.sensitivity, null, (v) => SP.save({ sensitivity: v })),
        h("div", { class: "flex justify-between text-muted text-[12px] mt-0.5" }, h("span", {}, "Fewer cuts"), h("span", {}, "More cuts")),
        row("Join scenes shorter than (s)", Stepper(s.min_len, { min: 0, max: 30, step: 0.1, decimals: 1 }, (v) => SP.save({ min_len: v })))),
      panelSection("Working in the background",
        h("div", { class: "text-[15px] mb-2" }, "Videos at the same time"),
        Seg([["1", 1], ["2", 2], ["3", 3], ["4", 4]], s.parallel, (v) => SP.save({ parallel: v })),
        h("div", { class: "text-[15px] mt-4 mb-2" }, "How much of the PC to use"),
        SP.bind(Seg([["Light", "light"], ["Balanced", "balanced"], ["Full speed", "full"]], s.mode, (v) => ((modeHint.textContent = hints[v]), SP.save({ mode: v }))), "mode"),
        modeHint,
        row("Start as soon as videos are added", SP.bind(Switch(s.auto_start, (v) => SP.save({ auto_start: v })), "auto_start")),
        row("Stop the PC sleeping while working", Switch(s.keep_awake, (v) => SP.save({ keep_awake: v })))),
    ]);

    const el = h("section", { class: "flex flex-col min-h-0" },
      header("Queue", "Everything waiting to be split. Drop films anywhere on this page.", [
        Button("Add folder", () => pick("folder"), { iconName: "folder" }),
        Object.assign(Button("Add films", () => pick("films"), { kind: "primary", iconName: "plus" }), { title: "Add films  (Ctrl+O)" }),
      ]),
      h("div", { class: "flex gap-6 px-8 pb-6 flex-1 min-h-0" }, list, panel));

    SP.on("jobs", ({ jobs }) => {
      const seen = new Set();
      jobs.forEach((j, i) => {
        seen.add(j.id);
        let c = cards.get(j.id);
        if (!c) {
          c = Card(j);
          cards.set(j.id, c);
          c.el.firstChild.style.animationDelay = `${Math.min(i, 8) * 40}ms`;
        } else c.update(j);
        if (listInner.children[i] !== c.el) listInner.insertBefore(c.el, listInner.children[i] || null);
      });
      for (const [id, c] of cards) {
        if (seen.has(id)) continue;
        cards.delete(id);
        c.el.style.height = c.el.offsetHeight + "px";
        requestAnimationFrame(() => {
          c.el.style.height = "0px";
          c.el.style.opacity = "0";
        });
        setTimeout(() => c.el.remove(), 340);
      }
      empty.hidden = jobs.length > 0;
    });

    return { el, onDrop: add, pick };
  };
})(window.SP);
