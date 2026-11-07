import * as monaco from 'monaco-editor';
import { basename } from './fs.js';
import type { Flagger } from './flags.js';

const LANGS: Record<string, string> = {
  py: 'python', ml: 'ocaml', js: 'javascript', ts: 'typescript', tsx: 'typescript',
  go: 'go', rs: 'rust', java: 'java', cpp: 'cpp', c: 'c', rb: 'ruby', sh: 'shell',
  json: 'json', md: 'markdown',
};
export const languageFor = (path: string) => LANGS[basename(path).split('.').pop()!.toLowerCase()] ?? 'plaintext';

let themed = false;
function defineTheme() {
  if (themed) return;
  themed = true;
  // #22292b = Tailwind mist-800 (same as QuitLARP monacoTheme.ts)
  monaco.editor.defineTheme('quitlarp', {
    base: 'vs-dark', inherit: true, rules: [],
    colors: { 'editor.background': '#22292b', 'editorGutter.background': '#22292b' },
  });
}

export interface EditorHost {
  openFile(path: string, text: string): void;
  has(path: string): boolean;
  /** Reload a clean model from disk. Dirty models are left alone. */
  reloadIfClean(path: string, diskText: string): void;
  openPaths(): string[];
  closeFile(path: string): void;
  /** Close tabs at or under `path` (after rename/delete in the explorer). */
  closeUnder(path: string): void;
  active(): string | null;
  layout(): void;
  dispose(): void;
}

interface Doc { model: monaco.editor.ITextModel; saved: string }

export function createEditor(
  els: { tabs: HTMLElement; host: HTMLElement; placeholder: HTMLElement; lang: HTMLElement; file: HTMLElement; save: HTMLButtonElement },
  save: (path: string, text: string) => Promise<void>,
  onActive: (path: string | null) => void,
  flagger?: Flagger,
): EditorHost {
  defineTheme();
  monaco.editor.setTheme('quitlarp');
  const editor = monaco.editor.create(els.host, {
    model: null,
    automaticLayout: true,
    padding: { top: 8, bottom: 8 },
  });

  flagger?.attachEditor(editor, els.host);
  const docs = new Map<string, Doc>();
  let current: string | null = null;
  const dirty = (d: Doc) => d.model.getValue() !== d.saved;

  function render() {
    els.tabs.replaceChildren();
    for (const [path, d] of docs) {
      const tab = document.createElement('div');
      tab.className = 'xwi-tab' + (path === current ? ' active' : '');
      tab.title = path;
      const name = document.createElement('span');
      name.textContent = basename(path);
      tab.append(name);
      if (dirty(d)) { const dot = document.createElement('span'); dot.className = 'dot'; tab.append(dot); }
      const x = document.createElement('button');
      x.className = 'x'; x.textContent = '×'; x.title = 'Close';
      x.onclick = (e) => { e.stopPropagation(); closeFile(path); };
      tab.append(x);
      tab.onclick = () => show(path);
      tab.onauxclick = (e) => { if (e.button === 1) closeFile(path); };
      els.tabs.append(tab);
    }
    const d = current ? docs.get(current) : undefined;
    els.placeholder.style.display = d ? 'none' : 'flex';
    els.lang.style.display = els.file.style.display = d ? '' : 'none';
    els.save.disabled = !d || !dirty(d);
    if (current) { els.lang.textContent = languageFor(current); els.file.textContent = basename(current); }
  }

  function show(path: string | null) {
    current = path;
    editor.setModel(path ? docs.get(path)!.model : null);
    render();
    onActive(path);
    if (path) editor.focus();
  }

  async function saveCurrent() {
    const d = current ? docs.get(current) : undefined;
    if (!current || !d) return;
    const text = d.model.getValue();
    await save(current, text);
    d.saved = text;
    render();
  }

  function closeFile(path: string) {
    const d = docs.get(path);
    if (!d) return;
    if (dirty(d) && !confirm(`Discard unsaved changes to ${basename(path)}?`)) return;
    const keys = [...docs.keys()];
    const next = keys[keys.indexOf(path) + 1] ?? keys[keys.indexOf(path) - 1] ?? null;
    docs.delete(path);
    d.model.dispose();
    if (current === path) show(next); else render();
  }

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveCurrent());
  els.save.onclick = () => void saveCurrent();
  const sub = editor.onDidChangeModelContent(render);

  return {
    openFile(path, text) {
      if (!docs.has(path)) {
        const model = monaco.editor.createModel(text, languageFor(path), monaco.Uri.file(path));
        docs.set(path, { model, saved: text });
      }
      show(path);
    },
    has: (p) => docs.has(p),
    reloadIfClean(path, diskText) {
      const d = docs.get(path);
      if (!d || dirty(d) || d.saved === diskText) return;
      d.saved = diskText;
      d.model.setValue(diskText);
      render();
    },
    openPaths: () => [...docs.keys()],
    closeFile,
    closeUnder(path) {
      for (const p of [...docs.keys()]) {
        if (p === path || p.startsWith(path + '/')) {
          const d = docs.get(p)!;
          docs.delete(p);
          d.model.dispose();
          if (current === p) current = null;
        }
      }
      if (!current) show([...docs.keys()].pop() ?? null); else render();
    },
    active: () => current,
    layout: () => editor.layout(),
    dispose() {
      sub.dispose();
      editor.dispose();
      for (const d of docs.values()) d.model.dispose();
      docs.clear();
    },
  };
}
