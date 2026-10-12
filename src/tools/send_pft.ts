import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { preparePayment, signAndSubmit } from "../chain/submitter.js";

export const sendPftSchema = z.object({
  recipient: z
    .string()
    .describe("Destination PFTL wallet address (r-address)"),
  amount_pft: z
    .string()
    .optional()
    .describe('PFT amount to send (e.g. "10"). Mutually exclusive with amount_drops.'),
  amount_drops: z
    .string()
    .optional()
    .describe("PFT amount in drops (1 PFT = 1,000,000 drops). Mutually exclusive with amount_pft."),
});

export type SendPftParams = z.infer<typeof sendPftSchema>;

/**
 * Format a drop amount as PFT with exactly six fractional digits, using BigInt
 * quotient/remainder so amounts above Number.MAX_SAFE_INTEGER stay exact
 * (1 PFT = 1,000,000 drops).
 */
export function formatDropsAsPft(drops: bigint | string): string {
  const value = BigInt(drops);
  const whole = value / 1_000_000n;
  const fraction = value % 1_000_000n;
  return `${whole}.${fraction.toString().padStart(6, "0")}`;
}

/**
 * Send PFT to an address without attaching a message.
 * Lightweight transfer for payments, tipping, and funding other wallets.
 */
export async function executeSendPft(
  config: Config,
  keypair: BotKeypair,
  params: SendPftParams
): Promise<string> {
  // Validate that at least one amount is provided
  if (!params.amount_pft && !params.amount_drops) {
    throw new Error("Either amount_pft or amount_drops must be provided.");
  }

  // Determine PFT amount in drops. Only a complete decimal token is accepted
  // (surrounding whitespace is trimmed): amount_pft must match
  // /^\d+(\.\d{1,6})?$/ (6 decimals = drop precision) and amount_drops must
  // match /^\d+$/. Exponents, signs, hex, suffixes, NaN/Infinity and extra
  // decimals are refused instead of being silently reinterpreted by
  // parseFloat/parseInt. Conversion uses exact BigInt arithmetic, and the
  // result must be between 1 drop and MAX_DROPS. MAX_DROPS is the XRPL
  // maximum (100,000,000,000 PFT = 1e17 drops), assumed to apply to PFTL.
  const MAX_DROPS = 100_000_000_000_000_000n;
  let amountDrops: string;
  if (params.amount_pft) {
    const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(params.amount_pft.trim());
    const drops = match
      ? BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"))
      : 0n;
    if (!match || drops < 1n || drops > MAX_DROPS) {
      throw new Error(
        `Invalid amount_pft: "${params.amount_pft}". Must be a positive decimal PFT amount (digits, optional "." and at most 6 decimals; no exponent, sign or suffix) between 0.000001 and 100000000000.`
      );
    }
    amountDrops = drops.toString();
  } else {
    const match = /^\d+$/.exec(params.amount_drops!.trim());
    const drops = match ? BigInt(match[0]) : 0n;
    if (!match || drops < 1n || drops > MAX_DROPS) {
      throw new Error(
        `Invalid amount_drops: "${params.amount_drops}". Must be a positive integer of digits only (no exponent, sign, decimal point or suffix) between 1 and 100000000000000000.`
      );
    }
    amountDrops = drops.toString();
  }

  // Prepare payment (no memo)
  const prepared = await preparePayment(
    config,
    keypair.wallet,
    params.recipient,
    amountDrops
  );

  // Sign and submit
  const submitResult = await signAndSubmit(
    config,
    keypair.wallet,
    prepared.txJson
  );

  const pftSent = formatDropsAsPft(amountDrops);

  return JSON.stringify(
    {
      tx_hash: submitResult.txHash,
      result: submitResult.result,
      recipient: params.recipient,
      amount_pft: pftSent,
      amount_drops: amountDrops,
      fee_drops: prepared.fee,
    },
    null,
    2
  );
}
