/**
 * Store journal (FR-18) — the sidecar's answer to "who changed which note, when, and can I undo it".
 *
 * The sidecar is the only place that can write files, so the history lives here and not in the
 * browser library. Three backends, chosen by the *infrastructure* the deployment happens to have:
 *
 *  - `git`   the store lives in a work tree: every coalesced batch of mutations becomes one commit,
 *            the same pattern the project's own presentation page used (add → empty-diff check →
 *            commit). Coalescing matters: one commit per click is noise.
 *  - `file`  no git around: an append-only JSON file with a SHA-256 hash chain. Tamper-evident,
 *            replayable, no external tool, works on any server. This is the default.
 *  - `none`  history switched off on purpose (`--journal none`).
 *
 * `auto` picks `git` when the store directory is inside a work tree and `file` otherwise; if the
 * file journal cannot be created, `auto` falls back to `none` instead of refusing to start — a
 * history is a convenience, not a precondition for serving notes.
 *
 * Nothing here ever throws into the request path: the note was already persisted atomically when the
 * journal is written, so a journal failure must not roll a note back. Failures are reported once on
 * stderr and stay visible through `status()` / `GET {base}/journal`.
 */
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What happened to a note. Kept small on purpose — the note itself is the record. */
export type JournalOp = "create" | "update" | "message" | "bulk-delete" | "import";

/** One recorded mutation. `hash`/`prevHash` turn the file journal into a chain. */
export interface JournalEntry {
  seq: number;
  ts: string;
  op: JournalOp;
  noteId?: string;
  actor?: string;
  summary: string;
  hash: string;
  prevHash: string;
}

/** What a mutation reports about itself — the journal adds sequence, time and hashes. */
export interface JournalRecord {
  op: JournalOp;
  noteId?: string;
  actor?: string;
  summary: string;
}

export interface JournalStatus {
  backend: "git" | "file" | "none";
  /** Where the history lives (journal file or repository). */
  location?: string;
  /** Entries this process recorded; for `git` these are the commits it made. */
  entries: number;
  /** Highest sequence number in the medium. */
  lastSeq: number;
  /** Set when a write failed — the journal keeps serving, but an operator must see this. */
  issue?: string;
}

export interface Journal {
  readonly backend: JournalStatus["backend"];
  /** Records a mutation. Best-effort: never throws into the request path. */
  record(record: JournalRecord): void;
  /** Writes out anything a coalescing backend is holding back (idempotent). */
  flush(): void;
  /** The recorded entries with `seq > since`, oldest first. */
  read(since?: number): { entries: JournalEntry[]; issue?: string };
  /** Verifies the medium: chain intact (file) / history readable (git). */
  verify(): { ok: boolean; entries: number; issue?: string };
  status(): JournalStatus;
}

export interface JournalOptions {
  /** `auto` (default) decides from the infrastructure; the others are explicit. */
  backend?: "auto" | "git" | "file" | "none";
  /** Where the journal file lives (`file`); defaults to the store's directory. */
  dir?: string;
  /** Repository root for the `git` backend; defaults to the store's directory. */
  repo?: string;
  /** Files the `git` backend stages. */
  paths?: string[];
  /** Milliseconds a `git` commit waits for more mutations (default 2000, `0` = commit at once). */
  coalesceMs?: number;
  /** `Name <mail>`; defaults to the repository's own configuration. */
  author?: string;
  /** Commit subject template: `{count}`, `{op}`, `{app}` are substituted. */
  subjectTemplate?: string;
  /** App name for the subject template. */
  appName?: string;
  /** Injectable for tests. */
  run?: CommandRunner;
  now?: () => string;
  setTimeoutImpl?: (fn: () => void, ms: number) => number;
  clearTimeoutImpl?: (handle: number) => void;
  /** Reported once per failure, never per request. */
  onError?: (message: string) => void;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: SpawnSyncOptions,
) => { status: number | null; stdout: string; stderr: string };

const FILE_NAME = "journal.jsonl";
const DEFAULT_SUBJECT = "chore(notes): {count} change(s) in {app}";
const DEFAULT_COALESCE_MS = 2000;

