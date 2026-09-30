import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as dns } from "node:dns";

const REGION_NAME = {
  CN: "中国大陆",
  HK: "香港",
  MO: "澳门",
};

const SUFFIXES = [
  [".cn", "CN"],
  [".hk", "HK"],
  [".mo", "MO"],
  [".xn--fiqs8s", "CN"],
  [".xn--fiqz9s", "CN"],
  [".xn--j6w193g", "HK"],
  [".xn--mix082f", "MO"],
];

const FILE_SUFFIX = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "json", "md", "yml", "yaml",
  "css", "html", "map", "log", "txt", "png", "jpg", "jpeg", "gif", "svg",
  "woff", "woff2", "lock", "vue", "py", "go", "rs", "java", "xml", "toml",
  "ini", "bak", "patch", "diff", "sh", "ps1", "cmd", "exe",
]);

const SKIP_KEYS = new Set([
  "content", "old_string", "new_string", "text", "patch", "code",
  "file_text", "body", "diff",
]);

const ranges = loadRanges();
const v4 = ranges.v4;
const v6 = ranges.v6.map((row) => ({
  value: parseIpv6(row[0]),
  len: row[1],
  region: row[2],
})).filter((row) => row.value != null);

const lookupCache = new Map();
const LOOKUP_TTL_MS = 10 * 60 * 1000;
const LOOKUP_LIMIT = 12;

function loadRanges() {
  try {
    const fp = path.join(path.dirname(fileURLToPath(import.meta.url)), "net-scope-ranges.json");
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
    return {
      v4: Array.isArray(parsed.v4) ? parsed.v4 : [],
      v6: Array.isArray(parsed.v6) ? parsed.v6 : [],
    };
  } catch {
    return { v4: [], v6: [] };
  }
}

function ipv4ToInt(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const number = Number(part);
    if (number > 255) return null;
    value = value * 256 + number;
  }
  return value >>> 0;
}

