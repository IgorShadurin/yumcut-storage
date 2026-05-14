import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const originalNodeEnv = process.env.NODE_ENV ?? 'test';

async function loadCors() {
  vi.resetModules();
  return import('@/lib/storage-cors');
}

function setNodeEnv(value: string) {
  (process.env as Record<string, string | undefined>)['NODE_ENV'] = value;
}

function requestWithOrigin(origin: string) {
  return new NextRequest('http://localhost/api/storage/user-images', {
    headers: { origin },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  setNodeEnv(originalNodeEnv);
  delete process.env.STORAGE_ALLOWED_ORIGINS;
});

describe('storage CORS origin policy', () => {
  it('allows local app origins by default outside production', async () => {
    setNodeEnv('test');
    delete process.env.STORAGE_ALLOWED_ORIGINS;
    const cors = await loadCors();
    expect(cors.resolveStorageCorsOrigin(requestWithOrigin('http://localhost:3000'))).toBe('http://localhost:3000');
  });

  it('does not fail open in production without configured origins', async () => {
    setNodeEnv('production');
    delete process.env.STORAGE_ALLOWED_ORIGINS;
    const cors = await loadCors();
    expect(cors.resolveStorageCorsOrigin(requestWithOrigin('https://evil.example'))).toBeNull();
    expect(cors.resolveStorageCorsOrigin(requestWithOrigin('https://app.yumcut.com'))).toBeNull();
  });

  it('allows only configured production origins', async () => {
    setNodeEnv('production');
    vi.stubEnv('STORAGE_ALLOWED_ORIGINS', 'https://app.yumcut.com');
    const cors = await loadCors();
    expect(cors.resolveStorageCorsOrigin(requestWithOrigin('https://app.yumcut.com'))).toBe('https://app.yumcut.com');
    expect(cors.resolveStorageCorsOrigin(requestWithOrigin('https://evil.example'))).toBeNull();
  });
});
