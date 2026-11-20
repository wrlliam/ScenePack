/* About page: what ScenePack is, how it works, credits, and the note that it was made with AI. */
(function (SP) {
  const { h, icon, Button, toast, errorText } = SP;

  const FEATURES = [
    ["film", "Whole films", "Every scene of a film, saved as separate clips in the format and quality you choose."],
    ["tv", "TV shows", "Pick seasons and how many clips to take from each episode, with intros and credits skipped."],
    ["ai", "AI search", "Describe a character, a place or a moment, then choose from the scenes that match."],
    ["library", "Library", "Browse every clip you've made with live previews, then export picks from several films into one folder."],
    ["gpu", "Runs in the background", "Queue as much as you like, decide how much of the PC to use, and let your graphics card help."],
    ["refresh", "Keeps itself up to date", "New versions download quietly in the background and install the next time ScenePack restarts."],
  ];
  const STEPS = [
    "Add videos: drop films on the Queue, a show folder on TV shows, or search with AI.",
    "ScenePack scans each video and finds every cut between shots.",
    "Each scene is saved as its own clip, numbered and time-stamped, in one folder per video or show.",
  ];
  const CREDITS = [
    ["FFmpeg", "reads, scans and cuts the video (installed separately, LGPL/GPL)"],
    ["CLIP by OpenAI", "the image and text model behind AI search (MIT)"],
    ["ONNX Runtime + DirectML", "runs the AI model on your graphics card or processor (MIT)"],
    ["Hugging Face Tokenizers", "turns search words into tokens (Apache 2.0)"],
    ["Electron + Tailwind CSS", "the app window and its styling (MIT)"],
    ["Figtree and DM Sans", "the typefaces (SIL Open Font License)"],
  ];

  SP.AboutPage = function () {
    const { header } = SP.parts;
    const repo = SP.state.repo;
    const updateBtn = Button("Check for updates", checkUpdates, { size: "sm", iconName: "refresh" });

    const hero = h("div", { class: "tile sticker-lg p-8 flex items-center gap-10 reveal" },
      h("img", { src: "../assets/icon_512.png", alt: "", draggable: "false", class: "shrink-0 w-[168px] h-[168px] anim-bob", style: { animationDuration: "3.2s" } }),
      h("div", { class: "min-w-0" },
        h("div", { class: "flex items-center gap-3" }, h("h2", { class: "font-display text-[46px] leading-none" }, "scenepack"), h("span", { class: "tag" }, `v${SP.state.version}`)),
        h("p", { class: "font-display text-[24px] text-accent-ink mt-2 leading-tight" }, "One film in. Every scene out."),
        h("p", { class: "text-muted text-[16px] mt-4 leading-relaxed max-w-[620px]" },
          "ScenePack turns films and TV episodes into scenepacks: folders of short clips, one per scene, ready to use in edits. " +
          "It watches each video for the moments the picture cuts to a new shot, then saves every scene as its own frame-accurate file, " +
          "named with where it starts so it's easy to find again."),
        h("div", { class: "flex gap-2.5 mt-5" },
          repo ? Button("GitHub page", () => window.sp.openExternal(repo), { size: "sm", iconName: "external" }) : null,
          updateBtn,
          repo ? Button("Licence", () => window.sp.openExternal(repo.replace(/\/$/, "") + "/blob/main/LICENSE"), { size: "sm" }) : null)));

    const features = h("div", { class: "grid grid-cols-2 gap-4" }, FEATURES.map(([ic, t, b]) =>
      h("div", { class: "tile sticker p-6 reveal" },
        h("div", { class: "w-11 h-11 rounded-xl bg-card text-accent flex items-center justify-center sticker-sm" }, icon(ic, "w-6 h-6")),
        h("h3", { class: "font-display text-[24px] mt-4 leading-tight" }, t),
        h("p", { class: "text-muted mt-1.5 leading-snug" }, b))));

    const steps = h("div", { class: "tile sticker p-6 flex flex-col gap-4 reveal" }, STEPS.map((t, i) =>
      h("div", { class: "flex items-center gap-4" },
        h("span", { class: "w-9 h-9 rounded-full bg-accent text-on-accent font-display text-[17px] flex items-center justify-center sticker-sm shrink-0" }, String(i + 1)),
        h("span", { class: "text-[16px]" }, t))));

    const madeWithAI = h("div", { class: "tile sticker p-6 flex gap-5 items-start reveal" },
      h("div", { class: "w-11 h-11 rounded-xl bg-accent text-on-accent flex items-center justify-center sticker-sm shrink-0" }, icon("ai", "w-6 h-6")),
      h("div", {},
        h("h3", { class: "font-display text-[24px] leading-tight" }, "Made with the help of AI"),
        h("p", { class: "text-muted mt-2 leading-relaxed max-w-[720px]" },
          "ScenePack was created with the assistance of AI. Its design, code and this page were written together with Claude, " +
          "an AI assistant made by Anthropic. The AI search feature also uses a small AI model (CLIP) that runs entirely on your PC: " +
          "nothing you search for or watch is ever uploaded.")));

    const credits = h("div", { class: "tile sticker p-6 reveal" }, CREDITS.map(([n, w], i) =>
      h("div", { class: `flex gap-3 py-2 ${i ? "border-t border-line" : ""}` }, h("span", { class: "font-bold w-[230px] shrink-0" }, n), h("span", { class: "text-muted" }, w))));

    const label = (t) => h("div", { class: "label-caps mt-8 mb-3 reveal" }, t);
    const content = h("div", { class: "max-w-[980px]" }, hero, label("What it can do"), features, label("How it works"), steps,
      label("Keyboard shortcuts"),
      h("div", { class: "tile sticker p-6 grid grid-cols-2 gap-x-8 gap-y-2.5 reveal" }, SP.SHORTCUTS.map(([k, what]) =>
        h("div", { class: "flex items-center gap-3" }, h("kbd", { class: "chip sticker-sm !font-mono !text-[12px] shrink-0" }, k), h("span", { class: "text-muted" }, what)))),
      label("Made with AI"), madeWithAI, label("Built with"), credits,
      h("p", { class: "text-muted text-[14px] mt-6 leading-snug reveal" },
        "Only use ScenePack with videos you have the right to use. Clips from films and TV shows are usually copyrighted, so check what's allowed before sharing them."));

    async function checkUpdates() {
      updateBtn.setLabel("Checking...");
      const u = await window.sp.update.check();
      updateBtn.setLabel("Check for updates");
      if (u.state === "current") toast("You're up to date", `Version ${SP.state.version} is the newest.`, "up");
      else if (u.state === "downloading" || u.state === "available") toast("Update found", `Version ${u.version} is downloading. You'll be asked to restart.`, "up");
      else if (u.state === "ready") toast("Update ready", "Use Restart now in the sidebar.", "up");
      else if (u.state === "unavailable") toast("Updates aren't set up", "This copy wasn't installed from a GitHub Release.", "warn");
      else toast("Couldn't check for updates", u.message || "Check your internet connection and try again.", "warn");
    }
    const scroller = h("div", { class: "flex-1 min-h-0 scroll px-8 pb-10" }, content);
    const el = h("section", { class: "flex flex-col min-h-0" }, header("About", "What ScenePack does, and how it was made.", []), scroller);
    return {
      el,
      onShow() {
        scroller.scrollTop = 0;
        el.querySelectorAll(".reveal").forEach((n, i) => {
          n.classList.remove("anim-rise");
          void n.offsetWidth;
          n.style.animationDelay = `${Math.min(i, 14) * 45}ms`;
          n.classList.add("anim-rise");
        });
      },
    };
  };
})(window.SP);
