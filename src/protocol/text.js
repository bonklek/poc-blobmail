import {
  MAGIC,
  MAX_TEXT_BYTES,
  PADDED_PLAINTEXT_SIZE,
  PROTOCOL_VERSION,
  TEXT_KIND,
} from "./constants.js";
import { asBytes, requireLength, requireMagic, requireZero, readU16, writeU16 } from "./bytes.js";
import { fail } from "./errors.js";

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const TEXT_OFFSET = 8;

export function encodePaddedText(text) {
  if (typeof text !== "string") fail("INVALID_TEXT", "text must be a string");
  const normalized = text.normalize("NFC");
  const message = encoder.encode(normalized);
  if (message.length === 0) fail("EMPTY_TEXT", "text must not be empty");
  if (message.length > MAX_TEXT_BYTES) {
    fail("TEXT_TOO_LARGE", `UTF-8 text exceeds ${MAX_TEXT_BYTES} bytes`, {
      actual: message.length,
      maximum: MAX_TEXT_BYTES,
    });
  }
  const output = new Uint8Array(PADDED_PLAINTEXT_SIZE);
  output.set(MAGIC.plaintext, 0);
  output[4] = PROTOCOL_VERSION;
  output[5] = TEXT_KIND;
  writeU16(output, 6, message.length);
  output.set(message, TEXT_OFFSET);
  return output;
}

export function decodePaddedText(value) {
  const bytes = requireLength(value, PADDED_PLAINTEXT_SIZE, "padded plaintext");
  requireMagic(bytes.subarray(0, 4), MAGIC.plaintext, "plaintext");
  if (bytes[4] !== PROTOCOL_VERSION) fail("UNKNOWN_PLAINTEXT_VERSION", "unsupported plaintext version");
  if (bytes[5] !== TEXT_KIND) fail("UNKNOWN_CONTENT_KIND", "only canonical text content is supported");
  const length = readU16(bytes, 6);
  if (length === 0 || length > MAX_TEXT_BYTES) fail("INVALID_TEXT_LENGTH", "text length is out of bounds");
  requireZero(bytes.subarray(TEXT_OFFSET + length), "plaintext padding");
  const plaintextBytes = asBytes(bytes.subarray(TEXT_OFFSET, TEXT_OFFSET + length)).slice();
  let text;
  try {
    text = fatalDecoder.decode(plaintextBytes);
  } catch (cause) {
    fail("INVALID_UTF8", "text bytes are not valid UTF-8", { cause: cause?.message });
  }
  if (text.normalize("NFC") !== text) fail("NON_CANONICAL_TEXT", "text must use NFC normalization");
  return { text, plaintextBytes };
}
