import { NextRequest, NextResponse } from 'next/server';
import { config } from '@/server/config';

const DEFAULT_ALLOWED_HEADERS = 'content-type';
const DEFAULT_ALLOWED_METHODS = 'POST,OPTIONS';

function parseAllowedOrigins() {
  const raw = process.env.STORAGE_ALLOWED_ORIGINS || config.STORAGE_ALLOWED_ORIGINS || '';
  return raw.split(',').map((origin) => origin.trim()).filter(Boolean);
}

export function resolveStorageCorsOrigin(req: NextRequest): string | null {
  const origin = req.headers.get('origin');
  if (!origin) return null;
  const allowed = parseAllowedOrigins();
  if (allowed.length === 0 || allowed.includes(origin)) {
    return origin;
  }
  return null;
}

export function applyStorageCors(
  res: NextResponse,
  origin: string,
  allowedMethods = DEFAULT_ALLOWED_METHODS,
  allowedHeaders = DEFAULT_ALLOWED_HEADERS
) {
  res.headers.set('Access-Control-Allow-Origin', origin);
  res.headers.set('Access-Control-Allow-Credentials', 'true');
  res.headers.set('Access-Control-Allow-Methods', allowedMethods);
  res.headers.set('Access-Control-Allow-Headers', allowedHeaders);
  res.headers.append('Vary', 'Origin');
  return res;
}

export function storageCorsPreflight(
  req: NextRequest,
  allowedMethods = DEFAULT_ALLOWED_METHODS,
  allowedHeaders = DEFAULT_ALLOWED_HEADERS
) {
  const origin = resolveStorageCorsOrigin(req);
  if (!origin) {
    return new NextResponse(null, { status: 204 });
  }
  const res = new NextResponse(null, { status: 204 });
  return applyStorageCors(res, origin, allowedMethods, allowedHeaders);
}
