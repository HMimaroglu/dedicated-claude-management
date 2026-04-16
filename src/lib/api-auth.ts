import { NextResponse } from "next/server";
import { getSessionUser, type SessionUser } from "./session";
import { isSameOrigin } from "./csrf";

export interface AuthGuardOk {
  ok: true;
  user: SessionUser;
}
export interface AuthGuardFail {
  ok: false;
  response: NextResponse;
}
export type AuthGuardResult = AuthGuardOk | AuthGuardFail;

export async function requireAuth(req: Request, opts?: { requireCsrf?: boolean }): Promise<AuthGuardResult> {
  const requireCsrf = opts?.requireCsrf !== false;
  if (requireCsrf && req.method !== "GET" && req.method !== "HEAD") {
    if (!isSameOrigin(req)) {
      return { ok: false, response: NextResponse.json({ error: "Bad origin" }, { status: 403 }) };
    }
  }
  const user = await getSessionUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { ok: true, user };
}
