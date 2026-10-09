import { Wallet } from "xrpl";
import type { Config } from "../config.js";

export interface PreparedTransaction {
  txJson: any;
  fee: string;
}

/** PFTL Amount: either PFT drops (string) or issued currency (object) */
export type PftlAmount =
  | string
  | { currency: string; issuer: string; value: string };

// ---------------------------------------------------------------------------
// HTTP JSON-RPC helpers (no WebSocket dependency)
// ---------------------------------------------------------------------------

/**
 * Call a JSON-RPC method on the PFTL HTTP endpoint.
 */
async function rpcCall(rpcUrl: string, method: string, params: any = {}): Promise<any> {
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params: [params] }),
  });
  if (!resp.ok) {
    throw new Error(`RPC ${method} HTTP ${resp.status}: ${resp.statusText}`);
  }
  const json = (await resp.json()) as any;
  if (json.result?.error) {
    throw new Error(`RPC ${method}: ${json.result.error_message || json.result.error}`);
  }
  return json.result;
}

interface LedgerInfo {
  sequence: number;
  validatedSeq: number;
  feeDrops: string;
  networkId: number | undefined;
}

/**
 * Fetch account sequence, validated ledger, base fee, and network ID
 * from the PFTL HTTP RPC. Used to autofill transactions without WSS.
 */
async function fetchLedgerInfo(rpcUrl: string, account: string): Promise<LedgerInfo> {
  const [accountInfo, serverInfo] = await Promise.all([
    rpcCall(rpcUrl, "account_info", { account, ledger_index: "current" }),
    rpcCall(rpcUrl, "server_info", {}),
  ]);

  const sequence = accountInfo.account_data?.Sequence;
  if (sequence == null) {
    throw new Error("Could not read account Sequence from account_info");
  }

  const info = serverInfo.info;
  const validatedSeq = info?.validated_ledger?.seq;
  const baseFee = info?.validated_ledger?.base_fee_xrp;
  if (!validatedSeq) {
    throw new Error("Could not read validated_ledger from server_info");
  }

  const feeDrops = baseFee
    ? Math.ceil(parseFloat(baseFee) * 1_000_000).toString()
    : "12";

  return {
    sequence,
    validatedSeq,
    feeDrops,
    networkId: info?.network_id,
  };
}

/**
 * Final or provisional state of a submitted transaction.
 *
 * - `validated`: included in a validated ledger; `result` is the ledger's
 *   `meta.TransactionResult` (which may still be a `tec` failure code).
 * - `expired`: the validated ledger passed the transaction's
 *   `LastLedgerSequence` without it being validated; it can never be applied
 *   and may safely be resent with a new sequence.
 * - `pending`: still in flight when polling stopped. It may yet validate;
 *   callers must not resend blindly, and should check `txHash` first.
 * - `rejected`: `submit` returned something other than `tesSUCCESS` or
 *   `terQUEUED`; `result` is that provisional engine result.
 */
export type SubmissionStatus = "validated" | "expired" | "pending" | "rejected";

export interface SubmissionOutcome {
  txHash: string;
  /** Engine/ledger result code, or a short description for `pending`/`expired`. */
  result: string;
  status: SubmissionStatus;
  /** The transaction's LastLedgerSequence, when known. */
  lastLedgerSequence?: number;
  /** The last validated ledger observed while polling, when known. */
  lastValidatedLedger?: number;
}

export interface PollOptions {
  /** Delay between polls in ms (default 2000). */
  intervalMs?: number;
  /** Maximum number of polls (default 30). */
  maxAttempts?: number;
}

/**
 * Submit a signed transaction blob and poll until it is validated, expires,
 * or the polling budget runs out.
 *
 * Reliable submission: a transaction that has passed its LastLedgerSequence
 * without validating is reported as `expired` (final), while one that is
 * merely still in flight is reported as `pending` (not final). Previously both
 * came back as a free-text "not yet validated" result that callers treated as
 * a failure, which invited resending a payment that could still validate.
 */
