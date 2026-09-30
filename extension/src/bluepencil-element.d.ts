/**
 * The types of the *built* element bundle `extension/src/bootstrap.ts` imports.
 *
 * ## Why a declaration instead of the real module
 *
 * The extension does not import the library's source. It imports the artefact a page gets too —
 * `dist/bluepencil.element.js`, bundled *into* `bootstrap.js` by `extension/build.mjs`, so that the
 * layer arrives as a packaged file rather than as text the page's CSP would refuse to evaluate.
 *
 * That artefact is generated and not committed, which leaves two bad options and one good one:
 *
 *   - typechecking only in a worktree where `npm run build` has already run makes the typecheck
 *     depend on build order, and a fresh clone fails instead of reporting anything useful;
 *   - not typechecking the extension at all is what let a real error
 *     (`extension/src/settings.ts`: possibly-undefined index) sit in the sources while `tsc --noEmit`
 *     stayed green — the root `tsconfig.json` does not include `extension/`;
 *   - declaring the one surface the extension actually uses, which is this file. It is one function
 *     wide on purpose: the more of the bundle is restated here, the more this file can disagree with
 *     what is really shipped.
 *
 * The wildcard keeps the declaration attached to the path `bootstrap.ts` writes, so renaming the
 * import target in one place cannot leave a stale declaration behind that still typechecks.
 */
declare module "*/dist/bluepencil.element.js" {
  /**
   * Registers the `<bluepencil-notes>` custom element. Idempotent — calling it twice is a no-op, as
   * the layer's own contract requires (FR-12.1/12.2).
   */
  export function defineBluepencilElement(tagName?: string): void;

  /** The custom element the layer mounts as. */
  export class BluepencilNotesElement extends HTMLElement {
    static readonly tagName: string;
  }
}
