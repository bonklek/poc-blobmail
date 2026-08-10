export class ProtocolError extends Error {
  constructor(code, message, details = undefined, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProtocolError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function fail(code, message, details) {
  throw new ProtocolError(code, message, details);
}
