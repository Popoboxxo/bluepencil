/**
 * The launcher page (FR-6.26): one form, no script, no external resource.
 *
 * The page is served by the **hub** origin and is the browser entry point of the viewer. It exists
 * because a browser can neither set the `x-bluepencil-admin` header nor be asked to type a secret
 * into the address bar; the secret travels in the form body instead (FR-6.21, FR-6.27).
 *
 * Rendering rules that are part of the contract (spec §4):
 *  - exactly one `<input type="password" name="secret">`, no `value` attribute, `autofocus`;
 *  - `<form method="post">` against `{base}/viewer/start` with the form-urlencoded enctype;
 *  - every string comes from the shared admin table (FR-6.30), `error` is already localised;
 *  - the error block sits directly after the `<h1>` and carries `role="alert"`;
 *  - no JavaScript, no external asset, every class `bp-` prefixed, every custom property `--bp-*`.
 */
import type { AdminStrings } from "./admin-i18n";
import { escapeHtml } from "./html";

/**
 * Substitutes `{name}` placeholders exactly like the admin page's `fmt()`: an unknown placeholder
 * stays literal instead of being blanked.
 */
export function fillTemplate(template: string, vars: Record<string, string | number>): string {
  return String(template).replace(/{([A-Za-z0-9_]+)}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

/**
 * The launcher page: one form, no script, no external resource. Every string comes from the shared
 * admin table (FR-6.30); `error` is already localised by the caller.
 */
export function renderLauncherHtml(
  strings: AdminStrings,
  options: { action: string; error?: string },
): string {
  const s = strings;
  const error =
    options.error === undefined || options.error.length === 0
      ? ""
      : `\n  <p class="bp-error" role="alert">${escapeHtml(options.error)}</p>`;
  return `<!doctype html>
<html lang="${escapeHtml(s.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(s.launcherTitle)}</title>
<style>
  :root { color-scheme: light dark; --bp-bg:#fbfbfd; --bp-fg:#1c1c1f; --bp-muted:#61616a; --bp-line:#e3e3ea;
          --bp-card:#fff; --bp-accent:#2f5fd0; --bp-danger:#b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bp-bg:#16161a; --bp-fg:#ececf1; --bp-muted:#9a9aa6; --bp-line:#2c2c34; --bp-card:#1d1d22;
            --bp-accent:#7aa2f7; --bp-danger:#f28b82; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bp-bg); color:var(--bp-fg); font:15px/1.5 system-ui, sans-serif; }
  main { max-width: 26rem; margin: 3rem auto; padding: 1.25rem; }
  .bp-card { background:var(--bp-card); border:1px solid var(--bp-line); border-radius:10px; }
  h1 { font-size:1.15rem; margin:0 0 .25rem; }
  .bp-muted { color:var(--bp-muted); font-size:.9rem; }
  .bp-error { color:var(--bp-danger); font-weight:600; margin:.5rem 0 0; }
  label { display:block; margin:1rem 0 .35rem; font-weight:600; }
  input, button { font:inherit; width:100%; padding:.5rem .6rem; border-radius:8px; border:1px solid var(--bp-line);
                  background:var(--bp-card); color:var(--bp-fg); }
  input:focus-visible, button:focus-visible { outline:2px solid var(--bp-accent); outline-offset:1px; }
  button { margin-top:.75rem; cursor:pointer; }
  button.bp-primary { background:var(--bp-accent); border-color:var(--bp-accent); color:#fff; }
  @media (prefers-color-scheme: dark) { button.bp-primary { color:#10101a; } }
</style>
</head>
<body>
<main class="bp-card">
  <h1>${escapeHtml(s.launcherHeading)}</h1>${error}
  <p class="bp-muted">${escapeHtml(s.launcherHelp)}</p>
  <form method="post" action="${escapeHtml(options.action)}" enctype="application/x-www-form-urlencoded">
    <label for="secret">${escapeHtml(s.secretLabel)}</label>
    <input type="password" name="secret" id="secret" autocomplete="off" required autofocus>
    <button type="submit" class="bp-primary">${escapeHtml(s.launcherSubmit)}</button>
  </form>
</main>
</body>
</html>
`;
}
