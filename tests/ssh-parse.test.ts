import { describe, expect, it } from "vitest";
import {
  parseDarwinMem,
  parseDiskUsedPct,
  parseLinuxFree,
  parseLoadAvg,
  parseNvidiaSmi,
} from "../src/lib/ssh";

describe("parseLoadAvg", () => {
  it("parses Linux uptime format", () => {
    const s = " 22:00:15 up 5 days, load average: 0.42, 0.35, 0.30";
    expect(parseLoadAvg(s)).toBe(0.42);
  });
  it("parses macOS uptime format", () => {
    const s = "22:00 up 4 hrs, 2 users, load averages: 1.55 1.40 1.33";
    expect(parseLoadAvg(s)).toBe(1.55);
  });
  it("returns null when missing", () => {
    expect(parseLoadAvg("hello")).toBeNull();
  });
});

describe("parseLinuxFree", () => {
  it("parses `free -m` row", () => {
    const out = [
      "              total        used        free      shared  buff/cache   available",
      "Mem:           16000        8000        1000         200        7000        7500",
      "Swap:           2048         128        1920",
    ].join("\n");
    expect(parseLinuxFree(out)).toEqual({ total_mb: 16000, used_mb: 8000 });
  });
  it("returns null when unparseable", () => {
    expect(parseLinuxFree("garbage")).toBeNull();
  });
});

describe("parseDarwinMem", () => {
  it("computes used = total - (free + speculative)", () => {
    const out =
      "MEMSIZE:17179869184\n" +
      "Mach Virtual Memory Statistics: (page size of 4096 bytes)\n" +
      'Pages free:                            100000.\n' +
      'Pages active:                          500000.\n' +
      'Pages inactive:                        200000.\n' +
      'Pages speculative:                     50000.\n' +
      'Pages wired down:                      300000.\n';
    const mem = parseDarwinMem(out)!;
    expect(mem.total_mb).toBe(Math.round(17179869184 / (1024 * 1024)));
    // free + speculative = 150000 pages * 4096 = ~586 MB
    expect(mem.used_mb).toBe(mem.total_mb - 586);
  });
  it("returns null when MEMSIZE missing", () => {
    expect(parseDarwinMem("no memsize")).toBeNull();
  });
});

describe("parseDiskUsedPct", () => {
  it("parses df -P / output", () => {
    const out = [
      "Filesystem     1024-blocks      Used Available Capacity Mounted on",
      "/dev/disk3s1     488047928 123456789 364591139      26% /",
    ].join("\n");
    expect(parseDiskUsedPct(out)).toBe(26);
  });
  it("returns null when no root row", () => {
    expect(parseDiskUsedPct("Filesystem only")).toBeNull();
  });
});

describe("parseNvidiaSmi", () => {
  it("parses multi-GPU CSV", () => {
    const out = "NVIDIA A100, 81920, 4096, 42\nNVIDIA A100, 81920, 60000, 95\n";
    const gpus = parseNvidiaSmi(out)!;
    expect(gpus).toHaveLength(2);
    expect(gpus[0]).toEqual({
      name: "NVIDIA A100",
      memory_total_mb: 81920,
      memory_used_mb: 4096,
      util_pct: 42,
    });
    expect(gpus[1]!.util_pct).toBe(95);
  });
  it("returns null when empty", () => {
    expect(parseNvidiaSmi("")).toBeNull();
  });
});
