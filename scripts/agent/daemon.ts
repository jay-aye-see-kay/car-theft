// The agent's game: one headless Chromium kept open on the built game with
// ?debug, driven by short text commands over HTTP on localhost, answered in
// short text. Started (and found again) by scripts/agent/play.ts; stops itself
// after IDLE minutes with nothing to do. See docs/AGENT-PLAYTEST.md.
//
//   node --experimental-strip-types scripts/agent/daemon.ts [--port=4380] [--map=test] [--headed]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium, type Page } from 'playwright';
import { COMMANDS, type Ctx } from './commands.ts';
import { TextMap } from './ascii.ts';

const args = process.argv.slice(2);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const PORT = Number(opt('port') ?? 4380);
const WEB = PORT + 1;
const IDLE = Number(opt('idle') ?? 30); // minutes
export const STATE_DIR = new URL('../../.agent/', import.meta.url);
mkdirSync(STATE_DIR, { recursive: true });
const STATE_FILE = new URL(PORT === 4380 ? 'daemon.json' : `daemon-${PORT}.json`, STATE_DIR);

const server = spawn('npx', ['vite', 'preview', '--port', String(WEB), '--strictPort'], { stdio: 'ignore', cwd: new URL('../..', import.meta.url).pathname });
const url = `http://localhost:${WEB}/?debug${opt('map') ? `&map=${opt('map')}` : ''}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(url)).ok) break;
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 100));
}

const browser = await chromium.launch({
  headless: !args.includes('--headed'),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page: Page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!(window as any).__game, null, { timeout: 30000 });
await page.waitForFunction(() => !/Loading/.test(document.getElementById('status')!.textContent!), null, { timeout: 60000 });
await page.keyboard.press('KeyX');
await page.waitForFunction(() => (window as any).__game.state().started, null, { timeout: 5000 });
await page.evaluate(() => (window as any).__game.reset());

const ctx: Ctx = { page, errors, textMap: opt('map') ? null : new TextMap(), shots: new URL('shots/', STATE_DIR).pathname };
mkdirSync(ctx.shots, { recursive: true });

let idleTimer: NodeJS.Timeout;
const touch = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => shutdown(), IDLE * 60_000);
};
let queue = Promise.resolve();

async function run(line: string): Promise<string> {
  const out: string[] = [];
  // Several commands in one go: "go k-road-dairy; look". An eval takes the rest of the line (JS has semicolons).
  const ev = line.search(/(^|;)\s*eval\s/);
  const parts = (ev < 0 ? line : line.slice(0, ev)).split(/\s*;\s*/).filter(Boolean);
  if (ev >= 0) parts.push(line.slice(ev).replace(/^;?\s*/, ''));
  for (const one of parts) {
    const [name, ...rest] = one.trim().split(/\s+/);
    const cmd = COMMANDS[name] ?? Object.values(COMMANDS).find((c) => c.alias?.includes(name));
    if (!cmd) {
      out.push(`unknown command "${name}". Try: help`);
      break;
    }
    try {
      out.push(await cmd.run(ctx, rest));
    } catch (e) {
      out.push(`error in "${one}": ${e instanceof Error ? e.message.split('\n')[0] : e}`);
      break;
    }
    if (errors.length) out.push(`page errors: ${errors.splice(0).join(' | ')}`);
  }
  return out.join('\n');
}

const http = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    touch();
    if (body.trim() === 'stop') {
      res.end('stopped\n');
      void shutdown();
      return;
    }
    queue = queue.then(async () => {
      const text = await run(body);
      res.end(text.endsWith('\n') ? text : text + '\n');
    });
  });
});
http.listen(PORT, '127.0.0.1', () => {
  writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port: PORT, url }));
  console.log(`agent daemon on 127.0.0.1:${PORT}, game at ${url}`);
});
touch();

async function shutdown() {
  rmSync(STATE_FILE, { force: true });
  http.close();
  await browser.close().catch(() => {});
  server.kill();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
