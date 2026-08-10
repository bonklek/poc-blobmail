import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOTS = ["src", "scripts"];
const OUTPUT = "reports/safety-audit.json";
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".json", ".html", ".css"]);
const FORBIDDEN = [
  ["transaction submission", /\b(?:sendTransaction|sendRawTransaction|writeContract)\b/],
  ["raw Ethereum submission", /\beth_send(?:Raw)?Transaction\b/],
  ["transaction or bundle construction", /\b(?:signTransaction|serializeTransaction|prepareTransactionRequest|sendBundle)\b/],
  ["wallet client", /\b(?:createWalletClient|walletClient|privateKeyToAccount)\b/],
  ["funded-key environment", /\bPRIVATE_KEY\b|process\.env\.(?:MNEMONIC|SEED_PHRASE)/],
  ["credential literal", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["injected wallet", /(?:window|globalThis)\.ethereum\b/],
  ["peer or streaming network", /\b(?:WebSocket|EventSource|RTCPeerConnection)\b/],
  ["runtime network request", /\bfetch\s*\(|from\s+["']node:https?["']/],
];
const APPROVED_READ_ONLY_NETWORK_PROBES = new Set([
  "src/network/node-https.js",
]);

async function filesUnder(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(candidate));
    else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) files.push(candidate);
  }
  return files;
}

const files = [];
for (const root of ROOTS) {
  try {
    files.push(...await filesUnder(root));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const findings = [];
for (const file of files.sort()) {
  if (file === OUTPUT || file.endsWith("verify-safety.mjs")) continue;
  const text = await readFile(file, "utf8");
  for (const [rule, pattern] of FORBIDDEN) {
    if (file.endsWith("probe-running-client.mjs") && rule === "runtime network request") continue;
    if (APPROVED_READ_ONLY_NETWORK_PROBES.has(file.replaceAll("\\", "/")) && rule === "runtime network request") continue;
    if (pattern.test(text)) findings.push({ file: file.replaceAll("\\", "/"), rule });
  }
}

const boundedHttps = await readFile("src/network/node-https.js", "utf8");
const sepoliaProbe = await readFile("scripts/probe-sepolia-providers.mjs", "utf8");
const sidecarProbe = await readFile("scripts/probe-sepolia-sidecars.mjs", "utf8");
const sepoliaProbeChecks = {
  httpsOnly: boundedHttps.includes("spec.url.protocol !== 'https:'"),
  boundedTimeout: boundedHttps.includes("spec.timeoutMs > 15_000"),
  boundedResponse: boundedHttps.includes("spec.maxResponseBytes > 8_388_608"),
  noRedirectHandling: !boundedHttps.includes("redirect"),
  providerProbeUsesBoundedAdapter: sepoliaProbe.includes("boundedHttpsJson"),
  sidecarProbeUsesBoundedAdapter: sidecarProbe.includes("boundedHttpsJson"),
};
for (const [check, passed] of Object.entries(sepoliaProbeChecks)) {
  if (!passed) findings.push({ file: "src/network/node-https.js", rule: check });
}

const clientMain = await readFile("src/client/main.js", "utf8");
const renderingChecks = {
  decryptedMessageUsesTextContent: clientMain.includes("body.textContent = message.body"),
  evidenceDetailUsesTextContent: clientMain.includes("detail.textContent = item.detail"),
};
for (const [check, passed] of Object.entries(renderingChecks)) {
  if (!passed) findings.push({ file: "src/client/main.js", rule: check });
}

const report = {
  schema: "blobmail.safety-audit.v1",
  scope: ROOTS,
  guarantees: [
    "no transaction-submission API in project source",
    "no funded-key environment access in project source",
    "no credential-shaped literals in project source",
    "no wallet-injection access in project source",
    "no external runtime network or peer API in browser application source",
    "verification-network exceptions are the hard-coded 127.0.0.1 client probe and explicit bounded read-only Sepolia provider/sidecar probes",
  ],
  filesScanned: files.length,
  renderingChecks,
  sepoliaProbeChecks,
  findings,
  passed: findings.length === 0,
};

await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (findings.length) process.exitCode = 1;
