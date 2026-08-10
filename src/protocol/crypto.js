import { Aes128Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { asBytes, bytesToHex, concatBytes, requireLength } from "./bytes.js";
import { DOMAINS } from "./constants.js";
import { ProtocolError } from "./errors.js";

export const hpkeSuite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});

export async function sha256(value) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", asBytes(value));
  return new Uint8Array(digest);
}

export async function domainHash(domain, ...values) {
  return sha256(concatBytes(domain, ...values));
}

export async function identityId(publicKeyBytes) {
  const publicBytes = requireLength(publicKeyBytes, 32, "publicKeyBytes");
  return bytesToHex(await domainHash(DOMAINS.identity, publicBytes));
}

export async function deriveIdentity(seed) {
  let ikm;
  if (seed === undefined) {
    ikm = globalThis.crypto.getRandomValues(new Uint8Array(32));
  } else {
    ikm = requireLength(seed, 32, "identity seed");
  }
  const keyPair = await hpkeSuite.kem.deriveKeyPair(ikm);
  const publicKeyBytes = new Uint8Array(await hpkeSuite.kem.serializePublicKey(keyPair.publicKey));
  const privateKeyBytes = new Uint8Array(await hpkeSuite.kem.serializePrivateKey(keyPair.privateKey));
  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicKeyBytes,
    privateKeyBytes,
    identityId: await identityId(publicKeyBytes),
  };
}

export async function importIdentity({ publicKeyBytes, privateKeyBytes } = {}) {
  const publicBytes = requireLength(publicKeyBytes, 32, "publicKeyBytes");
  let publicKey;
  let privateKey;
  try {
    publicKey = await hpkeSuite.kem.deserializePublicKey(publicBytes);
    if (privateKeyBytes !== undefined) {
      privateKey = await hpkeSuite.kem.deserializePrivateKey(
        requireLength(privateKeyBytes, 32, "privateKeyBytes"),
      );
    }
  } catch (cause) {
    throw new ProtocolError("INVALID_KEY", "X25519 key material is invalid", undefined, cause);
  }
  return {
    publicKey,
    ...(privateKey === undefined ? {} : { privateKey }),
    publicKeyBytes: publicBytes.slice(),
    ...(privateKeyBytes === undefined
      ? {}
      : { privateKeyBytes: requireLength(privateKeyBytes, 32, "privateKeyBytes").slice() }),
    identityId: await identityId(publicBytes),
  };
}
