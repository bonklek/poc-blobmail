import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import http from "node:http";

const ORIGIN = "http://127.0.0.1:5173";
const OUTPUT = "reports/dev-server-probe.json";

function get(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${ORIGIN}${pathname}`, { timeout: 2_000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({
          pathname,
          statusCode: response.statusCode,
          contentType: response.headers["content-type"] ?? null,
          body,
          sha256: createHash("sha256").update(body).digest("hex"),
        });
      });
    });
    request.on("timeout", () => request.destroy(new Error("local client probe timed out")));
    request.on("error", reject);
  });
}

const [root, entry] = await Promise.all([get("/"), get("/src/main.js")]);
const rootText = root.body.toString("utf8");
const entryText = entry.body.toString("utf8");
const checks = {
  rootHttp200: root.statusCode === 200,
  entryHttp200: entry.statusCode === 200,
  appRootPresent: rootText.includes('id="app"'),
  mvpEntryPresent: entryText.includes("startMvpClient"),
};
const passed = Object.values(checks).every(Boolean);

const report = {
  schema: "blobmail.dev-server-probe.v1",
  generatedAt: new Date().toISOString(),
  origin: ORIGIN,
  scope: "hard-coded loopback HTTP probe only; no external request",
  checks,
  responses: [root, entry].map(({ body, ...response }) => ({
    ...response,
    bytes: body.length,
  })),
  passed,
};

await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
