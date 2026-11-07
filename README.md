# xterm-wasm-ide

**Full documentation: [DOCS.md](DOCS.md).**

A tiny in-browser IDE: file explorer, Monaco editor and a real `bash` terminal (WASIX via
`@wasmer/sdk`, drawn with xterm.js). No backend required. Every part is optional.

```sh
npm i xterm-wasm-ide @wasmer/sdk
```

```ts
import { mountIDE } from 'xterm-wasm-ide';
const ide = await mountIDE(document.getElementById('app')!, {   // container needs an explicit height
  components: { explorer: true, editor: true, terminal: true }, // turn any off; all default to true
  files: { 'hello.py': 'print("hi")\n' },                       // seeded into /workspace
});
ide.flags(); ide.fs; ide.dispose();
```

## Modes
- **Editor/explorer only** (`terminal: false`): no WebAssembly, no COOP/COEP needed. Files live in memory, or on a server via `backend`.
- **Terminal only**: bash in an in-memory `/workspace`.
- **Everything**: explorer, editor and bash share one filesystem; bash writes appear in the tree (polled ~1s).

## Terminal commands
```ts
terminal: {
  extraPackages: ['wasmer/coreutils'],        // added to the defaults (bash grep sed findutils tar gzip less ripgrep nano)
  packages: [...],                            // or replace the defaults
  commands: { mytool: wasmBytes },            // your own WASIX modules as bash commands
  aliases: { ll: 'ls -la' }, bashrc: 'export FOO=1', env: { FOO: '1' },
}
```

## Server backend (QuitLARP-style fetch: JSON, `credentials: 'include'`, `ApiError(status, detail)`)
`backend: { baseUrl: '/api/v1/sessions/current', headers?, credentials?, fetch? }` expects:
`GET /files?path` → `{entries:[{name,kind}]` · `GET /files/content?path` → `{content}` · `PUT /files/content {path,content}` ·
`POST /files/directories {path}` · `POST /files/rename {from,to}` · `DELETE /files?path` · `GET /files/stat?path` (404 if missing).
With a terminal too, the server is loaded into the sandbox at start and local changes are pushed every ~3s and on save.
`createMockServer(files)` implements this contract in memory (pass its `fetch`/`baseUrl`); `memoryFS`/`httpFS` are exported.

## Flagging (opt-in)
```ts
flagging: { sessionId: 'abc', onFlag: f => console.log(f), api?: {...}, path: '/flags', includeText: false }
```
Each flag is POSTed as `{type, at, source, path, sessionId, detail}` (failed posts are retried). Types: `copy`, `cut`,
`paste` (`internal` = text last copied from this editor), `drop`, `fast-typing` (> 14 chars/s over 3s; tune via
`typing: {maxCps, windowMs, minChars, bulkChars}`), `bulk-insert` (one non-paste insert ≥ 80 chars), `tab-out`/`tab-return`
(`durationMs`). Terminal paste is flagged too. These are signals, not proof; tell candidates what is monitored.

## Headers and Vite
Terminal mode needs `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
Vite: `optimizeDeps: { exclude: ['@wasmer/sdk'] }`, those headers in `server.headers`, and set `self.MonacoEnvironment`
yourself with `monaco-editor/editor/editor.worker.js?worker` (+ `language/{json,css,html,typescript}/*.worker.js?worker`); see `demo/main.ts`.

## Known gaps
Sandbox filesystem resets on reload (use `backend` to persist). No `awk`, `diff`, `jq`, `make`, `vim`, `stty`.
`@wasmer/sdk` 0.19 has no `Directory`/mount API; the shared FS is `Sandbox.fs`. Rename/delete closes the file's tab.

## License

[MPL-2.0](LICENSE)
