import type * as monaco from 'monaco-editor';
import type { Terminal } from '@xterm/xterm';
import { type ApiOptions, createApi } from './api.js';

export type FlagType =
  | 'paste' | 'copy' | 'cut' | 'drop'
  | 'fast-typing' | 'bulk-insert'
  | 'tab-out' | 'tab-return';

export interface Flag {
  type: FlagType;
  at: string; // ISO timestamp
  source: 'editor' | 'terminal' | 'window';
  path: string | null; // active file when it happened
  sessionId?: string;
  detail: Record<string, unknown>;
}

export interface FlaggingOptions {
  /** Where flags are POSTed. Defaults to the `backend` api. With neither, flags stay local. */
  api?: ApiOptions;
  /** Relative to the api base. Default "/flags". */
  path?: string;
  /** Called synchronously for every flag (also the way to use flagging with mock data). */
  onFlag?: (flag: Flag) => void;
  /** Echoed in every flag so the server can tie them to a session. */
  sessionId?: string;
  /** Include a short text preview of pasted content. Default false (length/lines only). */
  includeText?: boolean;
  /** copy / cut / paste / drop. Default true. */
  clipboard?: boolean;
  /** Window blur / hidden tab, and the return. Default true. */
  tabOut?: boolean;
  /** Typing-speed heuristics (only unusually FAST input is flagged). false disables. */
  typing?: false | {
    /** Flag when typed chars/second over the window exceeds this. Default 14. */
    maxCps?: number;
    windowMs?: number; // default 3000
    minChars?: number; // ignore windows with fewer chars than this. Default 30
    /** One non-paste insertion this long is flagged as bulk-insert. Default 80. */
    bulkChars?: number;
  };
}

export interface Flagger {
  flags: Flag[];
  attachEditor(editor: monaco.editor.IStandaloneCodeEditor, node: HTMLElement): void;
  attachTerminal(term: Terminal): void;
  dispose(): void;
}

