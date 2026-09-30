#!/usr/bin/env node
/**
 * Secret scan (NFR-13).
 *
 * A dependency-free guard over the tracked files: it looks for the credential shapes that must
 * never end up in this repository (tokens, private keys, passwords, connection strings) and for
 * committed review data. It is intentionally noisy-free: matches inside the ignore list (lock
 * files) are skipped, and the pattern list is short enough to reason about.
 *
 * Usage: node scripts/secret-scan.mjs        (exit 1 on a finding)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const SKIP = [/^package-lock\.json$/, /\.map$/, /^dist\//, /\.png$/, /\.jpg$/, /\.gif$/];
const PATTERNS = [
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "OpenAI-style key", regex: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "private key block", regex: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "password literal", regex: /(password|passwd|secret)\s*[:=]\s*["'][^"'\s]{6,}["']/i },
  { name: "connection string", regex: /\b(?:postgres|mysql|mongodb(\+srv)?):\/\/[^\s"']+:[^\s"']+@/ },
];

// Tracked *and* about-to-be-committed files. `git ls-files` alone lists what is already tracked, so a
// scan run before the first commit of a new file reports "OK" while that exact file is what gets
// pushed — measured: a suite with a secret-shaped fixture passed locally and failed in CI, because
// the file was still untracked when the local scan ran. A check that cannot see the file being
// written is the same class of bug as a typecheck that skips a directory.
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !SKIP.some((pattern) => pattern.test(line)));

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(`${root}/${file}`, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  for (const { name, regex } of PATTERNS) {
    lines.forEach((line, index) => {
      if (regex.test(line)) {
        findings.push(`${file}:${index + 1} — ${name}`);
      }
    });
  }
}

// Review data must never be committed (see .gitignore).
const reviewData = files.filter(
  (file) => file.endsWith(".bluepencil.json") && !file.startsWith("examples/"),
);
for (const file of reviewData) {
  findings.push(`${file} — committed review data (only the fixture seed may be tracked)`);
}

if (findings.length > 0) {
  console.error(`secret scan: ${findings.length} finding(s)`);
  for (const finding of findings) {
    console.error(`  ${finding}`);
  }
  process.exit(1);
}

console.log(`secret scan: OK (${files.length} files, no credentials or review data)`);
