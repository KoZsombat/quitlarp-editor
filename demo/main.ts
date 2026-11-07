import { createMockServer, mountIDE, type Flag } from '../src/index.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

// Vite needs its own worker imports (it can't resolve bare specifiers inside `new URL()`).
(self as any).MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

// Demo switches: ?components=editor,explorer,terminal  &backend=mock  &flags=1  &extra=wasmer/jq
const q = new URLSearchParams(location.search);
const on = (q.get('components') ?? 'explorer,editor,terminal').split(',');
const files = {
  'hello.py': 'print("hello from python")\n',
  'notes.md': '# Notes\n\nEdit me, save with Ctrl/Cmd+S, then `cat notes.md` in the terminal.\n',
  'src/main.ts': 'export const answer: number = 42;\n',
};
const mock = q.get('backend') === 'mock' ? createMockServer(files) : null;
const log = document.createElement('pre');
log.id = 'flaglog';
log.style.cssText = 'position:fixed;right:8px;bottom:8px;max-width:420px;max-height:30vh;overflow:auto;margin:0;padding:6px;background:#000c;color:#abab9c;font:11px monospace;z-index:9;display:none';
document.body.append(log);

const ide = await mountIDE(document.getElementById('app')!, {
  components: { explorer: on.includes('explorer'), editor: on.includes('editor'), terminal: on.includes('terminal') },
  files: mock ? undefined : files,
  backend: mock ? { baseUrl: mock.baseUrl, fetch: mock.fetch } : undefined,
  terminal: { extraPackages: q.get('extra')?.split(',').filter(Boolean), aliases: { ll: 'ls -la' } },
  flagging: q.get('flags') ? {
    api: mock ? { baseUrl: mock.baseUrl, fetch: mock.fetch } : undefined,
    sessionId: 'demo-session',
    onFlag: (f: Flag) => { log.style.display = 'block'; log.textContent += `${f.type} ${JSON.stringify(f.detail)}\n`; },
  } : undefined,
});
Object.assign(window, { ide, mock });
