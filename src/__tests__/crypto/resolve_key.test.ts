import { afterEach, describe, expect, it, vi } from "vitest";
import { ECDSA, Wallet } from "xrpl";
import sodium from "../../crypto/sodium.js";
import { resolveRecipientKey } from "../../crypto/resolve_key.js";
import { signingKeyBelongsTo } from "../../chain/scanner.js";

const RPC = "http://rpc.test/";
// A real Ed25519 wallet so SigningPubKey -> address derivation is exercised
// for real; the recipient address is the wallet's own classic address.
const RECIPIENT_WALLET = Wallet.generate(ECDSA.ed25519);
const RECIPIENT = RECIPIENT_WALLET.classicAddress;
const RECIPIENT_SIGNING_PUBKEY = RECIPIENT_WALLET.publicKey; // "ED" + 64 hex

type Handler = (method: string, params: any) => any;

function mockRpc(handler: Handler): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body.method);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ result: handler(body.method, body.params?.[0] ?? {}) }),
      };
    })
  );
  return { calls };
}

function accountInfo(extra: Record<string, unknown> = {}) {
  return { account_data: { Balance: "1000000", ...extra } };
}

function signedTx(account: string, signingPubKey: string, validated = true) {
  return { tx: { Account: account, TransactionType: "Payment", SigningPubKey: signingPubKey }, validated };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveRecipientKey", () => {
  it("uses the on-chain MessageKey when present and never reads account_tx", async () => {
    await sodium.ready;
    const key = sodium.crypto_box_keypair().publicKey;
    const { calls } = mockRpc((method) => {
      if (method === "account_info") return accountInfo({ MessageKey: "ED" + Buffer.from(key).toString("hex").toUpperCase() });
      throw new Error(`unexpected ${method}`);
    });
    const resolved = await resolveRecipientKey(RPC, RECIPIENT);
    expect(Buffer.from(resolved)).toEqual(Buffer.from(key));
    expect(calls).toEqual(["account_info"]);
  });

  it("derives the X25519 key from the Ed25519 SigningPubKey of the recipient's latest signed transaction", async () => {
    await sodium.ready;
    const signingPubKey = RECIPIENT_SIGNING_PUBKEY;
    const expected = sodium.crypto_sign_ed25519_pk_to_curve25519(
      Buffer.from(signingPubKey.slice(2), "hex")
    );
    const { calls } = mockRpc((method, params) => {
      if (method === "account_info") return accountInfo({ RegularKey: "rSomeRegularKeyAddress" });
      if (method === "account_tx") {
        expect(params).toMatchObject({ account: RECIPIENT, forward: false });
        return {
          transactions: [
            // Newest first: a payment *to* the recipient (signed by someone else) must be skipped.
            signedTx("rSomeoneElse", "ED" + "11".repeat(32)),
            signedTx(RECIPIENT, signingPubKey),
            signedTx(RECIPIENT, "ED" + "22".repeat(32)),
          ],
        };
      }
      throw new Error(`unexpected ${method}`);
    });
    const resolved = await resolveRecipientKey(RPC, RECIPIENT);
    expect(Buffer.from(resolved)).toEqual(Buffer.from(expected));
    expect(calls).toEqual(["account_info", "account_tx"]);
  });

  it("never treats RegularKey (an address) as a key", async () => {
    mockRpc((method) => {
      if (method === "account_info") return accountInfo({ RegularKey: "r".padEnd(66, "9") });
      if (method === "account_tx") return { transactions: [] };
      throw new Error(`unexpected ${method}`);
    });
    await expect(resolveRecipientKey(RPC, RECIPIENT)).rejects.toThrow(/no transaction signed with its master key/);
  });

  it("explains a secp256k1 signer precisely", async () => {
    const secp = Wallet.generate(ECDSA.secp256k1);
    mockRpc((method) => {
      if (method === "account_info") return accountInfo();
      if (method === "account_tx") return { transactions: [signedTx(secp.classicAddress, secp.publicKey)] };
      throw new Error(`unexpected ${method}`);
    });
    await expect(resolveRecipientKey(RPC, secp.classicAddress)).rejects.toThrow(/secp256k1/);
  });

  it("skips RegularKey-signed transactions and uses the master key", async () => {
    await sodium.ready;
    const regular = Wallet.generate(ECDSA.ed25519); // the delegated signer's key
    const expected = sodium.crypto_sign_ed25519_pk_to_curve25519(
      Buffer.from(RECIPIENT_SIGNING_PUBKEY.slice(2), "hex")
    );
    const { calls } = mockRpc((method) => {
      if (method === "account_info") return accountInfo({ RegularKey: regular.classicAddress });
      if (method === "account_tx")
        return {
          transactions: [
            // Newest: signed via the RegularKey; its SigningPubKey derives to the regular key's address.
            signedTx(RECIPIENT, regular.publicKey),
            // Older: signed with the master key.
            signedTx(RECIPIENT, RECIPIENT_SIGNING_PUBKEY),
          ],
        };
      throw new Error(`unexpected ${method}`);
    });
    const resolved = await resolveRecipientKey(RPC, RECIPIENT);
    expect(Buffer.from(resolved)).toEqual(Buffer.from(expected));
    expect(calls).toEqual(["account_info", "account_tx"]);
    expect(signingKeyBelongsTo(regular.publicKey, RECIPIENT)).toBe(false);
    expect(signingKeyBelongsTo(RECIPIENT_SIGNING_PUBKEY, RECIPIENT)).toBe(true);
  });

  it("treats an account with only RegularKey-signed or multi-signed transactions as having no master-signed one", async () => {
    const regular = Wallet.generate(ECDSA.ed25519);
    mockRpc((method) => {
      if (method === "account_info") return accountInfo({ RegularKey: regular.classicAddress });
      if (method === "account_tx")
        return { transactions: [signedTx(RECIPIENT, regular.publicKey), signedTx(RECIPIENT, "")] }; // "" = multi-signed
      throw new Error(`unexpected ${method}`);
    });
    await expect(resolveRecipientKey(RPC, RECIPIENT)).rejects.toThrow(/no transaction signed with its master key/);
  });

  it("explains an account with no signed transaction precisely", async () => {
    mockRpc((method) => {
      if (method === "account_info") return accountInfo();
      if (method === "account_tx") return { transactions: [signedTx("rSomeoneElse", "ED" + "11".repeat(32))] };
      throw new Error(`unexpected ${method}`);
    });
    await expect(resolveRecipientKey(RPC, RECIPIENT)).rejects.toThrow(/no transaction signed with its master key/);
  });

  it("skips unvalidated transactions when looking for the signing key", async () => {
    await sodium.ready;
    const signingPubKey = RECIPIENT_SIGNING_PUBKEY;
    const expected = sodium.crypto_sign_ed25519_pk_to_curve25519(
      Buffer.from(signingPubKey.slice(2), "hex")
    );
    mockRpc((method) => {
      if (method === "account_info") return accountInfo();
      if (method === "account_tx")
        return { transactions: [signedTx(RECIPIENT, "ED" + "33".repeat(32), false), signedTx(RECIPIENT, signingPubKey)] };
      throw new Error(`unexpected ${method}`);
    });
    const resolved = await resolveRecipientKey(RPC, RECIPIENT);
    expect(Buffer.from(resolved)).toEqual(Buffer.from(expected));
  });

  it("rejects a malformed MessageKey instead of silently using a short key", async () => {
    mockRpc((method) => {
      if (method === "account_info") return accountInfo({ MessageKey: "ED" + "ab".repeat(16) });
      throw new Error(`unexpected ${method}`);
    });
    await expect(resolveRecipientKey(RPC, RECIPIENT)).rejects.toThrow(/Invalid MessageKey/);
  });
});
