import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from './config';

let inferredPublicBase: string | null = null;
let cachedMediaRoot: string | null = null;
const STORAGE_DELETE_PREFIXES = ['characters/', 'audio/', 'image/', 'video/'];

function normalizeBaseUrl(base: string) {
  return base.replace(/\/+$/, '');
}

export function mediaRoot() {
  if (cachedMediaRoot) return cachedMediaRoot;
  const raw = (process.env.MEDIA_ROOT?.trim() || config.MEDIA_ROOT || '').trim();
  const resolved = raw.length > 0 ? raw : (process.cwd() + '/media');
  const root = resolved.replace(/\/+$/, '');
  try {
    fsSync.mkdirSync(root, { recursive: true });
  } catch {
    // Best effort: later write operations will surface a real error if creation failed.
  }
  cachedMediaRoot = root;
  return cachedMediaRoot;
}

function storagePublicBase() {
  const raw = (config.STORAGE_PUBLIC_URL || process.env.NEXT_PUBLIC_STORAGE_BASE_URL || process.env.TEST_STORAGE_BASE_URL || '').trim();
  if (raw.length > 0) {
    const normalized = normalizeBaseUrl(raw);
    inferredPublicBase = normalized;
    return normalized;
  }
  return inferredPublicBase;
}

export function recordStoragePublicUrlHint(possibleUrl: string | null | undefined) {
  if (!possibleUrl || possibleUrl.length === 0) return;
  if (config.STORAGE_PUBLIC_URL && config.STORAGE_PUBLIC_URL.trim().length > 0) {
    return;
  }
  try {
    const parsed = new URL(possibleUrl);
    inferredPublicBase = normalizeBaseUrl(parsed.origin);
  } catch {
    // ignore
  }
}

async function ensureDir(targetPath: string) {
  await fs.mkdir(targetPath, { recursive: true });
}

function ensureNoTraversal(segment: string) {
  if (segment === '..') {
    throw new Error('Path traversal segment not allowed');
  }
}

export function toStoredMediaPath(input: string) {
  if (!input) throw new Error('Media path is required');
  let working = input.trim();
  if (/^https?:\/\//i.test(working)) {
    let parsed: URL;
    try {
      parsed = new URL(working);
    } catch {
      throw new Error(`Invalid media URL: ${working}`);
    }
    working = parsed.pathname || '';
    if (!working) {
      throw new Error('Media URL must include a path');
    }
    if (parsed.pathname.startsWith('/api/media/')) {
      working = parsed.pathname;
    } else {
      throw new Error('Media URL must originate from /api/media on the storage host');
    }
  }
  if (working.startsWith('/api/media/')) {
    working = working.slice('/api/media/'.length);
    working = working
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  }
  if (working.startsWith('/')) {
    working = working.replace(/^\/+/, '');
  }
  const lowerWorking = working.toLowerCase();
  const disallowedPrefixes = ['media/', 'files/', 'project/', 'daemon/'];
  for (const prefix of disallowedPrefixes) {
    if (lowerWorking.startsWith(prefix)) {
      throw new Error(`Unsupported media path prefix: ${working}`);
    }
  }
  const segments = working.split(/[\\/]+/).filter((seg) => seg.length > 0);
  segments.forEach(ensureNoTraversal);
  if (segments.length === 0) {
    throw new Error('Media path is required');
  }
  return segments.join('/');
}

export function buildPublicMediaUrl(relativePath: string) {
  const stored = toStoredMediaPath(relativePath);
  const encoded = stored.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const base = storagePublicBase();
  if (base) {
    return `${base}/api/media/${encoded}`;
  }
  return `/api/media/${encoded}`;
}

export async function persistDaemonUpload(kind: 'audio' | 'image' | 'video' | 'character-image', data: Uint8Array, originalName?: string) {
  const now = new Date();
  const root = mediaRoot();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const segments = [kind === 'character-image' ? 'characters' : kind, `${year}`, month, day];
  const ext = (() => {
    if (!originalName) return '';
    const extname = path.extname(originalName);
    return extname || '';
  })();
  const filename = `${randomUUID()}${ext}`;
  const relativePath = [...segments, filename].join('/');
  const absolutePath = path.resolve(root, ...segments, filename);
  await ensureDir(path.dirname(absolutePath));
  await fs.writeFile(absolutePath, data);
  const publicUrl = buildPublicMediaUrl(relativePath);
  recordStoragePublicUrlHint(publicUrl);
  return { relativePath, absolutePath, publicUrl };
}

export async function persistCharacterImage(data: Uint8Array, originalName?: string) {
  const stored = await persistDaemonUpload('character-image', data, originalName);
  return { relativePath: stored.relativePath, absolutePath: stored.absolutePath, url: stored.publicUrl };
}

export function resolveMediaAbsolutePath(relativePath: string) {
  const stored = toStoredMediaPath(relativePath);
  if (/^https?:\/\//i.test(stored)) {
    throw new Error('Cannot serve remote media');
  }
  const root = mediaRoot();
  const segments = stored.split('/');
  segments.forEach(ensureNoTraversal);
  const absolute = path.resolve(root, ...segments);
  const normalizedRoot = path.resolve(root);
  if (!absolute.startsWith(normalizedRoot)) {
    throw new Error('Requested media path escapes root');
  }
  return absolute;
}

function isDeletableStoragePath(stored: string) {
  const lower = stored.toLowerCase();
  return STORAGE_DELETE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function getErrnoCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  if (!('code' in err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

async function shouldIgnoreUnlinkError(err: unknown, absolutePath: string) {
  const code = getErrnoCode(err);
  if (code === 'ENOENT') {
    return true;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    try {
      await fs.stat(absolutePath);
    } catch (statErr: unknown) {
      if (getErrnoCode(statErr) === 'ENOENT') {
        return true;
      }
    }
  }
  return false;
}

export async function removeStoredMedia(paths: Array<string | null | undefined>) {
  if (!paths || paths.length === 0) return;
  const unique = new Set<string>();
  for (const candidate of paths) {
    if (!candidate) continue;
    let stored: string;
    try {
      stored = toStoredMediaPath(candidate);
    } catch {
      continue;
    }
    if (!isDeletableStoragePath(stored)) {
      continue;
    }
    unique.add(stored);
  }
  if (unique.size === 0) return;
  const root = mediaRoot();
  await Promise.all(
    Array.from(unique).map(async (stored) => {
      const absolute = path.resolve(root, ...stored.split('/'));
      try {
        await fs.unlink(absolute);
      } catch (err: unknown) {
        if (await shouldIgnoreUnlinkError(err, absolute)) {
          return;
        }
        throw err;
      }
    }),
  );
}

export async function removeCharacterImage(relativePath: string | null | undefined) {
  await removeStoredMedia([relativePath]);
}

export function detectMimeType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.wav':
      return 'audio/wav';
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    case '.ogg':
      return 'audio/ogg';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.mp4':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    default:
      return 'application/octet-stream';
  }
}
