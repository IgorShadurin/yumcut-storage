import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { error, forbidden, ok, withApiError } from '@/lib/http';
import { assertStorageCommandFresh, verifySignedStorageCommand } from '@/lib/upload-signature';
import { buildPublicMediaUrl, detectMimeType, resolveMediaAbsolutePath, toStoredMediaPath } from '@/server/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_CHARACTER_PREVIEW_HEIGHTS = new Set([896]);
const CHARACTER_PREVIEW_KIND = 'catalog-preview';
const CHARACTER_VARIANT_USER_ID = 'admin-character-catalog';

type RequestBody = {
  data?: unknown;
  signature?: unknown;
};

function isAllowedSourcePath(storedPath: string) {
  return storedPath.startsWith('characters/') && !storedPath.startsWith('characters/variants/');
}

function isAllowedImageMime(mime: string) {
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp';
}

function variantPathFor(sourcePath: string, height: number) {
  const digest = crypto.createHash('sha256').update(`${sourcePath}:${height}`).digest('hex').slice(0, 32);
  return `characters/variants/${CHARACTER_PREVIEW_KIND}/h${height}/${digest}.webp`;
}

async function readVariantMetadata(absolutePath: string) {
  const metadata = await sharp(absolutePath).metadata();
  return {
    width: metadata.width ?? null,
    height: metadata.height ?? null,
  };
}

async function convertVariant(sourceAbsolutePath: string, variantAbsolutePath: string, height: number) {
  await fs.mkdir(path.dirname(variantAbsolutePath), { recursive: true });
  const output = await sharp(sourceAbsolutePath)
    .rotate()
    .resize({ height, withoutEnlargement: true })
    .webp({ quality: 84, effort: 4 })
    .toBuffer();

  try {
    await fs.writeFile(variantAbsolutePath, output, { flag: 'wx' });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
      throw err;
    }
  }
}

export const POST = withApiError(async function POST(req: NextRequest) {
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return error('VALIDATION_ERROR', 'Invalid storage command payload', 400);
  }

  if (typeof body.data !== 'string' || typeof body.signature !== 'string') {
    return forbidden('Missing storage command data');
  }

  let payload;
  try {
    payload = verifySignedStorageCommand(body.data, body.signature);
    assertStorageCommandFresh(payload);
  } catch (err: unknown) {
    const message = err instanceof Error && err.message ? err.message : 'Invalid storage command';
    return forbidden(message);
  }

  if (payload.type !== 'resize-character-image') {
    return error('VALIDATION_ERROR', 'Unsupported storage command', 400);
  }
  if (payload.userId !== CHARACTER_VARIANT_USER_ID) {
    return forbidden('Storage command user is not allowed');
  }
  if (!payload.path || !payload.height) {
    return error('VALIDATION_ERROR', 'Storage command missing source path or height', 400);
  }
  if (!ALLOWED_CHARACTER_PREVIEW_HEIGHTS.has(payload.height)) {
    return error('VALIDATION_ERROR', 'Unsupported preview image height', 400);
  }

  let sourcePath: string;
  try {
    sourcePath = toStoredMediaPath(payload.path);
  } catch {
    return forbidden('Invalid source media path');
  }
  if (!isAllowedSourcePath(sourcePath)) {
    return forbidden('Source media path is not allowed');
  }

  const sourceAbsolutePath = resolveMediaAbsolutePath(sourcePath);
  try {
    await fs.access(sourceAbsolutePath);
  } catch {
    return error('NOT_FOUND', 'Source media not found', 404);
  }

  const sourceMime = detectMimeType(sourceAbsolutePath);
  if (!isAllowedImageMime(sourceMime)) {
    return error('VALIDATION_ERROR', 'Source media is not a supported image', 400);
  }

  const variantPath = variantPathFor(sourcePath, payload.height);
  const variantAbsolutePath = resolveMediaAbsolutePath(variantPath);

  try {
    await fs.access(variantAbsolutePath);
  } catch {
    await convertVariant(sourceAbsolutePath, variantAbsolutePath, payload.height);
  }

  const metadata = await readVariantMetadata(variantAbsolutePath);
  return ok({
    path: variantPath,
    url: buildPublicMediaUrl(variantPath),
    width: metadata.width,
    height: metadata.height,
  });
}, 'Failed to prepare character preview image');
