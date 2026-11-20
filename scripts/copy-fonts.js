// Copies the two variable fonts the interface uses into renderer/fonts (works offline, no CDN).
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = path.join(root, "renderer", "fonts");
fs.mkdirSync(out, { recursive: true });
for (const [pkg, file] of [
  ["figtree", "figtree-latin-wght-normal.woff2"],
  ["dm-sans", "dm-sans-latin-wght-normal.woff2"],
]) {
  const dir = path.join(root, "node_modules", "@fontsource-variable", pkg);
  fs.copyFileSync(path.join(dir, "files", file), path.join(out, file));
  const lic = path.join(dir, "LICENSE");
  if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(out, `${pkg}-OFL.txt`));
}
console.log("fonts copied to renderer/fonts");
