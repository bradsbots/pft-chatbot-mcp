import sodium from "./sodium.js";
import { fetchLatestSigningPubKey, getAccountInfo } from "../chain/scanner.js";

const X25519_KEY_LENGTH = 32;
const ED25519_PREFIX = "ED";

function stripEdPrefix(hex: string): string {
  if (hex.length === 66 && hex.toUpperCase().startsWith("ED")) {
    return hex.slice(2);
  }
  return hex;
}

function assertKeyLength(key: Uint8Array, source: string, address: string): void {
  if (key.length !== X25519_KEY_LENGTH) {
    throw new Error(
      `Invalid ${source} for ${address}: expected ${X25519_KEY_LENGTH} bytes, got ${key.length}. ` +
        "The on-chain key may be malformed."
    );
  }
}

/**
 * Resolve the recipient's X25519 public key for encryption.
 *
 * Tries, in order:
 *   1. the account's on-chain `MessageKey` (set by `register_bot`);
 *   2. the Ed25519 `SigningPubKey` from the most recent transaction the
 *      account signed, converted to X25519.
 *
 * `account_info` itself carries no signing key (and `RegularKey` is an
 * address), so the second path reads `account_tx`, taking only a
 * `SigningPubKey` that derives to the recipient's own address (a
 * RegularKey-signed transaction carries the delegated key, whose X25519
 * counterpart the recipient's wallet seed cannot produce). A secp256k1
 * signing key cannot be converted; that case and an account with no
 * master-signed transaction each fail with a precise reason.
 */
export async function resolveRecipientKey(
  rpcUrl: string,
  recipientAddress: string
): Promise<Uint8Array> {
  await sodium.ready;

  const info = await getAccountInfo(rpcUrl, recipientAddress);

  if (info.messageKey) {
    const keyHex = stripEdPrefix(info.messageKey);
    const key = Buffer.from(keyHex, "hex");
    assertKeyLength(key, "MessageKey", recipientAddress);
    return key;
  }

  const signingKey = await fetchLatestSigningPubKey(rpcUrl, recipientAddress);
  if (signingKey == null) {
    throw new Error(
      `Cannot resolve encryption key for ${recipientAddress}: the account has no ` +
        `MessageKey set and no transaction signed with its master key in its recent history ` +
        `to derive a key from (RegularKey-signed and multi-signed transactions do not count). ` +
        `Ask the recipient to register (set a MessageKey) first.`
    );
  }
  if (!signingKey.toUpperCase().startsWith(ED25519_PREFIX)) {
    throw new Error(
      `Cannot resolve encryption key for ${recipientAddress}: the account has no ` +
        `MessageKey set and signs with a secp256k1 key, which cannot be converted to X25519. ` +
        `Ask the recipient to register (set a MessageKey) first.`
    );
  }
  const ed25519Pubkey = Buffer.from(stripEdPrefix(signingKey), "hex");
  assertKeyLength(ed25519Pubkey, "SigningPubKey", recipientAddress);
  const curve25519Key = sodium.crypto_sign_ed25519_pk_to_curve25519(ed25519Pubkey);
  assertKeyLength(curve25519Key, "derived X25519 key", recipientAddress);
  return curve25519Key;
}
