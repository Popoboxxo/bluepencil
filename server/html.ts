/**
 * The one HTML escaper of the server-rendered pages (FR-9.3: user text is always rendered as text,
 * never as markup).
 *
 * `server/admin-html.ts` and `server/launcher-html.ts` both import this function instead of each
 * carrying a copy: two escapers drift apart, and the page that drifts is the one nobody looks at.
 */

/** Escapes a string for HTML text and quoted attributes, including the single quote. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
