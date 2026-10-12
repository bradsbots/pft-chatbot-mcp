import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  /** Bot wallet seed (mnemonic or hex). REQUIRED. */
  botSeed: string;
  /** PFTL chain JSON-RPC endpoint */
  pftlRpcUrl: string;
  /** PFTL chain WebSocket endpoint */
  pftlWssUrl: string;
  /** Primary IPFS gateway for reads (falls back to public gateways) */
  ipfsGatewayUrl: string;
  /** Upper bound on bytes read from a gateway for one CID (default 16 MiB; the gateway falls back to the default when absent) */
  ipfsMaxFetchBytes?: number;
  /** Keystone gRPC service URL */
  keystoneGrpcUrl: string;
  /** Keystone API key (auto-provisioned on first register_bot call) */
  keystoneApiKey: string | null;
  /** Ping interval in ms (default 900000 = 15 min, 0 = disabled) */
  pingIntervalMs: number;
  /** Decoded X25519 public key for tasknode encryption (32 bytes), or null if disabled */
  tasknodeEncryptionKey: Uint8Array | null;
  /** Human-readable label for startup log: "testnet default" | "custom key" | null */
  tasknodeKeySource: string | null;
}

const API_KEY_CACHE_FILE = ".keystone-api-key";

function loadCachedApiKey(): string | null {
  const keyPath = resolve(process.cwd(), API_KEY_CACHE_FILE);
  if (existsSync(keyPath)) {
    try {
      return readFileSync(keyPath, "utf-8").trim();
    } catch {
      return null;
    }
  }
  return null;
}

export function cacheApiKey(apiKey: string): void {
  const keyPath = resolve(process.cwd(), API_KEY_CACHE_FILE);
  writeFileSync(keyPath, apiKey, { mode: 0o600 });
}

/**
 * Load the bot seed from environment or file.
 *
 * Priority: BOT_SEED env var > BOT_SEED_FILE env var (path to file containing seed)
 *
 * Using BOT_SEED_FILE is recommended for production as it avoids having
 * the seed in environment variable listings or shell history.
 */
function loadBotSeed(): string {
  if (process.env.BOT_SEED) {
    return process.env.BOT_SEED;
  }

  if (process.env.BOT_SEED_FILE) {
    const seedPath = resolve(process.cwd(), process.env.BOT_SEED_FILE);
    if (!existsSync(seedPath)) {
      throw new Error(`BOT_SEED_FILE points to ${seedPath} but the file does not exist.`);
    }
    const seed = readFileSync(seedPath, "utf-8").trim();
    if (!seed) {
      throw new Error(`BOT_SEED_FILE at ${seedPath} is empty.`);
    }
    return seed;
  }

  throw new Error(
    "BOT_SEED or BOT_SEED_FILE environment variable is required.\n" +
      "  BOT_SEED: set directly to your PFTL wallet mnemonic or hex seed\n" +
      "  BOT_SEED_FILE: path to a file containing the seed (more secure)\n" +
      "See .env.example for details."
  );
}

const TESTNET_TASKNODE_PUBKEY = "knyyRfO9ws9JmIHjOA7v0x4+hjflnKeGIhLVS/G0BwM=";
const X25519_KEY_LENGTH = 32;

function loadTasknodeKey(): { key: Uint8Array | null; source: string | null } {
  const envVal = process.env.TASKNODE_ENCRYPTION_PUBKEY;

  if (envVal === "" || envVal === "none") {
    return { key: null, source: null };
  }

  const b64 = envVal || TESTNET_TASKNODE_PUBKEY;
  const source = envVal ? "custom key" : "testnet default";

  const decoded = Buffer.from(b64, "base64");
  if (decoded.length !== X25519_KEY_LENGTH) {
    throw new Error(
      `Invalid TASKNODE_ENCRYPTION_PUBKEY: expected ${X25519_KEY_LENGTH} bytes after base64 decode, ` +
        `got ${decoded.length}. Set to "none" to disable tasknode sharing.`
    );
  }

  return { key: new Uint8Array(decoded), source };
}

export const DEFAULT_IPFS_MAX_FETCH_BYTES = 16 * 1024 * 1024;
export const DEFAULT_PING_INTERVAL_MS = 900_000;
/**
 * Largest delay Node's setTimeout/setInterval honour: 2^31-1 ms (~24.8 days).
 * Anything larger emits TimeoutOverflowWarning and Node resets the delay to
 * 1 ms, which would turn the ping loop into a hot loop.
 */
export const MAX_PING_INTERVAL_MS = 2_147_483_647;

/**
 * Parse an integer env setting from its whole trimmed token. parseInt reads
 * only a numeric prefix ("5e3" -> 5, "15m" -> 15, "0.5" -> 0), which would
 * silently turn a mis-typed value into a tiny interval or bound instead of
 * the documented warn-and-default. Anything other than a run of decimal
 * digits within [`minimum`, `maximum`] warns on stderr and falls back, as
 * before. `maximum` defaults to Number.MAX_SAFE_INTEGER.
 */
function parseIntegerEnv(
  name: string,
  envVal: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number = Number.MAX_SAFE_INTEGER
): number {
  if (envVal === undefined || envVal.trim() === "") return fallback;
  const token = envVal.trim();
  const parsed = /^\d+$/.test(token) ? Number(token) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    process.stderr.write(
      `[config] WARN – Invalid ${name}="${envVal}", using default ${fallback}\n`
    );
    return fallback;
  }
  return parsed;
}

function parseIpfsMaxFetchBytes(envVal: string | undefined): number {
  return parseIntegerEnv("IPFS_MAX_FETCH_BYTES", envVal, DEFAULT_IPFS_MAX_FETCH_BYTES, 1);
}

function parsePingInterval(envVal: string | undefined): number {
  return parseIntegerEnv("PING_INTERVAL_MS", envVal, DEFAULT_PING_INTERVAL_MS, 0, MAX_PING_INTERVAL_MS);
}

export function loadConfig(): Config {
  const botSeed = loadBotSeed();

  const keystoneApiKey =
    process.env.KEYSTONE_API_KEY || loadCachedApiKey() || null;

  const { key: tasknodeEncryptionKey, source: tasknodeKeySource } =
    loadTasknodeKey();

  return {
    botSeed,
    pftlRpcUrl:
      process.env.PFTL_RPC_URL || "https://rpc.testnet.postfiat.org",
    pftlWssUrl:
      process.env.PFTL_WSS_URL || "wss://ws.testnet.postfiat.org",
    ipfsGatewayUrl:
      process.env.IPFS_GATEWAY_URL ||
      "https://ipfs-testnet.postfiat.org",
    ipfsMaxFetchBytes: parseIpfsMaxFetchBytes(process.env.IPFS_MAX_FETCH_BYTES),
    keystoneGrpcUrl:
      process.env.KEYSTONE_GRPC_URL || "keystone-grpc.postfiat.org:443",
    keystoneApiKey,
    pingIntervalMs: parsePingInterval(process.env.PING_INTERVAL_MS),
    tasknodeEncryptionKey,
    tasknodeKeySource,
  };
}
