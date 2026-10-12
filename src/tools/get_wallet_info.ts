import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { getAccountInfo, getAccountLines } from "../chain/scanner.js";

/**
 * Format a drops string as PFT with exactly 6 decimals, using BigInt so balances
 * above 2^53 drops are not rounded. Non-digit input is returned unchanged.
 */
function formatDropsAsPft(drops: string): string {
  if (!/^\d+$/.test(drops)) return drops;
  const d = BigInt(drops);
  return `${d / 1_000_000n}.${(d % 1_000_000n).toString().padStart(6, "0")}`;
}

export const getWalletInfoSchema = z.object({});

export type GetWalletInfoParams = z.infer<typeof getWalletInfoSchema>;

/**
 * Return the bot's wallet address, public key, encryption key, and trust line status.
 * Useful for onboarding flows and debugging connectivity issues.
 */
export async function executeGetWalletInfo(
  config: Config,
  keypair: BotKeypair
): Promise<string> {
  const [accountInfo, trustLines] = await Promise.all([
    getAccountInfo(config.pftlRpcUrl, keypair.address),
    getAccountLines(config.pftlRpcUrl, keypair.address),
  ]);

  const balanceDrops = accountInfo.balance;
  const balancePft = formatDropsAsPft(balanceDrops);

  // Determine PFT trust line status
  const pftTrustLine = trustLines.find(
    (tl) => tl.currency === "PFT" || tl.currency === "504654000000000000000000000000000000000000"
  );

  const trustLineStatus = pftTrustLine
    ? {
        active: true,
        currency: pftTrustLine.currency,
        issuer: pftTrustLine.issuer,
        balance: pftTrustLine.balance,
        limit: pftTrustLine.limit,
      }
    : { active: false };

  return JSON.stringify(
    {
      wallet_address: keypair.address,
      public_signing_key: keypair.wallet.publicKey,
      x25519_encryption_key: Buffer.from(keypair.x25519PublicKey).toString(
        "hex"
      ),
      native_balance: {
        pft: balancePft,
        drops: balanceDrops,
      },
      pft_trust_line: trustLineStatus,
      all_trust_lines: trustLines.map((tl) => ({
        currency: tl.currency,
        issuer: tl.issuer,
        balance: tl.balance,
        limit: tl.limit,
      })),
      chain_rpc: config.pftlRpcUrl,
      keystone_grpc: config.keystoneGrpcUrl,
    },
    null,
    2
  );
}
