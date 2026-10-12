import { afterEach, describe, expect, it, vi } from "vitest";
import { scanMessages } from "../../chain/scanner.js";
import { executeScanMessages } from "../../tools/scan_messages.js";
import type { BotKeypair } from "../../crypto/keys.js";
import { buildPfPointerMemo } from "../../chain/pointer.js";
import type { Config } from "../../config.js";

const BOT = "rBotAddress";
const PEER = "rPeerAddress";
const config = { pftlRpcUrl: "http://rpc.test/" } as unknown as Config;

async function chatTx(ledger: number, n: number, sender = PEER) {
  const memo = await buildPfPointerMemo({ cid: `bafy-${ledger}-${n}`, kind: "CHAT", flags: 0 });
  return {
    tx: {
      TransactionType: "Payment",
      Account: sender,
      Destination: sender === BOT ? PEER : BOT,
      Amount: "1000000",
      hash: `HASH-${ledger}-${n}`,
      date: 800000000,
      Memos: [{ Memo: { MemoType: memo.memoTypeHex, MemoFormat: memo.memoFormatHex, MemoData: memo.memoDataHex } }],
    },
    meta: { TransactionResult: "tesSUCCESS" },
    ledger_index: ledger,
  };
}

/** A successful transaction that is not a chat message (no memo). */
function plainTx(ledger: number, n: number, type = "Payment") {
  return {
    tx: { TransactionType: type, Account: PEER, Destination: BOT, Amount: "1", hash: `PLAIN-${ledger}-${n}` },
    meta: { TransactionResult: "tesSUCCESS" },
    ledger_index: ledger,
  };
}

/** A Payment carrying a pf.ptr memo whose data cannot be decoded. */
async function garbledTx(ledger: number, n: number) {
  const t = await chatTx(ledger, n);
  t.tx.Memos[0].Memo.MemoData = "ff";
  t.tx.hash = `GARBLED-${ledger}-${n}`;
  return t;
}

/** Mock fetch serving account_tx pages; records each request's params. */
function mockAccountTx(pages: Array<{ transactions: any[]; marker?: unknown }>) {
  const requests: any[] = [];
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.method).toBe("account_tx");
      requests.push(body.params[0]);
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ result: page }) };
    })
  );
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scanMessages paging", () => {
  it("requests newest-first without a cursor and oldest-first with one", async () => {
    const requests = mockAccountTx([{ transactions: [] }]);
    await scanMessages(config, BOT, {});
    await scanMessages(config, BOT, { sinceLedger: 500 });
    expect(requests[0]).toMatchObject({ account: BOT, limit: 100, forward: false });
    expect(requests[0].ledger_index_min).toBeUndefined();
    expect(requests[1]).toMatchObject({ account: BOT, limit: 100, forward: true, ledger_index_min: 500 });
  });

  it("follows the marker across pages up to the limit and reports no truncation when exhausted", async () => {
    const page1 = [await chatTx(501, 1), await chatTx(502, 1)];
    const page2 = [await chatTx(503, 1)];
    const requests = mockAccountTx([
      { transactions: page1, marker: { ledger: 502, seq: 1 } },
      { transactions: page2 },
    ]);
    const result = await scanMessages(config, BOT, { sinceLedger: 500, limit: 10 });
    expect(result.truncated).toBe(false);
    expect(result.messages.map((m) => m.txHash)).toEqual(["HASH-501-1", "HASH-502-1", "HASH-503-1"]);
    expect(requests).toHaveLength(2);
    expect(requests[0].marker).toBeUndefined();
    expect(requests[0].limit).toBe(10);
    expect(requests[1].marker).toEqual({ ledger: 502, seq: 1 });
    expect(requests[1].limit).toBe(8); // only the remainder of the limit is requested
  });

  it("stops at the limit and reports truncation when the node still has more", async () => {
    const page1 = [await chatTx(501, 1), await chatTx(502, 1)];
    const requests = mockAccountTx([{ transactions: page1, marker: { ledger: 502, seq: 1 } }]);
    const result = await scanMessages(config, BOT, { sinceLedger: 500, limit: 2 });
    expect(result.truncated).toBe(true);
    expect(result.messages).toHaveLength(2);
    expect(requests).toHaveLength(1);
  });

  it("never fetches more than ten pages", async () => {
    const tx = await chatTx(600, 1);
    const requests = mockAccountTx([{ transactions: [tx], marker: { more: true } }]);
    const result = await scanMessages(config, BOT, { sinceLedger: 500, limit: 100 });
    expect(requests).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.messages).toHaveLength(10);
  });
});

describe("scanMessages raw-window cursor metadata", () => {
  it("reports the last scanned ledger from non-message and undecodable transactions", async () => {
    mockAccountTx([
      {
        transactions: [plainTx(601, 1, "TrustSet"), await garbledTx(605, 1), plainTx(612, 1)],
        marker: { ledger: 612, seq: 1 },
      },
    ]);
    const result = await scanMessages(config, BOT, { sinceLedger: 500, limit: 3 });
    expect(result.messages).toHaveLength(0);
    expect(result.truncated).toBe(true);
    expect(result.lastScannedLedger).toBe(612);
  });

  it("counts non-message transactions after an earlier message", async () => {
    mockAccountTx([{ transactions: [await chatTx(501, 1), plainTx(520, 1), plainTx(540, 1, "OfferCreate")] }]);
    const result = await scanMessages(config, BOT, { sinceLedger: 500 });
    expect(result.messages.map((m) => m.ledgerIndex)).toEqual([501]);
    expect(result.lastScannedLedger).toBe(540);
  });

  it("is null when the window is empty", async () => {
    mockAccountTx([{ transactions: [] }]);
    const result = await scanMessages(config, BOT, { sinceLedger: 500 });
    expect(result.lastScannedLedger).toBeNull();
  });
});

describe("scan_messages cursor across account_tx pages (end to end)", () => {
  const keypair = { address: BOT } as unknown as BotKeypair;

  it("advances past a full page with no decodable messages and reaches the message after it", async () => {
    const requests = mockAccountTx([
      { transactions: [plainTx(501, 1), await garbledTx(503, 1)], marker: { ledger: 503, seq: 1 } },
      { transactions: [await chatTx(504, 1)] },
    ]);
    const first = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500, limit: 2 }));
    expect(first.count).toBe(0);
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toBe(503);
    const second = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: first.next_cursor, limit: 2 }));
    expect(requests[1].ledger_index_min).toBe(503);
    expect(second.messages.map((m: any) => m.tx_hash)).toEqual(["HASH-504-1"]);
  });

  it("keeps the rest of a ledger reachable when the marker stops partway through it", async () => {
    // Ledger 502 holds three messages; a limit of 2 stops after 501 and 502#1.
    const requests = mockAccountTx([
      { transactions: [await chatTx(501, 1), await chatTx(502, 1)], marker: { ledger: 502, seq: 1 } },
      { transactions: [await chatTx(502, 1), await chatTx(502, 2), await chatTx(502, 3)] },
    ]);
    const first = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500, limit: 2 }));
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toBe(502);
    const second = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: first.next_cursor, limit: 10 }));
    expect(requests[1].ledger_index_min).toBe(502);
    const seen = new Set([...first.messages, ...second.messages].map((m: any) => m.tx_hash));
    expect([...seen].sort()).toEqual(["HASH-501-1", "HASH-502-1", "HASH-502-2", "HASH-502-3"]);
    expect(second.truncated).toBe(false);
    expect(second.next_cursor).toBe(503);
  });
});
