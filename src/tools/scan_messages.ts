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
  const { messages, truncated, lastScannedLedger } = await scanMessages(config, keypair.address, {
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

  // Cursor rule. The cursor comes from the raw account_tx window
  // (lastScannedLedger: every scanned transaction, including non-Payment,
  // failed, memo-less and undecodable ones), never from decoded or filtered
  // messages, so a window without matching messages still advances it.
  //  - Window fully read: every transaction at or below lastScannedLedger
  //    was examined, so next_cursor = lastScannedLedger + 1 (exclusive).
  //  - Window truncated: the account_tx marker can stop partway through a
  //    ledger, so unread transactions may share lastScannedLedger. Resume from
  //    it inclusively, next_cursor = lastScannedLedger; callers deduplicate by
  //    tx_hash. since_ledger is itself inclusive (ledger_index_min).
  //  - Nothing scanned: keep the caller's since_ledger.
  // If a truncated page lies entirely inside the since_ledger ledger, the
  // inclusive cursor cannot move without skipping that ledger's remainder; the
  // hint then asks for a larger limit instead of advancing.
  const nextCursor =
    lastScannedLedger == null
      ? params.since_ledger ?? null
      : truncated
        ? lastScannedLedger
        : lastScannedLedger + 1;
  const stalled =
    truncated && nextCursor != null && params.since_ledger != null && nextCursor <= params.since_ledger;
  const resumeHint = stalled
    ? `The first ${params.limit ?? 100} transactions all sit in ledger ${nextCursor}; call again with since_ledger=${nextCursor} and a larger limit to read the rest of that ledger.`
    : `Pass since_ledger=${nextCursor} on your next scan_messages call to continue (deduplicate by tx_hash).`;

  if (results.length === 0) {
    return JSON.stringify({
      messages: [],
      count: 0,
      next_cursor: nextCursor,
      truncated,
      hint: truncated
        ? `No ${direction} messages in the scanned window, but more transactions remain unread. ${resumeHint}`
        : "No new messages found. Call scan_messages again later, or pass a since_ledger to resume from a specific point.",
    }, null, 2);
  }

  return JSON.stringify({
    messages: results,
    count: results.length,
    next_cursor: nextCursor,
    truncated,
    hint: truncated
      ? `Found ${results.length} message(s) but the window held more transactions than were scanned. ${resumeHint}`
      : `Found ${results.length} message(s). Pass since_ledger=${nextCursor} on your next scan_messages call to get only new messages.`,
  }, null, 2);
}
