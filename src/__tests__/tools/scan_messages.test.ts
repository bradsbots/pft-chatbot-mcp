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
    });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500 }));
    expect(out.count).toBe(0);
    expect(out.next_cursor).toBe(503);
  });

  it("keeps the caller's cursor when nothing at all was scanned", async () => {
    vi.mocked(scanMessages).mockResolvedValue({ messages: [], truncated: false });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500 }));
    expect(out.count).toBe(0);
    expect(out.next_cursor).toBe(500);
  });

  it("points at the unread remainder when the filter leaves nothing but the window was truncated", async () => {
    vi.mocked(scanMessages).mockResolvedValue({
      messages: [message(501, "outbound"), message(502, "outbound")],
      truncated: true,
    });
    const out = JSON.parse(await executeScanMessages(config, keypair, { since_ledger: 500, limit: 2 }));
    expect(out.count).toBe(0);
    expect(out.truncated).toBe(true);
    expect(out.next_cursor).toBe(502);
  });
});
