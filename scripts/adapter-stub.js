/**
 * Adapter stub used only by the size guard (NFR-3).
 *
 * `npm run build` produces `dist/bluepencil.core.js` with the four built-in adapters aliased to
 * this file, so the reported core size is what a host pays when it brings its own transport.
 * Never shipped, never imported by the library itself.
 */
const fail = () => {
  throw new Error("bluepencil: adapters are not part of the core size measurement");
};

export const createMemoryAdapter = fail;
export const createLocalStorageAdapter = fail;
export const createFileAdapter = fail;
export const createHttpAdapter = fail;
