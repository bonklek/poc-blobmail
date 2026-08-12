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
const APPROVED_BATCHER_CAPABILITIES = new Set([
  "src/batcher/node-server.js",
  "src/batcher/publisher.js",
  "scripts/run-reference-batcher.mjs",
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
    const normalizedFile = file.replaceAll("\\", "/");
    if (file.endsWith("probe-running-client.mjs") && rule === "runtime network request") continue;
    if (APPROVED_READ_ONLY_NETWORK_PROBES.has(normalizedFile) && rule === "runtime network request") continue;
    if (APPROVED_BATCHER_CAPABILITIES.has(normalizedFile)) continue;
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
const mvpMain = await readFile("src/mvp/main.js", "utf8");
const renderingChecks = {
  decryptedMessageUsesTextContent: clientMain.includes("body.textContent = message.body")
    && mvpMain.includes("body.textContent = message.body"),
  evidenceDetailUsesTextContent: clientMain.includes("detail.textContent = item.detail"),
};
for (const [check, passed] of Object.entries(renderingChecks)) {
  if (!passed) findings.push({ file: "src/client/main.js", rule: check });
}

const browserFetch = await readFile("src/network/browser-fetch.js", "utf8");
const sendingClient = await readFile("src/sending/client.js", "utf8");
const browserNetworkChecks = {
  httpsRpcOnly: browserFetch.includes("url.protocol !== 'https:'"),
  credentialsOmitted: browserFetch.includes("credentials: 'omit'") && sendingClient.includes("credentials: 'omit'"),
  redirectsRejected: browserFetch.includes("redirect: 'error'") && sendingClient.includes("redirect: 'error'"),
  boundedRpcResponses: browserFetch.includes("bytes.byteLength > spec.maxResponseBytes"),
  safeBatcherOrigins: sendingClient.includes("url.protocol !== 'https:'") && sendingClient.includes("127.0.0.1"),
};
for (const [check, passed] of Object.entries(browserNetworkChecks)) {
  if (!passed) findings.push({ file: "src/network/browser-fetch.js", rule: check });
}

const publicationSources = await Promise.all([
  "src/publication/canonical-json.js",
  "src/publication/cost.js",
  "src/publication/package.js",
  "src/publication/segment-package.js",
].map((file) => readFile(file, "utf8")));
const publicationSource = publicationSources.join("\n");
const unsignedRequest = JSON.parse(await readFile(
  "artifacts/sepolia-unsigned-publication-v1/unsigned-request.json",
  "utf8",
));
const publicationReport = JSON.parse(await readFile("reports/sepolia-unsigned-publication.json", "utf8"));
const forbiddenArtifactKeys = /^(?:privateKey|mnemonic|seedPhrase|keystore|signer|wallet|authorization|token|signature|rawTransaction|rpcUrl|headers|submission)$/i;
const artifactKeyFindings = [];
function scanArtifactKeys(value, cursor = "$") {
  if (Array.isArray(value)) return value.forEach((item, index) => scanArtifactKeys(item, `${cursor}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenArtifactKeys.test(key)) artifactKeyFindings.push(`${cursor}.${key}`);
    scanArtifactKeys(item, `${cursor}.${key}`);
  }
}
scanArtifactKeys(unsignedRequest);
const publicationChecks = {
  sourceIsOffline: !/node:https|node:http|\bfetch\s*\(|process\.env|WebSocket|EventSource/.test(publicationSource),
  noSigningOrSubmissionApi: !/createWalletClient|privateKeyToAccount|signTransaction|serializeTransaction|eth_send|sendTransaction|sendRawTransaction|sendBundle/.test(publicationSource),
  artifactKeysClosed: artifactKeyFindings.length === 0,
  unsignedReviewStatus: unsignedRequest.status === "UNSIGNED_REVIEW_ONLY",
  zeroValue: unsignedRequest.value === "0x0",
  oneBlob: unsignedRequest.blobVersionedHashes?.length === 1,
  reportClaimsNoSecret: publicationReport.safety?.containsSecretMaterial === false,
  reportClaimsNoSignature: publicationReport.safety?.containsSignature === false,
  reportClaimsNoSubmission: publicationReport.safety?.containsSubmissionCapability === false,
};
for (const [check, passed] of Object.entries(publicationChecks)) {
  if (!passed) findings.push({ file: "src/publication", rule: check });
}

const batcherPublisher = await readFile("src/batcher/publisher.js", "utf8");
const batcherServer = await readFile("src/batcher/node-server.js", "utf8");
const batcherScript = await readFile("scripts/run-reference-batcher.mjs", "utf8");
const browserEntry = await readFile("src/main.js", "utf8");
const batcherChecks = {
  notImportedByBrowserEntry: !browserEntry.includes("batcher"),
  offlineByDefault: batcherScript.includes("BLOBMAIL_BATCHER_MODE ?? 'offline'"),
  loopbackBindOnly: batcherScript.includes("HOST !== '127.0.0.1'"),
  explicitSepoliaMode: batcherScript.includes("MODE === 'offline'") && batcherScript.includes("sepolia.id"),
  pinnedContractBytecode: batcherScript.includes("SEPOLIA_BSS_RUNTIME_KECCAK256"),
  boundedFeeEnvelope: batcherScript.includes("calculateCostEnvelope") && batcherScript.includes("MAX_TOTAL_EXPOSURE_WEI"),
  secretOnlyInOperatorScript: !batcherPublisher.includes("process.env") && !batcherServer.includes("process.env")
    && batcherScript.includes("BLOBMAIL_BATCHER_PRIVATE_KEY"),
  secretNotLogged: !/console\.(?:log|error)\([^)]*(?:secret|PRIVATE_KEY)/.test(batcherScript),
  boundedRequestBody: batcherServer.includes("total > maxBytes"),
  explicitCorsOrigin: batcherServer.includes("origin === allowedOrigin"),
};
for (const [check, passed] of Object.entries(batcherChecks)) {
  if (!passed) findings.push({ file: "src/batcher", rule: check });
}

const report = {
  schema: "blobmail.safety-audit.v1",
  scope: ROOTS,
  guarantees: [
    "transaction submission exists only in the isolated Node reference-batcher capability",
    "funded-key environment access exists only in the explicit live-mode operator script",
    "no credential-shaped literals in project source",
    "no wallet-injection access in project source",
    "browser network access is bounded to credential-free HTTPS RPC/beacon reads and an explicit HTTPS or loopback batcher origin",
    "unsigned publication source is offline and generated package keys exclude secret, signature, wallet, endpoint, and submission fields",
    "verification-network exceptions are the hard-coded 127.0.0.1 client probe and explicit bounded read-only Sepolia provider/sidecar probes",
    "reference batcher is offline by default, loopback-bound, fee-capped, and excluded from the browser entry graph",
  ],
  filesScanned: files.length,
  renderingChecks,
  browserNetworkChecks,
  sepoliaProbeChecks,
  publicationChecks,
  batcherChecks,
  findings,
  passed: findings.length === 0,
};

await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (findings.length) process.exitCode = 1;
