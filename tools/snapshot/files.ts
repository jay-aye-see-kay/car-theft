// Reading files out of the frozen input snapshot (#46). The generator asks
// for a snapshot path and gets a local file whose sha256 matches the
// committed manifest: from .snapshot/<id>/ if it's there, else downloaded
// from the R2 mirror first. Nothing else is fetched from the network.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_BASE, SNAPSHOT_ID } from './sources.ts';

export const SNAPSHOT_ROOT = fileURLToPath(new URL('../../.snapshot/', import.meta.url));

export type ManifestFile = { bytes: number; sha256: string; url: string; licence: string; note?: string; lastModified?: string };
export type Manifest = { id: string; created: string; files: Record<string, ManifestFile> };

export const manifestPath = (id: string) => fileURLToPath(new URL(`./${id}.json`, import.meta.url));

export function loadManifest(id = SNAPSHOT_ID): Manifest {
  const p = manifestPath(id);
  if (!existsSync(p)) throw new Error(`no manifest for snapshot ${id} (${p}); run: npm run snapshot -- manifest`);
  return JSON.parse(readFileSync(p, 'utf8')) as Manifest;
}

export const localPath = (path: string, id = SNAPSHOT_ID) => join(SNAPSHOT_ROOT, id, path);

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/** Streams a URL to a file, via .part so an interrupted download is never mistaken for a whole one. */
export async function download(url: string, file: string): Promise<Response> {
  mkdirSync(dirname(file), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(`${file}.part`));
  renameSync(`${file}.part`, file);
  return res;
}

// Hashing 50 MB tiles on every run would cost seconds, so a verified file
// leaves a marker with the size and mtime it was checked at.
const okMarker = (file: string) => `${file}.ok`;
function markedOk(file: string, want: ManifestFile): boolean {
  if (!existsSync(okMarker(file))) return false;
  const st = statSync(file);
  return readFileSync(okMarker(file), 'utf8') === `${want.sha256} ${st.size} ${st.mtimeMs}`;
}

/** The local path of a snapshot file, fetched from the mirror if missing, checked against the manifest. */
export async function snapshotFile(path: string, id = SNAPSHOT_ID): Promise<string> {
  const want = loadManifest(id).files[path];
  if (!want) throw new Error(`${path} is not in snapshot ${id}`);
  const file = localPath(path, id);
  if (existsSync(file) && markedOk(file, want)) return file;
  if (!existsSync(file)) {
    const base = process.env.CITYGEN_SNAPSHOT_URL ?? SNAPSHOT_BASE;
    console.log(`  fetching ${path} from ${base}/${id}/ (${(want.bytes / 1e6).toFixed(1)} MB)`);
    await download(`${base}/${id}/${path}`, file);
  }
  const got = await sha256File(file);
  if (got !== want.sha256) throw new Error(`${file}: sha256 ${got} is not the manifest's ${want.sha256}`);
  const st = statSync(file);
  writeFileSync(okMarker(file), `${want.sha256} ${st.size} ${st.mtimeMs}`);
  return file;
}
