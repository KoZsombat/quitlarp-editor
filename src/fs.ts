import { Wasmer, type Sandbox, type PackageLoadProgress, type PackageSource } from '@wasmer/sdk/browser';
import { type ApiOptions, createApi } from './api.js';

export const ROOT = '/workspace';

export const DEFAULT_PACKAGES = [
  'wasmer/bash', 'wasmer/grep', 'wasmer/sed', 'wasmer/findutils', 'wasmer/tar',
  'wasmer/gzip', 'wasmer/less', 'wasmer/ripgrep', 'wasmer/nano',
];

export interface Entry { name: string; path: string; dir: boolean }

/** All paths are absolute, under /workspace. Every backend implements this. */
export interface FileSystem {
  list(path: string): Promise<Entry[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export const join = (a: string, b: string) => (a.endsWith('/') ? a : a + '/') + b;
export const parent = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), 1)) || '/';
export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Seed keys are relative to /workspace ("a/b.txt"); "/workspace/a/b.txt" is accepted too. */
export function seedPaths(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) out[`${ROOT}/${k.replace(/^\/+/, '').replace(/^workspace\//, '')}`] = v;
  return out;
}

const sortEntries = (rows: Entry[]) =>
  rows.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));

/** Pure in-memory filesystem (mock data, editor-only use). */
export function memoryFS(files: Record<string, string> = {}): FileSystem {
  const data = new Map<string, string>();
  const dirs = new Set<string>([ROOT]);
  const ensureDir = (p: string) => { while (p.startsWith(ROOT + '/')) { dirs.add(p); p = parent(p); } };
  const under = (k: string, p: string) => k === p || k.startsWith(p + '/');
  const missing = (p: string) => new Error(`No such file or directory: ${p}`);
  for (const [k, v] of Object.entries(seedPaths(files))) { ensureDir(parent(k)); data.set(k, v); }
  return {
    async list(path) {
      if (!dirs.has(path)) throw missing(path);
      const rows: Entry[] = [];
      for (const d of dirs) if (d !== path && parent(d) === path) rows.push({ name: d.slice(path.length + 1), path: d, dir: true });
      for (const f of data.keys()) if (parent(f) === path) rows.push({ name: f.slice(path.length + 1), path: f, dir: false });
      return sortEntries(rows);
    },
    async readText(p) { const t = data.get(p); if (t === undefined) throw missing(p); return t; },
    async writeText(p, t) { ensureDir(parent(p)); data.set(p, t); },
    async mkdir(p) { ensureDir(p); },
    async remove(p) {
      for (const k of [...data.keys()]) if (under(k, p)) data.delete(k);
      for (const d of [...dirs]) if (under(d, p) && d !== ROOT) dirs.delete(d);
    },
    async rename(from, to) {
      if (!data.has(from) && !dirs.has(from)) throw missing(from);
      ensureDir(parent(to));
      for (const k of [...data.keys()]) if (under(k, from)) { data.set(to + k.slice(from.length), data.get(k)!); data.delete(k); }
      for (const d of [...dirs]) if (under(d, from)) { dirs.delete(d); dirs.add(to + d.slice(from.length)); }
    },
    async exists(p) { return data.has(p) || dirs.has(p); },
  };
}

/**
 * Server-backed filesystem. REST contract (all JSON, paths are absolute):
 *   GET    {base}/files?path=DIR             -> { entries: [{ name, kind: "file"|"directory" }] }
 *   GET    {base}/files/content?path=FILE    -> { content }
 *   PUT    {base}/files/content              body { path, content }
 *   POST   {base}/files/directories          body { path }
 *   POST   {base}/files/rename               body { from, to }
 *   DELETE {base}/files?path=PATH
 *   GET    {base}/files/stat?path=PATH       -> 200 { kind } | 404
 */
