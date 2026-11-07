import { type FileSystem, BASHRC_PATH, ROOT, join } from './fs.js';

/**
 * Keeps the runtime sandbox (what bash sees) and a server filesystem in step.
 * Remote wins on first load; afterwards local changes (editor or bash) are pushed.
 */
export function createMirror(local: FileSystem, remote: FileSystem, onError: (e: unknown) => void) {
  const DIR = null; // snapshot value for directories
  let snap = new Map<string, string | null>();

  async function walk(fs: FileSystem, dir: string, out: Map<string, string | null>) {
    for (const e of await fs.list(dir)) {
      if (e.path === BASHRC_PATH) continue;
      if (e.dir) { out.set(e.path, DIR); await walk(fs, e.path, out); continue; }
      try { out.set(e.path, await fs.readText(e.path)); } catch { /* binary or unreadable: skip */ }
    }
  }

  return {
    /** Pull the server's files into the sandbox. */
    async hydrate() {
      const remoteTree = new Map<string, string | null>();
      await walk(remote, ROOT, remoteTree);
      for (const [p, v] of remoteTree) {
        if (v === DIR) await local.mkdir(p); else await local.writeText(p, v);
      }
      snap = remoteTree;
    },
    /** Push local changes to the server. Safe to call repeatedly. */
    async sync() {
      const now = new Map<string, string | null>();
      try { await walk(local, ROOT, now); } catch (e) { return onError(e); }
      try {
        for (const [p, v] of now) {
          if (snap.has(p) && snap.get(p) === v) continue;
          if (v === DIR) await remote.mkdir(p); else await remote.writeText(p, v);
          snap.set(p, v);
        }
        // Deletions: remove top-most missing paths only.
        const gone = [...snap.keys()].filter((p) => !now.has(p)).sort();
        for (const p of gone) {
          if (!snap.has(p)) continue;
          await remote.remove(p);
          for (const k of [...snap.keys()]) if (k === p || k.startsWith(join(p, ''))) snap.delete(k);
        }
      } catch (e) { onError(e); }
    },
  };
}
