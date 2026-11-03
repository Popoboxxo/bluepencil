// @vitest-environment node

/**
 * Compose defaults for the shipped container (contract J, plan T-J1).
 *
 * Pins the three G11/SEC-24 defaults that an operator should never have to add by hand:
 *
 *  - AC-J01: the root `docker-compose.yml` publishes on host loopback, so a hub is not reachable
 *            from the network until somebody edits the file on purpose.
 *  - AC-J02: both compose files pin an exact image version (never `:latest`) and the federation
 *            aggregator stays on `127.0.0.1`.
 *  - AC-J03: every service runs hardened — `read_only`, `tmpfs: /tmp`, `cap_drop: [ALL]` and
 *            `no-new-privileges:true` — while `/data` (a named volume) stays writable.
 *
 * The checks are textual on purpose: they must run without a Docker daemon (CI unit job) and the
 * rendered result is verified separately with `docker compose config`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT_COMPOSE = fileURLToPath(new URL("../../docker-compose.yml", import.meta.url));
const FEDERATION_COMPOSE = fileURLToPath(
  new URL("../../examples/federation/docker-compose.yml", import.meta.url),
);
const DOCKER_DOC = fileURLToPath(new URL("../../docs/DOCKER.md", import.meta.url));

/** Exact version tag inside the documented `${BLUEPENCIL_IMAGE:-…}` override. */
const IMAGE_LINE =
  /^ {4}image:\s+\$\{BLUEPENCIL_IMAGE:-ghcr\.io\/popoboxxo\/bluepencil:([^}]+)\}$/m;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Split the `services:` top-level block into per-service bodies.
 *
 * A YAML parser would be a runtime dependency, and the two files are small and hand-written; a
 * line-based split keeps the assertions readable and fails loudly (an empty map) if the shape
 * changes.
 */
