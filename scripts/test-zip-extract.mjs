import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { extractZipArchive, extractZipBuffer, listZipEntries, unzipTools } from "../lib/zip-extract.js";

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const body = Buffer.from(file.body);
    const method = file.method === 8 ? 8 : 0;
    const data = method === 8 ? zlib.deflateRawSync(body) : body;
    const crc = crc32(body);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(data.length), u32(body.length), u16(name.length), u16(0),
      name, data,
    ]);
    locals.push(local);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(data.length), u32(body.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset),
      name,
    ]);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

assert.deepEqual(unzipTools("win32"), ["tar", "powershell", "node"]);
assert.deepEqual(unzipTools("linux"), ["tar", "unzip", "python3", "bsdtar", "node"]);
assert.deepEqual(unzipTools("darwin"), ["tar", "unzip", "python3", "bsdtar", "node"]);
assert.equal(unzipTools("linux").includes("powershell"), false);
assert.equal(unzipTools("darwin").includes("powershell"), false);

const zip = buildZip([
  { name: "hello.txt", body: "hello", method: 0 },
  { name: "nested/a.txt", body: "deflated-body", method: 8 },
  { name: "dir/", body: "", method: 0 },
]);
assert.deepEqual(listZipEntries(zip), ["hello.txt", "nested/a.txt", "dir/"]);

const dest = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-zip-"));
try {
  extractZipBuffer(zip, dest);
  assert.equal(fs.readFileSync(path.join(dest, "hello.txt"), "utf8"), "hello");
  assert.equal(fs.readFileSync(path.join(dest, "nested", "a.txt"), "utf8"), "deflated-body");
  assert.equal(fs.existsSync(path.join(dest, "..", "evil.txt")), false);
} finally {
  fs.rmSync(dest, { recursive: true, force: true });
}

assert.throws(() => extractZipBuffer(buildZip([{ name: "../evil.txt", body: "no", method: 0 }]), dest));
assert.equal(fs.existsSync(path.join(os.tmpdir(), "evil.txt")), false);

const zipPath = path.join(os.tmpdir(), `dsh-zip-src-${process.pid}.zip`);
const viaDest = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-zip-via-"));
const liveDest = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-zip-live-"));
const fallbackDest = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-zip-fallback-"));
fs.writeFileSync(zipPath, zip);
try {
  const via = extractZipArchive(zipPath, viaDest, ["node"]);
  assert.equal(via, "node");
  assert.equal(fs.readFileSync(path.join(viaDest, "hello.txt"), "utf8"), "hello");
  const fallback = extractZipArchive(zipPath, fallbackDest, ["tar-does-not-exist", "node"]);
  assert.equal(fallback, "node");
  assert.equal(fs.readFileSync(path.join(fallbackDest, "nested", "a.txt"), "utf8"), "deflated-body");
  const live = extractZipArchive(zipPath, liveDest);
  assert.ok(["tar", "powershell", "unzip", "python3", "bsdtar", "node"].includes(live));
  console.log(`ok: zip extract via ${live} on ${process.platform}`);
} finally {
  fs.rmSync(zipPath, { force: true });
  fs.rmSync(viaDest, { recursive: true, force: true });
  fs.rmSync(liveDest, { recursive: true, force: true });
  fs.rmSync(fallbackDest, { recursive: true, force: true });
}
