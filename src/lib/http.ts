import { NextResponse } from 'next/server';

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function error(code: string, message: string, status = 400, details?: unknown) {
  return NextResponse.json({ error: { code, message, details } }, { status });
}

export function unauthorized(message = 'Unauthorized') {
  return error('UNAUTHORIZED', message, 401);
}

export function forbidden(message = 'Forbidden') {
  return error('FORBIDDEN', message, 403);
}

export function notFound(message = 'Not found') {
  return error('NOT_FOUND', message, 404);
}

export function withApiError<P extends unknown[], R extends Response | Promise<Response>>(
  handler: (...args: P) => R,
  human: string
): (...args: P) => Promise<Response> {
  return async (...args: P) => {
    try {
      const result = await handler(...args);
      return result as Response;
    } catch (e: unknown) {
      const msg = e instanceof Error && e.message ? `${human}: ${e.message}` : human;
      return error('INTERNAL_ERROR', msg, 500, { raw: String(e) });
    }
  };
}
