/**
 * Atomic file replacement for the hub's own state — the store file, its Markdown mirror, the device
 * registry and the revocation list.
 *
 * Shared rather than copied: the same write discipline has to hold for every file the hub owns, and
 * a second implementation is how one of them ends up with a half-written file after a crash.
 */
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

let writeCounter = 0;

/**
 * Atomic write: the temp file lives in the target directory (so `rename` never crosses a mount,
 * FR-6.5) and is removed on *every* exit path — including a failed rename — so a refused write
 * can never leave litter behind. The counter keeps two writes of one process from sharing a temp
 * path, which would let one rename publish a blob another write is still filling in.
 */
export function writeAtomic(path: string, text: string): void {
  writeCounter += 1;
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${writeCounter}`);
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
