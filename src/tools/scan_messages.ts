import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { scanMessages, type ScannedMessage } from "../chain/scanner.js";

/** Current continuation-token format version. */
export const CURSOR_TOKEN_VERSION = 1;
/** Upper bound on an encoded continuation token. */
const MAX_CURSOR_TOKEN_LENGTH = 2048;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const scanMessagesSchema = z.object({
  since_ledger: z
    .number()
    .optional()
    .describe("Only return messages from this ledger index onwards"),
  cursor: z
    .string()
    .min(1)
    .max(MAX_CURSOR_TOKEN_LENGTH)
    .regex(BASE64URL, "cursor must be the unmodified next_cursor_token from a previous scan_messages call")
    .optional()
    .describe(
      "Opaque continuation token: the next_cursor_token from a previous scan_messages call. Resumes exactly after the last scanned transaction, even partway through a ledger, so nothing is skipped or re-read. If since_ledger is also given it must equal the since_ledger the token was issued for. Tokens wrap an account_tx marker, which nodes may stop honouring after about 10 minutes; if one is rejected, fall back to since_ledger=next_cursor."
    ),
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

/**
 * Decoded continuation token. `marker` is the account_tx marker exactly as
 * the node returned it; `ledger_index_min` and `account` are the query
 * parameters it was issued for. A marker is only valid against the same
 * account_tx parameters, so both are checked before it is replayed.
 */
interface CursorToken {
  v: number;
  account: string;
  ledger_index_min: number;
  marker: unknown;
}

export function encodeCursorToken(token: Omit<CursorToken, "v">): string {
  const body: CursorToken = {
    v: CURSOR_TOKEN_VERSION,
    account: token.account,
    ledger_index_min: token.ledger_index_min,
    marker: token.marker,
  };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

function invalidCursor(reason: string): Error {
  return new Error(
    `Invalid cursor: ${reason}. Pass the next_cursor_token from a previous scan_messages call unchanged, or omit cursor and resume with since_ledger=next_cursor.`
  );
}

/**
 * Strictly decode a continuation token: canonical base64url, JSON object with
 * exactly the expected keys, a known version, the bot's own account and a
 * non-negative integer ledger window. The marker itself stays opaque; it is
 * only checked for presence and, if it carries a numeric `ledger` (as
 * rippled's {ledger, seq} does), for lying inside the token's window.
 */
export function decodeCursorToken(cursor: string, account: string): CursorToken {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_TOKEN_LENGTH || !BASE64URL.test(cursor)) {
    throw invalidCursor("not a base64url token");
  }
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.toString("base64url") !== cursor) {
    throw invalidCursor("not canonical base64url");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalidCursor("payload is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidCursor("payload is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj).sort().join(",");
  if (obj.v !== CURSOR_TOKEN_VERSION) {
    throw invalidCursor(`unsupported version ${JSON.stringify(obj.v)} (expected ${CURSOR_TOKEN_VERSION})`);
  }
  if (keys !== "account,ledger_index_min,marker,v") {
    throw invalidCursor("unexpected fields");
  }
  if (obj.account !== account) {
    throw invalidCursor("issued for a different account");
  }
  const min = obj.ledger_index_min;
  if (typeof min !== "number" || !Number.isSafeInteger(min) || min < 0) {
    throw invalidCursor("ledger_index_min is not a non-negative integer");
  }
  const marker = obj.marker;
  if (marker === null || marker === undefined) {
    throw invalidCursor("missing marker");
  }
  if (typeof marker === "object" && !Array.isArray(marker)) {
    const markerLedger = (marker as Record<string, unknown>).ledger;
    if (typeof markerLedger === "number" && markerLedger < min) {
      throw invalidCursor(`marker ledger ${markerLedger} lies before ledger_index_min ${min}`);
    }
  }
  return { v: CURSOR_TOKEN_VERSION, account, ledger_index_min: min, marker };
}

export async function executeScanMessages(
  config: Config,
  keypair: BotKeypair,
  params: ScanMessagesParams
): Promise<string> {
  // A continuation token pins the ledger window its marker belongs to.
  let sinceLedger = params.since_ledger;
  let startMarker: unknown = undefined;
  if (params.cursor != null) {
    const token = decodeCursorToken(params.cursor, keypair.address);
    if (params.since_ledger != null && params.since_ledger !== token.ledger_index_min) {
      throw invalidCursor(
        `issued for since_ledger=${token.ledger_index_min} but since_ledger=${params.since_ledger} was passed; an account_tx marker is only valid for the query it came from`
      );
    }
    sinceLedger = token.ledger_index_min;
    startMarker = token.marker;
  }

  let scan;
  try {
    scan = await scanMessages(config, keypair.address, {
      sinceLedger,
      limit: params.limit,
      marker: startMarker,
    });
  } catch (err: any) {
    if (params.cursor != null) {
      throw new Error(
        `${err.message}. The node did not accept the continuation cursor (account_tx markers are ephemeral and can expire after about 10 minutes); resume with since_ledger and deduplicate by tx_hash instead.`
      );
    }
    throw err;
  }
  const { messages, truncated, lastScannedLedger, resumeMarker } = scan;

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
  //  - Nothing scanned: keep the effective since_ledger.
  // A ledger-index cursor cannot express a position inside a ledger, so when
  // the window is truncated the node's marker is also returned as an opaque
  // next_cursor_token. Passing it back as `cursor` resumes exactly after the
  // last scanned transaction. This is the only way forward when a truncated
  // page lies entirely inside the since_ledger ledger and the limit is
  // already at its maximum.
  const nextCursor =
    lastScannedLedger == null
      ? sinceLedger ?? null
      : truncated
        ? lastScannedLedger
        : lastScannedLedger + 1;
  // Tokens are only issued for since_ledger scans (oldest-first). Without
  // since_ledger the scan reads the newest transactions, and its marker would
  // page backwards into older history instead of continuing forwards.
  const nextCursorToken =
    resumeMarker != null && sinceLedger != null && Number.isSafeInteger(sinceLedger) && sinceLedger >= 0
      ? encodeCursorToken({ account: keypair.address, ledger_index_min: sinceLedger, marker: resumeMarker })
      : null;
  const stalled =
    truncated && nextCursor != null && sinceLedger != null && nextCursor <= sinceLedger;
  const resumeHint = nextCursorToken
    ? stalled
      ? `Every scanned transaction sits in ledger ${nextCursor}, so since_ledger cannot advance without skipping the rest of that ledger. Pass cursor=next_cursor_token on your next scan_messages call to continue exactly where this scan stopped.`
      : `Pass cursor=next_cursor_token on your next scan_messages call to continue exactly where this scan stopped (or since_ledger=${nextCursor} and deduplicate by tx_hash).`
    : stalled
      ? `The first ${params.limit ?? 100} transactions all sit in ledger ${nextCursor}; call again with since_ledger=${nextCursor} and a larger limit to read the rest of that ledger.`
      : `Pass since_ledger=${nextCursor} on your next scan_messages call to continue (deduplicate by tx_hash).`;

  if (results.length === 0) {
    return JSON.stringify({
      messages: [],
      count: 0,
      next_cursor: nextCursor,
      next_cursor_token: nextCursorToken,
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
    next_cursor_token: nextCursorToken,
    truncated,
    hint: truncated
      ? `Found ${results.length} message(s) but the window held more transactions than were scanned. ${resumeHint}`
      : `Found ${results.length} message(s). Pass since_ledger=${nextCursor} on your next scan_messages call to get only new messages.`,
  }, null, 2);
}
