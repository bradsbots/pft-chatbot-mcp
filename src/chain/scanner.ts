import type { Config } from "../config.js";
import {
  identifyMemoType,
  decodePfPointer,
  decodeKeystoneEnvelope,
  extractCidFromCoreMessage,
  type DecodedMemo,
  type MemoType,
} from "./pointer.js";

/** Parsed amount for issued currencies (non-PFT tokens on PFTL) */
export interface IssuedCurrencyAmount {
  currency: string;
  issuer: string;
  value: string;
}

export interface ScannedMessage {
  txHash: string;
  sender: string;
  recipient: string;
  direction: "inbound" | "outbound";
  /** PFT amount in drops (native currency). 1 PFT = 1,000,000 drops. */
  amountDrops: string;
  /** Issued currency amount (for non-PFT tokens on the PFTL chain, null for native PFT) */
  issuedCurrencyAmount: IssuedCurrencyAmount | null;
  memoType: MemoType;
  /** CID extracted from pf.ptr pointer or keystone envelope metadata/message */
  cid: string | null;
  threadId: string | null;
  contentKind: string | null;
  isEncrypted: boolean;
  ledgerIndex: number;
  timestamp: number;
  decodedMemo: DecodedMemo;
}

/** One page of account_tx results. */
interface AccountTxPage {
  transactions: any[];
  /** Opaque resume marker when more results remain; undefined when exhausted. */
  marker?: unknown;
}

/**
 * Call account_tx via JSON-RPC for one page of a wallet's transactions.
 *
 * With `ledgerIndexMin` (a resume cursor) the page is requested oldest-first
 * (`forward: true`) so that a window larger than one page truncates at the
 * newest end, which the next cursor will pick up, instead of silently
 * dropping the oldest messages. Without a cursor the most recent
 * transactions are wanted, so the page is newest-first.
 */