function isSkippedV4(value) {
  const a = value >>> 24;
  const b = (value >>> 16) & 255;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function parseIpv6(input) {
  let text = String(input || "").trim().toLowerCase().split("%")[0];
  if (!text) return null;
  if (text.includes(".")) {
    const colon = text.lastIndexOf(":");
    const tail = ipv4ToInt(text.slice(colon + 1));
    if (tail == null) return null;
    const hi = (tail >>> 16).toString(16);
    const lo = (tail & 0xffff).toString(16);
    text = `${text.slice(0, colon + 1)}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && missing < 0) return null;
  const parts = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (parts.length !== 8) return null;
  let out = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    out = (out << 16n) + BigInt(parseInt(part, 16));
  }
  return out;
}

export function regionOfIp(ip) {
  const text = String(ip || "").trim().toLowerCase();
  if (text.includes(":")) {
    const value = parseIpv6(text);
    if (value == null) return "";
    for (const row of v6) {
      const shift = BigInt(128 - row.len);
      if ((value >> shift) === (row.value >> shift)) return row.region;
    }
    return "";
  }
  const value = ipv4ToInt(text);
  if (value == null || isSkippedV4(value)) return "";
  let lo = 0;
  let hi = v4.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (v4[mid][0] <= value) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return "";
  return value <= v4[found][1] ? v4[found][2] : "";
}

export function regionOfSuffix(host) {
  const name = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  if (!name || name === "localhost" || name.endsWith(".local")) return "";
  for (const [suffix, region] of SUFFIXES) {
    if (name === suffix.slice(1) || name.endsWith(suffix)) return region;
  }
  return "";
}

function hostOf(raw) {
  let host = String(raw || "").trim().toLowerCase();
  if (!host) return "";
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end > 1 ? host.slice(1, end) : "";
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(host)) return host.replace(/:\d+$/, "");
  if (/^[a-z0-9.-]+:\d+$/.test(host)) return host.replace(/:\d+$/, "");
  return host.replace(/\.$/, "");
}

function addHost(raw, hosts) {
  const host = hostOf(raw);
  if (!host || host.length > 253) return;
  hosts.add(host);
}

function collectFromText(text, hosts) {
  const sample = String(text || "").slice(0, 32768);
  const url = /\b(?:[a-z][a-z0-9+.-]*:\/\/)([^/?#\s]+)/gi;
  for (const match of sample.matchAll(url)) addHost(match[1], hosts);
  const ipv4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
  for (const match of sample.matchAll(ipv4)) hosts.add(match[0]);
  const ipv6 = /\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi;
  for (const match of sample.matchAll(ipv6)) hosts.add(match[0]);
  if (/[\\/]/.test(sample)) return;
  const domain = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;
  for (const match of sample.matchAll(domain)) {
    const name = match[0].toLowerCase();
    const tail = name.slice(name.lastIndexOf(".") + 1);
    if (FILE_SUFFIX.has(tail)) continue;
    hosts.add(name);
  }
}

function collect(value, key, hosts) {
  if (typeof value === "string") {
    if (SKIP_KEYS.has(String(key || "")) && value.length > 200) return;
    collectFromText(value, hosts);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, key, hosts);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) collect(child, childKey, hosts);
  }
}

function blocked(label, region) {
  return { label, region, regionName: REGION_NAME[region] || region };
}

async function addressesOf(host) {
  const found = [];
  const records = await Promise.race([
    Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]),
    new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
  ]);
  if (Array.isArray(records)) {
    for (const item of records) {
      if (item.status === "fulfilled" && Array.isArray(item.value)) found.push(...item.value);
    }
  }
  if (found.length) return found;
  try {
    const looked = await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise((resolve) => setTimeout(() => resolve([]), 1500)),
    ]);
    if (Array.isArray(looked)) {
      for (const item of looked) {
        if (item?.address) found.push(item.address);
      }
    }
  } catch {
    /* 解析失败就不当成命中，境外地址不会被误拦。 */
  }
  return found;
}

async function regionOfResolved(host) {
  const now = Date.now();
  const cached = lookupCache.get(host);
  if (cached && now - cached.at < LOOKUP_TTL_MS) return cached.region;
  let region = "";
  try {
    for (const address of await addressesOf(host)) {
      region = regionOfIp(address);
      if (region) break;
    }
  } catch {
    region = "";
  }
  lookupCache.set(host, { at: now, region });
  return region;
}

/** 命中中国大陆、香港、澳门网段时返回目标；解析不到或不在这些网段则放行。 */
export async function findBlocked(value) {
  const hosts = new Set();
  collect(value, "", hosts);
  const pending = [];
  for (const host of hosts) {
    const suffix = regionOfSuffix(host);
    if (suffix) return blocked(host, suffix);
    const ip = regionOfIp(host);
    if (ip) return blocked(host, ip);
    if (host.includes(".") && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && !host.includes(":")) {
      pending.push(host);
    }
  }
  const batch = pending.slice(0, LOOKUP_LIMIT);
  const resolved = await Promise.all(batch.map((host) => regionOfResolved(host)));
  for (let i = 0; i < batch.length; i += 1) {
    if (resolved[i]) return blocked(batch[i], resolved[i]);
  }
  return null;
}

export function installRegionGate(ctx) {
  if (!ctx || typeof ctx.on !== "function") return;
  const hook = async (exec, next) => {
    try {
      const hit = await findBlocked(exec?.arguments);
      if (hit) {
        return {
          kind: "deny",
          reason: "不行，这是严令禁止的",
        };
      }
    } catch {
      return next();
    }
    return next();
  };
  const arm = () => {
    if (ctx.__dshPurgeRegionGate) return;
    try {
      ctx.on("tools/pre-execute", hook, { global: true, prepend: true });
      ctx.__dshPurgeRegionGate = true;
    } catch {
      /* 宿主还没有这条事件时，下一拍再挂。 */
    }
  };
  arm();
  queueMicrotask(arm);
}
