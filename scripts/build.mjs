import { build } from "esbuild";
import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "dist", "geolibre-mapterhorn");
const manifest = JSON.parse(readFileSync(resolve(root, "geolibre-plugin/plugin.json"), "utf8"));

rmSync(resolve(root, "dist"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [resolve(root, "src/index.js")],
  outfile: resolve(out, "index.js"),
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",  define: { __PLUGIN_VERSION__: JSON.stringify(manifest.version) },
});
copyFileSync(resolve(root, "geolibre-plugin/plugin.json"), resolve(out, "plugin.json"));
copyFileSync(resolve(root, "geolibre-plugin/style.css"), resolve(out, "style.css"));

if (process.argv.includes("--zip")) {
  const zipPath = resolve(root, "dist", `${manifest.id}-${manifest.version}.zip`);
  const zip = new AdmZip();
  for (const file of ["plugin.json", "index.js", "style.css"]) {
    zip.addLocalFile(resolve(out, file));
  }
  zip.writeZip(zipPath);
  const sha = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  writeFileSync(`${zipPath}.sha256`, `${sha}\n`);
  console.log(`${zipPath}\nsha256 ${sha}`);
}