function services(source: string): Map<string, string> {
  const out = new Map<string, string>();
  let inServices = false;
  let current: string | undefined;
  let body: string[] = [];
  const flush = () => {
    if (current !== undefined) out.set(current, body.join("\n"));
    current = undefined;
    body = [];
  };
  for (const line of source.split(/\r?\n/)) {
    if (!inServices) {
      if (/^services:\s*$/.test(line)) inServices = true;
      continue;
    }
    if (/^\S/.test(line)) {
      flush();
      inServices = false;
      continue;
    }
    const heading = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (heading) {
      flush();
      current = heading[1];
      continue;
    }
    if (current !== undefined) body.push(line);
  }
  flush();
  return out;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Entries of a list-valued key, inline (`key: ["value"]`) or block style. */
function listItems(block: string, key: string): string[] {
  const keyPattern = new RegExp(`^ {4}${escape(key)}:\\s*(.*)$`);
  const lines = block.split("\n");
  const start = lines.findIndex((line) => keyPattern.test(line));
  if (start === -1) return [];
  const keyLine = lines[start];
  if (keyLine === undefined) return [];
  const inline = keyPattern.exec(keyLine)?.[1] ?? "";
  if (inline.startsWith("[")) {
    return inline
      .slice(1, -1)
      .split(",")
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
      .filter((entry) => entry !== "");
  }
  if (inline !== "") return [];
  // Block list: items sit at six spaces; a comment or a blank line in between is fine. The first
  // line that is not indented that far is the next key, so the list has ended.
  const items: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || !line.startsWith("      ")) break;
    const item = /^ {6}-\s*(.+?)\s*$/.exec(line);
    const value = item?.[1];
    if (value !== undefined) items.push(value.replace(/^["']|["']$/g, ""));
  }
  return items;
}

/** True when `key` declares `value`. */
function declares(block: string, key: string, value: string): boolean {
  return listItems(block, key).includes(value);
}

describe("AC-J01 — the compose default publishes on host loopback", () => {
  const root = read(ROOT_COMPOSE);
  const hub = services(root).get("hub");

  it("renders the loopback host address on the documented port variable", () => {
    expect(hub).toBeDefined();
    expect(declares(hub ?? "", "ports", "127.0.0.1:${BLUEPENCIL_PORT:-8787}:8787")).toBe(true);
    // A bare port (`8787:8787`) would bind every interface — that is the bug, not a style choice.
    expect(hub ?? "").not.toMatch(/^\s+-\s*"\$\{BLUEPENCIL_PORT:-8787\}:8787"\s*$/m);
  });

  it("documents that widening the address is an explicit edit", () => {
    const doc = read(DOCKER_DOC);
    expect(doc).toMatch(/Widening is an explicit edit/);
    expect(doc).toMatch(/0\.0\.0\.0:\$\{BLUEPENCIL_PORT:-8787\}:8787/);
  });
});

describe("AC-J02 — both compose files pin an exact image version", () => {
  for (const [label, path] of [
    ["docker-compose.yml", ROOT_COMPOSE],
    ["examples/federation/docker-compose.yml", FEDERATION_COMPOSE],
  ] as const) {
    it(`${label} never uses a moving tag`, () => {
      const source = read(path);
      const blocks = services(source);
      expect(blocks.size).toBeGreaterThan(0);
      for (const [name, block] of blocks) {
        const match = IMAGE_LINE.exec(block);
        expect(match, `${label}:${name} carries the documented image override`).not.toBeNull();
        const tag = match?.[1] ?? "";
        expect(EXACT_VERSION.test(tag), `${label}:${name} tag "${tag}" is an exact version`).toBe(true);
        expect(tag).not.toBe("latest");
        expect(source).not.toMatch(/bluepencil:latest/);
      }
    });
  }

  it("publishes no port on every host interface", () => {
    for (const path of [ROOT_COMPOSE, FEDERATION_COMPOSE]) {
      for (const [name, block] of services(read(path))) {
        for (const port of listItems(block, "ports")) {
          expect(port, `${name} publishes ${port} on an explicit host address`).toMatch(
            /^127\.0\.0\.1:/,
          );
        }
      }
    }
  });

  it("keeps the federation aggregator on loopback", () => {
    const aggregator = services(read(FEDERATION_COMPOSE)).get("hub-aggregator");
    expect(aggregator).toBeDefined();
    expect(
      declares(aggregator ?? "", "ports", "127.0.0.1:${BLUEPENCIL_AGGREGATOR_PORT:-8790}:8787"),
    ).toBe(true);
  });
});

describe("AC-J03 — every compose service is hardened", () => {
  for (const [label, path] of [
    ["docker-compose.yml", ROOT_COMPOSE],
    ["examples/federation/docker-compose.yml", FEDERATION_COMPOSE],
  ] as const) {
    it(`${label} runs read-only, without capabilities and without privilege escalation`, () => {
      const blocks = services(read(path));
      expect(blocks.size).toBeGreaterThan(0);
      for (const [name, block] of blocks) {
        expect(block, `${label}:${name} read_only`).toMatch(/^ {4}read_only:\s*true\s*$/m);
        expect(declares(block, "tmpfs", "/tmp"), `${label}:${name} tmpfs /tmp`).toBe(true);
        expect(declares(block, "cap_drop", "ALL"), `${label}:${name} cap_drop ALL`).toBe(true);
        expect(
          declares(block, "security_opt", "no-new-privileges:true"),
          `${label}:${name} no-new-privileges`,
        ).toBe(true);
      }
    });
  }

  it("keeps the writable paths writable (named volume /data, tmpfs /tmp)", () => {
    const root = read(ROOT_COMPOSE);
    expect(root).toMatch(/^ {6}- bluepencil-notes:\/data$/m);
    const federation = read(FEDERATION_COMPOSE);
    expect(federation).toMatch(/^ {6}- dev-data:\/data$/m);
    expect(federation).toMatch(/^ {6}- staging-data:\/data$/m);
  });
});

/**
 * Ignore-file semantics for the checks below.
 *
 * Both ignore formats share an ordered, last-match-wins model, so one small evaluator covers them.
 * It is deliberately *not* a general implementation: it understands the rule shapes these two files
 * actually use — literal names, `*`, `?`, a trailing `**` segment and `!` negations — and it is
 * pinned by negative controls. Anything fancier in the files would make these assertions fail loudly
 * (nothing matches) rather than pass silently.
 *
 * The two formats differ in one place that matters here: a pattern *without a slash*. Git matches
 * such a pattern at any depth; Docker matches it against the whole relative path, i.e. the context
 * root only (verified against a real daemon: `.env` in `.dockerignore` leaves `sub/.env` alone).
 * That is why `.dockerignore` spells out a globstar-prefixed `.env` rule instead of relying on the
 * bare name.
 */
interface IgnoreRule {
  negated: boolean;
  regex: RegExp;
}

function escapeChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function compileRule(line: string, semantics: "git" | "docker"): IgnoreRule | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return undefined;
  const negated = trimmed.startsWith("!");
  const body = (negated ? trimmed.slice(1) : trimmed).replace(/\/+$/, "");
  if (body === "") return undefined;
  const anchored = body.includes("/");
  let source = "";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] ?? "";
    if (char === "*" && body[i + 1] === "*") {
      // `**/` spans zero or more directories; a bare `**` spans anything.
      if (body[i + 2] === "/") {
        source += "(?:[^/]+/)*";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeChar(char);
    }
  }
  const prefix = anchored || semantics === "docker" ? "^" : "(?:^|.*/)";
  // A rule naming a directory also covers its contents.
  return { negated, regex: new RegExp(`${prefix}${source}(?:/.*)?$`) };
}

function readRules(path: string, semantics: "git" | "docker"): IgnoreRule[] {
  return read(path)
    .split(/\r?\n/)
    .map((line) => compileRule(line, semantics))
    .filter((rule): rule is IgnoreRule => rule !== undefined);
}

function isIgnored(rules: IgnoreRule[], candidate: string): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(candidate)) ignored = !rule.negated;
  }
  return ignored;
}

