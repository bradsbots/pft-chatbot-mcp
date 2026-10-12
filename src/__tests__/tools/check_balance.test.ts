import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config } from "../../config.js";
import type { BotKeypair } from "../../crypto/keys.js";

vi.mock("../../chain/scanner.js", () => ({
  getAccountInfo: vi.fn(),
  getAccountLines: vi.fn(),
}));

import { getAccountInfo, getAccountLines } from "../../chain/scanner.js";
import { executeCheckBalance } from "../../tools/check_balance.js";
import { executeGetWalletInfo } from "../../tools/get_wallet_info.js";

const mockAccountInfo = vi.mocked(getAccountInfo);
const mockAccountLines = vi.mocked(getAccountLines);

const config = {
  pftlRpcUrl: "https://rpc.example.invalid",
  keystoneGrpcUrl: "grpc.example.invalid:443",
} as Config;

const keypair = {
  address: "rTestAddress",
  wallet: { publicKey: "ED00" },
  x25519PublicKey: new Uint8Array(32),
  x25519PrivateKey: new Uint8Array(32),
} as unknown as BotKeypair;

const trustLine = {
  currency: "PFT",
  issuer: "rIssuer",
  balance: "12.5",
  limit: "1000",
};

// Exact drops -> PFT, including values at and above 2^53 drops.
const exactCases: Array<[string, string]> = [
  ["0", "0.000000"],
  ["1", "0.000001"],
  ["1000000", "1.000000"],
  ["1500000", "1.500000"],
  ["9007199254740991", "9007199254.740991"],
  ["9007199254740993", "9007199254.740993"],
  ["99999999999999999", "99999999999.999999"],
  ["100000000000000000", "100000000000.000000"],
];

// Anything that is not a plain digit string is passed through unchanged.
const fallbackCases = ["", "abc", "-5", "1.5"];

const tools = [
  ["check_balance", executeCheckBalance],
  ["get_wallet_info", executeGetWalletInfo],
] as const;

beforeEach(() => {
  mockAccountInfo.mockReset();
  mockAccountLines.mockReset();
  mockAccountLines.mockResolvedValue([trustLine]);
});

describe.each(tools)("%s native_balance", (_name, execute) => {
  async function run(drops: string) {
    mockAccountInfo.mockResolvedValue({ publicKey: "ED00", balance: drops });
    return JSON.parse(await execute(config, keypair));
  }

  it.each(exactCases)("drops %s -> pft %s", async (drops, pft) => {
    const out = await run(drops);
    expect(out.native_balance).toEqual({ pft, drops });
    expect(out.wallet_address).toBe("rTestAddress");
  });

  it.each(fallbackCases)("non-digit drops %j passes through as pft", async (drops) => {
    const out = await run(drops);
    expect(out.native_balance).toEqual({ pft: drops, drops });
  });
});

describe("other response fields are unchanged", () => {
  it("check_balance keeps trust_lines", async () => {
    mockAccountInfo.mockResolvedValue({ publicKey: "ED00", balance: "1500000" });
    const out = JSON.parse(await executeCheckBalance(config, keypair));
    expect(Object.keys(out)).toEqual(["wallet_address", "native_balance", "trust_lines"]);
    expect(out.trust_lines).toEqual([trustLine]);
  });

  it("get_wallet_info keeps keys, trust line status and endpoints", async () => {
    mockAccountInfo.mockResolvedValue({ publicKey: "ED00", balance: "1500000" });
    const out = JSON.parse(await executeGetWalletInfo(config, keypair));
    expect(out.public_signing_key).toBe("ED00");
    expect(out.x25519_encryption_key).toBe("00".repeat(32));
    expect(out.pft_trust_line).toEqual({ active: true, ...trustLine });
    expect(out.all_trust_lines).toEqual([trustLine]);
    expect(out.chain_rpc).toBe(config.pftlRpcUrl);
    expect(out.keystone_grpc).toBe(config.keystoneGrpcUrl);
  });
});
