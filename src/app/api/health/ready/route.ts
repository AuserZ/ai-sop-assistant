import { sql } from "drizzle-orm";
import { getDatabase } from "@/server/db/client";

export const dynamic = "force-dynamic";

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    await getDatabase().execute(sql`select '[1,0]'::public.vector <-> '[0,1]'::public.vector`);
    return Response.json({ status: "ready" }, { headers });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
}