const DOCKERFILE = fileURLToPath(new URL("../../Dockerfile", import.meta.url));
const GITIGNORE = fileURLToPath(new URL("../../.gitignore", import.meta.url));
const DOCKERIGNORE = fileURLToPath(new URL("../../.dockerignore", import.meta.url));
const DEPENDABOT = fileURLToPath(new URL("../../.github/dependabot.yml", import.meta.url));

/** `node:22-alpine@sha256:<64 lowercase hex>` — the tag stays for humans, the digest pins the bits. */
const PINNED_BASE = /^node:22-alpine@sha256:[0-9a-f]{64}$/;

/** The image reference of every `FROM`, without the optional stage name. */
function fromImages(source: string): string[] {
  return source
    .split(/\r?\n/)
    .filter((line) => /^FROM\s/.test(line))
    .map((line) => (line.replace(/^FROM\s+/, "").split(/\s+AS\s+/i)[0] ?? "").trim());
}

describe("AC-J04 — both Dockerfile stages pin the base image by digest", () => {
  const source = read(DOCKERFILE);
  const images = fromImages(source);

  it("has exactly the two stages, both digest-pinned", () => {
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image, `FROM ${image} carries a sha256 digest`).toMatch(PINNED_BASE);
    }
  });

  it("does not depend on a moving tag", () => {
    // A bare `node:22-alpine` re-resolves on every build; the digest is what makes it reproducible.
    expect(source).not.toMatch(/^FROM\s+node:22-alpine(\s|$)/m);
    expect(images.some((image) => image.includes(":latest"))).toBe(false);
  });

  it("pins both stages to the same digest so build and runtime cannot drift apart", () => {
    expect(new Set(images).size).toBe(1);
  });

  it("is not a placeholder digest", () => {
    for (const image of images) {
      const digest = image.split("@")[1] ?? "";
      expect(digest).not.toBe("sha256:" + "0".repeat(64));
    }
  });

  it("lets Dependabot maintain the pin", () => {
    // Without a docker watcher the digest silently ages instead of arriving as a reviewable PR.
    expect(read(DEPENDABOT)).toMatch(/^\s+-\s+package-ecosystem:\s+docker\s*$/m);
  });
});

describe("AC-J05 — ignore files keep secrets out of git and out of the image", () => {
  it("makes a root .env and its variants untrackable, but keeps the template", () => {
    const rules = readRules(GITIGNORE, "git");
    // Controls: the evaluator must discriminate, not just say "ignored" or "not ignored".
    expect(isIgnored(rules, "node_modules/vitest/package.json")).toBe(true);
    expect(isIgnored(rules, "src/index.ts")).toBe(false);
    expect(isIgnored(rules, "package.json")).toBe(false);
    // …the actual contract (SEC-26).
    expect(isIgnored(rules, ".env")).toBe(true);
    expect(isIgnored(rules, ".env.local")).toBe(true);
    expect(isIgnored(rules, ".env.production.local")).toBe(true);
    // `!.env.example` must win as the later rule, here and in the nested example.
    expect(isIgnored(rules, ".env.example")).toBe(false);
    expect(isIgnored(rules, "examples/federation/.env.example")).toBe(false);
  });

  it("declares the negation after the pattern it excepts", () => {
    const lines = read(GITIGNORE).split(/\r?\n/).map((line) => line.trim());
    const dotEnvStar = lines.indexOf(".env.*");
    const exception = lines.indexOf("!.env.example");
    expect(dotEnvStar, ".env.* is listed").toBeGreaterThanOrEqual(0);
    expect(exception, "!.env.example is listed").toBeGreaterThanOrEqual(0);
    expect(exception).toBeGreaterThan(dotEnvStar);
  });

  it("keeps secrets and agent state out of the image context", () => {
    const rules = readRules(DOCKERIGNORE, "docker");
    // Controls: what the build genuinely needs must still travel.
    expect(isIgnored(rules, "package.json")).toBe(false);
    expect(isIgnored(rules, "src/index.ts")).toBe(false);
    expect(isIgnored(rules, "extension/manifest.json")).toBe(false);
    expect(isIgnored(rules, "node_modules/vitest/package.json")).toBe(true);

    for (const excluded of [
      ".env",
      ".env.local",
      "examples/federation/.env",
      ".meta-config/secrets.local.yaml",
      ".meta-config/env.sh",
      ".mcp.json",
      "notes.bluepencil.json",
      ".claude/settings.local.json",
      ".opencode/settings.local.json",
      "AGENTS.personal.md",
      "CLAUDE.local.md",
      "extension/dist-test/manifest.json",
    ]) {
      expect(isIgnored(rules, excluded), `${excluded} stays out of the image`).toBe(true);
    }
  });

  it("still ships the public example template", () => {
    // `**/.env.example` is spelled out because a dockerignore pattern without a slash only reaches
    // the context root; dropping the negation would have excluded the documented template too.
    expect(isIgnored(readRules(DOCKERIGNORE, "docker"), "examples/federation/.env.example")).toBe(
      false,
    );
  });
});
