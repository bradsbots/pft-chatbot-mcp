import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../chain/submitter.js", () => ({
  preparePayment: vi.fn(async () => ({
    txJson: { TransactionType: "Payment" },
    fee: "12",
  })),
  signAndSubmit: vi.fn(async () => ({
    txHash: "ABC123",
    result: "tesSUCCESS",
  })),
}));

import { preparePayment, signAndSubmit } from "../../chain/submitter.js";
import { executeSendPft } from "../../tools/send_pft.js";

const mockPrepare = vi.mocked(preparePayment);
const mockSubmit = vi.mocked(signAndSubmit);

const config = {} as any;
const keypair = { wallet: { address: "rSender" } } as any;

function send(params: { amount_pft?: string; amount_drops?: string }) {
  return executeSendPft(config, keypair, { recipient: "rRecipient", ...params });
}

beforeEach(() => {
  mockPrepare.mockClear();
  mockSubmit.mockClear();
});

describe("executeSendPft amount_pft", () => {
  it.each([
    ["1", "1000000"],
    ["1000000", "1000000000000"],
    ["0.000001", "1"],
    ["10", "10000000"],
    ["10.5", "10500000"],
    ["99999999999", "99999999999000000"],
    ["100000000000", "100000000000000000"],
    [" 10 ", "10000000"],
  ])("accepts %j as %s drops", async (input, drops) => {
    const out = JSON.parse(await send({ amount_pft: input }));
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(mockPrepare.mock.calls[0][3]).toBe(drops);
    expect(out.amount_drops).toBe(drops);
  });

  it.each([
    "1e6",
    "1e21",
    "10abc",
    "+1",
    "-1",
    "0x10",
    "0.0000001",
    "1.1234567",
    "NaN",
    "Infinity",
    "   ",
    "0",
    "0.000000",
    ".5",
    "1.",
    "100000000000.000001",
  ])("refuses %j before preparePayment", async (input) => {
    await expect(send({ amount_pft: input })).rejects.toThrow(
      /^Invalid amount_pft: /
    );
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});

describe("executeSendPft amount_drops", () => {
  it.each([
    ["1", "1"],
    ["1000000", "1000000"],
    ["100000000000000000", "100000000000000000"],
    [" 25 ", "25"],
  ])("accepts %j as %s drops", async (input, drops) => {
    const out = JSON.parse(await send({ amount_drops: input }));
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(mockPrepare.mock.calls[0][3]).toBe(drops);
    expect(out.amount_drops).toBe(drops);
  });

  it.each([
    "1e6",
    "1.9",
    "25abc",
    "+5",
    "-5",
    "0x10",
    "NaN",
    "Infinity",
    "   ",
    "0",
    "100000000000000001",
  ])("refuses %j before preparePayment", async (input) => {
    await expect(send({ amount_drops: input })).rejects.toThrow(
      /^Invalid amount_drops: /
    );
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});

describe("executeSendPft amount selection", () => {
  it("refuses when neither amount is provided", async () => {
    await expect(send({ amount_pft: "", amount_drops: "" })).rejects.toThrow(
      "Either amount_pft or amount_drops must be provided."
    );
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it("uses amount_pft when both are provided", async () => {
    await send({ amount_pft: "2", amount_drops: "5" });
    expect(mockPrepare.mock.calls[0][3]).toBe("2000000");
  });
});