export function httpFS(opts: ApiOptions): FileSystem {
  const api = createApi(opts);
  return {
    async list(path) {
      const d = await api.request<{ entries: { name: string; kind: string }[] }>('/files', { method: 'GET', query: { path } });
      return sortEntries(d.entries.map((e) => ({ name: e.name, path: join(path, e.name), dir: e.kind === 'directory' })));
    },
    async readText(path) {
      return (await api.request<{ content: string }>('/files/content', { method: 'GET', query: { path } })).content;
    },
    async writeText(path, content) { await api.request('/files/content', { method: 'PUT', body: { path, content } }); },
    async mkdir(path) { await api.request('/files/directories', { method: 'POST', body: { path } }); },
    async remove(path) { await api.request('/files', { method: 'DELETE', query: { path } }); },
    async rename(from, to) { await api.request('/files/rename', { method: 'POST', body: { from, to } }); },
    async exists(path) {
      try { await api.request('/files/stat', { method: 'GET', query: { path } }); return true; }
      catch (e) { if ((e as { status?: number }).status === 404) return false; throw e; }
    },
  };
}

export interface WorkspaceOptions {
  files: Record<string, string>;
  packages: PackageSource[];
  /** WASIX modules (raw .wasm bytes) exposed as terminal commands, keyed by command name. */
  commands?: Record<string, Uint8Array>;
  aliases?: Record<string, string>;
  bashrc?: string;
  env?: Record<string, string>;
  onProgress?: (p: PackageLoadProgress) => void;
}

export const BASHRC_PATH = `${ROOT}/.bashrc`;

/**
 * The runtime filesystem when the terminal is enabled. @wasmer/sdk 0.19 has no `Directory`
 * class; the shared filesystem is `Sandbox.fs`, and bash in the same sandbox sees /workspace.
 */
export class Workspace implements FileSystem {
  private constructor(readonly wasmer: Wasmer, readonly sandbox: Sandbox, readonly env: Record<string, string>) {}

  static async create(o: WorkspaceOptions): Promise<Workspace> {
    const wasmer = new Wasmer();
    try {
      const packages = [...o.packages];
      const names = Object.keys(o.commands ?? {});
      if (names.length) {
        packages.push(await wasmer.packages.create({
          modules: o.commands!,
          commands: Object.fromEntries(names.map((n) => [n, { module: n }])),
          entrypoint: names[0],
        }));
      }
      const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      const rc = [
        "clear() { printf '\\033[H\\033[2J\\033[3J'; }",
        ...Object.entries(o.aliases ?? {}).map(([k, v]) => `alias ${k}=${q(v)}`),
        o.bashrc ?? '',
      ].join('\n') + '\n';
      const sandbox = await wasmer.sandboxes.create({
        packages, files: { ...seedPaths(o.files), [BASHRC_PATH]: rc }, onPackageProgress: o.onProgress,
      });
      return new Workspace(wasmer, sandbox, { HOME: ROOT, PWD: ROOT, TERM: 'xterm-256color', ...o.env });
    } catch (e) {
      await wasmer.close().catch(() => {});
      throw e;
    }
  }

  async list(path: string): Promise<Entry[]> {
    const rows = await this.sandbox.fs.readDir(path);
    return sortEntries(rows
      .filter((r) => r.name !== '.' && r.name !== '..')
      .map((r) => ({ name: r.name, path: join(path, r.name), dir: r.kind === 'directory' })));
  }
  readText(path: string) { return this.sandbox.fs.readText(path); }
  writeText(path: string, text: string) { return this.sandbox.fs.writeText(path, text); }
  mkdir(path: string) { return this.sandbox.fs.mkdir(path, { recursive: true }); }
  remove(path: string) { return this.sandbox.fs.remove(path, { recursive: true }); }
  rename(from: string, to: string) { return this.sandbox.fs.rename(from, to); }
  async exists(path: string) { try { await this.sandbox.fs.stat(path); return true; } catch { return false; } }

  async dispose() {
    await this.sandbox.close().catch(() => {});
    await this.wasmer.close().catch(() => {});
  }
}
