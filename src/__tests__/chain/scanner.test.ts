import { afterEach, describe, expect, it, vi } from "vitest";
import { scanMessages } from "../../chain/scanner.js";
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
