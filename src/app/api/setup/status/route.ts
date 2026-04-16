import { NextResponse } from "next/server";
import { hasAnyUser } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ setupComplete: hasAnyUser() });
}
