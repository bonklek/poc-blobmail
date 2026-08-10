import { createPreviewAdapter } from "./adapter.js";
import { startBlobMailClient } from "./main.js";

startBlobMailClient({ adapter: createPreviewAdapter() });
