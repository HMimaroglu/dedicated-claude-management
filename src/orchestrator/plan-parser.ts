// Parses a markdown plan produced by sys-design agents. Strict enough to
// refuse malformed input (so we don't create garbage aspect rows) but lenient
// about extra whitespace and bullet style.

export interface ParsedAspect {
  ord: number;
  title: string;
  description: string;
  depends_on: number[];
  acceptance_criteria: string | null;
}

export interface StatusLine {
  kind: "consensus" | "disagree" | "need_round" | "deadlock" | "research_ready" | "unknown";
  raw: string;
}

// Case-insensitively parses the trailing STATUS: ... line the agents emit.
// Strips any trailing markdown like "> " or "`" markers.
export function parseStatusLine(text: string): StatusLine {
  const lines = text.trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    // Strip quote prefix + emphasis markdown, but NOT underscores (they're
    // part of the status value, e.g. CONSENSUS_REACHED).
    const line = (lines[i] ?? "").trim().replace(/^>\s*/, "").replace(/[`*]/g, "");
    if (line.length === 0) continue;
    const m = line.match(/^STATUS:\s*([A-Z_]+)\s*$/i);
    // Skip non-STATUS lines (agents sometimes add a closing sentence after
    // the status marker) — a "noise-after-status" adversary cannot force
    // cost-exhaustion by appending trailing content.
    if (!m) continue;
    const name = (m[1] ?? "").toUpperCase();
    switch (name) {
      case "CONSENSUS_REACHED":
        return { kind: "consensus", raw: line };
      case "DISAGREE":
        return { kind: "disagree", raw: line };
      case "NEED_ROUND":
        return { kind: "need_round", raw: line };
      case "DEADLOCK":
        return { kind: "deadlock", raw: line };
      case "RESEARCH_READY":
        return { kind: "research_ready", raw: line };
      default:
        return { kind: "unknown", raw: line };
    }
  }
  return { kind: "unknown", raw: "" };
}

// Parses aspects out of a sys-design agent's output. Expects:
//   ### Aspect N: title
//   - Description: ...
//   - Depends on: [numbers] or "none"
//   - Acceptance criteria: ...
export function parsePlan(text: string): ParsedAspect[] {
  const aspects: ParsedAspect[] = [];
  const lines = text.split(/\r?\n/);
  let current: Partial<ParsedAspect> | null = null;

  const flush = () => {
    if (current && typeof current.ord === "number") {
      aspects.push({
        ord: current.ord,
        title: current.title?.trim() || "untitled",
        description: current.description?.trim() ?? "",
        depends_on: current.depends_on ?? [],
        acceptance_criteria: current.acceptance_criteria ?? null,
      });
    }
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const header = line.match(/^###\s+Aspect\s+(\d+)\s*:\s*(.+?)\s*$/i);
    if (header) {
      flush();
      current = {
        ord: parseInt(header[1]!, 10),
        title: header[2]!,
        description: "",
        depends_on: [],
        acceptance_criteria: null,
      };
      continue;
    }
    if (!current) continue;
    const desc = line.match(/^[-*]\s*Description\s*:\s*(.+?)\s*$/i);
    if (desc) {
      current.description = desc[1]!;
      continue;
    }
    const deps = line.match(/^[-*]\s*Depends\s*on\s*:\s*(.*)$/i);
    if (deps) {
      const nums = deps[1]!.match(/\d+/g);
      current.depends_on = nums ? nums.map((s) => parseInt(s, 10)) : [];
      continue;
    }
    const acc = line.match(/^[-*]\s*Acceptance\s*criteria\s*:\s*(.+?)\s*$/i);
    if (acc) {
      current.acceptance_criteria = acc[1]!;
      continue;
    }
  }
  flush();
  return aspects;
}

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

// Returns true if two parsed plans match structurally — same number of
// aspects, same ordinals, same normalised titles. Descriptions and criteria
// may differ (agents often reword). Consensus is about WHICH aspects and in
// WHAT ORDER, not about phrasing.
export function plansAlign(a: ParsedAspect[], b: ParsedAspect[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (ai.ord !== bi.ord) return false;
    if (normalize(ai.title) !== normalize(bi.title)) return false;
  }
  return true;
}

// Sanity checks on a parsed plan before we accept it. Returns null if OK, or
// a human-readable reason to reject.
export function validateParsedPlan(aspects: ParsedAspect[]): string | null {
  if (aspects.length === 0) return "plan has no aspects";
  if (aspects.length > 50) return "plan has too many aspects (>50)";
  const ords = new Set<number>();
  for (const a of aspects) {
    if (!Number.isInteger(a.ord) || a.ord < 1) return `aspect ord ${a.ord} is invalid`;
    if (ords.has(a.ord)) return `aspect ord ${a.ord} is duplicated`;
    ords.add(a.ord);
    if (a.title.length === 0) return `aspect ${a.ord} has empty title`;
    if (a.title.length > 200) return `aspect ${a.ord} title exceeds 200 chars`;
    for (const dep of a.depends_on) {
      if (dep >= a.ord) return `aspect ${a.ord} depends on later aspect ${dep}`;
      if (!ords.has(dep)) return `aspect ${a.ord} depends on missing aspect ${dep}`;
    }
  }
  // Check ords start at 1 and are contiguous (we produce them in order).
  const sorted = [...ords].sort((x, y) => x - y);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i + 1) return `aspects must be numbered 1..N contiguously`;
  }
  return null;
}
