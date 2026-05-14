import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import fs from 'fs';
import crypto from 'node:crypto';
import { withApiError, unauthorized, forbidden, notFound } from '@/lib/http';
import { detectMimeType, resolveMediaAbsolutePath, toStoredMediaPath } from '@/server/storage';
import { verifySignedMediaDownloadGrant, assertMediaDownloadGrantFresh } from '@/lib/upload-signature';
import { config } from '@/server/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { path: string[] };
type ByteRange = { start: number; end: number };

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
    'access-control-allow-methods': 'GET,HEAD,OPTIONS',
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

function parseByteRangeSpec(spec: string, size: number): ByteRange | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null;

  const match = /^(\d*)-(\d*)$/.exec(spec.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    const start = Math.max(size - suffixLength, 0);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    start >= size
  ) {
    return null;
  }

  return { start, end: Math.min(end, size - 1) };
}

function parseByteRanges(range: string, size: number): ByteRange[] | null {
  const trimmed = range.trim();
  if (!trimmed.toLowerCase().startsWith('bytes=')) return null;

  const specs = trimmed.slice('bytes='.length).split(',').map((entry) => entry.trim()).filter(Boolean);
  if (specs.length === 0) return null;

  const ranges: ByteRange[] = [];
  for (const spec of specs) {
    const parsed = parseByteRangeSpec(spec, size);
    if (!parsed) return null;
    ranges.push(parsed);
  }
  return ranges;
}

function streamRangeToController(
  controller: ReadableStreamDefaultController<Uint8Array>,
  absolutePath: string,
  range: ByteRange,
  signal?: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(absolutePath, { start: range.start, end: range.end });
    let finished = false;

    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (fn: () => void) => {
      if (finished) return;
      finished = true;
      cleanup();
      fn();
    };
    const onData = (chunk: Buffer | string) => {
      if (finished) return;
      controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    };
    const onEnd = () => finish(resolve);
    const onError = (err: Error) => finish(() => reject(err));
    const onAbort = () => finish(() => {
      stream.destroy();
      resolve();
    });

    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function streamMultipartRangesToReadable(
  absolutePath: string,
  ranges: ByteRange[],
  size: number,
  contentType: string,
  boundary: string,
  signal?: AbortSignal,
) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const range of ranges) {
          if (signal?.aborted) break;
          controller.enqueue(encoder.encode(
            `--${boundary}\r\n` +
            `Content-Type: ${contentType}\r\n` +
            `Content-Range: bytes ${range.start}-${range.end}/${size}\r\n\r\n`,
          ));
          await streamRangeToController(controller, absolutePath, range, signal);
          if (signal?.aborted) break;
          controller.enqueue(encoder.encode('\r\n'));
        }
        if (!signal?.aborted) {
          controller.enqueue(encoder.encode(`--${boundary}--\r\n`));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

async function serveMedia(req: NextRequest, { params }: { params: Promise<Params> }, headOnly = false) {
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
    const ranges = parseByteRanges(range, stats.size);
    if (!ranges) {
      return new NextResponse(null, {
        status: 416,
        headers: {
          ...baseHeaders,
          'content-range': `bytes */${stats.size}`,
          'content-length': '0',
        },
      });
    }
    if (ranges.length > 1) {
      const boundary = `yumcut-${crypto.randomUUID()}`;
      const body = headOnly
        ? null
        : streamMultipartRangesToReadable(absolutePath, ranges, stats.size, contentType, boundary, req.signal);
      return new NextResponse(body, {
        status: 206,
        headers: {
          ...baseHeaders,
          'content-type': `multipart/byteranges; boundary=${boundary}`,
        },
      });
    }

    const { start, end } = ranges[0];
    const chunkSize = end - start + 1;
    const body = headOnly ? null : streamToReadable(fs.createReadStream(absolutePath, { start, end }), req.signal);
    return new NextResponse(body, {
      status: 206,
      headers: {
        ...baseHeaders,
        'content-range': `bytes ${start}-${end}/${stats.size}`,
        'content-length': `${chunkSize}`,
      },
    });
  }

  const body = headOnly ? null : streamToReadable(fs.createReadStream(absolutePath), req.signal);
  return new NextResponse(body, {
    status: 200,
    headers: {
      ...baseHeaders,
      'content-length': `${stats.size}`,
    },
  });
}

export const GET = withApiError(async function GET(req: NextRequest, context: { params: Promise<Params> }) {
  return serveMedia(req, context, false);
}, 'Failed to load media');

export const HEAD = withApiError(async function HEAD(req: NextRequest, context: { params: Promise<Params> }) {
  return serveMedia(req, context, true);
}, 'Failed to load media headers');
