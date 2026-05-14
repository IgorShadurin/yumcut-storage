import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tmpRoot: string;

async function loadRoute() {
  vi.resetModules();
  return import('@/app/api/media/[...path]/route');
}

function request(url: string, headers?: Record<string, string>) {
  return new NextRequest(url, { headers });
}

const params = (segments: string[]) => ({ params: Promise.resolve({ path: segments }) });

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-media-route-'));
  process.env.MEDIA_ROOT = tmpRoot;
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.MEDIA_ROOT;
});

describe('media route byte ranges', () => {
  async function writeSampleFile() {
    const segments = ['characters', '2026', '05', '14', 'sample.mp4'];
    const absolutePath = path.join(tmpRoot, ...segments);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, Buffer.from('0123456789'));
    return segments;
  }

  it('serves suffix byte ranges used by native video players', async () => {
    const segments = await writeSampleFile();
    const route = await loadRoute();

    const res = await route.GET(
      request(`http://localhost/api/media/${segments.join('/')}`, { range: 'bytes=-4' }),
      params(segments),
    );

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 6-9/10');
    expect(res.headers.get('content-length')).toBe('4');
    expect(await res.text()).toBe('6789');
  });

  it('serves HEAD metadata without streaming the file body', async () => {
    const segments = await writeSampleFile();
    const route = await loadRoute();

    const res = await route.HEAD(
      request(`http://localhost/api/media/${segments.join('/')}`),
      params(segments),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('10');
    expect(await res.text()).toBe('');
  });

  it('serves ranged HEAD requests with content-range metadata', async () => {
    const segments = await writeSampleFile();
    const route = await loadRoute();

    const res = await route.HEAD(
      request(`http://localhost/api/media/${segments.join('/')}`, { range: 'bytes=-3' }),
      params(segments),
    );

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 7-9/10');
    expect(res.headers.get('content-length')).toBe('3');
    expect(await res.text()).toBe('');
  });
});
