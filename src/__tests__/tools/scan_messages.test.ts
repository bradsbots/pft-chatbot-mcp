import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../chain/scanner.js", () => ({ scanMessages: vi.fn() }));

import { scanMessages } from "../../chain/scanner.js";
import { executeScanMessages, encodeCursorToken, scanMessagesSchema } from "../../tools/scan_messages.js";
import type { Config } from "../../config.js";
import type { BotKeypair } from "../../crypto/keys.js";

const config = {} as Config;
const keypair = { address: "rBotAddress" } as unknown as BotKeypair;

function message(ledgerIndex: number, direction: "inbound" | "outbound", n = 1) {
  return {
    txHash: `HASH-${ledgerIndex}-${n}`,
    sender: direction === "inbound" ? "rPeer" : "rBotAddress",
    recipient: direction === "inbound" ? "rBotAddress" : "rPeer",
    direction,
    amountDrops: "1000000",
    issuedCurrencyAmount: null,
    memoType: "keystone" as const,
    cid: `cid-${ledgerIndex}`,
    threadId: null,
    contentKind: null,
    isEncrypted: true,
    ledgerIndex,
    timestamp: 0,
    decodedMemo: null,
  };
}

afterEach(() => {
  vi.mocked(scanMessages).mockReset();
});

describe("executeScanMessages cursor", () => {
  it("advances past a fully read window", async () => {
    vi.mocked(scanMessages).mockResolvedValue({
      messages: [message(501, "inbound"), message(503, "inbound")],
      truncated: false,
      lastScannedLedger: 503,
      resumeMarker: null,
    });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500 }));
    expect(out.count).toBe(2);
    expect(out.truncated).toBe(false);
    expect(out.next_cursor).toBe(504);
  });

  it("resumes inclusively from the highest scanned ledger when truncated", async () => {
    vi.mocked(scanMessages).mockResolvedValue({
      messages: [message(501, "inbound"), message(503, "inbound", 1), message(503, "inbound", 2)],
      truncated: true,
      lastScannedLedger: 503,
      resumeMarker: null,
    });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500, limit: 3 }));
    expect(out.truncated).toBe(true);
    expect(out.next_cursor).toBe(503);
    expect(out.hint).toContain("since_ledger=503");
  });

  it("derives the cursor from all scanned messages, not only the filtered direction", async () => {
    // Only outbound messages were scanned; the inbound filter leaves none,
    // but the cursor must still move past them.
    vi.mocked(scanMessages).mockResolvedValue({
      messages: [message(501, "outbound"), message(502, "outbound")],
      truncated: false,
      lastScannedLedger: 502,
      resumeMarker: null,
    });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500 }));
    expect(out.count).toBe(0);
    expect(out.next_cursor).toBe(503);
  });

  it("keeps the caller's cursor when nothing at all was scanned", async () => {
    vi.mocked(scanMessages).mockResolvedValue({ messages: [], truncated: false, lastScannedLedger: null, resumeMarker: null });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500 }));
    expect(out.count).toBe(0);
    expect(out.next_cursor).toBe(500);
  });

  it("points at the unread remainder when the filter leaves nothing but the window was truncated", async () => {
    vi.mocked(scanMessages).mockResolvedValue({
      messages: [message(501, "outbound"), message(502, "outbound")],
      truncated: true,
      lastScannedLedger: 502,
      resumeMarker: null,
    });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500, limit: 2 }));
    expect(out.count).toBe(0);
    expect(out.truncated).toBe(true);
    expect(out.next_cursor).toBe(502);
  });
  it("advances past a truncated window that held no decodable messages", async () => {
    // Reviewer regression: a full page of non-message / undecodable
    // transactions with a marker. The cursor must come from the raw window,
    // not stay at the caller's since_ledger forever.
    vi.mocked(scanMessages).mockResolvedValue({ messages: [], truncated: true, lastScannedLedger: 612, resumeMarker: null });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500, limit: 100 }));
    expect(out.count).toBe(0);
    expect(out.truncated).toBe(true);
    expect(out.next_cursor).not.toBe(500);
    expect(out.next_cursor).toBe(612);
    expect(out.hint).toContain("since_ledger=612");
  });

  it("advances past non-message transactions scanned after an earlier message", async () => {
    // A message at 501, then only non-message transactions up to 540.
    vi.mocked(scanMessages).mockResolvedValue({
      messages: [message(501, "inbound")],
      truncated: false,
      lastScannedLedger: 540,
      resumeMarker: null,
    });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500 }));
    expect(out.count).toBe(1);
    expect(out.next_cursor).toBe(541);
  });

  it("does not skip the rest of a ledger when truncated partway through it", async () => {
    vi.mocked(scanMessages).mockResolvedValue({
      messages: [message(501, "inbound"), message(502, "inbound", 1)],
      truncated: true,
      lastScannedLedger: 502,
      resumeMarker: null,
    });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500, limit: 2 }));
    expect(out.next_cursor).toBe(502); // inclusive: 502's unread transactions stay reachable
  });

  it("without a node marker, asks for a larger limit instead of advancing when a truncated page sits entirely in since_ledger", async () => {
    vi.mocked(scanMessages).mockResolvedValue({ messages: [], truncated: true, lastScannedLedger: 500, resumeMarker: null });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500, limit: 2 }));
    expect(out.next_cursor).toBe(500);
    expect(out.hint).toContain("larger limit");
  });
});

