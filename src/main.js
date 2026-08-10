import { createClientAdapter } from "./client/adapter.js";
import { startBlobMailClient } from "./client/main.js";
import "./client/styles.css";
import { executeLoopback } from "./integration/loopback.js";

const adapter = createClientAdapter({
  executeLoopback,
  runtimeLabel: "Verified local BlobMail loopback",
});

startBlobMailClient({ adapter });
