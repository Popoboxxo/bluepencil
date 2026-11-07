#!/usr/bin/env node
/**
 * Secret scan (NFR-13).
 *
 * A dependency-free guard over the tracked files: it looks for the credential shapes that must
 * never end up in this repository (tokens, private keys, passwords, connection strings) and for
 * committed review data. It is intentionally noisy-free: matches inside the ignore list (lock
 * files) are skipped, and the pattern list is short enough to reason about.
 *
 * Two narrow mechanisms keep identifier *names* out of the "password literal" rule without
 * weakening it:
 *   1. The keyword must not be preceded by `-`: `--auth-secret=` is a CLI flag name, not an
 *      assignment (the value of a flag lives outside its name).
 *   2. `NON_SECRET_LITERALS` is a byte-exact allowlist of quoted values that are names, not
 *      credentials (a protocol header name, an env-var name, a test fixture). Exact matching means
 *      a real credential can never be masked by it.
 * A value that differs in a single character is still a finding.
 *
 * Usage: node scripts/secret-scan.mjs        (exit 1 on a finding)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const SKIP = [/^package-lock\.json$/, /\.map$/, /^dist\//, /\.png$/, /\.jpg$/, /\.gif$/];

/**
 * `valueGroup` names the capture group holding the quoted literal. It is only set where an exact
 * allowlist applies; the remaining rules report on any match.
 */
export const PATTERNS = [
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "OpenAI-style key", regex: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "private key block", regex: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  {
    // `(?<!-)`: `--auth-secret=` is a flag name; the char before `secret` is a hyphen.
    name: "password literal",
    regex: /(?<!-)(password|passwd|secret)\s*[:=]\s*["']([^"'\s]{6,})["']/i,
    valueGroup: 2,
  },
  { name: "connection string", regex: /\b(?:postgres|mysql|mongodb(\+srv)?):\/\/[^\s"']+:[^\s"']+@/ },
];

/**
 * Quoted values that shape-match the "password literal" rule but are identifiers. Byte-exact on
 * purpose: the reason is part of the entry so the next reader knows why it is safe.
 */
export const NON_SECRET_LITERALS = new Map([
  ["x-bluepencil-auth", "protocol header name (src/core/protocol-headers.ts, docs/specs §3.8)"],
  ["WEBSTORE_CLIENT_SECRET", "environment-variable name (scripts/chrome-webstore.mjs ENV)"],
  ["hub-host-check-secret", "unit-test fixture value (tests/unit/hub-host-check.test.ts)"],
  ["operator-fixture-secret-1", "unit-test fixture value (tests/unit/admin-secret.test.ts)"],
  ["viewer-secret-123456", "unit-test fixture value (tests/unit/viewer-cors.test.ts)"],
  ["viewer-dispatch-operator", "unit-test fixture value (tests/unit/viewer-dispatch.test.ts)"],
  ["viewer-lifecycle-operator", "unit-test fixture value (tests/unit/viewer-lifecycle.test.ts)"],
  ["viewer-proxy-operator-secret", "unit-test fixture value (tests/unit/viewer-proxy.integration.test.ts)"],
  ["viewer-session-integration-operator", "unit-test fixture value (tests/unit/viewer-session.integration.test.ts)"],
  ["operator-secret-123456", "unit-test fixture value (tests/unit/viewer-start.test.ts)"],
]);

/**
 * Scans one file's text. Returns `{ line, name }` per finding, one per pattern per line.
 */
export function scanText(text) {
  const findings = [];
  const lines = text.split("\n");
  for (const { name, regex, valueGroup } of PATTERNS) {
    const globalRegex = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
    lines.forEach((line, index) => {
      for (const match of line.matchAll(globalRegex)) {
        if (valueGroup !== undefined && NON_SECRET_LITERALS.has(match[valueGroup])) continue;
        findings.push({ line: index + 1, name });
        return;
      }
    });
  }
  return findings;
}

/**
 * Every tracked *and* about-to-be-committed file. `git ls-files` alone lists what is already
 * tracked, so a scan run before the first commit of a new file reports "OK" while that exact file
 * is what gets pushed — measured: a suite with a secret-shaped fixture passed locally and failed in
 * CI, because the file was still untracked when the local scan ran. A check that cannot see the
 * file being written is the same class of bug as a typecheck that skips a directory.
 */
function listFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !SKIP.some((pattern) => pattern.test(line)));
}

function main() {
  const files = listFiles();
  const findings = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(`${root}/${file}`, "utf8");
    } catch {
      continue;
    }
    for (const { line, name } of scanText(text)) {
      findings.push(`${file}:${line} — ${name}`);
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
}

// Importable for tests: only run the repository scan when executed directly.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
