import { handleOperationalHealthRequest } from "../../../../server/observability/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleOperationalHealthRequest(request);
}
