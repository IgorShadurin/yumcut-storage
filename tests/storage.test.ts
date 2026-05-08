import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let tmpRoot: string;

async function loadStorage() {
  vi.resetModules();
  return import('@/server/storage');
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-media-'));
  process.env.MEDIA_ROOT = tmpRoot;
  process.env.STORAGE_PUBLIC_URL = 'http://localhost:3333';
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.MEDIA_ROOT;
  delete process.env.STORAGE_PUBLIC_URL;
});

describe('toStoredMediaPath', () => {
  it('normalizes api URLs and absolute storage URLs', async () => {
    const storage = await loadStorage();
    expect(storage.toStoredMediaPath('/api/media/video/2025/09/example.mp4')).toBe('video/2025/09/example.mp4');
    expect(storage.toStoredMediaPath('http://localhost:3333/api/media/audio/2025/clip.wav')).toBe('audio/2025/clip.wav');
  });

  it('rejects unsupported prefixes and traversal', async () => {
    const storage = await loadStorage();
    expect(() => storage.toStoredMediaPath('media/audio/2025/clip.wav')).toThrow(/unsupported media path prefix/i);
    expect(() => storage.toStoredMediaPath('../etc/passwd')).toThrow(/Path traversal/i);
  });
});

describe('buildPublicMediaUrl', () => {
  it('creates absolute media URLs for relative paths', async () => {
    const storage = await loadStorage();
    const url = storage.buildPublicMediaUrl('audio/2025/sample.wav');
    expect(url).toBe('http://localhost:3333/api/media/audio/2025/sample.wav');
  });
});

describe('persistDaemonUpload', () => {
  const fixedDate = new Date('2025-03-04T05:06:07Z');

  it('stores files under year/month/day and returns public URL', async () => {
    vi.useFakeTimers({ now: fixedDate });
    try {
      const storage = await loadStorage();
      const content = Buffer.from('hello-storage');

      const stored = await storage.persistDaemonUpload('image', content, 'pic.png');
      const segments = stored.relativePath.split('/');

      expect(segments[0]).toBe('image');
      expect(segments[1]).toBe('2025');
      expect(segments[2]).toBe('03');
      expect(segments[3]).toBe('04');
      expect(stored.publicUrl).toMatch(/^http:\/\/localhost:3333\/api\/media\/image\/2025\/03\/04\//);

      const file = await fs.readFile(stored.absolutePath);
      expect(file.toString()).toBe('hello-storage');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stores character images in the characters namespace with dated paths', async () => {
    vi.useFakeTimers({ now: fixedDate });
    try {
      const storage = await loadStorage();
      const stored = await storage.persistCharacterImage(Buffer.from([1, 2, 3]), 'avatar.jpg');
      expect(stored.relativePath.startsWith('characters/2025/03/04/')).toBe(true);
      expect(stored.url).toMatch(/^http:\/\/localhost:3333\/api\/media\/characters\/2025\/03\/04\//);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('deleteStoredMedia', () => {
  it('removes duplicate paths across prefixes and ignores invalid entries', async () => {
    const storage = await loadStorage();
    const audio = await storage.persistDaemonUpload('audio', Buffer.from('a'), 'clip.wav');
    const video = await storage.persistDaemonUpload('video', Buffer.from('b'), 'clip.mp4');
    const untouched = await storage.persistDaemonUpload('image', Buffer.from('c'), 'keep.png');

    const toDelete = [
      audio.relativePath,
      `/api/media/${video.relativePath}`,
      audio.relativePath, // duplicate should be ignored
      'files/not-allowed/path.png', // invalid prefix ignored
    ];

    await storage.removeStoredMedia(toDelete);

    await expect(fs.access(path.resolve(tmpRoot, audio.relativePath))).rejects.toThrow();
    await expect(fs.access(path.resolve(tmpRoot, video.relativePath))).rejects.toThrow();

    // Ensure unrelated files remain
    await expect(fs.access(path.resolve(tmpRoot, untouched.relativePath))).resolves.toBeUndefined();
  });

  it('ignores permission errors when the file has already been removed', async () => {
    const storage = await loadStorage();
    const audio = await storage.persistDaemonUpload('audio', Buffer.from('z'), 'already-gone.wav');
    const absolute = path.resolve(tmpRoot, audio.relativePath);

    await fs.unlink(absolute);

    const originalUnlink = fs.unlink;
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (target: Parameters<typeof fs.unlink>[0]) => {
      if (target === absolute) {
        const error = new Error('EACCES: permission denied');
        (error as NodeJS.ErrnoException).code = 'EACCES';
        throw error;
      }
      return originalUnlink(target);
    });

    try {
      await expect(storage.removeStoredMedia([audio.relativePath])).resolves.toBeUndefined();
    } finally {
      unlinkSpy.mockRestore();
    }
  });
});
