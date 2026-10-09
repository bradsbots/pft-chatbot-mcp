import { afterEach, describe, expect, it, vi } from "vitest";
import sodium from "../../crypto/sodium.js";
import { resolveRecipientKey } from "../../crypto/resolve_key.js";

const RPC = "http://rpc.test/";
const RECIPIENT = "rRecipientAddress";

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
    const signer = sodium.crypto_sign_keypair();
    const signingPubKey = "ED" + Buffer.from(signer.publicKey).toString("hex").toUpperCase();
    const expected = sodium.crypto_sign_ed25519_pk_to_curve25519(signer.publicKey);
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
    await expect(resolveRecipientKey(RPC, RECIPIENT)).rejects.toThrow(/no signed transaction/);
  });

  it("explains a secp256k1 signer precisely", async () => {
    mockRpc((method) => {
      if (method === "account_info") return accountInfo();
      if (method === "account_tx") return { transactions: [signedTx(RECIPIENT, "02" + "ab".repeat(32))] };
      throw new Error(`unexpected ${method}`);
    });
    await expect(resolveRecipientKey(RPC, RECIPIENT)).rejects.toThrow(/secp256k1/);
  });

  it("explains an account with no signed transaction precisely", async () => {
    mockRpc((method) => {
      if (method === "account_info") return accountInfo();
      if (method === "account_tx") return { transactions: [signedTx("rSomeoneElse", "ED" + "11".repeat(32))] };
      throw new Error(`unexpected ${method}`);
    });
    await expect(resolveRecipientKey(RPC, RECIPIENT)).rejects.toThrow(/no signed transaction in its recent history/);
  });

  it("skips unvalidated transactions when looking for the signing key", async () => {
    await sodium.ready;
    const signer = sodium.crypto_sign_keypair();
    const signingPubKey = "ED" + Buffer.from(signer.publicKey).toString("hex").toUpperCase();
    const expected = sodium.crypto_sign_ed25519_pk_to_curve25519(signer.publicKey);
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
