import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import fs from 'fs';
import { withApiError, unauthorized, forbidden, notFound } from '@/lib/http';
import { detectMimeType, resolveMediaAbsolutePath, toStoredMediaPath } from '@/server/storage';
import { verifySignedMediaDownloadGrant, assertMediaDownloadGrantFresh } from '@/lib/upload-signature';
import { config } from '@/server/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { path: string[] };

function sanitizeSegments(segments: string[]): string {
  return segments.map((segment) => decodeURIComponent(segment)).join('/');
}

function resolveCorsOrigin(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (!origin) return null;
  const allowlistRaw = process.env.MEDIA_CORS_ALLOWLIST || config.MEDIA_CORS_ALLOWLIST || '';
  const allowlist = (allowlistRaw.length > 0
    ? allowlistRaw.split(',').map((entry: string) => entry.trim()).filter(Boolean)
    : ['http://localhost:3000', 'http://localhost:3001']
  );
  const originLower = origin.toLowerCase();
  const isAllowed = allowlist.some((entry) => entry === '*' || entry.toLowerCase() === originLower);
  return isAllowed ? origin : null;
}

function applyCorsHeaders(req: NextRequest, headers: Record<string, string>) {
  const origin = resolveCorsOrigin(req);
  if (!origin) return headers;
  return {
    ...headers,
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    vary: headers.vary ? `${headers.vary}, Origin` : 'Origin',
  };
}

function buildPreflightResponse(req: NextRequest) {
  const headers = applyCorsHeaders(req, {
    'access-control-allow-methods': 'GET,OPTIONS',
    'access-control-allow-headers': req.headers.get('access-control-request-headers') || 'Range,Content-Type',
    'access-control-max-age': '86400',
  });
  return new NextResponse(null, { status: 204, headers });
}

export const OPTIONS = withApiError(async function OPTIONS(req: NextRequest) {
  return buildPreflightResponse(req);
}, 'Failed to process media preflight');

const toErrorMessage = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

function isSignedDownloadRequired(): boolean {
  const raw = process.env.MEDIA_REQUIRE_SIGNED_DOWNLOAD ?? config.MEDIA_REQUIRE_SIGNED_DOWNLOAD;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

const requireSignedDownload = isSignedDownloadRequired();

function streamToReadable(stream: fs.ReadStream, signal?: AbortSignal) {
  let cleanup = () => {};
  let finished = false;

  const finish = (fn?: () => void) => {
    if (finished) return;
    finished = true;
    cleanup();
    fn?.();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer | string) => {
        if (finished) return;
        const bufferChunk = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        controller.enqueue(bufferChunk);
      };
      const onEnd = () => {
        finish(() => controller.close());
      };
      const onError = (err: Error) => {
        finish(() => controller.error(err));
      };
      const onAbort = () => {
        // Client disconnected / aborted: stop streaming quietly (no uncaughtException noise).
        // Important: don't destroy with an Error after removing listeners, or Node will emit an
        // unhandled 'error' event.
        finish(() => {
          stream.destroy();
          try {
            controller.close();
          } catch {
            // Ignore: controller might already be closed/errored.
          }
        });
      };
      cleanup = () => {
        if (finished) return;
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.off('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      stream.on('data', onData);
      stream.once('end', onEnd);
      stream.once('error', onError);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    },
    cancel() {
      finish(() => stream.destroy());
    },
  });
}

export const GET = withApiError(async function GET(req: NextRequest, { params }: { params: Promise<Params> }) {
  const { path: rawSegments } = await params;
  if (!rawSegments || rawSegments.length === 0) return notFound('File not found');
  const requestedPath = sanitizeSegments(rawSegments);
  if (!requestedPath || requestedPath.includes('..')) return forbidden('Invalid media path');

  const dataParam = req.nextUrl.searchParams.get('data');
  const sigParam = req.nextUrl.searchParams.get('sig') || req.nextUrl.searchParams.get('signature');
  const hasGrantParams = Boolean(dataParam || sigParam);
  let grant: ReturnType<typeof verifySignedMediaDownloadGrant> | null = null;
  if (hasGrantParams) {
    if (!dataParam || !sigParam) {
      if (requireSignedDownload) {
        return unauthorized('Signed media download grant is required');
      }
    } else {
      try {
        grant = verifySignedMediaDownloadGrant(dataParam, sigParam);
        assertMediaDownloadGrantFresh(grant);
      } catch (err: unknown) {
        if (requireSignedDownload) {
          return unauthorized(toErrorMessage(err, 'Invalid media download grant'));
        }
        grant = null;
      }
    }
  }

  if (requireSignedDownload && !grant) {
    return unauthorized('Signed media download grant is required');
  }

  let storedPath: string;
  try {
    storedPath = toStoredMediaPath(requestedPath);
  } catch (err: unknown) {
    return forbidden(toErrorMessage(err, 'Invalid media path'));
  }

  if (grant && grant.path !== storedPath) {
    return forbidden('Signed grant does not cover requested path');
  }

  const absolutePath = resolveMediaAbsolutePath(storedPath);
  let stats;
  try {
    stats = await fs.promises.stat(absolutePath);
  } catch {
    return notFound('File not found');
  }
  if (!stats.isFile()) return notFound('File not found');

  const range = req.headers.get('range');
  const contentType = detectMimeType(absolutePath);
  const baseHeaders: Record<string, string> = applyCorsHeaders(req, {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0, must-revalidate',
  });
  const downloadFlag = String(req.nextUrl.searchParams.get('download') || '').toLowerCase();
  const wantAttachment =
    (grant?.disposition === 'attachment') ||
    downloadFlag === '1' ||
    downloadFlag === 'true' ||
    downloadFlag === 'yes';
  if (wantAttachment) {
    const filename = path.basename(absolutePath);
    baseHeaders['content-disposition'] = `attachment; filename="${filename}"`;
  }

  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (!match) {
      return new NextResponse(null, {
        status: 416,
        headers: { 'content-range': `bytes */${stats.size}` },
      });
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : stats.size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= stats.size) {
      return new NextResponse(null, {
        status: 416,
        headers: { 'content-range': `bytes */${stats.size}` },
      });
    }
    const chunkSize = end - start + 1;
    const stream = fs.createReadStream(absolutePath, { start, end });
    return new NextResponse(streamToReadable(stream, req.signal), {
      status: 206,
      headers: {
        ...baseHeaders,
        'content-range': `bytes ${start}-${end}/${stats.size}`,
        'content-length': `${chunkSize}`,
      },
    });
  }

  const stream = fs.createReadStream(absolutePath);
  return new NextResponse(streamToReadable(stream, req.signal), {
    status: 200,
    headers: {
      ...baseHeaders,
      'content-length': `${stats.size}`,
    },
  });
}, 'Failed to load media');
