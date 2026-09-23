/**
 * Unit tests of the store journal (FR-18).
 *
 * The file backend is tested against a real file (chain, tamper detection, `since`), the git backend
 * against a real throwaway repository — the whole point of it is that it drives git correctly — plus
 * an injected failing runner for the failure path, and `selectJournal` for the infrastructure
 * decision (`auto` inside a work tree must not silently pick the wrong backend).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isInsideWorkTree,
  selectJournal,
  type CommandRunner,
  type JournalOptions,
} from "../../server/journal";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bp-journal-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repository with an identity and one committed file. */
function initRepo(path: string): void {
  const git = (args: string[]): void => {
    const result = spawnSync("git", args, { cwd: path, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} → ${result.stderr}`);
  };
  git(["init", "-q"]);
  git(["config", "user.name", "Test Runner"]);
  git(["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(path, "store.json"), "{\"notes\":[]}\n", "utf8");
  git(["add", "store.json"]);
  git(["commit", "-q", "-m", "init"]);
}

function gitLog(path: string): string[] {
  const result = spawnSync("git", ["-C", path, "log", "--format=%s|%an|%ae"], { encoding: "utf8" });
  return result.stdout.trim().split("\n").filter((line) => line !== "");
}

function options(overrides: Partial<JournalOptions> = {}): JournalOptions {
  return { now: () => "2026-09-16T12:00:00.000Z", ...overrides };
}

describe("journal — file backend", () => {
  it("chains the entries, counts them and reports them since a sequence number", () => {
    const journal = selectJournal({ ...options(), backend: "file", storePath: join(dir, "store.json") });
    expect(journal.status().backend).toBe("file");

    journal.record({ op: "create", noteId: "n-1", summary: "create n-1" });
    journal.record({ op: "message", noteId: "n-1", summary: "message n-1" });
    journal.record({ op: "bulk-delete", summary: "bulk-delete 1 note(s) — 2 note(s) in the set" });

    const status = journal.status();
    expect(status.entries).toBe(3);
    expect(status.lastSeq).toBe(3);
    expect(status.issue).toBeUndefined();

    const all = journal.read();
    expect(all.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(all.entries[0]?.prevHash).toBe("");
    expect(all.entries[1]?.prevHash).toBe(all.entries[0]?.hash);
    expect(all.entries[2]?.hash).not.toBe(all.entries[1]?.hash);

    const since = journal.read(2);
    expect(since.entries.map((entry) => entry.seq)).toEqual([3]);
    expect(journal.verify()).toEqual({ ok: true, entries: 3 });
  });

  it("survives a restart and continues the chain", () => {
    const storePath = join(dir, "store.json");
    const first = selectJournal({ ...options(), backend: "file", storePath });
    first.record({ op: "create", noteId: "n-1", summary: "create n-1" });
    const firstHash = first.read().entries[0]?.hash;

    const second = selectJournal({ ...options(), backend: "file", storePath });
    second.record({ op: "update", noteId: "n-2", summary: "update n-2" });

    const entries = second.read().entries;
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(entries[1]?.prevHash).toBe(firstHash);
    expect(second.verify().ok).toBe(true);
    expect(second.status().entries).toBe(1); // only what this process wrote
  });

  it("detects a modified entry and a removed one", () => {
    const storePath = join(dir, "store.json");
    const journal = selectJournal({ ...options(), backend: "file", storePath });
    journal.record({ op: "create", noteId: "n-1", summary: "create n-1" });
    journal.record({ op: "update", noteId: "n-1", summary: "update n-1" });

    const path = join(dir, "journal.jsonl");
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    writeFileSync(path, lines.join("\n").replace("update n-1", "update n-1!") + "\n", "utf8");
    expect(journal.verify().ok).toBe(false);
    expect(journal.verify().issue).toMatch(/modified|chain/);

    // A removed line is a sequence gap, not a silently shorter history.
    const journal2 = selectJournal({ ...options(), backend: "file", storePath: join(dir, "other.json") });
    journal2.record({ op: "create", noteId: "a", summary: "a" });
    journal2.record({ op: "create", noteId: "b", summary: "b" });
    const path2 = join(dir, "journal.jsonl");
    const kept = readFileSync(path2, "utf8").trimEnd().split("\n").filter((line) => !line.includes("\"b\""));
    writeFileSync(path2, `${kept.join("\n")}\n`, "utf8");
    const verify2 = journal2.verify();
    expect(verify2.ok).toBe(false);
    expect(verify2.issue).toMatch(/sequence gap|modified/);
  });

  it("reports a line that is not JSON instead of skipping it", () => {
    const storePath = join(dir, "store.json");
    const journal = selectJournal({ ...options(), backend: "file", storePath });
    journal.record({ op: "create", noteId: "n-1", summary: "create n-1" });
    writeFileSync(join(dir, "journal.jsonl"), `${readFileSync(join(dir, "journal.jsonl"), "utf8")}not json\n`, "utf8");

    const read = journal.read();
    expect(read.entries).toHaveLength(1);
    expect(read.issue).toMatch(/not valid JSON/);
    expect(journal.verify().ok).toBe(false);
  });
});

describe("journal — git backend", () => {
  it("commits a coalesced batch and skips an empty diff", () => {
    initRepo(dir);
    const storePath = join(dir, "store.json");
    const journal = selectJournal({
      ...options(),
      backend: "git",
      storePath,
      coalesceMs: 0,
      author: "Daniel Duchrow <Popoboxxo@users.noreply.github.com>",
      subjectTemplate: "chore(notes): {count} change(s) in {app}",
      appName: "AI-Extremismus",
    });
    expect(journal.status().backend).toBe("git");

    // No change on disk: nothing to commit, and no empty commit either.
    journal.record({ op: "update", noteId: "n-1", summary: "update n-1" });
    journal.flush();
    expect(gitLog(dir)).toHaveLength(1);
    expect(journal.status().entries).toBe(0);

    writeFileSync(storePath, "{\"notes\":[{\"id\":\"n-1\"}]}\n", "utf8");
    journal.record({ op: "create", noteId: "n-1", summary: "create n-1" });
    journal.flush();

    const log = gitLog(dir);
    expect(log).toHaveLength(2);
    expect(log[0]).toBe("chore(notes): 1 change(s) in AI-Extremismus|Daniel Duchrow|Popoboxxo@users.noreply.github.com");
    expect(journal.status().entries).toBe(1);
    expect(journal.verify().ok).toBe(true);

    // The commit is about the store: the file content is what git sees.
    const show = spawnSync("git", ["-C", dir, "show", "--stat", "--format=", "HEAD"], { encoding: "utf8" });
    expect(show.stdout).toContain("store.json");
  });

  it("takes the commit identity from the environment when no option is given", () => {
    initRepo(dir);
    const storePath = join(dir, "store.json");
    const saved = process.env.BLUEPENCIL_JOURNAL_AUTHOR;
    process.env.BLUEPENCIL_JOURNAL_AUTHOR = "hermes <hermes@duchrow.local>";
    try {
      const journal = selectJournal({ ...options(), backend: "git", storePath, coalesceMs: 0 });
      // Which identity is in use is visible in the status, not only in the log.
      expect(journal.status().author).toBe("hermes <hermes@duchrow.local>");

      writeFileSync(storePath, "{\"notes\":[{\"id\":\"n-1\"}]}\n", "utf8");
      journal.record({ op: "create", noteId: "n-1", summary: "create n-1" });
      journal.flush();
      // Identity from the environment, subject from the default template — both land in the commit.
      expect(gitLog(dir)[0]).toBe("chore(notes): 1 change(s) in bluepencil|hermes|hermes@duchrow.local");
    } finally {
      if (saved === undefined) delete process.env.BLUEPENCIL_JOURNAL_AUTHOR;
      else process.env.BLUEPENCIL_JOURNAL_AUTHOR = saved;
    }
  });

  it("lets the flag win over the environment and names the inherited identity", () => {
    initRepo(dir);
    const storePath = join(dir, "store.json");
    const saved = process.env.BLUEPENCIL_JOURNAL_AUTHOR;
    process.env.BLUEPENCIL_JOURNAL_AUTHOR = "hermes <hermes@duchrow.local>";
    try {
      const flagged = selectJournal({
        ...options(),
        backend: "git",
        storePath,
        coalesceMs: 0,
        author: "Flag Wins <flag@example.invalid>",
      });
      expect(flagged.status().author).toBe("Flag Wins <flag@example.invalid>");
    } finally {
      if (saved === undefined) delete process.env.BLUEPENCIL_JOURNAL_AUTHOR;
      else process.env.BLUEPENCIL_JOURNAL_AUTHOR = saved;
    }

    // Neither flag nor env: the repository decides, and the status says exactly that instead of guessing.
    const inherited = selectJournal({ ...options(), backend: "git", storePath, coalesceMs: 0 });
    expect(inherited.status().author).toBe("(the repository's configured identity)");
  });

  it("waits for the coalescing window before it commits", () => {
    initRepo(dir);
    const storePath = join(dir, "store.json");
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const journal = selectJournal({
      ...options(),
      backend: "git",
      storePath,
      coalesceMs: 2000,
      setTimeoutImpl: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimeoutImpl: () => undefined,
    });

    writeFileSync(storePath, "{\"notes\":[1]}\n", "utf8");
    journal.record({ op: "create", noteId: "n-1", summary: "one" });
    writeFileSync(storePath, "{\"notes\":[1,2]}\n", "utf8");
    journal.record({ op: "create", noteId: "n-2", summary: "two" });

    expect(gitLog(dir)).toHaveLength(1); // nothing committed yet
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(2000);

    timers[0]?.fn();
    const log = gitLog(dir);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/2 change\(s\)/);
  });

  it("reports a git failure once and never throws", () => {
    initRepo(dir);
    const errors: string[] = [];
    const failing: CommandRunner = (_command, args) => {
      if (args.includes("commit")) return { status: 1, stdout: "", stderr: "no identity configured" };
      if (args.includes("rev-parse")) return { status: 0, stdout: "true\n", stderr: "" };
      if (args.includes("diff")) return { status: 1, stdout: "", stderr: "" }; // there IS a change
      return { status: 0, stdout: "", stderr: "" };
    };
    const journal = selectJournal({
      ...options(),
      backend: "git",
      storePath: join(dir, "store.json"),
      coalesceMs: 0,
      run: failing,
      onError: (message) => errors.push(message),
    });
    writeFileSync(join(dir, "store.json"), "{\"notes\":[1]}\n", "utf8");

    expect(() => journal.record({ op: "create", noteId: "n-1", summary: "x" })).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/git commit failed/);
    expect(journal.status().issue).toMatch(/git commit failed/);
  });
});

describe("journal — choosing the backend from the infrastructure", () => {
  it("picks git inside a work tree and file outside one", () => {
    const workTree = mkdtempSync(join(tmpdir(), "bp-journal-wt-"));
    try {
      initRepo(workTree);
      expect(isInsideWorkTree(workTree)).toBe(true);
      const inside = selectJournal({ ...options(), storePath: join(workTree, "store.json") });
      expect(inside.status().backend).toBe("git");

      const outside = selectJournal({ ...options(), storePath: join(dir, "store.json") });
      expect(outside.status().backend).toBe("file");
    } finally {
      rmSync(workTree, { recursive: true, force: true });
    }
  });

  it("honours an explicit choice and falls back to none when the request cannot be met", () => {
    expect(selectJournal({ ...options(), backend: "none", storePath: join(dir, "store.json") }).status().backend).toBe("none");
    expect(selectJournal({ ...options(), backend: "file", storePath: join(dir, "store.json") }).status().backend).toBe("file");

    // git requested outside a work tree: `none` with a reason beats a silent no-op.
    const forced = selectJournal({ ...options(), backend: "git", storePath: join(dir, "store.json") });
    expect(forced.status().backend).toBe("none");
    expect(forced.status().issue).toMatch(/not a git work tree/);

    // …and `auto` still serves notes when the file backend cannot be created.
    writeFileSync(join(dir, "store.json"), "{\"notes\":[]}\n", "utf8"); // a file where a dir is needed
    const blocked = selectJournal({
      ...options(),
      backend: "file",
      storePath: join(dir, "store.json"),
      dir: join(dir, "store.json", "nested"),
    });
    expect(blocked.status().backend).toBe("none");
    expect(blocked.status().issue).toMatch(/could not be created|ENOTDIR|EEXIST|not a directory/i);
  });

  it("writes the journal next to the store by default", () => {
    const storePath = join(dir, "notes", "store.json");
    const journal = selectJournal({ ...options(), backend: "file", storePath });
    journal.record({ op: "create", noteId: "n-1", summary: "create n-1" });
    const path = join(dir, "notes", "journal.jsonl");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("create n-1");
    expect(journal.status().location).toBe(path);
  });
});

describe("journal — the actor of a batch (FR-18)", () => {
  it("names the actor in the commit and reports it back through `read`", () => {
    initRepo(dir);
    const storePath = join(dir, "store.json");
    const journal = selectJournal({
      ...options(),
      backend: "git",
      storePath,
      coalesceMs: 0,
      subjectTemplate: "chore(notes): {count} change(s) by {actor}",
    });
    writeFileSync(storePath, "{\"notes\":[{\"id\":\"n-1\"}]}\n", "utf8");
    journal.record({ op: "create", noteId: "n-1", actor: "dduchrow", summary: "create n-1" });

    const subject = spawnSync("git", ["-C", dir, "log", "-1", "--format=%s"], { encoding: "utf8" }).stdout.trim();
    const body = spawnSync("git", ["-C", dir, "log", "-1", "--format=%b"], { encoding: "utf8" }).stdout.trim();
    expect(subject).toBe("chore(notes): 1 change(s) by dduchrow");
    expect(body).toBe("Actor: dduchrow");
    expect(journal.read().entries[0]?.actor).toBe("dduchrow");
  });

  it("leaves the trailer out when the batch names nobody or several disagree", () => {
    initRepo(dir);
    const storePath = join(dir, "store.json");
    const journal = selectJournal({ ...options(), backend: "git", storePath, coalesceMs: 2000 });

    writeFileSync(storePath, "{\"notes\":[{\"id\":\"n-1\"}]}\n", "utf8");
    journal.record({ op: "create", noteId: "n-1", summary: "create n-1" });
    journal.flush();
    expect(spawnSync("git", ["-C", dir, "log", "-1", "--format=%b"], { encoding: "utf8" }).stdout.trim()).toBe("");

    writeFileSync(storePath, "{\"notes\":[{\"id\":\"n-1\"},{\"id\":\"n-2\"}]}\n", "utf8");
    journal.record({ op: "update", noteId: "n-2", actor: "Hermes", summary: "update n-2" });
    journal.record({ op: "update", noteId: "n-2", actor: "dduchrow", summary: "update n-2" });
    journal.flush();
    const body = spawnSync("git", ["-C", dir, "log", "-1", "--format=%b"], { encoding: "utf8" }).stdout.trim();
    expect(body).not.toContain("Actor:");
    expect(journal.read().entries[1]?.actor).toBeUndefined();
  });
});
