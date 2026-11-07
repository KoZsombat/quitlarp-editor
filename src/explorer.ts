import { type Entry, type FileSystem, ROOT, join, parent } from './fs.js';

export interface Explorer {
  refresh(): Promise<boolean>;
  setActive(path: string | null): void;
  dispose(): void;
}

export function createExplorer(
  els: { tree: HTMLElement; newFile: HTMLElement; newFolder: HTMLElement; root: HTMLElement },
  ws: FileSystem,
  cb: {
    open(path: string): void;
    removed(path: string): void;
    renamed(from: string): void;
    error(e: unknown): void;
  },
): Explorer {
  const expanded = new Set<string>([ROOT]);
  const cache = new Map<string, Entry[]>();
  let active: string | null = null;
  let selected = ROOT; // target dir for "new" buttons
  let sig = '';
  let menu: HTMLElement | null = null;

  /** Reads all expanded directories; returns true if anything changed. */
  async function load(): Promise<boolean> {
    const next = new Map<string, Entry[]>();
    const walk = async (dir: string) => {
      let rows: Entry[];
      try { rows = await ws.list(dir); } catch { expanded.delete(dir); return; }
      next.set(dir, rows);
      for (const r of rows) if (r.dir && expanded.has(r.path)) await walk(r.path);
    };
    await walk(ROOT);
    const s = [...next].map(([d, r]) => d + ':' + r.map((e) => (e.dir ? '/' : '') + e.name).join('|')).join('\n');
    cache.clear();
    next.forEach((v, k) => cache.set(k, v));
    const changed = s !== sig;
    sig = s;
    return changed;
  }

  function draw() {
    const frag = document.createDocumentFragment();
    const add = (dir: string, depth: number) => {
      for (const e of cache.get(dir) ?? []) {
        const row = document.createElement('div');
        row.className = 'xwi-row' + (e.dir ? ' dir' : '') + (e.path === active ? ' active' : '');
        row.style.paddingLeft = `${4 + depth * 16}px`;
        const chev = document.createElement('span');
        chev.className = 'chev';
        chev.textContent = e.dir ? (expanded.has(e.path) ? '▾' : '▸') : '';
        const name = document.createElement('span');
        name.textContent = e.name;
        row.append(chev, name);
        row.onclick = () => {
          if (e.dir) {
            selected = e.path;
            if (expanded.has(e.path)) expanded.delete(e.path); else expanded.add(e.path);
            void refresh(true);
          } else {
            selected = parent(e.path);
            cb.open(e.path);
          }
        };
        row.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); showMenu(ev, e); };
        frag.append(row);
        if (e.dir && expanded.has(e.path)) add(e.path, depth + 1);
      }
    };
    add(ROOT, 0);
    if (!frag.childNodes.length) {
      const empty = document.createElement('div');
      empty.className = 'xwi-empty';
      empty.textContent = 'Empty. Right-click to create a file.';
      frag.append(empty);
    }
    els.tree.replaceChildren(frag);
  }

  async function refresh(force = false) {
    const changed = await load();
    if (changed || force) draw();
    return changed;
  }

  const guard = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { cb.error(e); }
    await refresh(true);
  };

  const dirOf = (e: Entry | null) => (e ? (e.dir ? e.path : parent(e.path)) : ROOT);

  function create(dir: string, isDir: boolean) {
    const name = prompt(isDir ? 'New folder name:' : 'New file name:')?.trim();
    if (!name) return;
    if (name.includes('/')) return cb.error(new Error('Names cannot contain "/"'));
    const path = join(dir, name);
    expanded.add(dir);
    void guard(async () => {
      if (await ws.exists(path)) throw new Error(`${name} already exists`);
      if (isDir) await ws.mkdir(path); else { await ws.writeText(path, ''); }
      if (!isDir) cb.open(path);
    });
  }

  function rename(e: Entry) {
    const name = prompt('Rename to:', e.name)?.trim();
    if (!name || name === e.name) return;
    if (name.includes('/')) return cb.error(new Error('Names cannot contain "/"'));
    const to = join(parent(e.path), name);
    void guard(async () => {
      if (await ws.exists(to)) throw new Error(`${name} already exists`);
      await ws.rename(e.path, to);
      cb.renamed(e.path);
    });
  }

  function remove(e: Entry) {
    if (!confirm(`Delete ${e.name}${e.dir ? ' and everything in it' : ''}?`)) return;
    void guard(async () => { await ws.remove(e.path); cb.removed(e.path); });
  }

  function closeMenu() { menu?.remove(); menu = null; }
  function showMenu(ev: MouseEvent, e: Entry | null) {
    closeMenu();
    const m = (menu = document.createElement('div'));
    m.className = 'xwi-menu';
    const item = (label: string, fn: () => void, cls = '') => {
      const b = document.createElement('button');
      b.textContent = label; b.className = cls;
      b.onclick = () => { closeMenu(); fn(); };
      m.append(b);
    };
    item('New file', () => create(dirOf(e), false));
    item('New folder', () => create(dirOf(e), true));
    if (e) { item('Rename', () => rename(e)); item('Delete', () => remove(e), 'danger'); }
    m.style.left = `${Math.min(ev.clientX, innerWidth - 160)}px`;
    m.style.top = `${Math.min(ev.clientY, innerHeight - 140)}px`;
    els.root.append(m);
  }

  els.tree.oncontextmenu = (ev) => { ev.preventDefault(); showMenu(ev, null); };
  els.newFile.onclick = () => create(selected, false);
  els.newFolder.onclick = () => create(selected, true);
  const onDoc = (ev: MouseEvent) => { if (menu && !menu.contains(ev.target as Node)) closeMenu(); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') closeMenu(); };
  document.addEventListener('mousedown', onDoc);
  document.addEventListener('keydown', onKey);

  void refresh(true);

  return {
    refresh: () => refresh(),
    setActive(p) { active = p; draw(); },
    dispose() {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      closeMenu();
    },
  };
}
