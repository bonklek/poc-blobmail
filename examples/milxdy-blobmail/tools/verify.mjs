import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const checks = [];

function check(name, condition, detail) {
  checks.push({ name, pass: Boolean(condition), detail });
  if (!condition) failures.push(`${name}: ${detail}`);
}

async function exists(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function safePath(input) {
  const target = resolve(packageRoot, input);
  const rel = relative(packageRoot, target);
  return rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !resolve(input).startsWith(input) ? target : target;
}

const manifestPath = resolve(packageRoot, "milxdy.app.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

check("manifest-version", manifest.manifestVersion === 1, "manifestVersion must be 1");
check("package-id", manifest.id === "blobmail-loopback", "package ID must remain stable");
check("disabled-by-default", manifest.defaultEnabled === false, "fixture app must start disabled");
check("fixture-only-lifecycle", manifest.lifecycle?.localOnly === true && manifest.lifecycle?.mode === "runtime", "runtime lifecycle must be localOnly");
check("dock-open-only", JSON.stringify(manifest.loadTriggers) === '["dockOpen"]', "only dockOpen may trigger loading");
check("overlay-only", JSON.stringify(manifest.surfaces) === '["overlayApp"]', "only overlayApp surface is allowed");
check("no-site-scopes", manifest.siteScopes === undefined, "siteScopes would imply host integration");
check("no-host-permissions", Array.isArray(manifest.permissions?.hosts) && manifest.permissions.hosts.length === 0, "host permission list must be explicitly empty");
check("no-optional-permissions", Array.isArray(manifest.permissions?.optional) && manifest.permissions.optional.length === 0, "optional permission list must be explicitly empty");
check("no-background-services", Array.isArray(manifest.background?.services) && manifest.background.services.length === 0, "background services must be explicitly empty");
check("no-background-messages", Array.isArray(manifest.background?.messageTypes) && manifest.background.messageTypes.length === 0, "background message types must be explicitly empty");
check("no-network-cost", manifest.cost?.network === "none", "network cost declaration must be none");
check("no-worker-cost", manifest.cost?.worker === "none", "worker declaration must be none");
check("no-remote-services", manifest.privacy?.remoteServices?.length === 0 && manifest.hub?.remoteServices?.length === 0, "remote service lists must be empty");
check("consent-required", manifest.privacy?.consentRequired === true, "plaintext fixture persistence requires package consent");
check("bounded-storage-keys", manifest.storageKeys?.local?.length === 3 && !manifest.storageKeys?.sync, "exactly three declared local keys and no sync keys are allowed");

const runtimePaths = [manifest.contentEntry, ...(manifest.css ?? []).map((item) => item.path), ...(manifest.package?.assets ?? []).map((item) => item.path)];
for (const path of new Set(runtimePaths)) {
  check(`safe-path:${path}`, typeof path === "string" && !path.includes("..") && !/^(?:[A-Za-z]:|[\\/])/.test(path), "runtime path must stay package-relative");
  check(`exists:${path}`, await exists(safePath(path)), "declared runtime file must exist");
}

for (const asset of manifest.package?.assets ?? []) {
  check(`asset-digest:${asset.path}`, asset.sha256 === await sha256(safePath(asset.path)), "declared SHA-256 must match bytes");
}

const entryText = await readFile(safePath(manifest.contentEntry), "utf8");
for (const symbol of ["boot", "open", "close", "disable", "dispose"]) {
  check(`lifecycle-export:${symbol}`, new RegExp(`\\b${symbol}\\b`).test(entryText), `content entry must include ${symbol}`);
}
for (const code of ["LOCAL_BATCH_CREATED", "BATCH_RECONSTRUCTED", "ENTRY_BYTES_VERIFIED", "DECRYPTED"]) {
  check(`evidence:${code}`, entryText.includes(code), `bundled client must retain ${code}`);
}

const forbiddenExecutablePatterns = [
  ["fetch", /\bfetch\s*\(/],
  ["xml-http-request", /\bXMLHttpRequest\b/],
  ["web-socket", /\bWebSocket\b/],
  ["send-beacon", /\bsendBeacon\s*\(/],
  ["wallet-provider", /\b(?:window\.)?ethereum\s*\./],
  ["transaction", /\b(?:sendTransaction|eth_sendTransaction|eth_sendRawTransaction)\b/],
  ["signing", /\b(?:signMessage|signTypedData|personal_sign|eth_sign)\b/],
  ["extension-message", /\b(?:chrome|browser)\.runtime\.(?:sendMessage|connect)\b/],
];
for (const [name, pattern] of forbiddenExecutablePatterns) {
  check(`forbidden:${name}`, !pattern.test(entryText), `content entry must not contain ${name} capability`);
}
check("self-contained-entry", !/^\s*import\s/m.test(entryText), "built content entry must have no runtime module imports");

const provenance = JSON.parse(await readFile(resolve(packageRoot, "UPSTREAM_PROVENANCE.json"), "utf8"));
check("pinned-upstream", /^[a-f0-9]{40}$/.test(provenance.commit), "upstream commit must be a full Git SHA");
check("pinned-source-blobs", provenance.sources?.length >= 6 && provenance.sources.every((item) => /^[a-f0-9]{40}$/.test(item.gitBlobSha1)), "every upstream source must have a Git blob SHA");
check("verbatim-theme-provenance", provenance.sources.some((item) => item.gitBlobSha1 === "c361b24fe7db9be6ae8bb036fa8db89b91a6018f" && item.use.includes("verbatim")), "copied theme must retain exact provenance");
check("upstream-license-retained", await exists(resolve(packageRoot, "UPSTREAM_LICENSE_VPL.txt")), "full upstream license must be retained");

const report = {
  schema: "blobmail.milxdy-package-verifier.v1",
  result: failures.length === 0 ? "PASS" : "FAIL",
  packageId: manifest.id,
  packageVersion: manifest.version,
  upstreamCommit: provenance.commit,
  checksPassed: checks.filter((item) => item.pass).length,
  checksTotal: checks.length,
  contentEntrySha256: await sha256(safePath(manifest.contentEntry)),
  manifestSha256: await sha256(manifestPath),
  checks,
  failures,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failures.length) process.exitCode = 1;
