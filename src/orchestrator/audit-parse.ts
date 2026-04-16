// Parses auditor JSON output. Auditors are told to produce exactly one
// fenced `json` code block; we accept either a fenced block or a raw JSON
// object anywhere in the text.

export type AuditVerdict = "pass" | "fail_implementation" | "fail_research";

export interface AuditIssue {
  domain: "data_validity" | "logic" | "accuracy" | string;
  location: string;
  description: string;
  evidence?: string;
}

export interface AuditReport {
  verdict: AuditVerdict;
  issues: AuditIssue[];
}

export interface AuditParseResult {
  report: AuditReport | null;
  error: string | null;
}

export function parseAuditReport(text: string): AuditParseResult {
  // Prefer a fenced ```json block.
  const fenceMatch = text.match(/```\s*json\s*\n([\s\S]*?)\n```/i);
  const candidate = fenceMatch
    ? (fenceMatch[1] ?? "")
    : extractLooseJsonObject(text);

  if (!candidate.trim()) {
    return { report: null, error: "no JSON block found in auditor output" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    return { report: null, error: `json parse failed: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { report: null, error: "json root is not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  if (verdict !== "pass" && verdict !== "fail_implementation" && verdict !== "fail_research") {
    return { report: null, error: `invalid verdict: ${String(verdict)}` };
  }
  const rawIssues = Array.isArray(obj.issues) ? obj.issues : [];
  const issues: AuditIssue[] = [];
  for (const item of rawIssues) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    issues.push({
      domain: typeof r.domain === "string" ? r.domain : "unknown",
      location: typeof r.location === "string" ? r.location : "",
      description: typeof r.description === "string" ? r.description : "",
      evidence: typeof r.evidence === "string" ? r.evidence : undefined,
    });
  }
  if (verdict === "pass" && issues.length > 0) {
    // Agent contradicted itself; treat as fail_implementation (safer).
    return {
      report: { verdict: "fail_implementation", issues },
      error: null,
    };
  }
  return { report: { verdict, issues }, error: null };
}

function extractLooseJsonObject(text: string): string {
  // Find the first `{` and last matching `}` that produce valid JSON.
  const start = text.indexOf("{");
  if (start < 0) return "";
  // Attempt a greedy-match from start to the last closing brace.
  const end = text.lastIndexOf("}");
  if (end <= start) return "";
  return text.slice(start, end + 1);
}

export interface AuditorsPanel {
  a1: AuditReport;
  a2: AuditReport;
  a3: AuditReport;
}

export interface PanelDecision {
  kind: "pass" | "fail_implementation" | "fail_research";
  // Union of all issues across auditors, in auditor order.
  all_issues: Array<{ auditor: "a1" | "a2" | "a3"; issue: AuditIssue }>;
}

// Any-fail rule: if ANY auditor finds an issue the whole panel fails.
// fail_research takes precedence over fail_implementation so the loop rewinds
// correctly.
export function decidePanel(panel: AuditorsPanel): PanelDecision {
  const all_issues: PanelDecision["all_issues"] = [];
  for (const key of ["a1", "a2", "a3"] as const) {
    for (const issue of panel[key].issues) {
      all_issues.push({ auditor: key, issue });
    }
  }
  const verdicts = [panel.a1.verdict, panel.a2.verdict, panel.a3.verdict];
  if (verdicts.includes("fail_research")) {
    return { kind: "fail_research", all_issues };
  }
  if (verdicts.includes("fail_implementation")) {
    return { kind: "fail_implementation", all_issues };
  }
  return { kind: "pass", all_issues };
}
