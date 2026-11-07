# xterm-wasm-ide Documentation

A mini VS Code-style IDE for the browser: a file explorer, a Monaco editor and a real `bash` terminal
running as WebAssembly (WASIX, via `@wasmer/sdk`). No backend is required, and every part is optional.

**On this page**

- [Quick start](#quick-start)
- [Core concepts](#core-concepts)
- [Guides](#guides): [editor only](#editor-and-explorer-only) · [terminal only](#terminal-only) · [extending the terminal](#extending-the-terminal) · [server backend](#saving-to-a-server) · [flagging](#flagging-integrity-signals) · [theming](#theming)
- [API reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## Quick start

### 1. Install

```sh
npm install xterm-wasm-ide @wasmer/sdk
```

`@wasmer/sdk` (`^0.19`) is a peer dependency. `monaco-editor`, `@xterm/xterm` and `@xterm/addon-fit` come with the package.

### 2. Mount it

```ts
import { mountIDE } from 'xterm-wasm-ide';

const ide = await mountIDE(document.getElementById('app')!, {
  files: {
    'hello.py': 'print("hello")\n',
    'src/main.ts': 'export const answer = 42;\n',
  },
});

// later
ide.dispose();
```

The container needs an explicit height (for example `height: 100vh`). The IDE fills it.

Try it in the terminal pane: edit `hello.py` in the editor, press <kbd>Ctrl/Cmd</kbd>+<kbd>S</kbd>, then run `cat hello.py`.
Run `echo hi > x.txt` and `x.txt` appears in the explorer.

### 3. Serve with the right headers (terminal only)

WebAssembly threads need `SharedArrayBuffer`, which browsers only enable on
[cross-origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated) pages:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

If the headers are missing, the terminal prints a red reminder. If you don't enable the terminal, you don't need them.

### 4. Vite setup

```ts
// vite.config.ts
import { defineConfig } from 'vite';

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ['@wasmer/sdk'] },
  build: { target: 'esnext' },
});
```

Monaco needs web workers. Vite can't resolve bare specifiers inside `new URL()`, so define `MonacoEnvironment` yourself
**before** calling `mountIDE`:

```ts
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};
```

Note the paths: Monaco 0.57 maps `monaco-editor/*.js` to `esm/vs/*.js`, so `monaco-editor/esm/vs/...` does **not** work.
If you don't define `MonacoEnvironment`, the package installs a default using `new Worker(new URL(...))`, which works in
bundlers that resolve bare specifiers there (webpack 5). It has not been tested outside Vite.

A complete working setup is in [`demo/`](demo/).

---

## Core concepts

### One shared filesystem

Explorer, editor and terminal always see the same files under `/workspace`, which is also bash's `$HOME` and working
directory. Which backend holds those files depends on what you enable:

| Terminal | `backend` | Files live in | Notes |
|---|---|---|---|
| on | none | the Wasmer sandbox (memory) | Reset on reload. |
| on | set | the sandbox, mirrored to your server | Server is loaded at start; changes are pushed back. |
| off | none | plain memory (`memoryFS`) | No WebAssembly involved. |
| off | set | your server directly (`httpFS`) | Every operation is an API call. |

`@wasmer/sdk` 0.19 has no `Directory` class or mount API. The shared filesystem is `Sandbox.fs`, and bash runs in
the same sandbox.

### How changes stay in sync

- **Editor to terminal:** <kbd>Ctrl/Cmd</kbd>+<kbd>S</kbd> writes the file; bash sees it immediately.
- **Terminal to explorer/editor:** the explorer re-reads expanded folders about once a second while the tab is visible, plus
  shortly after you press Enter in the terminal. Open tabs that are not dirty reload when the file changes on disk.
  Tabs with unsaved edits are never overwritten.
- **Sandbox to server** (terminal + `backend`): a mirror pushes new, changed and deleted files every ~3 seconds and after each
  save. The server wins on first load. `.bashrc` is never uploaded. Files that aren't valid UTF-8 are skipped.

### Editor language

Chosen by extension: `py` python, `ml` ocaml, `js` javascript, `ts`/`tsx` typescript, `go`, `rs` rust, `java`, `cpp`, `c`,
`rb` ruby, `sh` shell, `json`, `md` markdown, anything else plaintext. The editor uses Monaco's `vs-dark` theme with the
background set to `#22292b`; everything else is Monaco defaults (minimap included).

---

## Guides

### Editor and explorer only

```ts
await mountIDE(el, {
  components: { terminal: false },
  files: { 'main.py': 'print(1)\n' },
});
```

No WebAssembly is loaded, so no special headers are needed and it starts instantly.

To show only the editor with fixed tabs:

```ts
await mountIDE(el, {
  components: { explorer: false, terminal: false },
  files: { 'a.ts': '', 'b.ts': '' },
  open: ['a.ts', 'b.ts'],          // default without an explorer: the first 20 files
});
```

### Terminal only

```ts
await mountIDE(el, { components: { explorer: false, editor: false } });
```

### Extending the terminal

The default package list is `wasmer/bash`, `grep`, `sed`, `findutils`, `tar`, `gzip`, `less`, `ripgrep` and `nano`. Add to it:

```ts
await mountIDE(el, {
  terminal: {
    extraPackages: ['wasmer/coreutils'],         // registry names (or WEBC bytes / Package objects)
    aliases: { ll: 'ls -la', gs: 'echo no git here' },
    bashrc: 'export GREETING=hello',             // appended to ~/.bashrc
    env: { EDITOR: 'nano' },
  },
});
```

To **replace** the defaults instead, use `terminal.packages` (or the shorthand top-level `packages`). Keep a package that
provides `bash`, or the terminal won't start.

Your own commands, as WASIX modules compiled from C, Rust or Go:

```ts
const bytes = new Uint8Array(await (await fetch('/mytool.wasm')).arrayBuffer());
await mountIDE(el, { terminal: { commands: { mytool: bytes } } });
// then in the terminal: mytool --help
```

> `commands` is implemented but untested: no WASIX binary was available to verify it.

Only registry packages that exist work. A typo or missing package makes sandbox creation fail: the terminal prints
`Could not start the Wasmer sandbox: ...` and the editor and explorer fall back to memory or the server.

### Saving to a server

Pass a `backend` and the explorer and editor use your API. The transport follows QuitLARP's conventions: plain `fetch`,
JSON bodies, `credentials: 'include'` by default, and errors that read `{ detail }` or `{ error }` from the response.

```ts
await mountIDE(el, {
  backend: {
    baseUrl: `/api/v1/assessments/${id}/sessions/current`,
    headers: () => ({ 'X-CSRF-Token': getCsrf() }),   // optional; object or (async) function
    // credentials: 'include',                          // default
    // fetch: customFetch,                              // optional, e.g. for tests
  },
});
```

Your server implements this contract (all paths absolute, under `/workspace`):

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/files` | `?path=DIR` | `{ "entries": [{ "name": "a.py", "kind": "file" \| "directory" }] }` |
| GET | `/files/content` | `?path=FILE` | `{ "content": "..." }` |
| PUT | `/files/content` | `{ path, content }` | 2xx |
| POST | `/files/directories` | `{ path }` | 2xx |
| POST | `/files/rename` | `{ from, to }` | 2xx |
| DELETE | `/files` | `?path=PATH` | 2xx (recursive) |
| GET | `/files/stat` | `?path=PATH` | 200 `{ kind }`, or 404 if missing |

Errors should be non-2xx with `{ "detail": "message" }`. Validate paths on the server: reject anything outside
`/workspace` and anything containing `..`.

**No server yet?** `createMockServer` implements the whole contract (and `POST /flags`) in memory. It is also a
compact reference implementation: see [`src/mock.ts`](src/mock.ts).

```ts
import { createMockServer, mountIDE } from 'xterm-wasm-ide';

const mock = createMockServer({ 'hello.py': 'print(1)\n' }, { latencyMs: 80 });
await mountIDE(el, { backend: { baseUrl: mock.baseUrl, fetch: mock.fetch } });
mock.requests; // every request made
mock.flags;    // flags received
```

If your routes differ, implement the `FileSystem` interface yourself (see the [reference](#filesystem)). `httpFS` is about 30 lines
and a good starting point.

### Flagging (integrity signals)

Flagging is **opt-in**. It records signals that can indicate outside help during an assessment and POSTs each one to
your server.

```ts
await mountIDE(el, {
  backend: { baseUrl: '/api/v1/sessions/current' },
  flagging: {
    sessionId: 'abc123',                  // echoed in every flag
    onFlag: (f) => console.log(f),        // optional, called synchronously
    // api: { baseUrl, ... },             // send flags elsewhere; default: the backend
    // path: '/flags',                    // default
    // includeText: false,                // default; true adds a 120-char preview of pasted text
  },
});
```

Without `backend` or `flagging.api`, flags stay in memory: read them with `ide.flags()` or `onFlag`.

**What is flagged**

| `type` | `source` | Fires when | `detail` |
|---|---|---|---|
| `copy`, `cut` | editor | Ctrl/Cmd+C or X, or the context menu | `{ chars }` |
| `paste` | editor, terminal | Ctrl/Cmd+V or the context menu | `{ chars, lines, internal? }` |
| `drop` | editor | text is dragged into the editor | `{ chars, lines }` |
| `fast-typing` | editor | typed characters per second exceed the limit over a window | `{ cps, chars, windowMs }` |
| `bulk-insert` | editor | a single non-paste insertion is long (autocomplete, extensions, scripts) | `{ chars }` |
| `tab-out` | window | window loses focus or the tab is hidden | `{ reason: 'blur' \| 'hidden' }` |
| `tab-return` | window | focus returns | `{ durationMs }` |

Details worth knowing:

- Paste is `internal: true` when the text equals what was last copied from this same editor. That is usually benign.
- Only **unusually fast** typing is flagged, never slow typing. The defaults flag more than 14 characters per second over
  3 seconds with at least 30 characters, and at most once per 15 seconds. Pasted text, drops, undo/redo and programmatic
  reloads are excluded from the typing count, so they don't trigger it twice.
- Tune it: `typing: { maxCps: 12, windowMs: 3000, minChars: 30, bulkChars: 80 }`, or `typing: false` to disable.
  Other switches: `clipboard: false`, `tabOut: false`.
- Each flag is POSTed as it happens. Failed posts are retried every 10 seconds, when the browser comes back online, and
  on page hide.

**Payload**

```json
{
  "type": "paste",
  "at": "2026-11-07T15:40:12.345Z",
  "source": "editor",
  "path": "/workspace/solution.py",
  "sessionId": "abc123",
  "detail": { "chars": 340, "lines": 14, "internal": false }
}
```

**Use these as signals, not proof.** Fast typing can be a fast typist; tab-outs can be notifications; pastes can be the
candidate's own snippets. Review flags in context, and tell candidates what is monitored. Because all checks run in the
browser, a determined user can bypass them: treat them as one input to review, not a gate.

### Theming

The IDE root (`.xwi`) defines its palette as CSS variables, using Tailwind v4's default mist, olive and mauve colors
as plain hex. Override them in your own CSS after the library's stylesheet:

```css
.xwi {
  --accent: #3b82f6;
  --accent-light: #60a5fa;
  --panel: #101418;
}
```

| Variable | Default | Used for |
|---|---|---|
| `--ink` | `#f1f3f3` | primary text |
| `--muted` / `--dim` | `#9ca8ab` / `#67787c` | secondary text |
| `--shell` | `#090b0c` | page background, button text |
| `--panel` | `#161b1d` | frame, tab bar, terminal background |
| `--surface` | `#22292b` | explorer, chips |
| `--raised` | `#394447` | hover backgrounds, terminal selection |
| `--line` / `--line-hover` | `#22292b` / `#394447` | borders |
| `--accent` / `-light` / `-lighter` | `#7c7c67` / `#abab9c` / `#d8d8d0` | active tab, buttons, folders, hover |
| `--accent-secondary` / `-hover` | `#79697b` / `#a89ea9` | language chip |
| `--warning`, `--danger` | `oklch(66% 0.09 84)`, `oklch(58% 0.09 15)` | status and delete |
| `--mono` | system monospace stack | explorer and terminal |
| `--explorer-w`, `--terminal-h` | `240px`, `260px` | initial pane sizes |

The terminal reads its colors once when it mounts, so overrides must be in place before `mountIDE`. The Monaco theme
(`quitlarp`, `vs-dark` with `#22292b`) is fixed. If your bundler doesn't follow the CSS import inside the package,
import `xterm-wasm-ide/style.css` yourself.

---

## API reference

### `mountIDE(container, options?)`

```ts
function mountIDE(container: HTMLElement, options?: IDEOptions): Promise<IDE>;
```

Resolves once the filesystem is ready and (if enabled) bash has started. Mount one IDE per container.

### `IDEOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `components` | `{ explorer?, editor?, terminal? }` | all `true` | Turn parts off. The grid collapses around the rest. |
| `files` | `Record<string, string>` | `{}` | Seed files, keyed by path relative to `/workspace`. Nested paths create folders. |
| `packages` | `string[]` | default list | Shorthand for `terminal.packages`. |
| `terminal` | [`TerminalOptions`](#terminaloptions) | | Terminal customization. |
| `backend` | [`ApiOptions`](#apioptions) | none | Persist to a server. Omit for memory only. |
| `open` | `string[]` | `[]`, or first 20 files if the explorer is off | Files to open as tabs at start. |
| `flagging` | [`FlaggingOptions`](#flaggingoptions) | off | Enable integrity signals. |

### `IDE`

| Member | Description |
|---|---|
| `dispose()` | Remove the UI, stop timers and listeners, kill bash and close the sandbox. |
| `flags(): Flag[]` | Every flag raised so far. Empty unless `flagging` is set. |
| `fs: FileSystem` | The filesystem the explorer and editor use. Handy for reading or writing files from your own UI. |

### `TerminalOptions`

| Option | Type | Description |
|---|---|---|
| `packages` | `string[]` | Replace the default package list. |
| `extraPackages` | `PackageSource[]` | Add registry names, WEBC bytes or `Package` objects. |
| `commands` | `Record<string, Uint8Array>` | WASIX modules exposed as commands. Untested. |
| `aliases` | `Record<string, string>` | Shell aliases. |
| `bashrc` | `string` | Appended to `~/.bashrc`. |
| `env` | `Record<string, string>` | Extra environment variables. `HOME`, `PWD` and `TERM` are preset. |

### `ApiOptions`

| Option | Type | Description |
|---|---|---|
| `baseUrl` | `string` | Prefix for every request, with no trailing slash. |
| `headers` | `Record<string,string>` or `() => Record \| Promise<Record>` | Extra headers. |
| `credentials` | `RequestCredentials` | Default `'include'`. |
| `fetch` | `typeof fetch` | Custom fetch (mocks, auth wrappers). |

Failed requests throw `ApiError` with `.status` and `.message` (taken from the response's `detail` or `error`).

### `FlaggingOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `api` | `ApiOptions` | the `backend` | Where flags are POSTed. |
| `path` | `string` | `'/flags'` | Appended to the api base. |
| `onFlag` | `(flag: Flag) => void` | | Called for every flag. Errors in it are swallowed. |
| `sessionId` | `string` | | Included in every flag. |
| `includeText` | `boolean` | `false` | Include a 120-character preview of pasted or dropped text. |
| `clipboard` | `boolean` | `true` | Flag copy, cut, paste and drop. |
| `tabOut` | `boolean` | `true` | Flag focus loss and return. |
| `typing` | `false \| { maxCps?, windowMs?, minChars?, bulkChars? }` | `14, 3000, 30, 80` | Typing-speed heuristics. |

### `Flag`

```ts
type FlagType = 'paste' | 'copy' | 'cut' | 'drop' | 'fast-typing' | 'bulk-insert' | 'tab-out' | 'tab-return';

interface Flag {
  type: FlagType;
  at: string;                                  // ISO timestamp
  source: 'editor' | 'terminal' | 'window';
  path: string | null;                         // active file, if any
  sessionId?: string;
  detail: Record<string, unknown>;
}
```

### `FileSystem`

Implement this to plug in any storage. All paths are absolute under `/workspace`.

```ts
interface FileSystem {
  list(path: string): Promise<Entry[]>;        // Entry = { name, path, dir }
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  mkdir(path: string): Promise<void>;          // recursive
  remove(path: string): Promise<void>;         // recursive
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}
```

A custom `FileSystem` can't be passed as an option yet: use `backend` (REST) or build on `httpFS`/`memoryFS`.

### Other exports

| Export | Description |
|---|---|
| `memoryFS(files?)` | In-memory `FileSystem`. |
| `httpFS(api)` | REST `FileSystem` for the [contract above](#saving-to-a-server). |
| `createMockServer(files?, { latencyMs? })` | In-memory server: `{ baseUrl, fetch, fs, flags, requests }`. |
| `ApiError` | Error class thrown by API calls. |
| Types | `IDEOptions`, `IDE`, `TerminalOptions`, `ApiOptions`, `FlaggingOptions`, `Flag`, `FlagType`, `Entry`, `FileSystem`. |

### UI behavior

- **Explorer:** click a folder to expand, a file to open. Right-click for New file, New folder, Rename, Delete (the empty
  area targets the root). Rename and delete close the affected tabs, and unsaved edits in them are lost.
- **Editor:** one Monaco model per open file (URI = path). Tabs show a dot when dirty. <kbd>Ctrl/Cmd</kbd>+<kbd>S</kbd> or the Save
  button writes the file.
- **Splitters:** drag the explorer edge (min 160px) and the editor/terminal edge (terminal min 80px).
- **Terminal:** `bash -i` with readline editing. If bash exits, press any key to restart it. `clear` is redefined in `.bashrc`.

---

## Troubleshooting

**The terminal says the page is not cross-origin isolated.** Serve with the two headers from the [quick start](#3-serve-with-the-right-headers-terminal-only), including
in `vite preview` and production. Third-party iframes and scripts without CORP/CORS headers will break under
`require-corp`.

**Editor blank, console shows a 404 or error for a worker.** Vite needs the `MonacoEnvironment` setup from the
[quick start](#4-vite-setup), with the `monaco-editor/editor/editor.worker.js` style paths.

**The IDE has no height.** The container needs an explicit height.

**"Could not start the Wasmer sandbox".** Usually a package name that isn't in the registry (for example `wasmer/jq` does not
exist), a network problem fetching packages, or missing isolation headers. The message includes the cause.

**Terminal output looks staircased or misaligned.** Don't change `convertEol` in a fork: the WASIX tty emits bare line
feeds.

**Command not found.** The default list has no `awk`, `diff`, `jq`, `make`, `vim` or `stty`. Add packages with
`extraPackages`, but only names that exist in the Wasmer registry.

**Files from bash don't show up.** The explorer refreshes about once a second while the browser tab is visible. With a
backend, the server copy lags by up to ~3 seconds.

---

## Limitations

- The sandbox filesystem resets on reload. Use a `backend` to persist.
- Browser support was only tested on Chromium.
- Server sync doesn't merge: the server wins on load, then the last write wins. It reads every file each cycle, so it
  suits small workspaces.
- Flagging runs client-side and can be bypassed. It reports signals, not verdicts.
- A custom `FileSystem` isn't accepted as an option yet, and `commands` (custom WASIX modules) hasn't been tested.
