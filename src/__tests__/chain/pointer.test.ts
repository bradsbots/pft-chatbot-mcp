import { describe, it, expect } from "vitest";
import {
  buildPfPointerMemo,
  buildKeystoneEnvelopeMemo,
  decodeKeystoneEnvelope,
  extractCidFromCoreMessage,
  POINTER_FLAGS,
} from "../../chain/pointer.js";

describe("buildPfPointerMemo", () => {
  it("builds a memo with CID and thread_id", async () => {
    const memo = await buildPfPointerMemo({
      cid: "bafkreiabcdefghijklmnopqrstuvwxyz",
      kind: "CHAT",
      schema: 1,
      threadId: "thread-123",
      flags: POINTER_FLAGS.encrypted,
    });

    expect(memo).toBeDefined();
    expect(memo.memoTypeHex).toBeDefined();
    expect(memo.memoDataHex).toBeDefined();
    expect(memo.memoFormatHex).toBeDefined();
    expect(memo.memoTypeHex).toMatch(/^[0-9a-fA-F]+$/);
    expect(memo.memoDataHex).toMatch(/^[0-9a-fA-F]+$/);
  });

  it("builds a memo without thread_id", async () => {
    const memo = await buildPfPointerMemo({
      cid: "bafkreitest",
      kind: "CHAT",
      schema: 1,
      flags: 0,
    });

    expect(memo).toBeDefined();
    expect(memo.memoTypeHex).toBeDefined();
    expect(memo.memoDataHex).toBeDefined();
  });

  it("POINTER_FLAGS has encrypted = 0x01", () => {
    expect(POINTER_FLAGS.encrypted).toBe(0x01);
  });
});

describe("buildKeystoneEnvelopeMemo", () => {
  const TEST_CID = "bafkreiege7kpyjhba67jlf4dvlx6tjzjpvbylnjlfkx6flbuyfkdr7g3qm";
  const TEST_HASH = "a".repeat(64);

  it("produces valid hex memo fields", async () => {
    const memo = await buildKeystoneEnvelopeMemo({
      cid: TEST_CID,
      contentHash: TEST_HASH,
      contentLength: 1024,
    });

    expect(memo.memoTypeHex).toBe("6b657973746f6e65");
    expect(memo.memoFormatHex).toBe("7631");
    expect(memo.memoDataHex).toMatch(/^[0-9a-f]+$/);
  });

  it("round-trips through decodeKeystoneEnvelope", async () => {
    const memo = await buildKeystoneEnvelopeMemo({
      cid: TEST_CID,
      contentHash: TEST_HASH,
      contentLength: 2048,
      contentType: "application/json",
    });

    const decoded = await decodeKeystoneEnvelope(memo.memoDataHex);

    expect(decoded.type).toBe("keystone");
    expect(decoded.version).toBe(1);
    expect(decoded.messageType).toBe("MESSAGE_TYPE_CORE");
    expect(decoded.encryption).toBe("ENCRYPTION_MODE_PUBLIC_KEY");
    expect(decoded.metadata?.cid).toBe(TEST_CID);
    expect(decoded.contentHash.toString("hex")).toBe(TEST_HASH);
  });

  it("embeds CID in CoreMessage recoverable via extractCidFromCoreMessage", async () => {
    const memo = await buildKeystoneEnvelopeMemo({
      cid: TEST_CID,
      contentHash: TEST_HASH,
      contentLength: 512,
    });

    const decoded = await decodeKeystoneEnvelope(memo.memoDataHex);
    const extractedCid = await extractCidFromCoreMessage(decoded.message);

    expect(extractedCid).toBe(TEST_CID);
  });

  it("extractCidFromCoreMessage returns null for empty buffer", async () => {
    const result = await extractCidFromCoreMessage(Buffer.alloc(0));
    expect(result).toBeNull();
  });

  it("accepts an uppercase 64-hex digest and round-trips 32 hash bytes and the CID", async () => {
    const hash = "AB".repeat(32);
    const memo = await buildKeystoneEnvelopeMemo({
      cid: TEST_CID,
      contentHash: hash,
      contentLength: 10,
    });
    const decoded = await decodeKeystoneEnvelope(memo.memoDataHex);
    expect(decoded.contentHash.length).toBe(32);
    expect(decoded.contentHash.toString("hex")).toBe(hash.toLowerCase());
    expect(decoded.metadata?.cid).toBe(TEST_CID);
    expect(await extractCidFromCoreMessage(decoded.message)).toBe(TEST_CID);
  });

  const refused: Array<[string, unknown, unknown]> = [
    ["non-hex hash", "zz".repeat(32), TEST_CID],
    ["odd-length hash", "abc", TEST_CID],
    ["hex prefix then junk", "ab".repeat(4) + "zz" + "ab".repeat(27), TEST_CID],
    ["63-hex hash", TEST_HASH.slice(0, 63), TEST_CID],
    ["65-hex hash", TEST_HASH + "a", TEST_CID],
    ["400-hex hash", "a".repeat(400), TEST_CID],
    ["64-hex hash with trailing newline", TEST_HASH + "\n", TEST_CID],
    ["0x-prefixed hash", "0x" + TEST_HASH, TEST_CID],
    ["empty hash", "", TEST_CID],
    ["null hash", null, TEST_CID],
    ["number hash", 123, TEST_CID],
    ["Buffer hash", Buffer.alloc(32, 0xab), TEST_CID],
    ["array hash", [TEST_HASH], TEST_CID],
    ["empty cid", TEST_HASH, ""],
    ["whitespace-only cid", TEST_HASH, "   "],
    ["leading-space cid", TEST_HASH, " " + TEST_CID],
    ["trailing-newline cid", TEST_HASH, TEST_CID + "\n"],
    ["ipfs://-prefixed cid", TEST_HASH, "ipfs://" + TEST_CID],
    ["null cid", TEST_HASH, null],
    ["number cid", TEST_HASH, 42],
    ["undefined cid", TEST_HASH, undefined],
  ];

  it.each(refused)("refuses %s before encoding", async (_label, contentHash, cid) => {
    await expect(
      buildKeystoneEnvelopeMemo({ cid, contentHash, contentLength: 10 } as any)
    ).rejects.toThrow(/Invalid Keystone envelope input/);
  });
});