export async function submitAndPoll(
  rpcUrl: string,
  signedTxBlob: string,
  txHash: string,
  lastLedgerSequence?: number,
  options: PollOptions = {}
): Promise<SubmissionOutcome> {
  const intervalMs = options.intervalMs ?? 2000;
  const maxAttempts = options.maxAttempts ?? 30;

  const submitResult = await rpcCall(rpcUrl, "submit", {
    tx_blob: signedTxBlob,
  });

  const engineResult = submitResult.engine_result;
  if (engineResult !== "tesSUCCESS" && engineResult !== "terQUEUED") {
    return {
      txHash,
      result: engineResult || "unknown",
      status: "rejected",
      lastLedgerSequence,
    };
  }

  let lastValidatedLedger: number | undefined;
  for (let i = 0; i < maxAttempts; i++) {
    if (intervalMs > 0) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    try {
      const txResult = await rpcCall(rpcUrl, "tx", { transaction: txHash });
      if (txResult.validated) {
        const meta = txResult.meta || {};
        return {
          txHash,
          result: meta.TransactionResult || engineResult || "tesSUCCESS",
          status: "validated",
          lastLedgerSequence,
          lastValidatedLedger: txResult.ledger_index ?? lastValidatedLedger,
        };
      }
    } catch {
      // tx not found yet (or transient RPC error); keep polling
    }

    if (lastLedgerSequence != null) {
      try {
        const serverInfo = await rpcCall(rpcUrl, "server_info", {});
        const validatedSeq = serverInfo.info?.validated_ledger?.seq;
        if (typeof validatedSeq === "number") {
          lastValidatedLedger = validatedSeq;
          if (validatedSeq > lastLedgerSequence) {
            // One last look: the tx may have validated in the final ledgers.
            try {
              const txResult = await rpcCall(rpcUrl, "tx", { transaction: txHash });
              if (txResult.validated) {
                const meta = txResult.meta || {};
                return {
                  txHash,
                  result: meta.TransactionResult || engineResult || "tesSUCCESS",
                  status: "validated",
                  lastLedgerSequence,
                  lastValidatedLedger: txResult.ledger_index ?? validatedSeq,
                };
              }
            } catch {
              // still not found: expired below
            }
            return {
              txHash,
              result: `expired: LastLedgerSequence ${lastLedgerSequence} passed (validated ledger ${validatedSeq}) without validation`,
              status: "expired",
              lastLedgerSequence,
              lastValidatedLedger: validatedSeq,
            };
          }
        }
      } catch {
        // server_info unavailable; expiry cannot be decided this round
      }
    }
  }

  return {
    txHash,
    result: `pending: submitted (${engineResult}) but not yet validated after ${Math.round((maxAttempts * intervalMs) / 1000)}s`,
    status: "pending",
    lastLedgerSequence,
    lastValidatedLedger,
  };
}

/**
 * Apply common autofill fields to a transaction: Sequence, Fee,
 * LastLedgerSequence (with 120-ledger buffer), and NetworkID for sidechains.
 */
function applyAutofill(txJson: any, ledger: LedgerInfo): any {
  txJson.Fee = ledger.feeDrops;
  txJson.Sequence = ledger.sequence;
  txJson.LastLedgerSequence = ledger.validatedSeq + 120;

  // PFTL is a sidechain and requires NetworkID in transactions
  if (ledger.networkId != null && ledger.networkId > 1024) {
    txJson.NetworkID = ledger.networkId;
  }

  return txJson;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Prepare a Payment transaction with an optional memo (pointer or envelope).
 * Supports both PFT drop amounts (string) and issued currency amounts (object).
 * Returns the autofilled, unsigned transaction JSON.
 *
 * Uses HTTP JSON-RPC (no WebSocket dependency).
 */
export async function preparePayment(
  config: Config,
  wallet: Wallet,
  destination: string,
  amount: PftlAmount,
  memo?: {
    memoTypeHex: string;
    memoFormatHex: string;
    memoDataHex: string;
  }
): Promise<PreparedTransaction> {
  const ledger = await fetchLedgerInfo(config.pftlRpcUrl, wallet.address);

  const payment: any = {
    TransactionType: "Payment",
    Account: wallet.address,
    Destination: destination,
    Amount: amount || "1",
  };

  if (memo) {
    payment.Memos = [
      {
        Memo: {
          MemoType: memo.memoTypeHex,
          MemoFormat: memo.memoFormatHex,
          MemoData: memo.memoDataHex,
        },
      },
    ];
  }

  applyAutofill(payment, ledger);

  return {
    txJson: payment,
    fee: payment.Fee || "12",
  };
}

/**
 * Sign and submit a prepared transaction.
 * Uses HTTP JSON-RPC with polling (no WebSocket dependency).
 */
export async function signAndSubmit(
  config: Config,
  wallet: Wallet,
  txJson: any
): Promise<SubmissionOutcome> {
  const signed = wallet.sign(txJson);
  return submitAndPoll(
    config.pftlRpcUrl,
    signed.tx_blob,
    signed.hash,
    typeof txJson.LastLedgerSequence === "number" ? txJson.LastLedgerSequence : undefined
  );
}

/**
 * Publish the bot's X25519 encryption public key as the MessageKey on the PFTL ledger.
 * Uses HTTP JSON-RPC (no WebSocket dependency).
 */
export async function publishMessageKey(
  config: Config,
  wallet: Wallet,
  messageKeyHex: string
): Promise<SubmissionOutcome> {
  const ledger = await fetchLedgerInfo(config.pftlRpcUrl, wallet.address);

  const txJson: any = {
    TransactionType: "AccountSet",
    Account: wallet.address,
    MessageKey: messageKeyHex,
  };

  applyAutofill(txJson, ledger);

  const signed = wallet.sign(txJson);
  return submitAndPoll(
    config.pftlRpcUrl,
    signed.tx_blob,
    signed.hash,
    txJson.LastLedgerSequence
  );
}

/**
 * Create a Wallet from a seed string.
 * Handles both hex seeds (starting with 's') and mnemonic phrases.
 */
export function walletFromSeed(seed: string): Wallet {
  // If it looks like a mnemonic (contains spaces), use fromMnemonic
  if (seed.includes(" ")) {
    return Wallet.fromMnemonic(seed);
  }
  // Otherwise treat as a secret/seed
  return Wallet.fromSeed(seed);
}
