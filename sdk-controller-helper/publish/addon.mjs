// Reading a .lunaaddon (a zip) and checking it is one LUNA can install. No dependencies.
import { inflateRawSync } from 'node:zlib';

const MAX_ADD_ON = 8 * 1024 * 1024;

export class Refused extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** The files in a zip, from its central directory, and a reader for one of them. */
export function readZip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Refused('That is not a .lunaaddon file.');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Refused('That .lunaaddon file is damaged.');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, { method, size, local });
    at += 46 + nameLength + extra + comment;
  }
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const data = buf.subarray(start, start + e.size);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRawSync(data);
    throw new Refused('That .lunaaddon file uses a compression this service does not read.');
  };
  return { names: [...entries.keys()], read };
}

/** Check a .lunaaddon the way LUNA reads one: one top folder holding manifest.json and its page. */
export function inspectAddOn(buf) {
  if (buf.length > MAX_ADD_ON) throw new Refused('That Add On is over 8 MB.');
  const zip = readZip(buf);
  const manifests = zip.names.filter((n) => /^[^/]+\/manifest\.json$/.test(n));
  if (manifests.length !== 1) throw new Refused('A .lunaaddon holds one folder with a manifest.json in it.');
  const folder = manifests[0].split('/')[0];
  let manifest;
  try {
    manifest = JSON.parse(zip.read(manifests[0]).toString('utf8'));
  } catch {
    throw new Refused('Its manifest.json is not valid JSON.');
  }
  for (const field of ['id', 'title', 'html']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) throw new Refused(`Its manifest has no ${field}.`);
  }
  if (!zip.names.includes(`${folder}/${manifest.html}`)) throw new Refused(`Its page, ${manifest.html}, is missing.`);
  if (zip.names.some((n) => n.split('/').includes('..') || n.startsWith('/'))) throw new Refused('That .lunaaddon file has unsafe paths in it.');
  return { folder, manifest, files: zip.names.filter((n) => !n.endsWith('/')) };
}
