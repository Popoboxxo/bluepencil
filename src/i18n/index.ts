/**
 * i18n entry point of the review layer (FR-11.1).
 *
 * Minimal, dependency-free and side-effect free: two flat tables (`en`, `de`), language
 * normalisation (`de-AT` -> `de`, unknown -> `en`) and a `t(key, vars)` helper. Every
 * user-visible string of `src/ui/*` goes through this module — no literals in the UI.
 *
 * Three ways to translate:
 *  - `t(key, vars)`               — one-off, English by default;
 *  - `createTranslator(language)` — language-bound translator used by the layer;
 *  - `applyTranslations(root, t)` — marks up a rendered DOM subtree (`data-bp-i18n` and friends),
 *                                    which is what makes "every label switches" testable.
 *
 * `applyTranslations` is a plain DOM walk (no eval, no inline handlers — NFR-6) and only touches
 * nodes inside the layer's own container.
 */

import { de } from "./de";
import { en, type MessageKey, type Messages } from "./en";

export type { MessageKey, Messages };

/** Languages shipped with the library. */
export const LANGUAGES = ["en", "de"] as const;
export type Language = (typeof LANGUAGES)[number];

/** English is the default and the fallback for anything unknown. */
export const DEFAULT_LANGUAGE: Language = "en";

/** Complete language tables, keyed by language. */
export const messages: Record<Language, Messages> = { en, de };

/** Interpolation values, e.g. `t("a11y.markerCount", { count: 3 })`. */
export type Vars = Record<string, string | number>;

/** Signature every UI module consumes — the layer always passes a bound translator. */
export type Translate = (key: MessageKey, vars?: Vars) => string;

function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

/**
 * Normalise a host-provided language tag: case-insensitive, region and separator agnostic
 * (`de-AT`, `de_AT`, `DE` -> `de`). Anything unsupported falls back to English (never throws).
 */
export function normalizeLanguage(input?: string | null): Language {
  if (typeof input !== "string") return DEFAULT_LANGUAGE;
  const primary = input.trim().toLowerCase().replace(/_/g, "-").split("-")[0] ?? "";
  return isLanguage(primary) ? primary : DEFAULT_LANGUAGE;
}

/** True when `value` is a known message key (guards hand-written attributes). */
export function isMessageKey(value: unknown): value is MessageKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(en, value);
}

/** Replace `{name}` placeholders; unknown placeholders are left untouched on purpose. */
export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return match;
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/** Translate one key in one language; `en` is the default language. */
export function translate(language: Language, key: MessageKey, vars?: Vars): string {
  const table = messages[language] ?? messages[DEFAULT_LANGUAGE];
  return interpolate(table[key], vars);
}

/**
 * One-off translation helper: `t("bar.panel")`.
 * The optional third argument accepts any raw language tag (`de-AT`, unknown values fall back).
 */
export function t(key: MessageKey, vars?: Vars, language?: string): string {
  return translate(normalizeLanguage(language), key, vars);
}

/** A language-bound translator, as used by the layer and every overlay component. */
export interface Translator {
  readonly language: Language;
  t: Translate;
}

/** Build a translator for a raw language tag; unknown tags resolve to English. */
export function createTranslator(language?: string | null): Translator {
  const resolved = normalizeLanguage(language);
  return {
    language: resolved,
    t: (key, vars) => translate(resolved, key, vars),
  };
}

/**
 * Attribute-to-property map used by `applyTranslations`.
 * Kept as data (not code) so the whole localisation of a rendered subtree is one declaration.
 */
const I18N_ATTRIBUTES: readonly (readonly [string, "text" | "attribute"])[] = [
  ["data-bp-i18n", "text"],
  ["data-bp-i18n-aria", "attribute"],
  ["data-bp-i18n-title", "attribute"],
  ["data-bp-i18n-placeholder", "attribute"],
];

const ATTRIBUTE_TARGETS: Record<string, string> = {
  "data-bp-i18n-aria": "aria-label",
  "data-bp-i18n-title": "title",
  "data-bp-i18n-placeholder": "placeholder",
};

/**
 * Translate every marked node inside `root` (the layer's own container), including `root`
 * itself when it carries a marker.
 * Marking convention:
 *  - `data-bp-i18n="key"`               -> `textContent`
 *  - `data-bp-i18n-aria="key"`          -> `aria-label`
 *  - `data-bp-i18n-title="key"`         -> `title`
 *  - `data-bp-i18n-placeholder="key"`   -> `placeholder`
 *
 * A marked element must not own child *elements*: the text property is written wholesale.
 * Unknown keys are ignored (never rendered as raw keys, FR-9.3/FR-11.1).
 */
export function applyTranslations(root: ParentNode, t: Translate): void {
  if (!root || typeof root.querySelectorAll !== "function") return;
  const self = asElement(root);
  for (const [attribute, kind] of I18N_ATTRIBUTES) {
    const nodes = Array.from(root.querySelectorAll(`[${attribute}]`));
    if (self !== null && self.hasAttribute(attribute)) nodes.unshift(self);
    for (const node of nodes) {
      const key = node.getAttribute(attribute);
      if (!isMessageKey(key)) continue;
      const text = t(key);
      if (kind === "text") {
        node.textContent = text;
        continue;
      }
      const property = ATTRIBUTE_TARGETS[attribute];
      if (property) node.setAttribute(property, text);
    }
  }
}

/** `Node` -> `Element`, without relying on a DOM global for the check. */
function asElement(node: ParentNode): Element | null {
  const candidate = node as { getAttribute?: unknown };
  return typeof candidate.getAttribute === "function" ? (node as Element) : null;
}
