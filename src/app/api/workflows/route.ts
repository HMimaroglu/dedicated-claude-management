import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import {
  ALLOWED_MODELS,
  DEFAULT_BUDGET_USD,
  DEFAULT_MAX_ITERATIONS_PER_ASPECT,
  DEFAULT_MODEL,
  MAX_BUDGET_USD,
  MAX_ITERATIONS_CEILING,
  createWorkflow,
  isProjectMultiAgentEnabled,
  listWorkflows,
  recordWorkflowEvent,
} from "@/lib/workflows";
import { anthropicAuthStatus } from "@/lib/anthropic-auth";
import { audit } from "@/lib/audit";
import { getRequestIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({
    workflows: listWorkflows(),
    anthropic: anthropicAuthStatus(),
  });
}

const CreateSchema = z.object({
  project_id: z.number().int().positive(),
  name: z.string().min(1).max(64),
  idea: z.string().min(10).max(10_000),
  require_human_gate: z.boolean().optional(),
  budget_usd: z.number().positive().max(MAX_BUDGET_USD).optional(),
  max_iterations_per_aspect: z.number().int().min(1).max(MAX_ITERATIONS_CEILING).optional(),
  model: z.enum(ALLOWED_MODELS as [string, ...string[]]).optional(),
});

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  // Require the Anthropic key be configured before a workflow can even be
  // created — otherwise the operator will hit the SDK error when they try to
  // start it. Fail fast with a clear message.
  const authStatus = anthropicAuthStatus();
  if (!authStatus.configured) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set on the controller. Configure it first." },
      { status: 412 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  if (!isProjectMultiAgentEnabled(parsed.data.project_id)) {
    return NextResponse.json(
      { error: "Project does not have multi-agent workflow enabled" },
      { status: 409 }
    );
  }

  try {
    const wf = createWorkflow({
      project_id: parsed.data.project_id,
      name: parsed.data.name,
      idea: parsed.data.idea,
      require_human_gate: parsed.data.require_human_gate,
      budget_usd: parsed.data.budget_usd ?? DEFAULT_BUDGET_USD,
      max_iterations_per_aspect:
        parsed.data.max_iterations_per_aspect ?? DEFAULT_MAX_ITERATIONS_PER_ASPECT,
      model: parsed.data.model ?? DEFAULT_MODEL,
    });
    recordWorkflowEvent({
      workflow_id: wf.id,
      phase: "idea_intake",
      kind: "workflow_created",
      payload: { budget_usd: wf.budget_usd, model: wf.model },
    });
    audit({
      event: "workflow.created",
      actorUserId: auth.user.id,
      ip: getRequestIp(req),
      details: { workflow_id: wf.id, project_id: wf.project_id, model: wf.model },
    });
    return NextResponse.json({ workflow: wf }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "create failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
