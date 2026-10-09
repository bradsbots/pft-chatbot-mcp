import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { scanMessages, type ScannedMessage } from "../chain/scanner.js";

export const scanMessagesSchema = z.object({
  since_ledger: z
    .number()
    .optional()
    .describe("Only return messages from this ledger index onwards"),
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum number of transactions to scan (default 100)"),
  direction: z
    .enum(["inbound", "outbound", "both"])
    .optional()
    .describe("Filter by message direction (default: inbound)"),
});

export type ScanMessagesParams = z.infer<typeof scanMessagesSchema>;

export async function executeScanMessages(
  config: Config,
  keypair: BotKeypair,
  params: ScanMessagesParams
): Promise<string> {
  const { messages, truncated } = await scanMessages(config, keypair.address, {
    sinceLedger: params.since_ledger,
    limit: params.limit,
  });

  const direction = params.direction || "inbound";
  const filtered =
    direction === "both"
      ? messages
      : messages.filter((m) => m.direction === direction);

  const results = filtered.map((m: ScannedMessage) => ({
    tx_hash: m.txHash,
    sender: m.sender,
    recipient: m.recipient,
    direction: m.direction,
    amount_drops: m.amountDrops,
    amount_pft: m.amountDrops !== "0"
      ? (Number(m.amountDrops) / 1_000_000).toString()
      : "0",
    issued_currency: m.issuedCurrencyAmount,
    memo_type: m.memoType,
    cid: m.cid,
    thread_id: m.threadId,
    content_kind: m.contentKind,
    is_encrypted: m.isEncrypted,
    ledger_index: m.ledgerIndex,
    timestamp: m.timestamp,
    timestamp_iso: m.timestamp
      ? new Date(m.timestamp * 1000).toISOString()
      : null,
  }));

  // The cursor is derived from every scanned message (before the direction
  // filter) so that filtering out, say, outbound messages cannot move the
  // cursor past unread transactions.
  const scannedLedgers = messages.map((m) => m.ledgerIndex);
  const maxLedger = scannedLedgers.length > 0 ? Math.max(...scannedLedgers) : null;

  if (results.length === 0) {
    const nextCursor = truncated && maxLedger != null
      ? maxLedger
      : maxLedger != null
        ? maxLedger + 1
        : params.since_ledger || null;
    return JSON.stringify({
      messages: [],
      count: 0,
      next_cursor: nextCursor,
      truncated,
      hint: truncated
        ? `No ${direction} messages in the first ${messages.length} scanned, but more transactions remain unread. Pass since_ledger=${nextCursor} to continue.`
        : "No new messages found. Call scan_messages again later, or pass a since_ledger to resume from a specific point.",
    }, null, 2);
  }

  // Compute the cursor. When the window was fully read, the highest ledger
  // index seen + 1 picks up only new messages next time. When it was
  // truncated, unread transactions may share that highest ledger, so resume
  // from it inclusively (callers deduplicate by tx_hash).
  const nextCursor = truncated ? (maxLedger as number) : (maxLedger as number) + 1;

  return JSON.stringify({
    messages: results,
    count: results.length,
    next_cursor: nextCursor,
    truncated,
    hint: truncated
      ? `Found ${results.length} message(s) but the window held more transactions than were scanned. Pass since_ledger=${nextCursor} on your next scan_messages call to continue (deduplicate by tx_hash).`
      : `Found ${results.length} message(s). Pass since_ledger=${nextCursor} on your next scan_messages call to get only new messages.`,
  }, null, 2);
}
