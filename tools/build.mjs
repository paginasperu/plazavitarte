// Empaqueta JavaScript vanilla; no incorpora frameworks ni un runtime adicional.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["app.js"],
  bundle: true,
  define: { __DIRECTORY_BUNDLED__: "true" },
  format: "esm",
  target: ["es2020"],
  minify: true,
  legalComments: "none",
  write: false,
});
const output = result.outputFiles[0].text;
const bundle = resolve(root, "assets/js/directory.js");
function update(path, text) {
  let before;
  try { before = readFileSync(path, "utf8").replace(/\r\n/g, "\n"); } catch {}
  if (before === text) return;
  if (check) throw new Error(`Generado pendiente: ${path}`);
  writeFileSync(path, text);
}
update(bundle, output);
const htmlPath = resolve(root, "index.html");
const html = readFileSync(htmlPath, "utf8");
const boot = readFileSync(resolve(root, "assets/js/bootstrap.js"), "utf8").trimEnd();
const next = html.replace(/\/\* DIRECTORY_BOOT_START \*\/[\s\S]*?\/\* DIRECTORY_BOOT_END \*\//,
  `/* DIRECTORY_BOOT_START */\n${boot}\n/* DIRECTORY_BOOT_END */`);
if (next === html && !html.includes("DIRECTORY_BOOT_START")) throw new Error("Falta el punto de inserción del arranque");
update(htmlPath, next.replace(/\r\n/g, "\n"));
console.log(check ? "JavaScript generado al día." : "JavaScript preparado.");
