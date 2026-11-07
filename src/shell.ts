import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Process } from '@wasmer/sdk/browser';
import { type Workspace, ROOT } from './fs.js';

export interface Shell {
  term: Terminal;
  fit(): void;
  /** Resolves once bash is running (or failed). */
  start(ws: Workspace): Promise<void>;
  dispose(): void;
}

const css = (el: HTMLElement, name: string) => getComputedStyle(el).getPropertyValue(name).trim();

export function createShell(host: HTMLElement, root: HTMLElement, onInput: (data: string) => void): Shell {
  const term = new Terminal({
    fontFamily: css(root, '--mono'),
    cursorBlink: true,
    convertEol: true, // the WASIX tty emits bare LF
    theme: {
      background: css(root, '--panel'),
      foreground: css(root, '--ink'),
      cursor: css(root, '--accent-light'),
      selectionBackground: css(root, '--raised'),
    },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(host);

  let fitted = false;
  let onFirstFit: (() => void) | undefined;
  const firstFit = new Promise<void>((r) => (onFirstFit = r));
  const fit = () => {
    try {
      const dims = fitAddon.proposeDimensions();
      if (!dims || !dims.cols || !dims.rows) return;
      fitAddon.fit();
      if (!fitted) { fitted = true; onFirstFit?.(); }
    } catch { /* zero-size container */ }
  };
  fit();

  let proc: Process | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let ws: Workspace | null = null;
  let restartOnKey = false;

  term.onData((data) => {
    if (restartOnKey && ws) { restartOnKey = false; term.write('\r\n'); void spawn(ws); return; }
    const p = proc;
    if (!p?.stdin) return;
    chain = chain.then(() => p.stdin!.write(data)).catch(() => {});
    onInput(data);
  });
  term.onResize(({ cols, rows }) => { try { proc?.resizeTerminal(cols, rows); } catch { /* not running */ } });

  async function pump(stream: AsyncIterable<Uint8Array> | null) {
    if (!stream) return;
    try { for await (const chunk of stream) term.write(chunk); } catch { /* process ended */ }
  }

  async function spawn(w: Workspace) {
    const p = await w.sandbox
      .command('bash', ['-i'], { cwd: ROOT, env: w.env })
      .spawn({ terminal: { columns: term.cols, rows: term.rows } });
    proc = p;
    void pump(p.stdout);
    if (p.stderr !== p.stdout) void pump(p.stderr);
    const out = await p.wait();
    if (proc === p) proc = null;
    if (!disposed) {
      term.write(`\r\n\x1b[2m[bash exited with code ${out.exitCode}; press any key to restart]\x1b[0m`);
      restartOnKey = true;
    }
  }

  return {
    term,
    fit,
    async start(w) {
      ws = w;
      await firstFit; // only start after the first successful fit
      term.reset();
      void spawn(w).catch((e) => term.writeln(`\r\n\x1b[31mFailed to start bash: ${e?.message ?? e}\x1b[0m`));
    },
    dispose() {
      disposed = true;
      void proc?.kill().catch(() => {});
      term.dispose();
    },
  };
}
