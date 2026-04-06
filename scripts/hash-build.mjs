/**
 * hash-build.mjs — Compute SHA-256 of dist/ output
 *
 * Run after `vite build` to generate a deterministic hash of all built assets.
 * The hash covers every file in dist/ (sorted by path for determinism).
 *
 * Output: dist/BUILD_HASH with the hash + metadata
 */

import { createHash } from "crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";

const DIST = join(process.cwd(), "dist");

function walkDir(dir) {
  const entries = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (name === "BUILD_HASH") continue; // skip our own output
    if (statSync(full).isDirectory()) {
      entries.push(...walkDir(full));
    } else {
      entries.push(full);
    }
  }
  return entries;
}

const files = walkDir(DIST);
const hash = createHash("sha256");

for (const file of files) {
  const rel = relative(DIST, file).replace(/\\/g, "/");
  hash.update(rel);
  hash.update(readFileSync(file));
}

const digest = hash.digest("hex");

const output = {
  hash: digest,
  algorithm: "sha256",
  files: files.length,
  timestamp: new Date().toISOString(),
};

writeFileSync(join(DIST, "BUILD_HASH"), JSON.stringify(output, null, 2));

console.log(`\n  Build hash: ${digest}`);
console.log(`  Files:      ${files.length}`);
console.log(`  Written to: dist/BUILD_HASH\n`);
