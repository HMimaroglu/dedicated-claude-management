import { describe, expect, it } from "vitest";
import {
  parsePlan,
  parseStatusLine,
  plansAlign,
  validateParsedPlan,
} from "../src/orchestrator/plan-parser";

const goodPlan = `
## Plan

### Aspect 1: Database schema
- Description: design tables and migrations
- Depends on: none
- Acceptance criteria: migrations run cleanly on empty DB

### Aspect 2: API endpoints
- Description: CRUD routes for books
- Depends on: [1]
- Acceptance criteria: routes covered by integration tests

STATUS: NEED_ROUND
`;

describe("parsePlan", () => {
  it("extracts aspects with metadata", () => {
    const aspects = parsePlan(goodPlan);
    expect(aspects).toHaveLength(2);
    expect(aspects[0]!.ord).toBe(1);
    expect(aspects[0]!.title).toBe("Database schema");
    expect(aspects[0]!.depends_on).toEqual([]);
    expect(aspects[1]!.depends_on).toEqual([1]);
    expect(aspects[1]!.acceptance_criteria).toContain("integration tests");
  });
  it("returns empty when no aspects", () => {
    expect(parsePlan("just some prose")).toEqual([]);
  });
  it("tolerates variant bullet styles and spacing", () => {
    const text = `
### Aspect 1:   Thing One
*    Description:   a thing
*    Depends on: none
*    Acceptance criteria: yup
`;
    const out = parsePlan(text);
    expect(out[0]!.title).toBe("Thing One");
    expect(out[0]!.description).toBe("a thing");
  });
});

describe("parseStatusLine", () => {
  it("reads consensus", () => {
    expect(parseStatusLine("body\n\nSTATUS: CONSENSUS_REACHED").kind).toBe("consensus");
  });
  it("reads deadlock", () => {
    expect(parseStatusLine("STATUS: DEADLOCK").kind).toBe("deadlock");
  });
  it("reads need_round", () => {
    expect(parseStatusLine("STATUS: NEED_ROUND").kind).toBe("need_round");
  });
  it("handles markdown quote prefix on last line", () => {
    expect(parseStatusLine("> STATUS: CONSENSUS_REACHED").kind).toBe("consensus");
  });
  it("handles trailing whitespace/blank lines", () => {
    expect(parseStatusLine("STATUS: CONSENSUS_REACHED\n\n").kind).toBe("consensus");
  });
  it("unknown when no status line", () => {
    expect(parseStatusLine("just prose").kind).toBe("unknown");
  });
});

describe("plansAlign", () => {
  it("true for same structure", () => {
    const a = parsePlan(goodPlan);
    const b = parsePlan(goodPlan);
    expect(plansAlign(a, b)).toBe(true);
  });
  it("false when different titles", () => {
    const a = parsePlan(goodPlan);
    const b = parsePlan(goodPlan.replace("Database schema", "Totally different"));
    expect(plansAlign(a, b)).toBe(false);
  });
  it("false when different aspect counts", () => {
    const a = parsePlan(goodPlan);
    const extra = goodPlan +
      "\n### Aspect 3: extra\n- Description: e\n- Depends on: [2]\n- Acceptance criteria: e\n";
    const b = parsePlan(extra);
    expect(plansAlign(a, b)).toBe(false);
  });
  it("case-insensitive title comparison", () => {
    const a = parsePlan(goodPlan);
    const b = parsePlan(goodPlan.replace("Database schema", "DATABASE SCHEMA"));
    expect(plansAlign(a, b)).toBe(true);
  });
  it("empty plans don't align", () => {
    expect(plansAlign([], [])).toBe(false);
  });
});

describe("validateParsedPlan", () => {
  it("accepts good plan", () => {
    expect(validateParsedPlan(parsePlan(goodPlan))).toBeNull();
  });
  it("rejects empty", () => {
    expect(validateParsedPlan([])).toMatch(/no aspects/);
  });
  it("rejects non-contiguous ords", () => {
    const plan = parsePlan(`
### Aspect 1: A
- Description: x
- Depends on: none
- Acceptance criteria: x

### Aspect 3: C
- Description: x
- Depends on: [1]
- Acceptance criteria: x
`);
    expect(validateParsedPlan(plan)).toMatch(/contiguous/);
  });
  it("rejects forward-looking depends_on", () => {
    const plan = parsePlan(`
### Aspect 1: A
- Description: x
- Depends on: [2]
- Acceptance criteria: x

### Aspect 2: B
- Description: x
- Depends on: none
- Acceptance criteria: x
`);
    expect(validateParsedPlan(plan)).toMatch(/later/);
  });
});
