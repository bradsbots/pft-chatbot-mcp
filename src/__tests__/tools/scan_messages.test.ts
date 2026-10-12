import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../chain/scanner.js", () => ({ scanMessages: vi.fn() }));

import { scanMessages } from "../../chain/scanner.js";
import { executeScanMessages } from "../../tools/scan_messages.js";
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
    });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500 }));
    expect(out.count).toBe(0);
    expect(out.next_cursor).toBe(503);
  });

  it("keeps the caller's cursor when nothing at all was scanned", async () => {
    vi.mocked(scanMessages).mockResolvedValue({ messages: [], truncated: false, lastScannedLedger: null });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500 }));
    expect(out.count).toBe(0);
    expect(out.next_cursor).toBe(500);
  });

  it("points at the unread remainder when the filter leaves nothing but the window was truncated", async () => {
    vi.mocked(scanMessages).mockResolvedValue({
      messages: [message(501, "outbound"), message(502, "outbound")],
      truncated: true,
      lastScannedLedger: 502,
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
    vi.mocked(scanMessages).mockResolvedValue({ messages: [], truncated: true, lastScannedLedger: 612 });
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
    });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500, limit: 2 }));
    expect(out.next_cursor).toBe(502); // inclusive: 502's unread transactions stay reachable
  });

  it("asks for a larger limit instead of advancing when a truncated page sits entirely in since_ledger", async () => {
    vi.mocked(scanMessages).mockResolvedValue({ messages: [], truncated: true, lastScannedLedger: 500 });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500, limit: 2 }));
    expect(out.next_cursor).toBe(500);
    expect(out.hint).toContain("larger limit");
  });
});
