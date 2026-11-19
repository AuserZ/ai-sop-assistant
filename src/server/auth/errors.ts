export class AuthFailure extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

export function authErrorResponse(error: unknown) {
  const failure = error instanceof AuthFailure ? error : new AuthFailure("SERVICE_UNAVAILABLE", 503);
  return Response.json({ error: { code: failure.code } }, {
    status: failure.status,
    headers: { "Cache-Control": "no-store", ...(failure.status === 429 ? { "Retry-After": "60" } : {}) },
  });
}
