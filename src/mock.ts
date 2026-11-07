import { type FileSystem, ROOT, memoryFS } from './fs.js';
import type { Flag } from './flags.js';

/**
 * An in-memory implementation of the REST contract (see httpFS) plus POST /flags.
 * Pass `.fetch` and `.baseUrl` as `backend`, or use it as a test double for your own server.
 */
export function createMockServer(files: Record<string, string> = {}, opts: { latencyMs?: number } = {}) {
  const baseUrl = 'https://mock.invalid/api';
  const fs: FileSystem = memoryFS(files);
  const flags: Flag[] = [];
  const requests: { method: string; path: string }[] = [];
  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const bad = (status: number, detail: string) => json(status, { detail });
  const valid = (p: unknown): p is string => typeof p === 'string' && (p === ROOT || p.startsWith(ROOT + '/')) && !p.includes('..');

  const mockFetch: typeof fetch = async (input, init) => {
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.slice(new URL(baseUrl).pathname.length);
    const q = url.searchParams.get('path');
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ method, path });
    try {
      if (method === 'POST' && path === '/flags') { flags.push(body); return json(204); }
      if (path === '/files' && method === 'GET') {
        if (!valid(q)) return bad(400, 'Invalid path');
        const rows = await fs.list(q);
        return json(200, { entries: rows.map((r) => ({ name: r.name, kind: r.dir ? 'directory' : 'file' })) });
      }
      if (path === '/files' && method === 'DELETE') { if (!valid(q)) return bad(400, 'Invalid path'); await fs.remove(q); return json(204); }
      if (path === '/files/stat' && method === 'GET') {
        if (!valid(q)) return bad(400, 'Invalid path');
        if (!(await fs.exists(q))) return bad(404, 'Not found');
        return json(200, { kind: await fs.list(q).then(() => 'directory', () => 'file') });
      }
      if (path === '/files/content' && method === 'GET') { if (!valid(q)) return bad(400, 'Invalid path'); return json(200, { content: await fs.readText(q) }); }
      if (path === '/files/content' && method === 'PUT') { if (!valid(body.path)) return bad(400, 'Invalid path'); await fs.writeText(body.path, String(body.content ?? '')); return json(204); }
      if (path === '/files/directories' && method === 'POST') { if (!valid(body.path)) return bad(400, 'Invalid path'); await fs.mkdir(body.path); return json(204); }
      if (path === '/files/rename' && method === 'POST') { if (!valid(body.from) || !valid(body.to)) return bad(400, 'Invalid path'); await fs.rename(body.from, body.to); return json(204); }
      return bad(404, `No route for ${method} ${path}`);
    } catch (e) {
      return bad(404, (e as Error).message);
    }
  };
  return { baseUrl, fetch: mockFetch, fs, flags, requests };
}
