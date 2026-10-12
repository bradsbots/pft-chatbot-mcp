/**
 * Startup mode decision, kept out of index.ts so it can be unit-tested
 * (importing index.ts starts the server).
 *
 * Setup mode (only create_wallet) is for "no wallet configured": neither
 * BOT_SEED nor BOT_SEED_FILE is set. If either one is set, any failure while
 * loading the config or deriving the wallet is a configuration error and the
 * server must not start; silently falling back to setup mode would hide the
 * operator's wallet behind "No wallet configured".
 */

import { loadConfig, type Config } from "./config.js";
import { deriveBotKeypair, type BotKeypair } from "./crypto/keys.js";

export type StartupMode<T> = { mode: "setup" } | { mode: "full"; value: T };

/** A configuration error that should stop the server. Its message is safe to print. */
export class StartupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupConfigError";
  }
}

type SeedEnv = Record<string, string | undefined>;

/** True when BOT_SEED or BOT_SEED_FILE is set (non-empty, matching loadConfig). */
export function isWalletConfigured(env: SeedEnv): boolean {
  return Boolean(env.BOT_SEED) || Boolean(env.BOT_SEED_FILE);
}

function redactSeed(message: string, env: SeedEnv): string {
  let out = message;
  const seeds = [env.BOT_SEED, env.BOT_SEED?.trim()].filter(
    (s): s is string => typeof s === "string" && s.length > 0
  );
  for (const seed of seeds) {
    out = out.split(seed).join("[redacted]");
  }
  return out;
}

/**
 * Run `load` (load config, derive the wallet, ...) and decide the mode.
 *
 * - neither BOT_SEED nor BOT_SEED_FILE set -> { mode: "setup" } (load is not called)
 * - load succeeds                         -> { mode: "full", value }
 * - load fails                            -> throws StartupConfigError
 *   "Fatal configuration error: <cause>", with the BOT_SEED value redacted.
 */
export async function resolveStartupMode<T>(
  env: SeedEnv,
  load: () => T | Promise<T>
): Promise<StartupMode<T>> {
  if (!isWalletConfigured(env)) {
    return { mode: "setup" };
  }
  try {
    return { mode: "full", value: await load() };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new StartupConfigError(
      `Fatal configuration error: ${redactSeed(cause, env)}`
    );
  }
}

/**
 * Load the config and derive the bot wallet. A seed that cannot be turned into
 * a wallet is reported by the variable it came from, never by its value.
 * loadConfig reads process.env; `env` only names the seed source.
 */
export async function loadWalletConfig(
  env: SeedEnv
): Promise<{ config: Config; keypair: BotKeypair }> {
  const config = loadConfig();
  let keypair: BotKeypair;
  try {
    keypair = await deriveBotKeypair(config.botSeed);
  } catch {
    // The underlying xrpl error can quote characters of the seed, so it is
    // not passed on.
    const source = env.BOT_SEED ? "BOT_SEED" : "BOT_SEED_FILE";
    throw new Error(
      `${source} is not a valid wallet seed or mnemonic (check for typos or stray whitespace)`
    );
  }
  return { config, keypair };
}
