import { describe, expect, it } from "vitest";
import { isSameOrigin } from "../src/lib/csrf";

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/", { headers });
}

describe("csrf isSameOrigin", () => {
  it("allows matching origin and host", () => {
    expect(isSameOrigin(req({ origin: "http://localhost:3000", host: "localhost:3000" }))).toBe(true);
  });
  it("rejects mismatching origin", () => {
    expect(isSameOrigin(req({ origin: "http://evil.example", host: "localhost:3000" }))).toBe(false);
  });
  it("rejects missing origin", () => {
    expect(isSameOrigin(req({ host: "localhost:3000" }))).toBe(false);
  });
  it("rejects malformed origin", () => {
    expect(isSameOrigin(req({ origin: "not-a-url", host: "localhost:3000" }))).toBe(false);
  });
});
