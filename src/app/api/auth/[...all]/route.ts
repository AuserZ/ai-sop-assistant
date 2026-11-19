import { handleAuthentication } from "@/server/auth/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = handleAuthentication;
export const POST = handleAuthentication;
export const PUT = handleAuthentication;
export const PATCH = handleAuthentication;
export const DELETE = handleAuthentication;
export const OPTIONS = handleAuthentication;
