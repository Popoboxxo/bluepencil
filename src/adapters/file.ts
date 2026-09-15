/**
 * File adapter — import/export of a JSON file (FR-6.2, FR-14.7).
 *
 * The host owns the I/O (`node:fs` in the CLI, a download/upload in the browser, a temp file in a
 * test), so this module stays free of `node:fs` and of the DOM and works in both runtimes. The
 * whole set lives in one JSON blob written through the shared engine in `memory.ts`; a failing
 * read or write degrades to memory and is reported once (NFR-8).
 */
import { BluepencilValidationError } from "../core/model";
import type { Adapter } from "../core/adapter";
import { createJsonAdapter, type JsonAdapterIo } from "./memory";

/** Adapter name reported to the store and to hosts. */
export const FILE_ADAPTER_NAME = "file";

/** Host-provided file access; `read()` returns `null` when the file does not exist yet. */
export interface FileAdapterIo {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export function createFileAdapter(options: FileAdapterIo): Adapter {
  if (
    !options ||
    typeof options.read !== "function" ||
    typeof options.write !== "function"
  ) {
    throw new BluepencilValidationError([
      "the file adapter needs injected I/O: createFileAdapter({ read, write })",
    ]);
  }

  let reported = false;
  const io: JsonAdapterIo = {
    readText: () => options.read(),
    writeText: (text) => options.write(text),
    onFallback: (reason) => {
      if (reported) {
        return;
      }
      reported = true;
      console.debug(
        "bluepencil: file adapter I/O failed — notes are kept in memory for this session",
        reason,
      );
    },
  };

  return createJsonAdapter(FILE_ADAPTER_NAME, io);
}
