import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/", { headers });
}

describe("getRequestIp", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does NOT honor x-forwarded-for when DCM_TRUST_PROXY is unset (default)", async () => {
    vi.stubEnv("DCM_TRUST_PROXY", "");
    const { getRequestIp } = await import("../src/lib/request-ip");
    expect(getRequestIp(req({ "x-forwarded-for": "1.1.1.1" }))).toBe("direct");
    expect(getRequestIp(req({ "x-real-ip": "3.3.3.3" }))).toBe("direct");
  });

  it("honors x-forwarded-for when DCM_TRUST_PROXY=true", async () => {
    vi.stubEnv("DCM_TRUST_PROXY", "true");
    const { getRequestIp } = await import("../src/lib/request-ip");
    expect(getRequestIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("1.1.1.1");
    expect(getRequestIp(req({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
    expect(getRequestIp(req({}))).toBe("direct");
  });
});
