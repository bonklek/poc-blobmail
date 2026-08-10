import { ProtocolError, fail } from "./errors.js";

export function asBytes(value, name = "value") {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new ProtocolError("INVALID_TYPE", `${name} must be bytes`);
}

export function requireLength(value, length, name) {
  const bytes = asBytes(value, name);
  if (bytes.length !== length) {
    fail("INVALID_LENGTH", `${name} must be exactly ${length} bytes`, {
      actual: bytes.length,
      expected: length,
    });
  }
  return bytes;
}

export function concatBytes(...values) {
  const arrays = values.map((value) => asBytes(value));
  const output = new Uint8Array(arrays.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  for (const value of arrays) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

export function equalBytes(leftValue, rightValue) {
  const left = asBytes(leftValue);
  const right = asBytes(rightValue);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function compareBytes(leftValue, rightValue) {
  const left = asBytes(leftValue);
  const right = asBytes(rightValue);
  const common = Math.min(left.length, right.length);
  for (let index = 0; index < common; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

export function bytesToHex(value) {
  return Array.from(asBytes(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(value, name = "hex") {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    fail("INVALID_HEX", `${name} must be an even-length hexadecimal string`);
  }
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

export function readU16(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, false);
}

export function writeU16(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, false);
}

export function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

export function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, false);
}

export function requireMagic(actual, expected, name) {
  if (!equalBytes(actual, expected)) fail("INVALID_MAGIC", `${name} magic is not canonical`);
}

export function requireZero(bytes, name) {
  if (bytes.some((byte) => byte !== 0)) fail("NONZERO_RESERVED", `${name} must be zero`);
}
