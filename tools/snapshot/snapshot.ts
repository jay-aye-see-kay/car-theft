// Makes, checks and mirrors the frozen input snapshot (#46).
//
//   npm run snapshot -- fetch      download anything in sources.ts not yet in .snapshot/<id>/
//   npm run snapshot -- manifest   hash .snapshot/<id>/ into tools/snapshot/<id>.json (commit it)
//   npm run snapshot -- verify     check every local file against the manifest
//   npm run snapshot -- upload     put every file into R2 (wrangler, logged in), skipping ones already there
//
// Run on the laptop: Geofabrik and Overpass are blocked in the Claude cloud
// sandbox, and the upload needs Cloudflare credentials. A snapshot is made
// once; after its manifest is committed it's never changed, only replaced
// by a new id.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { download, loadManifest, localPath, manifestPath, sha256File, type Manifest } from './files.ts';
import { SNAPSHOT_BASE, SNAPSHOT_BUCKET, SNAPSHOT_ID, SOURCES } from './sources.ts';

const id = process.argv.find((a) => a.startsWith('--id='))?.slice(5) ?? SNAPSHOT_ID;
const cmd = process.argv[2];
const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;

async function fetchAll() {
  for (const s of SOURCES) {
    const file = localPath(s.path, id);
    if (existsSync(file)) continue;
    if (!s.url || s.url.includes('sparql')) {
      console.log(`  ${s.path}: made locally, not downloaded (see its note in sources.ts)`);
      continue;
    }
    console.log(`  ${s.path} <- ${s.url}`);
    await download(s.url, file);
  }
}

async function manifest() {
  const m: Manifest = { id, created: new Date().toISOString().slice(0, 10), files: {} };
  let total = 0;
  for (const s of SOURCES) {
    const file = localPath(s.path, id);
    if (!existsSync(file)) throw new Error(`${s.path} missing; run fetch first`);
    const bytes = statSync(file).size;
    total += bytes;
    m.files[s.path] = { bytes, sha256: await sha256File(file), url: s.url, licence: s.licence, ...(s.note ? { note: s.note } : {}) };
    console.log(`  ${s.path} ${mb(bytes)}`);
  }
  writeFileSync(manifestPath(id), JSON.stringify(m, null, 2) + '\n');
  console.log(`${Object.keys(m.files).length} files, ${mb(total)} -> ${manifestPath(id)}`);
}

async function verify() {
  const m = loadManifest(id);
  let bad = 0;
  for (const [path, f] of Object.entries(m.files)) {
    const file = localPath(path, id);
    const ok = existsSync(file) && (await sha256File(file)) === f.sha256;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok ' : 'BAD'} ${path}`);
  }
  if (bad) throw new Error(`${bad} file(s) missing or changed`);
}

async function upload() {
  // wrangler's object put takes files up to ~300 MB; the whole-region
  // snapshot's Geofabrik NZ extract (~400 MB) will need rclone or the S3 API.
  const m = loadManifest(id);
  for (const [path, f] of Object.entries(m.files)) {
    const head = await fetch(`${SNAPSHOT_BASE}/${id}/${path}`, { method: 'HEAD' }).catch(() => null);
    if (head?.ok && Number(head.headers.get('content-length')) === f.bytes) {
      console.log(`  there ${path}`);
      continue;
    }
    console.log(`  put ${path} (${mb(f.bytes)})`);
    execFileSync('wrangler', ['r2', 'object', 'put', `${SNAPSHOT_BUCKET}/${id}/${path}`, '--file', localPath(path, id), '--remote'], { stdio: 'inherit' });
  }
}

const cmds: Record<string, () => Promise<void>> = { fetch: fetchAll, manifest, verify, upload };
if (!cmds[cmd]) {
  console.log('usage: npm run snapshot -- fetch | manifest | verify | upload [--id=YYYY-MM-DD]');
  process.exit(1);
}
await cmds[cmd]();