export function createFlagger(
  o: FlaggingOptions,
  fallbackApi: ApiOptions | undefined,
  getPath: () => string | null,
): Flagger {
  const flags: Flag[] = [];
  const cleanups: (() => void)[] = [];
  const target = o.api ?? fallbackApi;
  const api = target ? createApi(target) : null;
  const path = o.path ?? '/flags';
  let queue: Flag[] = [];

  async function post(f: Flag, keepalive = false) {
    try { await api!.request(path, { method: 'POST', body: f, keepalive }); return true; } catch { return false; }
  }
  async function flush(keepalive = false) {
    const pending = queue; queue = [];
    for (const f of pending) if (!(await post(f, keepalive))) queue.push(f);
  }

  function emit(type: FlagType, source: Flag['source'], detail: Record<string, unknown> = {}) {
    const f: Flag = { type, source, at: new Date().toISOString(), path: getPath(), sessionId: o.sessionId, detail };
    flags.push(f);
    try { o.onFlag?.(f); } catch { /* host callback errors never break the editor */ }
    if (api) void post(f).then((ok) => { if (!ok) queue.push(f); });
  }

  if (api) {
    const t = setInterval(() => queue.length && void flush(), 10_000);
    const online = () => void flush();
    const hide = () => queue.length && void flush(true);
    addEventListener('online', online);
    addEventListener('pagehide', hide);
    cleanups.push(() => { clearInterval(t); removeEventListener('online', online); removeEventListener('pagehide', hide); });
  }

  // ---- tab-outs: visibility + window focus ----
  if (o.tabOut !== false) {
    let awaySince: number | null = null;
    const away = (reason: string) => { if (awaySince == null) { awaySince = Date.now(); emit('tab-out', 'window', { reason }); } };
    const back = () => {
      if (awaySince == null || document.visibilityState === 'hidden') return;
      emit('tab-return', 'window', { durationMs: Date.now() - awaySince });
      awaySince = null;
    };
    const onVis = () => (document.visibilityState === 'hidden' ? away('hidden') : back());
    const onBlur = () => away('blur');
    document.addEventListener('visibilitychange', onVis);
    addEventListener('blur', onBlur);
    addEventListener('focus', back);
    cleanups.push(() => {
      document.removeEventListener('visibilitychange', onVis);
      removeEventListener('blur', onBlur);
      removeEventListener('focus', back);
    });
  }

  const preview = (t: string) => (o.includeText ? { preview: t.slice(0, 120) } : {});
  const shape = (t: string) => ({ chars: t.length, lines: t.split('\n').length });

  return {
    flags,

    attachEditor(editor, node) {
      let lastCopied = '';
      let ignoreInsertsUntil = 0; // paste/drop also fire model changes; don't double-count as typing

      if (o.clipboard !== false) {
        const selected = () => {
          const m = editor.getModel(), s = editor.getSelection();
          return m && s ? m.getValueInRange(s) : '';
        };
        const on = (name: string, fn: (e: Event) => void) => {
          node.addEventListener(name, fn, true);
          cleanups.push(() => node.removeEventListener(name, fn, true));
        };
        // Clipboard events fire for Ctrl/Cmd+C/X/V and their menu equivalents.
        on('copy', () => { lastCopied = selected(); emit('copy', 'editor', { chars: lastCopied.length }); });
        on('cut', () => { lastCopied = selected(); emit('cut', 'editor', { chars: lastCopied.length }); });
        on('paste', (e) => {
          const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
          ignoreInsertsUntil = performance.now() + 300;
          // internal = text last copied from this very editor (low suspicion)
          emit('paste', 'editor', { ...shape(text), internal: text !== '' && text === lastCopied, ...preview(text) });
        });
        on('drop', (e) => {
          const text = (e as DragEvent).dataTransfer?.getData('text/plain') ?? '';
          ignoreInsertsUntil = performance.now() + 300;
          emit('drop', 'editor', { ...shape(text), ...preview(text) });
        });
      }

      if (o.typing !== false) {
        const cfg = { maxCps: 14, windowMs: 3000, minChars: 30, bulkChars: 80, ...o.typing };
        let recent: { t: number; n: number }[] = [];
        let lastFast = -Infinity;
        const sub = editor.onDidChangeModelContent((e) => {
          // flush = programmatic setValue (disk reload); undo/redo restores text, not typing.
          if (e.isFlush || e.isUndoing || e.isRedoing) return;
          const now = performance.now();
          if (now < ignoreInsertsUntil) return;
          for (const c of e.changes) {
            const n = c.text.length;
            if (n === 0) continue;
            if (n >= cfg.bulkChars) { emit('bulk-insert', 'editor', { chars: n, ...preview(c.text) }); continue; }
            recent.push({ t: now, n });
          }
          recent = recent.filter((r) => now - r.t <= cfg.windowMs);
          const chars = recent.reduce((s, r) => s + r.n, 0);
          const cps = chars / (cfg.windowMs / 1000);
          if (chars >= cfg.minChars && cps > cfg.maxCps && now - lastFast > 15_000) {
            lastFast = now;
            emit('fast-typing', 'editor', { cps: Math.round(cps * 10) / 10, chars, windowMs: cfg.windowMs });
          }
        });
        cleanups.push(() => sub.dispose());
      }
    },

    attachTerminal(term) {
      if (o.clipboard === false) return;
      const ta = term.textarea;
      if (!ta) return;
      const onPaste = (e: ClipboardEvent) => {
        const text = e.clipboardData?.getData('text/plain') ?? '';
        emit('paste', 'terminal', { ...shape(text), ...preview(text) });
      };
      ta.addEventListener('paste', onPaste, true);
      cleanups.push(() => ta.removeEventListener('paste', onPaste, true));
    },

    dispose() { cleanups.forEach((c) => c()); cleanups.length = 0; },
  };
}
