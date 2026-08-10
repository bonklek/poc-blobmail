import { readFile, writeFile } from "node:fs/promises";

const path = "reports/test-results.xml";
let xml = await readFile(path, "utf8");

xml = xml
  .replace(/\s+time="[^"]*"/g, "")
  .replace(/^\s*<!-- duration_ms [^\n]*\r?\n/m, "")
  .replace(/file="[^"]*?[\\/](test[\\/][^"]+)"/g, (_match, relative) => (
    `file="${relative.replaceAll("\\", "/")}"`
  ));

await writeFile(path, xml, "utf8");
console.log("normalized reports/test-results.xml to repository-relative, timing-free evidence");
