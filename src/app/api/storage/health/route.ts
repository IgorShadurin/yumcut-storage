import { NextRequest } from 'next/server';
import { withApiError, forbidden, ok } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiError(async function GET(req: NextRequest) {
  const header = req.headers.get('x-daemon-password');
  const expected = process.env.DAEMON_API_PASSWORD;
  if (expected && expected.length > 0) {
    if (!header || header !== expected) return forbidden('Invalid daemon credentials');
  }
  return ok({ ok: true, time: new Date().toISOString() });
}, 'Failed to verify storage health');
