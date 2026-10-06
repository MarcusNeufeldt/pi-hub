// Runs `next build` with an fs shim so Next's build-time file tracer
// (@vercel/nft) copes with this machine's Windows user profile.
//
// Why: nft statically expands directory reads and globs it finds in traced
// code, and at least one traced pattern covers the whole home directory
// (`C:\Users\<user>/**/*`). Two failure modes on Windows:
//   1. readdir on compatibility junctions (C:\Users\<user>\Application Data,
//      ...) fails with EPERM, aborting the build outright.
//   2. If the walk succeeds it enumerates the entire profile (node_modules,
//      sessions, caches) and the build runs for tens of minutes.
// Both are fixed the same way: during the build, directory listings of the
// home ROOT are empty (slash-format agnostic). Nothing in `next build`
// legitimately enumerates the home root, runtime code is unaffected, and
// every other directory (.pi, .codex, .agents, temp) is still traced normally.
// The shim also installs itself into child processes (webpack workers trace
// in workers) via NODE_OPTIONS.
// Investigation: 2026-09-13 scheduled-task fix session.
"use strict";

if (!globalThis.__NEXT_BUILD_FS_SHIM) {
  globalThis.__NEXT_BUILD_FS_SHIM = true;

  const fs = require("fs");
  const os = require("os");

  const normalize = (p) => String(p).replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  const HOME_ROOTS = new Set(
    [os.homedir(), process.env.USERPROFILE].filter(Boolean).map(normalize),
  );

  const COMPAT_JUNCTIONS = new Set([
    "Application Data",
    "Cookies",
    "Local Settings",
    "My Documents",
    "NetHood",
    "PrintHood",
    "Recent",
    "SendTo",
    "Start Menu",
    "Templates",
  ]);

  const isHomeRoot = (p) => typeof p === "string" && HOME_ROOTS.has(normalize(p));

  function soften(p, err) {
    if (
      err &&
      (err.code === "EPERM" || err.code === "EACCES") &&
      typeof p === "string" &&
      COMPAT_JUNCTIONS.has(p.split(/[\\/]/).pop())
    ) {
      err.code = "ENOENT";
      err.errno = -4058;
      err.syscall = err.syscall || "scandir";
    }
    return err;
  }

  const origReaddir = fs.readdir;
  fs.readdir = function (p, opts, cb) {
    if (typeof opts === "function") {
      cb = opts;
      opts = undefined;
    }
    if (isHomeRoot(p)) {
      process.nextTick(cb, null, []);
      return;
    }
    try {
      return origReaddir.call(fs, p, opts, function (err, entries) {
        cb(soften(p, err), entries);
      });
    } catch (err) {
      throw soften(p, err);
    }
  };

  const origReaddirSync = fs.readdirSync;
  fs.readdirSync = function (p, opts) {
    if (isHomeRoot(p)) return [];
    try {
      return origReaddirSync.call(fs, p, opts);
    } catch (err) {
      throw soften(p, err);
    }
  };

  const promises = fs.promises;
  const origReaddirPromise = promises.readdir;
  promises.readdir = async function (p, opts) {
    if (isHomeRoot(p)) return [];
    try {
      return await origReaddirPromise.call(promises, p, opts);
    } catch (err) {
      throw soften(p, err);
    }
  };
}

// Propagate to child processes (Next runs webpack + tracing in workers).
const marker = `--require ${__filename}`;
if (!(process.env.NODE_OPTIONS || "").includes(marker)) {
  process.env.NODE_OPTIONS = `${marker} ${process.env.NODE_OPTIONS || ""}`.trim();
}

if (require.main === module) {
  // Next's CLI reads the subcommand from process.argv[2]; this script occupies
  // that slot when invoked as `node scripts/next-build.cjs --webpack`, so
  // inject the real command before loading Next's bin.
  process.argv.splice(2, 0, "build");
  require("next/dist/bin/next");
}

module.exports = {};
