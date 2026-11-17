import { expect, it } from "vitest";
import { ConversionContext, ProtocolError, ProtocolRegistry } from "../src/index.js";

it("retains diagnostics before refusing implicit loss", () => {
  const context = new ConversionContext("a", "b");
  expect(() => context.unsupported("/future", { secret: "synthetic" }, "unknown field")).toThrow(ProtocolError);
  expect(context.report.preserved[0]?.value).toEqual({ secret: "synthetic" });
  expect(context.report.ledger.dropped[0]?.path).toBe("/future");
});
it("requires both allow-loss and an exact omission path", () => {
  const context = new ConversionContext("a", "b", { policy: "allow-loss", omit: ["/future"] });
  context.unsupported("/future", 1, "unknown field");
  expect(() => context.unsupported("/other", 2, "unknown field")).toThrow(ProtocolError);
});
it("reports unknown protocols with a stable error code", () => {
  expect(() => new ProtocolRegistry().get("missing")).toThrowError(expect.objectContaining({ code: "UNKNOWN_PROTOCOL" }));
});
