import { sql } from "drizzle-orm";
import { getDatabase } from "../../../../server/db/client";
import { logEvent, resolveTraceId } from "../../../../server/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const traceId = resolveTraceId(request);
  const start = performance.now();
  const headers = {
    "Cache-Control": "no-store",
    "X-Request-Id": traceId,
  };
  try {
    await getDatabase().execute(sql`select '[1,0]'::public.vector <-> '[0,1]'::public.vector`);
    return Response.json({ status: "ready" }, { headers });
  } catch {
    logEvent("error", "health.ready_failed", {
      traceId,
      errorCode: "DATABASE_UNAVAILABLE",
      durationMs: Number(Math.max(0, performance.now() - start).toFixed(2)),
    });
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
}
