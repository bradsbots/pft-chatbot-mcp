import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { uploadContentSchema } from "../../tools/upload_content.js";

describe("uploadContentSchema", () => {
  it("accepts minimal params (content + content_type)", () => {
    const result = uploadContentSchema.safeParse({
      content: "Hello World",
      content_type: "text/plain",
    });
    expect(result.success).toBe(true);
  });

  it("accepts encrypt_for param", () => {
    const result = uploadContentSchema.safeParse({
      content: "c2VjcmV0",
      content_type: "application/pdf",
      encoding: "base64",
      encrypt_for: "rRecipientAddress123",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.encrypt_for).toBe("rRecipientAddress123");
    }
  });

  it("rejects invalid encoding", () => {
    const result = uploadContentSchema.safeParse({
      content: "x",
      content_type: "text/plain",
      encoding: "hex",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing content", () => {
    const result = uploadContentSchema.safeParse({
      content_type: "text/plain",
    });
    expect(result.success).toBe(false);
  });
});

describe("executeUploadContent size guard", () => {
  it("rejects content larger than 10 MB", async () => {
    const { executeUploadContent } = await import("../../tools/upload_content.js");
    const largeContent = "x".repeat(11 * 1024 * 1024);
    const dummyConfig = {
      botSeed: "", pftlRpcUrl: "", pftlWssUrl: "",
      ipfsGatewayUrl: "", keystoneGrpcUrl: "", keystoneApiKey: null, pingIntervalMs: 0,
      tasknodeEncryptionKey: null, tasknodeKeySource: null,
    };
    const mockGrpc = {} as any;
    await expect(
      executeUploadContent(dummyConfig, mockGrpc, {
        content: largeContent,
        content_type: "text/plain",
      })
    ).rejects.toThrow("too large for upload");
  });
});

describe("executeUploadContent base64 validation", () => {
  const dummyConfig = {
    botSeed: "", pftlRpcUrl: "", pftlWssUrl: "",
    ipfsGatewayUrl: "", keystoneGrpcUrl: "", keystoneApiKey: null, pingIntervalMs: 0,
    tasknodeEncryptionKey: null, tasknodeKeySource: null,
  };

  function makeGrpc() {
    const storeContent = vi.fn(async (buf: Buffer, contentType: string) => ({
      descriptor: {
        uri: "ipfs://bafytest",
        contentType,
        contentLength: buf.length,
        contentHash: null,
      },
    }));
    return { grpc: { storeContent } as any, storeContent };
  }

  async function upload(content: string, encoding: "utf8" | "base64" = "base64") {
    const { executeUploadContent } = await import("../../tools/upload_content.js");
    const { grpc, storeContent } = makeGrpc();
    const run = executeUploadContent(dummyConfig, grpc, {
      content,
      content_type: "application/octet-stream",
      encoding,
    });
    return { run, storeContent };
  }

  it.each([
    ["aGVsbG8=", "68656c6c6f"],
    ["aGVsbG8", "68656c6c6f"],
    ["aGVs\nbG8=", "68656c6c6f"],
    [" aGVs\r\n\tbG8= \n", "68656c6c6f"],
    ["AAAA", "000000"],
    ["AA==", "00"],
  ])("accepts %j and uploads exactly the decoded bytes", async (content, hex) => {
    const { run, storeContent } = await upload(content);
    const result = JSON.parse(await run);
    expect(storeContent).toHaveBeenCalledTimes(1);
    const sent = storeContent.mock.calls[0][0] as Buffer;
    expect(sent.toString("hex")).toBe(hex);
    expect(result.size).toBe(hex.length / 2);
  });

  it("accepts 1 MiB of base64 and uploads the decoded bytes unchanged", async () => {
    const raw = Buffer.alloc(786432);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + 7) & 0xff;
    const b64 = raw.toString("base64");
    expect(b64.length).toBe(1024 * 1024);
    const { run, storeContent } = await upload(b64);
    await run;
    const sent = storeContent.mock.calls[0][0] as Buffer;
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    expect(sent.length).toBe(raw.length);
    expect(sha(sent)).toBe(sha(raw));
  });

  it.each([
    ["Hello, world! plain text", 'character "," at offset 5 is outside the base64 alphabet (A-Z a-z 0-9 + /)'],
    ["%%", 'character "%" at offset 0 is outside the base64 alphabet (A-Z a-z 0-9 + /)'],
    ["aGVsbG8=garbage!!", 'data after "=" padding at offset 7'],
    ["", "empty after removing whitespace"],
    ["   ", "empty after removing whitespace"],
    ["aGVsbG8=!", 'data after "=" padding at offset 7'],
    ["a", "length 1 is 1 more than a multiple of 4"],
    // Over-padded: 9 characters, so the length rule fires first. Re-padding it
    // to 12 characters would not match the canonical "aGVsbG8=" either.
    ["aGVsbG8==", "length 9 is 1 more than a multiple of 4"],
    // base64url is a different alphabet (RFC 4648 section 5); callers must
    // convert "-" to "+" and "_" to "/" first.
    ["aGVs-bG8_", 'character "-" at offset 4 is outside the base64 alphabet (A-Z a-z 0-9 + /)'],
    ["====", 'more than two "=" padding characters'],
    ["==", "decodes to zero bytes"],
    // "9" sets trailing bits the decoder silently drops; canonical form is "aGVsbG8=".
    ["aGVsbG9=", "padding or trailing bits are not canonical"],
    ["AAAA==", "padding or trailing bits are not canonical"],
  ])("refuses %j before storeContent", async (content, reason) => {
    const { run, storeContent } = await upload(content);
    await expect(run).rejects.toThrow(`content is not valid base64: ${reason}`);
    expect(storeContent).not.toHaveBeenCalled();
  });

  it("refuses invalid base64 before the encryption path", async () => {
    const { executeUploadContent } = await import("../../tools/upload_content.js");
    const { grpc, storeContent } = makeGrpc();
    // No keypair: if validation ran after the encrypt branch, this would throw
    // "Bot keypair required" instead.
    await expect(
      executeUploadContent(dummyConfig, grpc, {
        content: "aGVsbG8=garbage!!",
        content_type: "application/octet-stream",
        encoding: "base64",
        encrypt_for: "rRecipientAddress123",
      })
    ).rejects.toThrow('content is not valid base64: data after "=" padding at offset 7');
    expect(storeContent).not.toHaveBeenCalled();
  });

  it("leaves utf8 encoding unchanged: \"%%\" uploads 2 bytes", async () => {
    const { run, storeContent } = await upload("%%", "utf8");
    await run;
    expect(storeContent).toHaveBeenCalledTimes(1);
    expect((storeContent.mock.calls[0][0] as Buffer).toString("hex")).toBe("2525");
  });
});
