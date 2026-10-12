import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "xrpl";
import {
  resolveStartupMode,
  loadWalletConfig,
  StartupConfigError,
} from "../startup.js";

// Throwaway wallet generated per run; it never holds funds and is never logged.
const THROWAWAY = Wallet.generate();
const VALID_SEED = THROWAWAY.seed!;
const FAKE_SEED = "sEdNOTAREALSEEDxxxxxxxxxxxxxxx";

describe("resolveStartupMode", () => {
  const ORIGINAL_ENV = process.env;
  let dir: string;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.BOT_SEED;
    delete process.env.BOT_SEED_FILE;
    delete process.env.TASKNODE_ENCRYPTION_PUBKEY;
    dir = mkdtempSync(join(tmpdir(), "startup-mode-"));
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    rmSync(dir, { recursive: true, force: true });
  });

  const load = () => loadWalletConfig(process.env);

  async function expectFatal(secret: string | null): Promise<string> {
    let caught: unknown;
    try {
      await resolveStartupMode(process.env, load);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StartupConfigError);
    const message = (caught as Error).message;
    expect(message.startsWith("Fatal configuration error: ")).toBe(true);
    if (secret) {
      expect(message.includes(secret)).toBe(false);
      expect(message.includes(secret.trim())).toBe(false);
    }
    return message;
  }

  describe("accept", () => {
    it("both BOT_SEED and BOT_SEED_FILE unset -> setup mode, loader not called", async () => {
      const loader = vi.fn(load);
      const result = await resolveStartupMode(process.env, loader);
      expect(result).toEqual({ mode: "setup" });
      expect(loader).not.toHaveBeenCalled();
    });

    it("BOT_SEED set to empty string counts as unset -> setup mode", async () => {
      process.env.BOT_SEED = "";
      const result = await resolveStartupMode(process.env, load);
      expect(result).toEqual({ mode: "setup" });
    });

    it("valid BOT_SEED -> full mode with the derived wallet", async () => {
      process.env.BOT_SEED = VALID_SEED;
      const result = await resolveStartupMode(process.env, load);
      expect(result.mode).toBe("full");
      if (result.mode === "full") {
        expect(result.value.keypair.address).toBe(THROWAWAY.address);
      }
    });

    it("valid BOT_SEED_FILE -> full mode with the derived wallet", async () => {
      const seedPath = join(dir, "seed");
      writeFileSync(seedPath, VALID_SEED + "\n", { mode: 0o600 });
      process.env.BOT_SEED_FILE = seedPath;
      const result = await resolveStartupMode(process.env, load);
      expect(result.mode).toBe("full");
      if (result.mode === "full") {
        expect(result.value.keypair.address).toBe(THROWAWAY.address);
      }
    });
  });

  describe("refuse", () => {
    it("invalid BOT_SEED -> fatal, names BOT_SEED, seed not echoed", async () => {
      process.env.BOT_SEED = FAKE_SEED;
      const message = await expectFatal(FAKE_SEED);
      expect(message).toContain("BOT_SEED is not a valid wallet seed or mnemonic");
    });

    it("valid BOT_SEED with a trailing space -> fatal, seed not echoed", async () => {
      process.env.BOT_SEED = VALID_SEED + " ";
      const message = await expectFatal(VALID_SEED + " ");
      expect(message).toContain("BOT_SEED is not a valid wallet seed or mnemonic");
    });

    it("BOT_SEED_FILE pointing at a missing file -> fatal, names the file", async () => {
      const missing = join(dir, "no-such-seed");
      process.env.BOT_SEED_FILE = missing;
      const message = await expectFatal(null);
      expect(message).toContain(`BOT_SEED_FILE points to ${missing} but the file does not exist.`);
    });

    it("BOT_SEED_FILE holding an invalid seed -> fatal, names BOT_SEED_FILE, content not echoed", async () => {
      const seedPath = join(dir, "seed");
      writeFileSync(seedPath, FAKE_SEED, { mode: 0o600 });
      process.env.BOT_SEED_FILE = seedPath;
      const message = await expectFatal(FAKE_SEED);
      expect(message).toContain("BOT_SEED_FILE is not a valid wallet seed or mnemonic");
    });

    it('valid BOT_SEED + TASKNODE_ENCRYPTION_PUBKEY="dG9vc2hvcnQ=" -> fatal, names the key, seed not echoed', async () => {
      process.env.BOT_SEED = VALID_SEED;
      process.env.TASKNODE_ENCRYPTION_PUBKEY = "dG9vc2hvcnQ=";
      const message = await expectFatal(VALID_SEED);
      expect(message).toContain("Invalid TASKNODE_ENCRYPTION_PUBKEY: expected 32 bytes after base64 decode, got 8.");
    });

    it("a loader error that quotes BOT_SEED is redacted", async () => {
      process.env.BOT_SEED = VALID_SEED;
      let caught: unknown;
      try {
        await resolveStartupMode(process.env, () => {
          throw new Error(`bad seed ${VALID_SEED} here`);
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(StartupConfigError);
      expect((caught as Error).message).toBe("Fatal configuration error: bad seed [redacted] here");
    });
  });
});
