import '@xterm/xterm/css/xterm.css';
import './style.css';
import type { PackageLoadProgress, PackageSource } from '@wasmer/sdk/browser';
import type { ApiOptions } from './api.js';
import { createEditor } from './editor.js';
import { createExplorer } from './explorer.js';
import { type Flag, type FlaggingOptions, createFlagger } from './flags.js';
import { DEFAULT_PACKAGES, type FileSystem, Workspace, httpFS, memoryFS, ROOT } from './fs.js';
import { createMirror } from './mirror.js';
import { createShell } from './shell.js';

export { ApiError, type ApiOptions } from './api.js';
export { type Flag, type FlagType, type FlaggingOptions } from './flags.js';
export { type Entry, type FileSystem, httpFS, memoryFS } from './fs.js';
export { createMockServer } from './mock.js';

export interface TerminalOptions {
  /** Replaces the default package list. */
  packages?: string[];
  /** Added to the (default or replaced) list: registry names ("wasmer/jq"), WEBC bytes, or Package objects. */
  extraPackages?: PackageSource[];
  /** Your own WASIX modules (raw .wasm bytes), each exposed as a bash command with that name. */
  commands?: Record<string, Uint8Array>;
  /** e.g. { ll: 'ls -la' } */
  aliases?: Record<string, string>;
  /** Appended to ~/.bashrc. */
  bashrc?: string;
  env?: Record<string, string>;
}

export interface IDEOptions {
  /** Turn parts off. All default to true. Without a terminal no WebAssembly (and no COOP/COEP) is needed. */
  components?: { explorer?: boolean; editor?: boolean; terminal?: boolean };
  /** Seeded into /workspace. Keys are paths relative to it. */
  files?: Record<string, string>;
  /** Shorthand for terminal.packages. */
  packages?: string[];
  terminal?: TerminalOptions;
  /** Persist to a server over REST (see httpFS). Omit for a pure in-memory workspace. */
  backend?: ApiOptions;
  /** Files to open as tabs at start. Default: the first 20 files when the explorer is off, else none. */
  open?: string[];
  /** Opt-in integrity signals: paste/copy, typing speed, tab-outs. */
  flagging?: FlaggingOptions;
}

export interface IDE {
  dispose(): void;
  /** Every flag raised so far (empty unless `flagging` is set). */
  flags(): Flag[];
  /** The filesystem the explorer and editor use. */
  fs: FileSystem;
}

// Default Monaco workers: editor + json, css, html, ts only. Bundlers that resolve bare specifiers in
// `new URL()` (webpack 5) work as-is. Vite does not; define self.MonacoEnvironment yourself (see README).
function installMonacoWorkers() {
  const g = self as unknown as { MonacoEnvironment?: unknown };
  if (g.MonacoEnvironment) return;
  const w = (u: URL) => new Worker(u, { type: 'module' });
  g.MonacoEnvironment = {
    getWorker(_id: string, label: string) {
      switch (label) {
        case 'json': return w(new URL('monaco-editor/language/json/json.worker.js', import.meta.url));
        case 'css': case 'scss': case 'less':
          return w(new URL('monaco-editor/language/css/css.worker.js', import.meta.url));
        case 'html': case 'handlebars': case 'razor':
          return w(new URL('monaco-editor/language/html/html.worker.js', import.meta.url));
        case 'typescript': case 'javascript':
          return w(new URL('monaco-editor/language/typescript/ts.worker.js', import.meta.url));
        default: return w(new URL('monaco-editor/editor/editor.worker.js', import.meta.url));
      }
    },
  };
}

const TEMPLATE = `
<div class="xwi-explorer">
  <div class="xwi-explorer-head">Explorer<span>
    <button class="xwi-icon-btn" data-r="newFile" title="New file">+f</button>
    <button class="xwi-icon-btn" data-r="newFolder" title="New folder">+d</button></span></div>
  <div class="xwi-tree" data-r="tree"></div>
</div>
<div class="xwi-split v"></div>
<div class="xwi-editor-col">
  <div class="xwi-bar">
    <div class="xwi-tabs" data-r="tabs"></div>
    <div class="xwi-tools">
      <span class="xwi-chip lang" data-r="lang"></span><span class="xwi-chip file" data-r="file"></span>
      <button class="xwi-btn" data-r="save" disabled>Save</button>
    </div>
  </div>
  <div class="xwi-editor-wrap">
    <div class="xwi-editor" data-r="editor"></div>
    <div class="xwi-placeholder" data-r="placeholder">Open a file from the explorer</div>
  </div>
</div>
<div class="xwi-split h"></div>
<div class="xwi-terminal-wrap"><div class="xwi-terminal" data-r="terminal"></div></div>`;

