/* TV shows page: pick seasons and how many clips to take from each episode. */
(function (SP) {
  const { h, icon, Button, Seg, Stepper, Switch, toast, errorText } = SP;

  SP.TVPage = function () {
    const { header, panelSection, row, sidePanel } = SP.parts;
    const s = SP.state.settings;
    let show = "", seasons = [], chosen = new Set(), skipped = new Set(), paths = [];
    const durations = {};

    const content = h("div", { class: "flex-1 min-w-0 scroll pr-2 pb-4" });
    const summary = h("p", { class: "text-muted text-[14px] leading-snug mb-3" });
    const queueBtn = Button("Add to queue", addToQueue, { kind: "primary", size: "big", iconName: "plus", cls: "w-full" });
    const hint = h("p", { class: "text-muted text-[13px] mt-2.5 leading-snug" });
    const hints = {
      spread: "Splits each episode into equal parts and takes the longest scene from each, so clips cover the whole episode.",
      longest: "Takes the longest scenes in each episode.",
      random: "Takes random scenes. The same episode always gives the same picks.",
    };
    hint.textContent = hints[s.tv_mode];
    const count = Stepper(s.tv_count, { min: 1, max: 200 }, (v) => (SP.save({ tv_count: v }), updateSummary()));
    count.disable(s.tv_all);

    const panel = sidePanel([
      panelSection("Clips per episode",
        h("div", { class: "flex items-center justify-between" }, count,
          h("label", { class: "flex items-center gap-3 text-[15px]" }, "Every scene",
            Switch(s.tv_all, (v) => (count.disable(v), SP.save({ tv_all: v }), updateSummary()))))),
      panelSection("How to choose clips",
        Seg([["Spread out", "spread"], ["Longest", "longest"], ["Random", "random"]], s.tv_mode, (v) => ((hint.textContent = hints[v]), SP.save({ tv_mode: v }))),
        hint),
      panelSection("Skip",
        row("Clips shorter than (s)", Stepper(s.tv_min_len, { min: 0, max: 60, step: 0.5, decimals: 1 }, (v) => SP.save({ tv_min_len: v }))),
        row("First minutes (intro)", Stepper(s.tv_skip_start, { min: 0, max: 30, step: 0.5, decimals: 1 }, (v) => SP.save({ tv_skip_start: v }))),
        row("Last minutes (credits)", Stepper(s.tv_skip_end, { min: 0, max: 30, step: 0.5, decimals: 1 }, (v) => SP.save({ tv_skip_end: v })))),
      panelSection("Folders", Seg([["A folder per season", "seasons"], ["One folder", "flat"]], s.tv_layout, (v) => SP.save({ tv_layout: v }))),
    ], [summary, queueBtn]);

    const clearBtn = Button("Clear", clear, {});
    const el = h("section", { class: "flex flex-col min-h-0" },
      header("TV shows", "Pick seasons and how many clips to take from each episode.", [
        clearBtn,
        Button("Add episodes", () => pick("films"), { iconName: "plus" }),
        Button("Add show folder", () => pick("folder"), { kind: "primary", iconName: "folder" }),
      ]),
      h("div", { class: "flex gap-6 px-8 pb-6 flex-1 min-h-0" }, content, panel));

    async function pick(kind) {
      const p = await window.sp.pick(kind);
      if (p.length) load(p);
    }
    async function load(newPaths) {
      try {
        const r = await SP.call("tv.scan", { paths: [...paths, ...newPaths] });
        if (!r.seasons.length) return toast("No episodes found", "That folder has no videos ScenePack can read.", "warn");
        const before = new Set(seasons.map((x) => x.season));
        paths = [...paths, ...newPaths];
        show = show || r.show;
        seasons = r.seasons;
        seasons.forEach((x) => !before.has(x.season) && chosen.add(x.season));
        const n = seasons.reduce((a, x) => a + x.episodes.length, 0);
        toast(show, `${SP.plural(n, "episode")} in ${SP.plural(seasons.length, "season")}`);
        render(true);
      } catch (e) {
        toast("Couldn't read that", errorText(e), "alert");
      }
    }
    function clear() {
      show = "";
      seasons = [];
      paths = [];
      chosen = new Set();
      skipped = new Set();
      render(true);
    }

    function selected() {
      const out = [];
      seasons.forEach((x) => chosen.has(x.season) && x.episodes.forEach((e) => !skipped.has(e.path) && out.push({ ...e, season: x.season })));
      return out;
    }
    function updateSummary() {
      const sel = selected();
      queueBtn.disabled = !sel.length;
      if (!seasons.length) return (summary.textContent = "Add a show, then choose its seasons.");
      if (!sel.length) return (summary.textContent = "Choose at least one season.");
      const st = SP.state.settings;
      summary.textContent = st.tv_all
        ? `${SP.plural(sel.length, "episode")}  ×  every scene`
        : `${SP.plural(sel.length, "episode")}  ×  ${st.tv_count} clips  =  up to ${sel.length * st.tv_count} clips`;
    }

    function render(animate) {
      content.innerHTML = "";
      clearBtn.disabled = !seasons.length;
      if (!seasons.length) {
        content.append(SP.Empty("Drop a show folder here", "ScenePack finds seasons and episodes from names like S01E02, 1x02 or Season 1 / Episode 2.", [
          Button("Add show folder", () => pick("folder"), { kind: "primary", iconName: "folder" }),
        ]));
        return updateSummary();
      }
      const nameField = h("input", { class: "field w-full font-display !text-[20px] !h-12", value: show });
      nameField.addEventListener("input", () => (show = nameField.value.trim()));
      const chips = h("div", { class: "flex flex-wrap gap-2.5" });
      seasons.forEach((x) => {
        const on = chosen.has(x.season);
        const chip = h("button", {
          class: `chip sticker-sm !text-[14px] !py-1.5 !px-3.5 cursor-pointer transition-colors duration-300 ${on ? "!bg-accent !text-on-accent" : "hover:!bg-raised-2"}`,
        }, on ? icon("check", "w-4 h-4") : null, `${x.season ? "Season " + x.season : "Other"}`, h("span", { class: "opacity-70 font-semibold" }, ` ${x.episodes.length}`));
        chip.addEventListener("click", () => {
          on ? chosen.delete(x.season) : chosen.add(x.season);
          render(false);
        });
        chips.append(chip);
      });
      content.append(h("div", { class: `tile sticker p-5 mb-6 ${animate ? "anim-card-in" : ""}` },
        h("div", { class: "label-caps mb-2" }, "Show name"), nameField,
        h("div", { class: "label-caps mt-5 mb-2.5" }, "Seasons to use"), chips));
      seasons.forEach((x, si) => {
        const on = chosen.has(x.season);
        const box = h("div", { class: `tile sticker overflow-hidden mb-5 transition-opacity duration-300 ${on ? "" : "opacity-45"} ${animate ? "anim-card-in" : ""}`, style: { animationDelay: `${(si + 1) * 60}ms` } });
        x.episodes.forEach((e, i) => {
          const used = on && !skipped.has(e.path);
          const sw = Switch(!skipped.has(e.path), (v) => {
            v ? skipped.delete(e.path) : skipped.add(e.path);
            rowEl.style.opacity = v ? 1 : 0.5;
            updateSummary();
          }, { disabled: !on });
          const dur = h("span", { class: "text-muted text-[14px] tabular-nums", "data-path": e.path }, durations[e.path] || "...");
          const rowEl = h("div", { class: `flex items-center gap-4 px-5 py-3 ${i ? "border-t border-line" : ""} transition-opacity duration-300`, style: { opacity: used || !on ? 1 : 0.5 } },
            h("span", { class: "font-display text-[16px] text-accent-ink w-16 shrink-0" }, e.code),
            h("span", { class: "truncate flex-1" }, e.title), dur, sw);
          box.append(rowEl);
        });
        content.append(h("div", { class: "label-caps mb-2.5" }, x.season ? `Season ${x.season}` : "Other", on ? "" : "  ·  not used"), box);
      });
      updateSummary();
    }

    SP.on("tvDuration", (d) => {
      durations[d.path] = d.duration || "unreadable";
      const span = [...content.querySelectorAll("[data-path]")].find((s) => s.dataset.path === d.path);
      if (span) span.textContent = durations[d.path];
    });

    async function addToQueue() {
      const sel = selected();
      try {
        const r = await SP.call("tv.queue", { show, episodes: sel.map((e) => ({ path: e.path, season: e.season, episode: e.episode })) });
        if (r.added) toast(`${SP.plural(r.added, "episode")} of ${show} added`, "Press Start when you're ready.");
        else toast("Already in the queue", "Those episodes are queued already.", "warn");
        SP.go("queue");
      } catch (e) {
        toast("Couldn't add those", errorText(e), "alert");
      }
    }

    render(false);
    return { el, onDrop: load, load };
  };
})(window.SP);
