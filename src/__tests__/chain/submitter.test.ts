import { afterEach, describe, expect, it, vi } from "vitest";
import { submitAndPoll } from "../../chain/submitter.js";

type Handler = (method: string, params: any) => any;

/** Mock global fetch with a JSON-RPC dispatcher; records the method sequence. */
function mockRpc(handler: Handler): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body.method);
      const result = handler(body.method, body.params?.[0] ?? {});
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ result }),
      };
    })
  );
  return { calls };
}

const RPC = "http://rpc.test/";
const HASH = "AB".repeat(32);
const NOT_FOUND = { error: "txnNotFound", error_message: "Transaction not found." };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submitAndPoll", () => {
  it("reports a validated transaction with the ledger result", async () => {
    let txLookups = 0;
    mockRpc((method) => {
      if (method === "submit") return { engine_result: "tesSUCCESS" };
      if (method === "tx") {
        txLookups += 1;
        return txLookups < 2
          ? NOT_FOUND
          : { validated: true, ledger_index: 1005, meta: { TransactionResult: "tesSUCCESS" } };
      }
      if (method === "server_info") return { info: { validated_ledger: { seq: 1004 } } };
      throw new Error(`unexpected ${method}`);
    });
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 5 });
    expect(outcome).toMatchObject({
      txHash: HASH,
      status: "validated",
      result: "tesSUCCESS",
      lastLedgerSequence: 1120,
      lastValidatedLedger: 1005,
    });
  });

  it("surfaces a tec result from the validated ledger as validated, not success", async () => {
    mockRpc((method) => {
      if (method === "submit") return { engine_result: "tesSUCCESS" };
      if (method === "tx") return { validated: true, meta: { TransactionResult: "tecUNFUNDED_PAYMENT" } };
      if (method === "server_info") return { info: { validated_ledger: { seq: 1 } } };
      throw new Error(`unexpected ${method}`);
    });
    const outcome = await submitAndPoll(RPC, "blob", HASH, 100, { intervalMs: 0, maxAttempts: 2 });
    expect(outcome.status).toBe("validated");
    expect(outcome.result).toBe("tecUNFUNDED_PAYMENT");
  });

  it("reports expiry once the validated ledger passes LastLedgerSequence and stops polling", async () => {
    let validatedSeq = 1118;
    const { calls } = mockRpc((method) => {
      if (method === "submit") return { engine_result: "tesSUCCESS" };
      if (method === "tx") return NOT_FOUND;
      if (method === "server_info") {
        validatedSeq += 1;
        return { info: { validated_ledger: { seq: validatedSeq } } };
      }
      throw new Error(`unexpected ${method}`);
    });
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 30 });
    expect(outcome.status).toBe("expired");
    expect(outcome.result).toContain("LastLedgerSequence 1120");
    expect(outcome.lastValidatedLedger).toBe(1121);
    // seq 1119 and 1120 do not expire; 1121 does: three server_info calls, then stop.
    expect(calls.filter((m) => m === "server_info")).toHaveLength(3);
    expect(calls.filter((m) => m === "tx")).toHaveLength(4); // 3 polls + 1 final look
  });

  it("does not report expiry for a transaction that validated in the final ledgers", async () => {
    let txLookups = 0;
    mockRpc((method) => {
      if (method === "submit") return { engine_result: "terQUEUED" };
      if (method === "tx") {
        txLookups += 1;
        // Not found on the regular poll, found on the final look after expiry.
        return txLookups === 2
          ? { validated: true, ledger_index: 1120, meta: { TransactionResult: "tesSUCCESS" } }
          : NOT_FOUND;
      }
      if (method === "server_info") return { info: { validated_ledger: { seq: 1121 } } };
      throw new Error(`unexpected ${method}`);
    });
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 30 });
    expect(outcome.status).toBe("validated");
    expect(outcome.result).toBe("tesSUCCESS");
  });

  it("reports pending, not failure, when the polling budget runs out before expiry", async () => {
    const { calls } = mockRpc((method) => {
      if (method === "submit") return { engine_result: "tesSUCCESS" };
      if (method === "tx") return NOT_FOUND;
      if (method === "server_info") return { info: { validated_ledger: { seq: 1010 } } };
      throw new Error(`unexpected ${method}`);
    });
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 3 });
    expect(outcome.status).toBe("pending");
    expect(outcome.result).toMatch(/^pending: submitted \(tesSUCCESS\)/);
    expect(outcome.lastLedgerSequence).toBe(1120);
    expect(outcome.lastValidatedLedger).toBe(1010);
    expect(calls.filter((m) => m === "tx")).toHaveLength(3);
  });

  it("reports a non-success submit result as rejected without polling", async () => {
    const { calls } = mockRpc((method) => {
      if (method === "submit") return { engine_result: "tefPAST_SEQ" };
      throw new Error(`unexpected ${method}`);
    });
    const outcome = await submitAndPoll(RPC, "blob", HASH, 1120, { intervalMs: 0, maxAttempts: 3 });
    expect(outcome).toMatchObject({ status: "rejected", result: "tefPAST_SEQ", txHash: HASH });
    expect(calls).toEqual(["submit"]);
  });

  it("keeps polling to the budget when LastLedgerSequence is unknown", async () => {
    const { calls } = mockRpc((method) => {
      if (method === "submit") return { engine_result: "tesSUCCESS" };
      if (method === "tx") return NOT_FOUND;
      throw new Error(`unexpected ${method}`);
    });
    const outcome = await submitAndPoll(RPC, "blob", HASH, undefined, { intervalMs: 0, maxAttempts: 2 });
    expect(outcome.status).toBe("pending");
    expect(calls.filter((m) => m === "server_info")).toHaveLength(0);
  });
});