/** Breadth-first list of up to `max` file paths, so an explorer-less editor still has tabs. */
async function firstFiles(fs: FileSystem, max: number): Promise<string[]> {
  const out: string[] = [];
  const dirs = [ROOT];
  while (dirs.length && out.length < max) {
    for (const e of await fs.list(dirs.shift()!)) (e.dir ? dirs.push(e.path) : out.length < max && out.push(e.path));
  }
  return out;
}

export async function mountIDE(container: HTMLElement, options: IDEOptions = {}): Promise<IDE> {
  const want = {
    explorer: options.components?.explorer !== false,
    editor: options.components?.editor !== false,
    terminal: options.components?.terminal !== false,
  };
  const t = options.terminal ?? {};
  const seed = options.files ?? {};

  if (want.editor) installMonacoWorkers();
  const root = document.createElement('div');
  root.className = 'xwi';
  root.classList.toggle('no-explorer', !want.explorer);
  root.classList.toggle('no-editor', !want.editor);
  root.classList.toggle('no-terminal', !want.terminal);
  root.innerHTML = TEMPLATE;
  container.append(root);
  const r = (n: string) => root.querySelector<HTMLElement>(`[data-r="${n}"]`)!;

  // ---- splitters (plain mouse handlers) ----
  const drag = (el: HTMLElement, onMove: (e: MouseEvent) => void) => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      root.classList.add('dragging');
      el.classList.add('active');
      const up = () => {
        root.classList.remove('dragging');
        el.classList.remove('active');
        removeEventListener('mousemove', onMove);
        removeEventListener('mouseup', up);
      };
      addEventListener('mousemove', onMove);
      addEventListener('mouseup', up);
    });
  };
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  drag(root.querySelector('.xwi-split.v')!, (e) => {
    const b = root.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(root).paddingLeft);
    root.style.setProperty('--explorer-w', `${clamp(e.clientX - b.left - pad, 160, b.width - 2 * pad - 6 - 200)}px`);
  });
  drag(root.querySelector('.xwi-split.h')!, (e) => {
    const b = root.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(root).paddingBottom);
    root.style.setProperty('--terminal-h', `${clamp(b.bottom - pad - e.clientY - 3, 80, b.height - 2 * pad - 6 - 120)}px`);
  });

  // ---- shared plumbing ----
  let editor: ReturnType<typeof createEditor> | null = null;
  let sync: () => Promise<void> = async () => {};
  let nudge: ReturnType<typeof setTimeout> | undefined;
  const shell = want.terminal
    ? createShell(r('terminal'), root, (d) => {
        // After Enter bash likely ran something: sync soon rather than waiting for the poll.
        if (d.includes('\r')) { clearTimeout(nudge); nudge = setTimeout(() => void sync(), 300); }
      })
    : null;
  const say = (s: string) => (shell ? shell.term.writeln(s) : console.info(s));
  const red = (s: string) => (shell ? shell.term.writeln(`\x1b[31m${s}\x1b[0m`) : console.error(s));
  const err = (e: unknown) => red(`${(e as Error)?.message ?? e}`);

  let raf = 0;
  const relayout = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { editor?.layout(); shell?.fit(); });
  };
  const ro = new ResizeObserver(relayout);
  ro.observe(root); ro.observe(r('editor')); ro.observe(r('terminal'));
  window.addEventListener('resize', relayout);

  const flagger = options.flagging
    ? createFlagger(options.flagging, options.backend, () => editor?.active() ?? null)
    : null;
  if (shell) flagger?.attachTerminal(shell.term);

  // ---- filesystem: sandbox when the terminal is on, otherwise memory or server ----
  const remote = options.backend ? httpFS(options.backend) : null;
  let ws: Workspace | null = null;
  let fs: FileSystem | null = null;
  let mirror: ReturnType<typeof createMirror> | null = null;

  if (shell) {
    if (!crossOriginIsolated) {
      red('This page is not cross-origin isolated, so WebAssembly threads are unavailable.');
      red('Serve it with these headers:');
      red('  Cross-Origin-Opener-Policy: same-origin');
      red('  Cross-Origin-Embedder-Policy: require-corp');
    }
    say('\x1b[2mLoading bash and packages (first load downloads them)...\x1b[0m');
    let loading = true;
    let lastPhase = '';
    const onProgress = (p: PackageLoadProgress) => {
      if (!loading) return;
      const pct = p.download.percent == null ? '' : ` ${Math.round(p.download.percent)}%`;
      const line = `${p.phase}${pct}`;
      if (line !== lastPhase && p.phase !== 'downloading') { lastPhase = line; say(`\x1b[2m  ${line}\x1b[0m`); }
    };
    try {
      ws = await Workspace.create({
        files: seed,
        packages: [...(t.packages ?? options.packages ?? DEFAULT_PACKAGES), ...(t.extraPackages ?? [])],
        commands: t.commands, aliases: t.aliases, bashrc: t.bashrc, env: t.env, onProgress,
      });
      fs = ws;
    } catch (e) {
      red(`Could not start the Wasmer sandbox: ${(e as Error)?.message ?? e}`);
    } finally { loading = false; }
    if (ws && remote) {
      mirror = createMirror(ws, remote, err);
      try { await mirror.hydrate(); } catch (e) { red(`Could not load files from the server: ${(e as Error)?.message ?? e}`); }
    }
  }
  // No terminal (or the sandbox failed): explorer + editor talk straight to memory or the server.
  fs ??= remote ?? memoryFS(seed);
  const files = fs;

  // ---- explorer + editor, both over the same filesystem ----
  const pushSoon = () => { void mirror?.sync(); };
  const explorer = want.explorer
    ? createExplorer({ tree: r('tree'), newFile: r('newFile'), newFolder: r('newFolder'), root }, files, {
        open: (p) => { if (editor) void files.readText(p).then((x) => editor!.openFile(p, x), err); },
        removed: (p) => { editor?.closeUnder(p); pushSoon(); },
        renamed: (from) => { editor?.closeUnder(from); pushSoon(); },
        error: (e) => alert(`${(e as Error)?.message ?? e}`),
      })
    : null;
  if (want.editor) {
    editor = createEditor(
      { tabs: r('tabs'), host: r('editor'), placeholder: r('placeholder'), lang: r('lang'), file: r('file'), save: r('save') as HTMLButtonElement },
      async (p, x) => { await files.writeText(p, x); void explorer?.refresh(); pushSoon(); },
      (p) => explorer?.setActive(p),
      flagger ?? undefined,
    );
    editor.layout();
    let initial = options.open?.map((p) => (p.startsWith('/') ? p : `/workspace/${p}`)) ?? [];
    if (!options.open && !want.explorer) initial = await firstFiles(files, 20).catch((e) => (err(e), []));
    for (const p of initial) await files.readText(p).then((x) => editor!.openFile(p, x), err);
  }

  // ---- terminal -> explorer/editor sync: only needed when something else (bash) can write ----
  let syncing = false;
  sync = async () => {
    if (!ws || syncing || document.visibilityState !== 'visible') return;
    syncing = true;
    try {
      await explorer?.refresh();
      for (const p of editor?.openPaths() ?? []) {
        try { editor!.reloadIfClean(p, await files.readText(p)); } catch { /* deleted/renamed by bash */ }
      }
    } catch { /* transient fs error; next tick retries */ } finally { syncing = false; }
  };
  const poll = ws ? setInterval(() => void sync(), 1000) : undefined;
  let mirroring = false;
  const mirrorTimer = mirror
    ? setInterval(() => { if (!mirroring) { mirroring = true; void mirror!.sync().finally(() => (mirroring = false)); } }, 3000)
    : undefined;
  const onVis = () => void sync();
  document.addEventListener('visibilitychange', onVis);

  relayout();
  if (shell && ws) await shell.start(ws);

  return {
    fs: files,
    flags: () => flagger?.flags ?? [],
    dispose() {
      clearInterval(poll);
      clearInterval(mirrorTimer);
      clearTimeout(nudge);
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', relayout);
      ro.disconnect();
      flagger?.dispose();
      explorer?.dispose();
      editor?.dispose();
      shell?.dispose();
      void ws?.dispose();
      root.remove();
    },
  };
}
