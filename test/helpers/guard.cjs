/* Preload guard (node -r). Records and BLOCKS filesystem writes, network and process spawning.
 * Env: PREHELLO_GUARD_LOG = file the guard appends violations to (written with the ORIGINAL appendFileSync)
 *      PREHELLO_ALLOW_WRITE = path.delimiter-separated absolute paths that may be written (explicit output files)
 */
const fs = require("node:fs");
const path = require("node:path");
const LOG = process.env.PREHELLO_GUARD_LOG;
const ALLOW = (process.env.PREHELLO_ALLOW_WRITE || "").split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
const LOGFD = LOG ? fs.openSync(LOG, "a") : -1;
const rawWriteSync = fs.writeSync.bind(fs);
const record = (kind, detail) => {
  if (LOGFD >= 0) rawWriteSync(LOGFD, JSON.stringify({ kind, detail: String(detail) }) + "\n");
};
const block = (kind, detail) => {
  record(kind, detail);
  throw new Error(`GUARD: ${kind} blocked: ${detail}`);
};
const allowed = (p) => {
  if (typeof p !== "string" && !(p instanceof URL) && !Buffer.isBuffer(p)) return false;
  const abs = path.resolve(p instanceof URL ? require("node:url").fileURLToPath(p) : p.toString());
  return ALLOW.includes(abs);
};
const writeFlag = (f) => {
  if (f === undefined || f === null) return false;
  if (typeof f === "number") return (f & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC)) !== 0;
  return /[wa+]/.test(String(f));
};

const PATH_ARG0 = ["writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink", "chmod", "chown", "truncate", "utimes", "lchown", "lutimes", "mkdtemp", "createWriteStream", "cp", "lchmod"];
const TWO_PATH = ["rename", "copyFile", "symlink", "link"];
const wrapFs = (obj, name, kind) => {
  for (const base of PATH_ARG0) {
    for (const fn of [base, base + "Sync"]) {
      if (typeof obj[fn] !== "function") continue;
      const orig = obj[fn];
      obj[fn] = function (...a) {
        if (allowed(a[0]) && (fn.startsWith("writeFile") || fn.startsWith("createWriteStream") || fn.startsWith("appendFile"))) return orig.apply(this, a);
        return block(name + ".write", fn + " " + a[0]);
      };
    }
  }
  for (const base of TWO_PATH) {
    for (const fn of [base, base + "Sync"]) {
      if (typeof obj[fn] !== "function") continue;
      obj[fn] = function (...a) {
        return block(name + ".write", fn + " " + a[0] + " -> " + a[1]);
      };
    }
  }
  for (const fn of ["open", "openSync"]) {
    if (typeof obj[fn] !== "function") continue;
    const orig = obj[fn];
    obj[fn] = function (p, flags, ...r) {
      if (writeFlag(flags) && !allowed(p)) return block(name + ".write", fn + " " + p + " flags=" + flags);
      return orig.call(this, p, flags, ...r);
    };
  }
};
wrapFs(fs, "fs");
wrapFs(fs.promises, "fs.promises");

const deny = (mod, names, kind) => {
  for (const n of names) {
    if (typeof mod[n] === "function") mod[n] = () => block(kind, n);
  }
};
const net = require("node:net");
net.Socket.prototype.connect = function () { return block("network", "net.Socket.connect"); };
deny(net, ["connect", "createConnection", "createServer"], "network");
net.Server.prototype.listen = function () { return block("network", "net.Server.listen"); };
const dgram = require("node:dgram");
deny(dgram, ["createSocket"], "network");
const dns = require("node:dns");
deny(dns, ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"], "network");
deny(dns.promises, ["lookup", "resolve", "resolve4", "resolve6"], "network");
for (const m of ["http", "https", "http2", "tls"]) {
  const mod = require("node:" + m);
  deny(mod, ["request", "get", "connect", "createServer", "createSecureServer"], "network");
}
deny(require("node:child_process"), ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"], "spawn");
if (typeof globalThis.fetch === "function") globalThis.fetch = () => block("network", "fetch");
if (typeof globalThis.WebSocket === "function") globalThis.WebSocket = function () { return block("network", "WebSocket"); };