describe("executeScanMessages continuation token", () => {
  const MARKER = { ledger: 500, seq: 200 };
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  const validToken = () => encodeCursorToken({ account: "rBotAddress", ledger_index_min: 500, marker: MARKER });

  it("returns the node marker as next_cursor_token and points the stalled hint at it, not at a larger limit", async () => {
    vi.mocked(scanMessages).mockResolvedValue({
      messages: [message(500, "inbound")],
      truncated: true,
      lastScannedLedger: 500,
      resumeMarker: MARKER,
    });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500, limit: 200 }));
    expect(out.next_cursor).toBe(500);
    expect(out.next_cursor_token).toBe(validToken());
    expect(JSON.parse(Buffer.from(out.next_cursor_token, "base64url").toString("utf8"))).toEqual({
      v: 1,
      account: "rBotAddress",
      ledger_index_min: 500,
      marker: MARKER,
    });
    expect(out.hint).toContain("cursor=next_cursor_token");
    expect(out.hint).not.toContain("larger limit");
  });

  it("is null when the window was read to the end", async () => {
    vi.mocked(scanMessages).mockResolvedValue({
      messages: [message(501, "inbound")],
      truncated: false,
      lastScannedLedger: 501,
      resumeMarker: null,
    });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500 }));
    expect(out.next_cursor_token).toBeNull();
    expect(out.next_cursor).toBe(502);
  });

  it("is not issued for a scan without since_ledger (newest-first markers page backwards)", async () => {
    vi.mocked(scanMessages).mockResolvedValue({
      messages: [message(900, "inbound")],
      truncated: true,
      lastScannedLedger: 900,
      resumeMarker: { ledger: 880, seq: 3 },
    });
    const out = JSON.parse(await executeScanMessages(config, keypair, { limit: 1 }));
    expect(out.next_cursor_token).toBeNull();
  });

  it("resumes from the token's marker and window, with or without a matching since_ledger", async () => {
    vi.mocked(scanMessages).mockResolvedValue({ messages: [], truncated: false, lastScannedLedger: 500, resumeMarker: null });
    await executeScanMessages(config, keypair, { cursor: validToken(), limit: 200 });
    await executeScanMessages(config, keypair, { cursor: validToken(), since_ledger: 500, limit: 200 });
    for (const call of vi.mocked(scanMessages).mock.calls) {
      expect(call[1]).toBe("rBotAddress");
      expect(call[2]).toEqual({ sinceLedger: 500, limit: 200, marker: MARKER });
    }
  });

  const rejected: Array<[string, () => string, RegExp, Partial<{ since_ledger: number }>?]> = [
    ["non-base64url characters", () => "not a token!", /not a base64url token/],
    ["non-canonical base64url", () => validToken() + "A", /not canonical base64url|not JSON/],
    ["bytes that are not JSON", () => Buffer.from("{oops", "utf8").toString("base64url"), /not JSON/],
    ["a JSON array", () => b64([1, 2]), /not an object/],
    ["an unknown version", () => b64({ v: 2, account: "rBotAddress", ledger_index_min: 500, marker: MARKER }), /unsupported version 2/],
    ["a missing version", () => b64({ account: "rBotAddress", ledger_index_min: 500, marker: MARKER }), /unsupported version/],
    ["extra fields", () => b64({ v: 1, account: "rBotAddress", ledger_index_min: 500, marker: MARKER, limit: 5 }), /unexpected fields/],
    ["another account", () => b64({ v: 1, account: "rSomeoneElse", ledger_index_min: 500, marker: MARKER }), /different account/],
    ["a fractional window", () => b64({ v: 1, account: "rBotAddress", ledger_index_min: 500.5, marker: MARKER }), /non-negative integer/],
    ["a missing marker", () => b64({ v: 1, account: "rBotAddress", ledger_index_min: 500, marker: null }), /missing marker/],
    ["a marker before its window", () => b64({ v: 1, account: "rBotAddress", ledger_index_min: 500, marker: { ledger: 499, seq: 0 } }), /lies before ledger_index_min/],
    ["a since_ledger that differs from the token's window", () => validToken(), /issued for since_ledger=500 but since_ledger=501/, { since_ledger: 501 }],
    [
      "a tampered window that no longer matches since_ledger",
      () => b64({ v: 1, account: "rBotAddress", ledger_index_min: 400, marker: MARKER }),
      /issued for since_ledger=400 but since_ledger=500/,
      { since_ledger: 500 },
    ],
  ];

  for (const [name, token, error, extra] of rejected) {
    it(`rejects a token with ${name} before calling account_tx`, async () => {
      await expect(executeScanMessages(config, keypair, { cursor: token(), ...(extra ?? {}) })).rejects.toThrow(error);
      await expect(executeScanMessages(config, keypair, { cursor: token(), ...(extra ?? {}) })).rejects.toThrow(/^Invalid cursor: /);
      expect(scanMessages).not.toHaveBeenCalled();
    });
  }

  it("rejects malformed tokens at the schema boundary", () => {
    expect(scanMessagesSchema.safeParse({ cursor: "has spaces=" }).success).toBe(false);
    expect(scanMessagesSchema.safeParse({ cursor: "" }).success).toBe(false);
    expect(scanMessagesSchema.safeParse({ cursor: "A".repeat(2049) }).success).toBe(false);
    expect(scanMessagesSchema.safeParse({ cursor: validToken(), since_ledger: 500 }).success).toBe(true);
  });

  it("explains how to fall back when the node rejects a replayed marker", async () => {
    vi.mocked(scanMessages).mockRejectedValue(new Error("account_tx error: invalid marker"));
    await expect(executeScanMessages(config, keypair, { cursor: validToken() })).rejects.toThrow(
      /account_tx error: invalid marker\. The node did not accept the continuation cursor.*since_ledger/
    );
  });
});
