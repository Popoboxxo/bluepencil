/**
 * The options page's credential copy and state (AC-B17, AC-B43).
 *
 * Two things a user cannot find out from a form alone: that the shared secret is the legacy mode and
 * a per-device signed token is the one to prefer, and when the stored token dies. Both are decided
 * here, pure and DOM-free, so the page only assigns `textContent` and never derives a second answer
 * of its own (FR-9.3).
 *
 * The copy never contains the credential itself — only the mode, a hint and the expiry that is
 * already stored beside it. `state` is `null` when there is nothing to report.
 */
import { configuredCredential } from "./credential";
import type { ExtensionSettings } from "./settings";

export interface CredentialCopy {
  /** The field label for the selected mode. */
  label: string;
  /** One sentence naming the header and the recommended credential. */
  hint: string;
  /** The expiry line, or `null` when there is no state to show. */
  state: string | null;
}

/**
 * A shared secret is still accepted (the hub accepts both modes at once), but it is the legacy path:
 * one value every client holds, and revoking it means revoking everyone. The hint says so and points
 * at the signed token that does not have that property.
 */
const SECRET_HINT =
  "Sent as x-bluepencil-auth. The shared secret is deprecated: prefer a per-device signed token (`bluepencil token --device <name>`). Stored in this browser only; the hub needs --auth-secret with the same value.";

/** `none` disables the credential; the hub is then open to whoever can reach it. */
const NONE_HINT =
  "None. The credential is disabled — anyone who can reach the hub URL can read and write your notes, so it must stay on loopback.";

/** A token is per device, so revoking one device does not lock out the others. */
const TOKEN_HINT =
  "Sent as Authorization: Bearer. Mint a per-device signed token with `bluepencil token --device <name>`; each device gets its own, it expires, and the hub can revoke one device without touching the others.";

const NO_TOKEN_STATE =
  "No token stored yet — notes will not reach the hub until you paste one.";

/**
 * The copy for the credential the form is showing.
 *
 * The `none` branch is first-class, not a fallthrough: it must return `state: null` even when an old
 * token is still in the field, because the saved settings would not use that value.
 */
export function credentialCopy(
  settings: Pick<ExtensionSettings, "auth" | "token" | "tokenExpiresAt">,
): CredentialCopy {
  if (settings.auth === "secret") {
    return { label: "Shared secret", hint: SECRET_HINT, state: null };
  }
  if (settings.auth === "none") {
    return { label: "Credential", hint: NONE_HINT, state: null };
  }
  return tokenCopy(settings.token, settings.tokenExpiresAt);
}

/**
 * The token mode's copy, with the expiry as its only state.
 *
 * The expiry is read from `tokenExpiresAt`, which `settings.ts` derives from the token itself — the
 * extension never decides whether a token is valid, only what is coming. An expiry that cannot be
 * parsed is treated like "unknown" (`null`), because a wrong countdown is worse than none.
 */
function tokenCopy(token: string, tokenExpiresAt: string): CredentialCopy {
  const copy = { label: "Signed token", hint: TOKEN_HINT };
  if (configuredCredential(token) === null) {
    return { ...copy, state: NO_TOKEN_STATE };
  }
  if (tokenExpiresAt.length === 0) {
    return { ...copy, state: null };
  }
  const expiresAt = Date.parse(tokenExpiresAt);
  if (!Number.isFinite(expiresAt)) {
    return { ...copy, state: null };
  }
  // The ISO form is the one stored, so the line names the exact instant as well as the distance to
  // it — "expires in 6 h" alone cannot be checked against the hub's own idea of the deadline.
  const expiry = new Date(expiresAt).toISOString();
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    return {
      ...copy,
      state: `Expired ${expiry}. Mint a new token — notes are not reaching the hub until you do.`,
    };
  }
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const relative = hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
  return { ...copy, state: `Expires ${expiry} (in about ${relative}).` };
}
