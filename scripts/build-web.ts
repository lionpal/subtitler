// Builds the web page into site/, in two forms:
//
//   site/index.html with site/core/ and site/web/   the page as separate files, for GitHub Pages
//   site/subtitle.lol.html                          the same page as one file, to download and
//                                                   double-click; it needs no server
//
// Both are compiled from src/ by TypeScript, which keeps every comment, and neither is minified,
// so what runs in the browser can be read line by line.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(root, "site");

rmSync(site, { recursive: true, force: true });
execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", join(root, "tsconfig.web.json")], { stdio: "inherit" });

const page = readFileSync(join(root, "src/web/index.html"), "utf8");

// The separate-files page loads its script from the same site and nothing else.
writeFileSync(
  join(site, "index.html"),
  page
    .replace("SCRIPT_SOURCES", () => "'self'")
    .replace("<!-- SCRIPT -->", () => '<script type="module" src="web/app.js"></script>'),
);

// The one-file page carries every module as text. A short loader turns each into a blob: URL and
// lists them in an import map, so the modules import each other just as they do on the web.
const modules = listFiles(site)
  .filter((path) => path.endsWith(".js"))
  .map((path) => relative(site, path).split("\\").join("/"));

const blocks = modules.map((path) => {
  const code = readFileSync(join(site, path), "utf8")
    // "./srt.js" inside core/pipeline.js becomes "@subtitler/core/srt.js", a name the import map knows.
    .replace(/(from\s+|import\s*\(\s*)"(\.{1,2}\/[^"]+)"/g, (_, before, specifier) => {
      return `${before}"@subtitler/${posix.normalize(posix.join(posix.dirname(path), specifier))}"`;
    })
    // A script block ends at the first "</script", so that text must not appear inside one.
    .replaceAll("</script", "<\\/script");
  return `<script type="text/plain" data-module="${path}">\n${code}</script>`;
});

const loader = `<script>
// Runs the modules written out below. Nothing is downloaded: each block of code becomes a blob: URL
// in this browser, and the import map lets them import each other by name.
const imports = {};
for (const block of document.querySelectorAll('script[type="text/plain"][data-module]')) {
  imports["@subtitler/" + block.dataset.module] = URL.createObjectURL(new Blob([block.textContent], { type: "text/javascript" }));
}
const importMap = document.createElement("script");
importMap.type = "importmap";
importMap.textContent = JSON.stringify({ imports });
document.head.append(importMap);
import(imports["@subtitler/web/app.js"]);
</script>`;

writeFileSync(
  join(site, "subtitle.lol.html"),
  page
    .replace("SCRIPT_SOURCES", () => "'unsafe-inline' blob:")
    // The link to download this file makes no sense inside it.
    .replace(/<!-- ONLINE ONLY -->[\s\S]*?<!-- \/ONLINE ONLY -->/, "")
    // A function, so "$&" and the like in the code are inserted as they are. A plain string would
    // treat them as replacement patterns.
    // The loader goes after the blocks, since a script only sees what the browser has read above it.
    .replace("<!-- SCRIPT -->", () => `<!-- The program, one module per block, as compiled from src/ -->\n${blocks.join("\n\n")}\n\n${loader}`),
);

console.log(`site/index.html and ${modules.length} modules, and site/subtitle.lol.html as one file`);

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}