const defaultRun: CommandRunner = (command, args, options) => {
  // The output is always piped: callers pass flags, not the stdio policy — a forced `ignore` would
  // silently turn every answer into "" (and `isInsideWorkTree` into a false negative).
  const result = spawnSync(command, args, { encoding: "utf8", ...options, stdio: ["ignore", "pipe", "pipe"] });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
};

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Canonical form the hash is computed over: fixed key order, no `hash` field. */
function hashOf(entry: Omit<JournalEntry, "hash">): string {
  const canonical = JSON.stringify([
    entry.seq,
    entry.ts,
    entry.op,
    entry.noteId ?? "",
    entry.actor ?? "",
    entry.summary,
    entry.prevHash,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** `git -C <dir> rev-parse --is-inside-work-tree` — the only reliable work-tree test. */
export function isInsideWorkTree(dir: string, run: CommandRunner = defaultRun): boolean {
  const result = run("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  return result.status === 0 && result.stdout.trim() === "true";
}

/* ------------------------------------------------------------------------------------------------ */
/* file                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Append-only JSON lines with a hash chain. Each line commits to the previous one, so a rewritten or
 * removed line is detectable — the audit trail git would have given, without git.
 */
class FileJournal implements Journal {
  readonly backend = "file" as const;
  readonly #path: string;
  readonly #now: () => string;
  readonly #onError: (message: string) => void;
  #entries = 0;
  #lastSeq = 0;
  #prevHash = "";
  #issue: string | undefined;

  constructor(options: JournalOptions, path: string) {
    this.#path = path;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#onError = options.onError ?? (() => undefined);
    mkdirSync(dirname(this.#path), { recursive: true });
    const existing = this.read();
    const last = existing.entries[existing.entries.length - 1];
    if (last !== undefined) {
      this.#lastSeq = last.seq;
      this.#prevHash = last.hash;
    }
    if (existing.issue !== undefined) {
      this.#issue = existing.issue;
    }
  }

  get path(): string {
    return this.#path;
  }

  /** A fresh journal at `dir`, or `undefined` when the directory cannot be written. */
  static open(options: JournalOptions, dir: string): FileJournal | undefined {
    const path = join(dir, FILE_NAME);
    try {
      mkdirSync(dir, { recursive: true });
      return new FileJournal(options, path);
    } catch (error) {
      (options.onError ?? (() => undefined))(
        `journal: cannot use ${path} — ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  record(record: JournalRecord): void {
    const base = {
      seq: this.#lastSeq + 1,
      ts: this.#now(),
      op: record.op,
      ...(record.noteId === undefined ? {} : { noteId: record.noteId }),
      ...(record.actor === undefined ? {} : { actor: record.actor }),
      summary: oneLine(record.summary),
      prevHash: this.#prevHash,
    };
    const entry: JournalEntry = { ...base, hash: hashOf(base) };
    try {
      appendFileSync(this.#path, `${JSON.stringify(entry)}\n`, "utf8");
      this.#lastSeq = entry.seq;
      this.#prevHash = entry.hash;
      this.#entries += 1;
    } catch (error) {
      this.#fail(`cannot append ${this.#path} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  flush(): void {
    /* the file backend writes on every record — nothing is held back */
  }

  read(since = 0): { entries: JournalEntry[]; issue?: string } {
    if (!existsSync(this.#path)) {
      return { entries: [] };
    }
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch (error) {
      return { entries: [], issue: `cannot read ${this.#path} — ${error instanceof Error ? error.message : String(error)}` };
    }
    const entries: JournalEntry[] = [];
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as JournalEntry;
        if (typeof parsed.seq === "number" && parsed.seq > since) entries.push(parsed);
      } catch {
        return { entries, issue: `line ${index + 1} of ${this.#path} is not valid JSON` };
      }
    }
    return { entries };
  }

  verify(): { ok: boolean; entries: number; issue?: string } {
    const read = this.read();
    if (read.issue !== undefined) {
      return { ok: false, entries: read.entries.length, issue: read.issue };
    }
    let prevHash = "";
    let expectedSeq = 1;
    for (const entry of read.entries) {
      if (entry.seq !== expectedSeq) {
        return { ok: false, entries: read.entries.length, issue: `sequence gap at ${entry.seq} (expected ${expectedSeq})` };
      }
      if (entry.prevHash !== prevHash) {
        return { ok: false, entries: read.entries.length, issue: `broken chain at ${entry.seq}` };
      }
      const { hash, ...rest } = entry;
      if (hashOf(rest) !== hash) {
        return { ok: false, entries: read.entries.length, issue: `entry ${entry.seq} was modified` };
      }
      prevHash = hash;
      expectedSeq += 1;
    }
    return { ok: true, entries: read.entries.length };
  }

  status(): JournalStatus {
    return {
      backend: "file",
      location: this.#path,
      entries: this.#entries,
      lastSeq: this.#lastSeq,
      ...(this.#issue === undefined ? {} : { issue: this.#issue }),
    };
  }

  /** Config problems are reported once — an operator has to see them, a request must not fail. */
  #fail(message: string): void {
    if (this.#issue !== message) {
      this.#issue = message;
      this.#onError(`journal: ${message}`);
    }
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* git                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Commits the store like the presentation page's own server did: stage the configured paths, skip an
 * empty diff, commit. The coalescing window keeps a review round from producing one commit per click.
 */
class GitJournal implements Journal {
  readonly backend = "git" as const;
  readonly #repo: string;
  readonly #paths: string[];
  readonly #run: CommandRunner;
  readonly #coalesceMs: number;
  readonly #author: { name: string; email: string } | undefined;
  readonly #subject: string;
  readonly #appName: string;
  readonly #setTimeout: (fn: () => void, ms: number) => number;
  readonly #clearTimeout: (handle: number) => void;
  readonly #onError: (message: string) => void;
  #pending: JournalRecord[] = [];
  #timer: number | null = null;
  #entries = 0;
  #lastSeq = 0;
  #issue: string | undefined;

  constructor(options: JournalOptions, repo: string, paths: string[]) {
    this.#repo = repo;
    this.#paths = paths;
    this.#run = options.run ?? defaultRun;
    this.#coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.#subject = options.subjectTemplate ?? DEFAULT_SUBJECT;
    this.#appName = options.appName ?? "bluepencil";
    this.#setTimeout = options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
    this.#clearTimeout = options.clearTimeoutImpl ?? ((handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));
    this.#onError = options.onError ?? (() => undefined);
    this.#author = parseAuthor(options.author);
  }

  record(record: JournalRecord): void {
    this.#pending.push(record);
    if (this.#coalesceMs <= 0) {
      this.flush();
      return;
    }
    if (this.#timer !== null) return;
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, this.#coalesceMs);
  }

  /** Stages and commits the pending batch. Safe to call at any time, including with an empty batch. */
  flush(): void {
    if (this.#timer !== null) {
      this.#clearTimeout(this.#timer);
      this.#timer = null;
    }
    const batch = this.#pending;
    this.#pending = [];
    if (batch.length === 0) return;

    const add = this.#run("git", ["-C", this.#repo, "add", ...this.#paths], { stdio: "ignore" });
    if (add.status !== 0) {
      this.#fail(`git add failed — ${oneLine(add.stderr) || `exit ${add.status}`}`);
      return;
    }
    // A batch commits the configured paths and nothing else: whatever else is staged in the work tree
    // belongs to someone else, and `git commit` without paths would sweep it in.
    const diff = this.#run("git", ["-C", this.#repo, "diff", "--cached", "--quiet", "--", ...this.#paths], { stdio: "ignore" });
    if (diff.status === 0) return; // nothing changed on disk — no empty commit

    const subject = this.#subject
      .replace(/\{count\}/g, String(batch.length))
      .replace(/\{op\}/g, batch[batch.length - 1]?.op ?? "update")
      .replace(/\{app\}/g, this.#appNameText());
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.#author !== undefined) {
      env.GIT_AUTHOR_NAME = this.#author.name;
      env.GIT_AUTHOR_EMAIL = this.#author.email;
      env.GIT_COMMITTER_NAME = this.#author.name;
      env.GIT_COMMITTER_EMAIL = this.#author.email;
    }
    const commit = this.#run("git", ["-C", this.#repo, "commit", "-q", "--only", "-m", oneLine(subject), "--", ...this.#paths], {
      stdio: "ignore",
      env,
    });
    if (commit.status !== 0) {
      this.#fail(`git commit failed — ${oneLine(commit.stderr) || `exit ${commit.status}`}`);
      return;
    }
    this.#entries += 1;
    this.#lastSeq += 1;
  }

  /** The commit subjects this server wrote, newest last — the git equivalent of the entry list. */
  read(since = 0): { entries: JournalEntry[]; issue?: string } {
    const limit = Math.max(0, this.#entries - since);
    if (limit === 0) return { entries: [] };
    const log = this.#run(
      "git",
      ["-C", this.#repo, "log", "-n", String(limit), "--format=%H%x09%cI%x09%s", "--", ...this.#paths],
      { stdio: "ignore" },
    );
    if (log.status !== 0) {
      return { entries: [], issue: `git log failed — ${oneLine(log.stderr) || `exit ${log.status}`}` };
    }
    const entries: JournalEntry[] = [];
    const lines = log.stdout.trim().split("\n").filter((line) => line.trim() !== "");
    lines.reverse().forEach((line, index) => {
      const [hash = "", ts = "", ...rest] = line.split("\t");
      entries.push({
        seq: since + index + 1,
        ts,
        op: "update",
        summary: rest.join("\t"),
        hash,
        prevHash: "",
      });
    });
    return { entries };
  }

  verify(): { ok: boolean; entries: number; issue?: string } {
    const rev = this.#run("git", ["-C", this.#repo, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    if (rev.status !== 0 || rev.stdout.trim() !== "true") {
      return { ok: false, entries: this.#entries, issue: `${this.#repo} is not a git work tree` };
    }
    const fsck = this.#run("git", ["-C", this.#repo, "rev-parse", "--verify", "HEAD"], { stdio: "ignore" });
    return { ok: true, entries: this.#entries, ...(fsck.status === 0 ? {} : { issue: "the repository has no commit yet" }) };
  }

  status(): JournalStatus {
    return {
      backend: "git",
      location: this.#repo,
      entries: this.#entries,
      lastSeq: this.#lastSeq,
      ...(this.#issue === undefined ? {} : { issue: this.#issue }),
    };
  }

  #appNameText(): string {
    return this.#appName;
  }

  #fail(message: string): void {
    this.#issue = message;
    this.#onError(`journal: ${message}`);
  }
}

function parseAuthor(value: string | undefined): { name: string; email: string } | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const match = /^(.*?)\s*<([^>]+)>\s*$/.exec(value);
  if (match === null) return { name: value.trim(), email: value.trim() };
  return { name: (match[1] ?? "").trim(), email: (match[2] ?? "").trim() };
}

/* ------------------------------------------------------------------------------------------------ */
/* none + selection                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

class NoJournal implements Journal {
  readonly backend = "none" as const;
  #reason: string | undefined;
  constructor(reason?: string) {
    this.#reason = reason;
  }
  record(): void {}
  flush(): void {}
  read(): { entries: JournalEntry[] } {
    return { entries: [] };
  }
  verify(): { ok: boolean; entries: number; issue?: string } {
    return { ok: true, entries: 0, ...(this.#reason === undefined ? {} : { issue: this.#reason }) };
  }
  status(): JournalStatus {
    return { backend: "none", entries: 0, lastSeq: 0, ...(this.#reason === undefined ? {} : { issue: this.#reason }) };
  }
}

/**
 * Picks the backend from the deployment: an explicit flag wins, otherwise `git` when the store lives
 * in a work tree, otherwise `file`, and `none` when even that cannot be created.
 */
export function selectJournal(options: JournalOptions & { storePath: string }): Journal {
  const requested = options.backend ?? "auto";
  if (requested === "none") return new NoJournal();
  const dir = options.dir ?? dirname(options.storePath);
  if (requested === "file") return FileJournal.open(options, dir) ?? new NoJournal("the journal file could not be created");
  const repo = options.repo ?? dir;
  const insideWorkTree = isInsideWorkTree(repo, options.run ?? defaultRun);
  if (requested === "git") {
    return insideWorkTree ? new GitJournal(options, repo, options.paths ?? [options.storePath]) : new NoJournal(`${repo} is not a git work tree`);
  }
  if (insideWorkTree) return new GitJournal(options, repo, options.paths ?? [options.storePath]);
  return FileJournal.open(options, dir) ?? new NoJournal("the journal file could not be created");
}
