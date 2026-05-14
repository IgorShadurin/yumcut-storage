import { NextRequest, NextResponse } from 'next/server';
import { config } from '@/server/config';

const DEFAULT_ALLOWED_HEADERS = 'content-type';
const DEFAULT_ALLOWED_METHODS = 'POST,OPTIONS';
const DEV_ALLOWED_ORIGINS = ['http://localhost:3000', 'http://localhost:3001'];

function parseAllowedOrigins() {
  const raw = process.env.STORAGE_ALLOWED_ORIGINS || config.STORAGE_ALLOWED_ORIGINS || '';
  const configured = raw.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (configured.length > 0) return configured;
  return process.env['NODE_ENV'] === 'production' ? [] : DEV_ALLOWED_ORIGINS;
}

export function resolveStorageCorsOrigin(req: NextRequest): string | null {
  const origin = req.headers.get('origin');
  if (!origin) return null;
  const allowed = parseAllowedOrigins();
  if (allowed.includes(origin)) {
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
