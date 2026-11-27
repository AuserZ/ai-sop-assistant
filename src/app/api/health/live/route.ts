import { resolveTraceId } from "../../../../server/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return Response.json(
    { status: "ok" },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": resolveTraceId(request),
      },
    },
  );
}
