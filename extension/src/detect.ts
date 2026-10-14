/**
 * Host-embed detection (#70).
 *
 * A page can already carry the Bluepencil layer on its own: as a `<bluepencil-notes>` element, via
 * the one-tag embed loader (`dist/attach.js`, which defines the element and the `bluepencilAttach`
 * global), or as a client of a hub (`[data-endpoint]`). On such a page the extension is at best
 * redundant and at worst a bug: a second overlay stacked on the same document, both fighting for the
 * same notes.
 *
 * So the extension asks this question *before* it mounts and, by default, steps aside when the page
 * owns the layer. The answer is the page's own markup — never a guess about intent.
 *
 * Deliberately a pure function over an injectable `Document`, so it can be unit-tested against fake
 * documents without a browser. It has no imports, no DOM side effects, and reads only what the
 * loader itself would leave behind.
 */

/** Which of the three host-embed shapes a page carries, or `null` for a page that has none. */
export type HostEmbedSource = "element" | "loader" | "hub";

/**
 * The first host-embed shape present in `doc`, in precedence order — or `null`.
 *
 * The order is the order of specificity: an actual `<bluepencil-notes>` element is unambiguous, the
 * loader is the documented way to create one, and a bare `[data-endpoint]` is the loosest signal
 * (any element could carry that attribute). Returning the first match keeps a page with more than
 * one shape from being reported three times.
 */
export function detectHostEmbed(doc: Document = document): HostEmbedSource | null {
  if (doc.querySelector("bluepencil-notes") !== null) return "element";

  // The loader leaves two traces and either is enough: the script tag it is loaded from, or the
  // `bluepencilAttach` global it installs. Checking both covers a loader that was renamed in a
  // bundler as well as one whose script tag has already been removed from the DOM.
  const loaderGlobal = (globalThis as Record<string, unknown>).bluepencilAttach;
  if (doc.querySelector('script[src*="attach.js"]') !== null || loaderGlobal !== undefined) {
    return "loader";
  }

  if (doc.querySelector("[data-endpoint]") !== null) return "hub";
  return null;
}