async function accountTxPage(
  rpcUrl: string,
  account: string,
  limit: number,
  ledgerIndexMin?: number,
  marker?: unknown
): Promise<AccountTxPage> {
  const params: any = {
    account,
    limit,
    forward: ledgerIndexMin != null,
  };
  if (ledgerIndexMin) {
    params.ledger_index_min = ledgerIndexMin;
  }
  if (marker != null) {
    params.marker = marker;
  }

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "account_tx",
      params: [params],
    }),
  });

  if (!response.ok) {
    throw new Error(`account_tx failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as any;
  if (json.result?.error) {
    throw new Error(`account_tx error: ${json.result.error_message || json.result.error}`);
  }

  return {
    transactions: json.result?.transactions || [],
    marker: json.result?.marker,
  };
}

/** Maximum account_tx pages fetched per scan, a safety bound on RPC calls. */
const MAX_ACCOUNT_TX_PAGES = 10;

/**
 * Fetch up to `limit` transactions, following account_tx markers across
 * pages. `truncated` is true when more transactions remained unread (the
 * node still returned a marker when the limit or page bound was reached).
 */
async function accountTx(
  rpcUrl: string,
  account: string,
  limit: number = 100,
  ledgerIndexMin?: number
): Promise<{ transactions: any[]; truncated: boolean }> {
  const transactions: any[] = [];
  let marker: unknown = undefined;
  for (let page = 0; page < MAX_ACCOUNT_TX_PAGES; page++) {
    const remaining = limit - transactions.length;
    if (remaining <= 0) {
      return { transactions, truncated: marker != null };
    }
    const result = await accountTxPage(rpcUrl, account, remaining, ledgerIndexMin, marker);
    transactions.push(...result.transactions);
    marker = result.marker;
    if (marker == null || result.transactions.length === 0) {
      return { transactions: transactions.slice(0, limit), truncated: false };
    }
  }
  return { transactions: transactions.slice(0, limit), truncated: marker != null };
}

/**
 * Resolve the close_time of a ledger to a Unix timestamp.
 * PFTL (like XRPL) epoch starts at 2000-01-01T00:00:00Z (946684800 seconds after Unix epoch).
 */
function rippleTimeToUnix(rippleTime: number): number {
  return rippleTime + 946684800;
}

export interface ScanResult {
  messages: ScannedMessage[];
  /**
   * True when the scan window held more transactions than `limit` (or the
   * page bound) allowed, so some were not examined. With a `sinceLedger`
   * cursor the unread transactions are the newest ones; resume from the
   * highest ledger index returned (inclusive) to pick them up.
   */
  truncated: boolean;
}

/**
 * Scan the bot's wallet for recent messages.
 * Returns decoded messages with memo type, CID, sender, amount, etc.
 */
export async function scanMessages(
  config: Config,
  botAddress: string,
  options: { sinceLedger?: number; limit?: number } = {}
): Promise<ScanResult> {
  const { transactions: txs, truncated } = await accountTx(
    config.pftlRpcUrl,
    botAddress,
    options.limit || 100,
    options.sinceLedger
  );

  const messages: ScannedMessage[] = [];

  for (const entry of txs) {
    const tx = entry.tx || entry.tx_json;
    const meta = entry.meta || entry.metadata;

    if (!tx || !meta) continue;

    // Only process successful Payment transactions
    if (tx.TransactionType !== "Payment") continue;
    if (
      meta.TransactionResult !== "tesSUCCESS" &&
      meta.TransactionResult !== undefined
    )
      continue;

    // Must have memos
    const memos = tx.Memos;
    if (!memos || !Array.isArray(memos) || memos.length === 0) continue;

    for (let i = 0; i < memos.length; i++) {
      const memo = memos[i]?.Memo;
      if (!memo?.MemoType || !memo?.MemoData) continue;

      // XRPL nodes return hex with uppercase letters; normalize to lowercase
      // so identifyMemoType constants match.
      const memoTypeHex = memo.MemoType.toLowerCase();
      const memoFormatHex = (memo.MemoFormat || "").toLowerCase();
      const memoDataHex = memo.MemoData.toLowerCase();

      const memoType = identifyMemoType(memoTypeHex, memoFormatHex);
      if (memoType === "unknown") continue;

      let decodedMemo: DecodedMemo = null;
      let cid: string | null = null;
      let threadId: string | null = null;
      let contentKind: string | null = null;
      let isEncrypted = false;

      try {
        if (memoType === "pf.ptr") {
          const pointer = await decodePfPointer(memoDataHex);
          decodedMemo = pointer;
          cid = pointer.cid;
          threadId = pointer.threadId || null;
          contentKind = pointer.kind;
          isEncrypted = pointer.isEncrypted;

          // Only include CHAT messages by default.
          // kind is "CHAT" after enum resolution via toObject({ enums: String }),
          // but fall back to checking "4" in case raw numeric value leaks through.
          if (pointer.kind !== "CHAT" && pointer.kind !== "4") continue;
        } else if (memoType === "keystone") {
          const envelope = await decodeKeystoneEnvelope(memoDataHex);
          decodedMemo = envelope;
          isEncrypted =
            envelope.encryption === "ENCRYPTION_MODE_PUBLIC_KEY" ||
            envelope.encryption === "ENCRYPTION_MODE_PROTECTED";
          cid = envelope.metadata?.cid || null;
          if (!cid && envelope.message && envelope.message.length > 0) {
            cid = await extractCidFromCoreMessage(envelope.message);
          }
        }
      } catch {
        // Skip memos we can't decode
        continue;
      }

      const sender = tx.Account;
      const recipient = tx.Destination;
      const direction = sender === botAddress ? "outbound" : "inbound";

      // Parse Amount: string = PFT drops (native), object = issued currency (other tokens)
      let amountDrops = "0";
      let issuedCurrencyAmount: IssuedCurrencyAmount | null = null;
      if (typeof tx.Amount === "string") {
        amountDrops = tx.Amount;
      } else if (tx.Amount && typeof tx.Amount === "object") {
        issuedCurrencyAmount = {
          currency: tx.Amount.currency,
          issuer: tx.Amount.issuer,
          value: tx.Amount.value,
        };
      }

      messages.push({
        txHash: tx.hash || entry.hash || "",
        sender,
        recipient,
        direction,
        amountDrops,
        issuedCurrencyAmount,
        memoType,
        cid,
        threadId,
        contentKind,
        isEncrypted,
        ledgerIndex: entry.ledger_index || tx.ledger_index || 0,
        timestamp: tx.date ? rippleTimeToUnix(tx.date) : 0,
        decodedMemo,
      });
    }
  }

  return { messages, truncated };
}

/**
 * Fetch account_info for a wallet address.
 * Returns the public key and balance.
 */
export async function getAccountInfo(
  rpcUrl: string,
  address: string
): Promise<{
  publicKey: string;
  balance: string;
  messageKey?: string;
}> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "account_info",
      params: [{ account: address }],
    }),
  });

  const json = (await response.json()) as any;
  if (json.result?.error) {
    throw new Error(
      `account_info error: ${json.result.error_message || json.result.error}`
    );
  }

  const data = json.result?.account_data;
  return {
    publicKey: data?.RegularKey || data?.SigningPubKey || "",
    balance: data?.Balance || "0",
    messageKey: data?.MessageKey,
  };
}

/** A single trust line returned by account_lines */
export interface TrustLine {
  currency: string;
  issuer: string;
  balance: string;
  limit: string;
}

/**
 * Fetch account_lines for a wallet address.
 * Returns the list of trust lines (issued currency balances and limits).
 */
export async function getAccountLines(
  rpcUrl: string,
  address: string
): Promise<TrustLine[]> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "account_lines",
      params: [{ account: address }],
    }),
  });

  const json = (await response.json()) as any;
  if (json.result?.error) {
    throw new Error(
      `account_lines error: ${json.result.error_message || json.result.error}`
    );
  }

  const lines = json.result?.lines || [];
  return lines.map((line: any) => ({
    currency: line.currency || "",
    issuer: line.account || "",
    balance: line.balance || "0",
    limit: line.limit || "0",
  }));
}
