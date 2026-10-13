import { afterEach, describe, expect, it, vi } from "vitest";
import { scanMessages } from "../../chain/scanner.js";
import { executeScanMessages, encodeCursorToken } from "../../tools/scan_messages.js";
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

/**
 * A fake rippled account_tx that honours forward, ledger_index_min, limit and
 * marker the way rippled does: pages are oldest-first with `forward: true`,
 * non-admin limits are clamped to [10, 400] (Tuning.h kAccountTx), `maxPage`
 * lets a page come back shorter than asked, the marker is {ledger, seq} of
 * the next unread transaction, and an unknown marker is an error.
 */
function fakeNode(ledgers: Array<[number, number]>, opts: { maxPage?: number } = {}) {
  const all: Array<{ ledger: number; seq: number; entry: any }> = [];
  for (const [ledger, count] of ledgers) {
    for (let seq = 0; seq < count; seq++) {
      all.push({ ledger, seq, entry: plainTx(ledger, seq) });
    }
  }
  const requests: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: any) => {
      const p = JSON.parse(init.body).params[0];
      requests.push(p);
      expect(p.forward).toBe(true);
      const window = all.filter((t) => t.ledger >= (p.ledger_index_min ?? 0));
      let start = 0;
      if (p.marker !== undefined) {
        start = window.findIndex((t) => t.ledger === p.marker?.ledger && t.seq === p.marker?.seq);
        if (start < 0) {
          return { ok: true, json: async () => ({ result: { error: "invalidParams", error_message: "invalid marker" } }) };
        }
      }
      const size = Math.min(Math.max(10, Math.min(400, p.limit)), opts.maxPage ?? Infinity);
      const page = window.slice(start, start + size);
      const next = window[start + size];
      return {
        ok: true,
        json: async () => ({
          result: { transactions: page.map((t) => t.entry), ...(next ? { marker: { ledger: next.ledger, seq: next.seq } } : {}) },
        }),
      };
    })
  );
  return { requests, hashes: all.map((t) => t.entry.tx.hash as string) };
}

const decodeToken = (token: string) => JSON.parse(Buffer.from(token, "base64url").toString("utf8"));

/** Call scan_messages, then keep passing next_cursor_token back as cursor until none is returned. */
async function chainTokens(firstParams: { since_ledger: number; limit: number; direction?: "both" }, maxCalls = 10) {
  const keypair = { address: BOT } as unknown as BotKeypair;
  const outputs: any[] = [];
  let params: any = firstParams;
  for (let i = 0; i < maxCalls; i++) {
    const out = JSON.parse(await executeScanMessages(config, keypair, params));
    outputs.push(out);
    if (!out.next_cursor_token) break;
    params = { cursor: out.next_cursor_token, limit: firstParams.limit, direction: firstParams.direction };
  }
  return outputs;
}

