import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

const REPORTS = "reports";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function artifact(path) {
  await access(path);
  return { path: path.replaceAll("\\", "/"), sha256: await sha256(path) };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

await mkdir(REPORTS, { recursive: true });

const junit = await readFile(`${REPORTS}/test-results.xml`, "utf8");
const testCount = [...junit.matchAll(/<testcase\b/g)].length;
const failureCount = [...junit.matchAll(/<(?:failure|error)\b/g)].length;
if (testCount < 36 || failureCount !== 0) {
  throw new Error(`test receipt is not green: ${testCount} tests, ${failureCount} failures/errors`);
}

const safety = await readJson(`${REPORTS}/safety-audit.json`);
if (!safety.passed) throw new Error("safety audit is not green");
const milxdy = await readJson(`${REPORTS}/milxdy-package-verification.json`);
if (milxdy.result !== "PASS") throw new Error("milXdy package verification is not green");
const milxdyBundleDigest = await sha256("examples/milxdy-blobmail/dist/content.js");
if (milxdyBundleDigest !== milxdy.build.contentEntrySha256) {
  throw new Error("milXdy bundle digest differs from its verification receipt");
}
await access("dist/index.html");
const devProbe = await readJson(`${REPORTS}/dev-server-probe.json`);
if (!devProbe.passed) throw new Error("running-client probe is not green");

const generatedAt = devProbe.generatedAt;
const testReceipt = await artifact(`${REPORTS}/test-results.xml`);
const vector = await artifact("vectors/blobmail-v0.json");

const protocol = {
  schema: "blobmail.protocol-core-tests.v1",
  generatedAt,
  result: "PASS",
  command: "pnpm run test:receipt",
  tests: testCount,
  failures: failureCount,
  coverage: [
    "deterministic HPKE vectors and independent HPKE reproduction",
    "canonical text, entry, and batch encodings",
    "recipient scan and authenticated decryption",
    "corruption, duplicate, reorder, version, bounds, and strict UTF-8 rejection",
  ],
  artifacts: [
    testReceipt,
    vector,
    await artifact("vectors/manifest.json"),
    await artifact("docs/core-protocol-v0.md"),
    await artifact("reports/crypto-encoding-probe.json"),
  ],
};
await writeJson(`${REPORTS}/protocol-core-tests.json`, protocol);

const browserQa = await readJson(`${REPORTS}/browser-client-qa.json`);
const browser = {
  schema: "blobmail.browser-loopback.v1",
  generatedAt,
  result: "PASS_WITH_VISUAL_BACKEND_UNAVAILABLE",
  localUrl: devProbe.origin,
  execution: {
    clientEntry: "/src/main.js",
    transport: "in-memory EIP-4844-shaped fixture",
    automatedDomIntegration: true,
    devServerHttpProbe: true,
    visualBackend: "unavailable; no visual-pass claim",
  },
  evidenceOrder: [
    "LOCAL_BATCH_CREATED",
    "BATCH_RECONSTRUCTED",
    "PAYLOAD_SHA256_VERIFIED",
    "ENTRY_BYTES_VERIFIED",
    "DECRYPTED",
  ],
  negativeClaims: {
    broadcast: false,
    chainIncluded: false,
    kzgProofVerified: false,
    senderAuthenticated: false,
  },
  checks: {
    fullSuiteTests: testCount,
    fullSuiteFailures: failureCount,
    localHttp: devProbe.checks,
    browserVisualProbe: browserQa.checks.find(({ name }) => name.includes("visual"))?.result ?? "unavailable",
  },
  scenarios: {
    reviewedComposeToDecrypt: {
      result: "pass",
      evidence: "test/client-dom-integration.test.mjs",
    },
    restartPersistence: {
      result: "pass",
      evidence: "the DOM integration reboots the client against the same bounded localStorage fixture",
    },
    duplicateRejection: {
      result: "pass",
      evidence: "test/protocol-v0.test.mjs canonical batch duplicate case",
    },
    corruptFixtureRejection: {
      result: "pass",
      evidence: "protocol and transport corruption cases execute in the same browser-bundled modules",
    },
    unsupportedInputRejection: {
      result: "pass",
      evidence: "client adapter/state tests reject invalid bytes, invalid UTF-8, and oversized text",
    },
  },
  artifacts: [
    testReceipt,
    await artifact("reports/dev-server-probe.json"),
    await artifact("test/client-dom-integration.test.mjs"),
    await artifact("test/integration-loopback.test.mjs"),
    await artifact("src/integration/loopback.js"),
    await artifact("src/main.js"),
  ],
};
await writeJson(`${REPORTS}/browser-loopback.json`, browser);

const adversarial = {
  schema: "blobmail.sprint-0-adversarial.v1",
  generatedAt,
  result: "PASS",
  command: "pnpm run test:receipt && pnpm run audit:safety",
  cases: {
    corrupt: ["entry commitment", "batch commitment", "field-element prefix", "HPKE ciphertext"],
    oversized: ["UTF-8 text", "entry count", "blob count", "serialized client state"],
    duplicate: ["entry ID", "sidecar versioned hash"],
    reordered: ["canonical batch entries", "manifest sidecars"],
    unknownVersion: ["plaintext", "entry", "batch", "stored client state"],
    wrongRecipient: ["recipient scan", "exporter tag mismatch"],
    unsafeCapability: safety.guarantees,
  },
  expectedOutcomes: [
    {
      case: "missing or duplicate sidecar",
      outcome: "reject before SIDECARS_MATCHED and emit no reconstruction/decryption claim",
    },
    {
      case: "reordered manifest sidecars",
      outcome: "restore manifest order only after commitment-derived versioned-hash matching",
    },
    {
      case: "corrupt batch, entry, field prefix, tag, or ciphertext",
      outcome: "reject at the failing integrity stage and never emit DECRYPTED",
    },
    {
      case: "duplicate or noncanonical entry order",
      outcome: "reject canonical batch parsing and emit no entry-verified state",
    },
    {
      case: "oversized or unknown-version input",
      outcome: "fail closed before persistence or cryptographic success evidence",
    },
    {
      case: "corrupt or oversized browser storage",
      outcome: "discard the invalid state or bounded inbox without broad storage deletion",
    },
    {
      case: "browser client restart",
      outcome: "restore only allowlisted bounded state and retain no key or wallet authority",
    },
  ],
  tests: testCount,
  failures: failureCount,
  safetyFindings: safety.findings.length,
  artifacts: [testReceipt, await artifact(`${REPORTS}/safety-audit.json`)],
};
await writeJson(`${REPORTS}/sprint-0-adversarial.json`, adversarial);

const required = [
  "README.md",
  "docs/SPRINT_0_AGENT_PROMPT.md",
  "docs/core-protocol-v0.md",
  "docs/rfe-transport-provenance.md",
  "docs/milxdy-adapter-boundary.md",
  "docs/sprint-0-handoff.md",
  "vectors/blobmail-v0.json",
  "vectors/manifest.json",
  "reports/planning-authority.json",
  "reports/crypto-encoding-probe.json",
  "reports/no-broadcast-audit.json",
  "reports/protocol-core-tests.json",
  "reports/browser-loopback.json",
  "reports/sprint-0-adversarial.json",
  "reports/safety-audit.json",
  "reports/dev-server-probe.json",
  "dist/index.html",
];
required.push(
  "reports/milxdy-package-verification.json",
  "examples/milxdy-blobmail/milxdy.app.json",
  "examples/milxdy-blobmail/dist/content.js",
);

const acceptance = {
  schema: "blobmail.sprint-0-acceptance.v1",
  generatedAt,
  result: "PASS",
  issue: "https://github.com/bonklek/blobmail/issues/3",
  branch: "codex/3-blobmail-loopback",
  commands: ["pnpm install --frozen-lockfile", "pnpm verify", "pnpm dev", "pnpm probe:client"],
  outcomes: {
    deterministicProtocolCore: true,
    independentVerifier: true,
    publicRfeTransportAdaptation: true,
    firstPassBrowserClient: true,
    verifiedLocalLoopback: true,
    boundedLocalPersistence: true,
    milxdyAdapterBoundary: true,
    milxdyFixturePackage: true,
    adversarialSuite: true,
  },
  limits: [
    "local fixtures only",
    "no transaction or bundle construction/submission",
    "no wallet, signing, funded key, or secret",
    "no live sidecar retrieval or network transport",
    "no KZG-proof or chain-inclusion claim",
    "HPKE base mode does not authenticate the selected sender",
    "no production privacy, settlement, delivery, read, or acknowledgement claim",
  ],
  tests: { total: testCount, failures: failureCount },
  safety: { passed: safety.passed, findings: safety.findings.length },
  artifacts: await Promise.all(required.map(artifact)),
};
await writeJson(`${REPORTS}/sprint-0-acceptance.json`, acceptance);

console.log(JSON.stringify({
  result: "PASS",
  tests: testCount,
  reports: [
    "reports/protocol-core-tests.json",
    "reports/browser-loopback.json",
    "reports/sprint-0-adversarial.json",
    "reports/sprint-0-acceptance.json",
  ],
}, null, 2));
