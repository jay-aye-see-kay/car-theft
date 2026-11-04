// Play the game from a shell, a command at a time: npm run play -- look
// The first call starts the daemon (scripts/agent/daemon.ts: a headless
// browser on the built game, so `npm run build` first) and later calls reuse
// it, so each command costs a round trip, not a page load. Game time only
// moves inside commands (wait, hold, go, play), so nothing happens while you
// think. `npm run play -- stop` shuts it down. See docs/AGENT-PLAYTEST.md.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';

const words = process.argv.slice(2);
const flags = words.filter((w) => w.startsWith('--'));
// One daemon per port (--port=n), so two agents can play side by side.
const PORT = Number(flags.find((f) => f.startsWith('--port='))?.split('=')[1] ?? 4380);
const STATE = new URL(`../../.agent/${PORT === 4380 ? 'daemon' : `daemon-${PORT}`}.json`, import.meta.url);
const LOG = new URL(`../../.agent/${PORT === 4380 ? 'daemon' : `daemon-${PORT}`}.log`, import.meta.url);
const line = words.filter((w) => !w.startsWith('--')).join(' ') || 'help';

async function send(port: number, body: string): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body });
    return await r.text();
  } catch {
    return null;
  }
}

const known = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;
let out = known ? await send(known.port, line) : null;
if (out === null) {
  if (line === 'stop') {
    console.log('not running');
    process.exit(0);
  }
  if (!existsSync(new URL('../../dist/index.html', import.meta.url))) {
    console.error('no dist/: run `npm run build` first');
    process.exit(1);
  }
  const t0 = Date.now();
  mkdirSync(new URL('.', LOG), { recursive: true });
  const log = openSync(LOG, 'a');
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', new URL('daemon.ts', import.meta.url).pathname, ...flags], { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  for (let i = 0; i < 600 && out === null; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (existsSync(STATE)) out = await send(PORT, line);
  }
  if (out === null) {
    console.error(`the daemon didn't start; see ${LOG.pathname}`);
    process.exit(1);
  }
  console.error(`(started the game in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
process.stdout.write(out);