describe("scan_messages continuation token over account_tx markers (end to end)", () => {
  it("reviewer regression: more than 200 transactions in since_ledger at limit=200 are each scanned exactly once", async () => {
    // 450 transactions, all in ledger 500; limit is at the schema maximum.
    const node = fakeNode([[500, 450]]);
    const outputs = await chainTokens({ since_ledger: 500, limit: 200 });
    expect(outputs).toHaveLength(3);
    expect(outputs.map((o) => o.truncated)).toEqual([true, true, false]);
    expect(outputs[0].next_cursor).toBe(500); // since_ledger alone cannot move
    expect(outputs[0].hint).toContain("cursor=next_cursor_token");
    expect(outputs[0].hint).not.toContain("larger limit");
    expect(outputs[2].next_cursor_token).toBeNull();
    expect(outputs[2].next_cursor).toBe(501);
    // Every request keeps the same window; follow-ups replay the node's marker.
    expect(node.requests.every((r) => r.ledger_index_min === 500 && r.forward === true)).toBe(true);
    expect(node.requests.map((r) => r.marker)).toEqual([undefined, { ledger: 500, seq: 200 }, { ledger: 500, seq: 400 }]);
    // The three windows tile the ledger: [0,200), [200,400), [400,450).
    const starts = node.requests.map((r) => (r.marker ? r.marker.seq : 0));
    expect(starts).toEqual([0, 200, 400]);
  });

  it("reviewer regression with chat messages: every message comes back exactly once, in order", async () => {
    const all = await Promise.all(Array.from({ length: 450 }, (_, n) => chatTx(500, n)));
    const requests: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        const p = JSON.parse(init.body).params[0];
        requests.push(p);
        const start = p.marker ? p.marker.seq : 0;
        const size = Math.max(10, Math.min(400, p.limit));
        const next = start + size < all.length ? { ledger: 500, seq: start + size } : undefined;
        return {
          ok: true,
          json: async () => ({ result: { transactions: all.slice(start, start + size), ...(next ? { marker: next } : {}) } }),
        };
      })
    );
    const outputs = await chainTokens({ since_ledger: 500, limit: 200 });
    expect(outputs).toHaveLength(3);
    const hashes = outputs.flatMap((o) => o.messages.map((m: any) => m.tx_hash));
    expect(hashes).toHaveLength(450);
    expect(new Set(hashes).size).toBe(450);
    expect(hashes).toEqual(all.map((t) => t.tx.hash));
    expect(requests.every((r) => r.ledger_index_min === 500)).toBe(true);
  });

  it("carries a token across into later ledgers without skipping or repeating", async () => {
    const node = fakeNode([[500, 150], [501, 100], [502, 30]]);
    const outputs = await chainTokens({ since_ledger: 500, limit: 200 });
    expect(outputs).toHaveLength(2);
    expect(outputs[0].truncated).toBe(true);
    expect(outputs[0].next_cursor).toBe(501); // stopped partway through 501
    expect(decodeToken(outputs[0].next_cursor_token)).toEqual({
      v: 1,
      account: BOT,
      ledger_index_min: 500,
      marker: { ledger: 501, seq: 50 },
    });
    expect(node.requests[1]).toMatchObject({ ledger_index_min: 500, limit: 200, forward: true, marker: { ledger: 501, seq: 50 } });
    expect(outputs[1].truncated).toBe(false);
    expect(outputs[1].next_cursor).toBe(503);
    expect(outputs[1].next_cursor_token).toBeNull();
  });

  it("keeps the marker exact when the node returns more than a later page asked for", async () => {
    // Pages come back at most 195 long, so the follow-up page asks for 5 and
    // the node raises that to its minimum of 10. That page is dropped and
    // re-read on the next call instead of being sliced.
    const node = fakeNode([[500, 260]], { maxPage: 195 });
    const outputs = await chainTokens({ since_ledger: 500, limit: 200 });
    expect(node.requests.slice(0, 2).map((r) => r.limit)).toEqual([200, 5]);
    expect(outputs[0].truncated).toBe(true);
    expect(decodeToken(outputs[0].next_cursor_token).marker).toEqual({ ledger: 500, seq: 195 });
    expect(outputs.at(-1).truncated).toBe(false);
    // Each call starts exactly where the previous token pointed: contiguous coverage.
    const tokenSeqs = outputs.slice(0, -1).map((o) => decodeToken(o.next_cursor_token).marker.seq);
    const resumedFrom = node.requests.filter((r) => r.marker && r.limit === 200).map((r) => r.marker.seq);
    expect(resumedFrom).toEqual(tokenSeqs);
  });

  it("the since_ledger-only flow is unchanged: same requests, cursor and truncation", async () => {
    const node = fakeNode([[500, 5], [501, 5], [502, 3]]);
    const keypair = { address: BOT } as unknown as BotKeypair;
    const first = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500, limit: 12 }));
    expect(node.requests[0]).toEqual({ account: BOT, limit: 12, forward: true, ledger_index_min: 500 });
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toBe(502); // inclusive, as before
    const second = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: first.next_cursor, limit: 12 }));
    expect(node.requests[1]).toEqual({ account: BOT, limit: 12, forward: true, ledger_index_min: 502 });
    expect(second.truncated).toBe(false);
    expect(second.next_cursor).toBe(503);
    expect(second.next_cursor_token).toBeNull();
  });

  it("reports the node's rejection of an expired or foreign marker with a fallback", async () => {
    fakeNode([[500, 20]]);
    const keypair = { address: BOT } as unknown as BotKeypair;
    const stale = encodeCursorToken({ account: BOT, ledger_index_min: 500, marker: { ledger: 500, seq: 999 } });
    await expect(executeScanMessages(config, keypair, { cursor: stale })).rejects.toThrow(
      /invalid marker\. The node did not accept the continuation cursor/
    );
  });
});
