import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("loadConfig – TASKNODE_ENCRYPTION_PUBKEY", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, BOT_SEED: "test-seed-for-config-tests" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  async function freshLoadConfig() {
    const mod = await import("../config.js?t=" + Date.now());
    return mod.loadConfig();
  }

  it("uses testnet default key when env var is unset", async () => {
    delete process.env.TASKNODE_ENCRYPTION_PUBKEY;
    const config = await freshLoadConfig();
    expect(config.tasknodeEncryptionKey).toBeInstanceOf(Uint8Array);
    expect(config.tasknodeEncryptionKey!.length).toBe(32);
    expect(config.tasknodeKeySource).toBe("testnet default");
  });

  it("disables sharing when set to empty string", async () => {
    process.env.TASKNODE_ENCRYPTION_PUBKEY = "";
    const config = await freshLoadConfig();
    expect(config.tasknodeEncryptionKey).toBeNull();
    expect(config.tasknodeKeySource).toBeNull();
  });

  it("disables sharing when set to 'none'", async () => {
    process.env.TASKNODE_ENCRYPTION_PUBKEY = "none";
    const config = await freshLoadConfig();
    expect(config.tasknodeEncryptionKey).toBeNull();
    expect(config.tasknodeKeySource).toBeNull();
  });

  it("accepts a valid 32-byte base64 key", async () => {
    const validKey = Buffer.alloc(32, 0x42).toString("base64");
    process.env.TASKNODE_ENCRYPTION_PUBKEY = validKey;
    const config = await freshLoadConfig();
    expect(config.tasknodeEncryptionKey).toBeInstanceOf(Uint8Array);
    expect(config.tasknodeEncryptionKey!.length).toBe(32);
    expect(config.tasknodeKeySource).toBe("custom key");
  });

  it("throws on invalid base64 / wrong length", async () => {
    process.env.TASKNODE_ENCRYPTION_PUBKEY = "dG9vc2hvcnQ="; // "tooshort" -> 8 bytes
    await expect(freshLoadConfig()).rejects.toThrow("expected 32 bytes");
  });
});

describe("loadConfig – IPFS_MAX_FETCH_BYTES", () => {
  const ORIGINAL_ENV = process.env;
  const DEFAULT_BOUND = 16 * 1024 * 1024;
  let warnings: string[];
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, BOT_SEED: "test-seed-for-config-tests" };
    delete process.env.IPFS_MAX_FETCH_BYTES;
    warnings = [];
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    }) as never);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    process.env = ORIGINAL_ENV;
  });

  let importSerial = 0;
  async function freshLoadConfig() {
    const mod = await import("../config.js?t=" + Date.now() + String(importSerial++));
    return mod.loadConfig();
  }

  // A 400-digit value parsed to Infinity, which the gateway accepted as a
  // bound "greater than zero" and every body length compared below it.
  it("keeps the default and a finite bound for a 400-digit value", async () => {
    process.env.IPFS_MAX_FETCH_BYTES = "9".repeat(400);
    const config = await freshLoadConfig();
    expect(Number.isFinite(config.ipfsMaxFetchBytes)).toBe(true);
    expect(Number.isSafeInteger(config.ipfsMaxFetchBytes)).toBe(true);
    expect(config.ipfsMaxFetchBytes).toBe(DEFAULT_BOUND);
    expect(warnings.join("")).toContain("Invalid IPFS_MAX_FETCH_BYTES=");
  });

  it("keeps the default for a value above Number.MAX_SAFE_INTEGER", async () => {
    process.env.IPFS_MAX_FETCH_BYTES = "9007199254740992"; // MAX_SAFE_INTEGER + 1
    const config = await freshLoadConfig();
    expect(config.ipfsMaxFetchBytes).toBe(DEFAULT_BOUND);
    expect(warnings.join("")).toContain('Invalid IPFS_MAX_FETCH_BYTES="9007199254740992"');
  });

  // parseInt read a numeric prefix from each of these ("1e6" -> 1 byte,
  // "16M" -> 16 bytes, "1.5" -> 1 byte): they must warn and keep the default.
  it.each(["1e6", "16M", "1.5", "0x10", "+1024", "1_000", "0", "-5", "junk"])(
    "warns and keeps the default bound for IPFS_MAX_FETCH_BYTES=%s",
    async (value) => {
      process.env.IPFS_MAX_FETCH_BYTES = value;
      const config = await freshLoadConfig();
      expect(config.ipfsMaxFetchBytes).toBe(DEFAULT_BOUND);
      expect(warnings.join("")).toContain(`Invalid IPFS_MAX_FETCH_BYTES="${value}"`);
    }
  );

  it("accepts a complete decimal token, padded, down to one byte and up to MAX_SAFE_INTEGER", async () => {
    process.env.IPFS_MAX_FETCH_BYTES = " 1048576 ";
    let config = await freshLoadConfig();
    expect(config.ipfsMaxFetchBytes).toBe(1_048_576);

    process.env.IPFS_MAX_FETCH_BYTES = "1";
    config = await freshLoadConfig();
    expect(config.ipfsMaxFetchBytes).toBe(1);

    process.env.IPFS_MAX_FETCH_BYTES = "9007199254740991";
    config = await freshLoadConfig();
    expect(config.ipfsMaxFetchBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(warnings.join("")).not.toContain("Invalid");
  });

  it("uses the default when unset or blank", async () => {
    let config = await freshLoadConfig();
    expect(config.ipfsMaxFetchBytes).toBe(DEFAULT_BOUND);

    process.env.IPFS_MAX_FETCH_BYTES = "  ";
    config = await freshLoadConfig();
    expect(config.ipfsMaxFetchBytes).toBe(DEFAULT_BOUND);
    expect(warnings.join("")).not.toContain("Invalid");
  });
});
