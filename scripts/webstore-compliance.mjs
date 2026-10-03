/**
 * Chrome Web Store program-policy compliance (#58).
 *
 * The store's *Privacy practices* form asks a handful of questions, and every answer is checked here
 * against the shipped artefact rather than against intent: the manifest, the built extension, and the
 * dashboard copy in `docs/WEBSTORE.md`. The point is drift — a permission added to the manifest, a
 * remote import that creeps into the worker, or a justification that no longer names a permission all
 * survive a read-through and fail here. (Best Practices §5/§6: keep the dashboard metadata accurate
 * and test before submitting.)
 *
 * Two severities, because the policy is not uniform:
 *
 *   - `check(...)`  a hard requirement. A failure means the submission is non-compliant, and the
 *                   process exits 1.
 *   - `advise(...)` a judgement call the policy leaves open — permission breadth, the in-product
 *                   disclosure. Printed with the finding, never fatal: the decision is a human's, not
 *                   a test's, and a suite that failed on a judgement call would be turned off.
 *
 * Sources, read 2026-10-02:
 *   Program Policies  https://developer.chrome.com/docs/webstore/program-policies/policies
 *   User Data FAQ     https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
 *   Privacy fields    https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
 *
 * No dependencies (NFR-4); runs on Node >= 20 like every other smoke script here.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const extDir = join(root, "extension");
const manifestPath = join(extDir, "manifest.json");
const distDir = join(extDir, "dist");
const webstoreDoc = join(root, "docs", "WEBSTORE.md");
const privacyDoc = join(root, "docs", "PRIVACY.md");

let passed = 0;
let failed = 0;
let advice = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return condition;
}

function advise(name, detail) {
  advice += 1;
  console.log(`ADVICE ${name} — ${detail}`);
}

async function readIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Comment stripping, so the word "eval" in an explanatory comment is not read as an `eval`.
 *
 * Block comments go first, then whole-line `//` comments. A trailing `// …` after code is left in
 * place on purpose: stripping it safely needs a parser (a `//` sits inside any `http://`), and the
 * authoritative scan is the *built* bundle anyway — esbuild removes the comments there.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const MANIFEST_PERMISSIONS = ["scripting", "storage", "activeTab"];

/**
 * Permissions the extension must never ask for. Each is either a tracking surface (history,
 * bookmarks, cookies), a code-execution escape hatch (debugger, userScripts, eval-like APIs), or
 * unrelated to taking review notes. Anything here is a "Use of Permissions" violation.
 */
const FORBIDDEN_PERMISSIONS = [
  "history",
  "bookmarks",
  "cookies",
  "webRequest",
  "webRequestBlocking",
  "debugger",
  "userScripts",
  "nativeMessaging",
  "proxy",
  "management",
  "downloads",
  "topSites",
  "browsingData",
  "declarativeNetRequest",
  "geolocation",
  "clipboardRead",
  "identity",
];

/* -------------------------------------------------------------------------- */
/* static checks — the manifest and the shipped code                           */
/* -------------------------------------------------------------------------- */

async function checkManifest() {
  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);

  // "Additional Requirements for Manifest V3" — the policy that governs the code requirements below.
  check("manifest is Manifest V3", manifest.manifest_version === 3, `manifest_version=${manifest.manifest_version}`);

  // "Listing Requirements" §1: a blank description is an automatic rejection; the store caps the
  // short description at 132 characters, so a longer one is silently truncated in the listing.
  const description = manifest.description ?? "";
  check(
    "listing description is present and within the store's 132 characters",
    description.trim().length > 0 && description.length <= 132,
    `${description.length} chars`,
  );

  // "Minimum Functionality" §1 and "Quality Guidelines" §1: one narrow purpose. The name must not
  // claim to be a Google/Chrome product ("Impersonation & Intellectual Property" §1/§2).
  const name = manifest.name ?? "";
  check(
    "name does not impersonate Chrome, Google or an OS surface",
    name.length > 0 && !/[Cc]hrome|[Gg]oogle|\b(Microsoft|Apple|Windows|macOS)\b/.test(name),
    `name=${JSON.stringify(name)}`,
  );

  // "Building Quality Products / Listing Requirements" §1: an icon is required for the listing. It is
  // not part of the zip policy but it is part of a submittable item; reported, not fatal, because the
  // icon is uploaded in the dashboard rather than read from the manifest.
  check(
    "manifest declares a pinned minimum Chrome version",
    typeof manifest.minimum_chrome_version === "string" && manifest.minimum_chrome_version.length > 0,
    `minimum_chrome_version=${manifest.minimum_chrome_version}`,
  );

  const permissions = manifest.permissions ?? [];

  // "Use of Permissions": the narrowest set that implements the existing features.
  const unknown = permissions.filter((p) => !MANIFEST_PERMISSIONS.includes(p));
  check(
    "requests only the documented permission set",
    unknown.length === 0,
    `unexpected: ${JSON.stringify(unknown)}`,
  );

  const forbidden = permissions.filter((p) => FORBIDDEN_PERMISSIONS.includes(p));
  check(
    "requests no tracking- or execution-surface permission",
    forbidden.length === 0,
    `forbidden: ${JSON.stringify(forbidden)}`,
  );

  // activeTab is the property the whole architecture rests on (sw.ts): inject on demand, never
  // standing access. Its absence would be a product regression, not a compliance one — checked so
  // that removing it cannot happen silently.
  check("keeps activeTab (on-demand access)", permissions.includes("activeTab"), JSON.stringify(permissions));

  // `tabs` unlocks url/title/favIconUrl for tabs the extension has **no host access to**. Nothing here
  // needs that: the page a note belongs to comes from the layer's own `route="url"` in the page, and
  // `chrome.tabs.query` / `tab.id` never required a permission. Measured in `smoke:ext` against a real
  // Chrome — the mount, the notes and the options page all work with `tabs` gone. Requesting it would
  // be an extra permission for data nothing reads, which is what "Use of Permissions" rejects.
  check(
    "does not request `tabs` (no code path reads a tab URL the host permission does not cover)",
    !permissions.includes("tabs"),
    `permissions=${JSON.stringify(permissions)}`,
  );

  const hosts = manifest.host_permissions ?? [];
  check(
    "declares at least one host permission for the registered content script",
    hosts.length > 0,
    `host_permissions=${JSON.stringify(hosts)}`,
  );
  // "<all_urls>" is not a violation by itself, but it is the broadest possible scope and the first
  // thing a reviewer looks at. The narrowest thing that works here is http + https.
  check("does not request <all_urls>", !hosts.includes("<all_urls>"), JSON.stringify(hosts));
  check(
    "host scope is http/https only (no file://, ftp://, chrome://)",
    hosts.length > 0 &&
      hosts.every((h) => /^https?:\/\/\*\/\*$/.test(h)),
    JSON.stringify(hosts),
  );

  // "Additional Requirements for Manifest V3" §1: the extension's logic must be in the package. A
  // declared content script whose `js` points at an external file is the classic violation.
  const contentScripts = manifest.content_scripts ?? [];
  check(
    "declares no content script that loads remote code",
    contentScripts.every(
      (cs) => (cs.js ?? []).every((f) => !/^(https?:)?\/\//.test(f)) && !(cs.code !== undefined),
    ),
    JSON.stringify(contentScripts.map((cs) => cs.js)),
  );

  // A page the extension injects into must not be able to reach extension files it does not need.
  // None are exposed today; if that changes, this is where it is noticed.
  const war = manifest.web_accessible_resources;
  check(
    "exposes no web-accessible resource to pages",
    war === undefined || (Array.isArray(war) && war.length === 0),
    JSON.stringify(war),
  );

  // "Additional Requirements for Manifest V3" §1: `script-src 'self'` with no remote origin is the
  // static form of "no remote code". `unsafe-eval` would let a fetched string run.
  const csp = manifest.content_security_policy?.extension_pages ?? "";
  check(
    "extension pages run no remote code (CSP script-src 'self')",
    csp.includes("script-src 'self'") && !/https?:/.test(csp) && !csp.includes("unsafe-eval"),
    `csp=${JSON.stringify(csp)}`,
  );

  // Chrome's own extension messaging, not a page-facing channel.
  check(
    "does not accept connections from pages",
    manifest.externally_connectable === undefined,
    JSON.stringify(manifest.externally_connectable),
  );

  return { manifest, permissions, hosts };
}

/**
 * The shipped JavaScript, scanned for the two things MV3 forbids outright: evaluating a string, and
 * loading code from outside the package. The built bundle is the authority; the sources are the
 * fallback so the check still runs before a build.
 */
async function checkShippedCode() {
  const shippable = ["sw.js", "bridge.js", "bootstrap.js", "options.js", "bluepencil.element.iife.js"];
  const built = await exists(join(distDir, "sw.js"));

  const files = [];
  if (built) {
    for (const name of shippable) {
      const source = await readIfPresent(join(distDir, name));
      if (source !== undefined) files.push({ name: `dist/${name}`, code: source });
    }
  } else {
    for (const name of ["sw.ts", "bridge.ts", "bootstrap.ts", "options.ts", "handoff.ts", "settings.ts"]) {
      const source = await readIfPresent(join(extDir, "src", name));
      if (source !== undefined) files.push({ name: `src/${name}`, code: stripComments(source) });
    }
  }

  check(
    `scans the ${built ? "built" : "source"} extension (${files.length} file(s))`,
    files.length > 0,
    "nothing to scan — run `npm run build:ext`",
  );

  const offences = { stringEval: [], remoteImport: [], obfuscation: [] };
  for (const { name, code } of files) {
    if (/\beval\s*\(/.test(code) || /new\s+Function\s*\(/.test(code)) offences.stringEval.push(name);
    if (/\bimport\s*\(\s*["'`]?\s*(https?:)?\/\//.test(code) || /from\s+["']https?:/.test(code)) {
      offences.remoteImport.push(name);
    }
    // Packed/obfuscated source is prohibited ("Code Readability Requirements" §1). Minification is
    // allowed — a name like `_0x4f2a` is the artefact of a packer, not of a minifier.
    if (/_0x[0-9a-f]{3,}/i.test(code)) offences.obfuscation.push(name);
  }

  check(
    "no shipped file evaluates a string (no eval, no new Function)",
    offences.stringEval.length === 0,
    offences.stringEval.join(", "),
  );
  check(
    "no shipped file imports from a remote origin",
    offences.remoteImport.length === 0,
    offences.remoteImport.join(", "),
  );
  check(
    "shipped code is not obfuscated (minification is allowed, packing is not)",
    offences.obfuscation.length === 0,
    offences.obfuscation.join(", "),
  );

  // `chrome.scripting.executeScript({ code: "…" })` is string evaluation wearing an API's clothes:
  // the payload is a string, which is exactly the shape the policy forbids. Only `files` and `func`
  // may appear.
  const worker = files.find((f) => f.name.endsWith("sw.js") || f.name.endsWith("sw.ts"));
  if (worker !== undefined) {
    check(
      "the worker injects files and functions only, never a code string",
      !/\bcode\s*:/.test(worker.code),
      "executeScript({ code }) found",
    );
  }

  // Every http(s) literal in the shipped code, minus the two that are not a fetch: the match pattern
  // for the registered content script and the XHTML namespace used by createElementNS. Anything else
  // would be a hardcoded remote origin — the thing a review reads the code to find.
  const ALLOWED_URLS = [/^https?:\/\/\*\/\*$/, /^http:\/\/www\.w3\.org\//, /^https?:\/\/(127\.0\.0\.1|localhost)\b/];
  const suspicious = new Set();
  for (const { code } of files) {
    for (const match of code.matchAll(/https?:\/\/[^\s"'`)\\]{0,60}/g)) {
      const url = match[0];
      if (!ALLOWED_URLS.some((re) => re.test(url))) suspicious.add(url);
    }
  }
  check(
    "no hardcoded remote origin in the shipped code",
    suspicious.size === 0,
    [...suspicious].slice(0, 6).join(", "),
  );

  // The extension's own code must make no network request at all. The one egress in the package is the
  // element's HTTP adapter — it sends notes to the hub URL the user configured, and only when they
  // picked that store. It is library code, not extension code, and it ships inside the element bundle.
  // Scanned on `extension/src` rather than on the build, because the built `bootstrap.js` inlines that
  // bundle and would otherwise report the library's single call site twice, as if the extension had
  // one of its own.
  const ownSources = [];
  for (const name of ["sw.ts", "bridge.ts", "bootstrap.ts", "options.ts", "handoff.ts", "settings.ts"]) {
    const source = await readIfPresent(join(extDir, "src", name));
    if (source !== undefined) ownSources.push({ name, code: stripComments(source) });
  }
  const networkApi = ownSources
    .filter(({ code }) => /\bfetch\s*\(|XMLHttpRequest|WebSocket|navigator\.sendBeacon/.test(code))
    .map(({ name }) => name);
  check(
    "the extension's own code never makes a network request (all egress is the user's hub)",
    networkApi.length === 0,
    `network API in: ${networkApi.join(", ")}`,
  );

  // The options page is the only HTML the extension ships. A remote <script>/<link> there would be
  // remote code by another name, and is refused by the extension CSP anyway.
  const html = await readIfPresent(join(extDir, "options.html"));
  if (html !== undefined) {
    const remoteTags = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
      .map((m) => m[1])
      .filter((url) => /^(https?:)?\/\//.test(url));
    check("the options page loads nothing from a remote origin", remoteTags.length === 0, remoteTags.join(", "));
    check(
      "the options page has no inline script (the CSP would refuse it)",
      !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html),
      "an inline <script> with content was found",
    );
    // "Disclosure Requirements" §2 and User Data FAQ §10: the prominent disclosure and the consent have
    // to happen **in the product's own UI** — a store description does not satisfy it.
    check(
      "the options page discloses what is stored and links the privacy policy",
      /What Bluepencil stores/.test(html) && /<a [^>]*href="https:\/\/[^"]*privacy/i.test(html),
      "the in-product data disclosure or its privacy link is missing",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* the dashboard copy — present, and still in step with the manifest           */
/* -------------------------------------------------------------------------- */

async function checkDashboardCopy(permissions, hosts) {
  const doc = await readIfPresent(webstoreDoc);
  if (!check("docs/WEBSTORE.md exists (the dashboard copy)", doc !== undefined, webstoreDoc)) return;

  // Every permission the manifest asks for must have a justification a human can paste. If the two
  // drift, the form is filled with a justification for a permission that is not requested — or, worse,
  // a permission is requested with no justification at all, which is a rejection.
  for (const permission of permissions) {
    check(
      `docs/WEBSTORE.md justifies \`${permission}\``,
      doc.includes(`\`${permission}\``),
      "no justification block names this permission",
    );
  }
  if (hosts.length > 0) {
    check(
      "docs/WEBSTORE.md justifies the host permission",
      doc.includes("**Justification — host permission**"),
      "no host-permission justification block",
    );
  }

  // The single-purpose field and the listing copy are the two places a blank answer is an automatic
  // rejection ("Listing Requirements" §1, Best Practices §8). The markers are bolded headings so a
  // rename of the section is caught here rather than in the dashboard's character counter.
  check("docs/WEBSTORE.md carries a single-purpose description", doc.includes("**Single purpose description**"));
  check("docs/WEBSTORE.md states the remote-code answer", doc.includes("**Remote code**"));
  check("docs/WEBSTORE.md lists the data-usage disclosures", doc.includes("**Data usage**"));

  // "Limited Use" §6: the affirmative statement has to live on a page belonging to the extension.
  const privacy = await readIfPresent(privacyDoc);
  if (!check("docs/PRIVACY.md exists (the privacy policy to host)", privacy !== undefined, privacyDoc)) return;
  check(
    "the privacy policy carries the Limited Use statement",
    /Limited Use/.test(privacy) && /Chrome Web Store User Data Policy/.test(privacy),
    "the Limited Use paragraph is missing or incomplete",
  );
  // "Privacy Policy" §2: collect, use, and *share* must each be answered.
  const answers = ["collect", "use", "share"]
    .map((verb) => new RegExp(`\\b${verb}`, "i").test(privacy))
    .filter(Boolean).length;
  check("the privacy policy answers collect / use / share", answers === 3, `${answers}/3`);

  // "Limited Use §1 / User Data FAQ §14": a privacy policy is required even when everything stays
  // local — and it must be reachable from the project's homepage.
  const readme = await readIfPresent(join(root, "README.md"));
  if (readme !== undefined) {
    check(
      "the homepage links the privacy policy (one click from the front page)",
      readme.includes("docs/PRIVACY.md"),
      "README.md does not link docs/PRIVACY.md",
    );
  }

  // "Limited Use" §6 wants the statement "on a website belonging to your extension". The policy has to
  // be *reachable*, not merely written — so the wiring that publishes it is part of the compliance
  // surface, and a deleted workflow would otherwise go unnoticed until the URL 404s.
  check(
    "a site is wired up to publish the privacy policy",
    (await exists(join(root, "scripts", "build-site.mjs"))) &&
      (await exists(join(root, ".github", "workflows", "pages.yml"))),
    "no site generator and/or Pages workflow",
  );
}

/* -------------------------------------------------------------------------- */
/* judgement calls — reported, never fatal                                     */
/* -------------------------------------------------------------------------- */

function adviseOnOpenQuestions(permissions, hosts) {
  // "Use of Permissions" §1 forbids asking for a permission an existing feature does not need, and
  // forbids future-proofing. `tabs` is only needed to read url/title of tabs the extension has no
  // host access to; with http/https host permissions the active tab's URL is readable without it.
  if (permissions.includes("tabs")) {
    advise(
      "`tabs` looks unnecessary",
      "with http/https host permissions, chrome.tabs.query + tab.url work without the `tabs` " +
        "permission (it only unlocks url/title for tabs outside the host scope). Requesting it is " +
        "the kind of extra permission 'Use of Permissions' rejects. Verified in docs/WEBSTORE.md §Findings.",
    );
  }

  // The broadest thing in the manifest, and the reason a review will be slower.
  if (hosts.some((h) => /^https?:\/\/\*\/\*$/.test(h))) {
    advise(
      "`http://*/*` + `https://*/*` is broad host access",
      "it exists for the registered MAIN-world content script, which is what makes the overlay " +
        "survive a navigation — that is the justification the dashboard copy uses (docs/WEBSTORE.md " +
        "D1). The narrower activeTab-only shape would drop the host permission entirely and is " +
        "documented there as well.",
    );
    advise(
      "the host permission must not be justified by testability",
      "extension/smoke.mjs and docs/EXTENSION.md currently say the up-front grant is what makes the " +
        "headless round trip testable. That is true, and it is not a justification the store accepts; " +
        "the dashboard copy in docs/WEBSTORE.md deliberately justifies it by the user-facing behaviour " +
        "only.",
    );
  }

  // Implemented: the options page carries the disclosure first, before any field — the hard check above
  // fails if it or its privacy link disappears.
  advise(
    "the in-product disclosure lives in the options page",
    "the User Data FAQ wants it in the product's own UI, and this is the product's own UI; the residual " +
      "is that the options page is not shown automatically, so a notice at the first mount would be the " +
      "stronger form. Judged sufficient: a note exists only after the user's own explicit annotate action.",
  );

  // Judged, not a gap: the hub is a **user-specified** server. The user types the URL, the developer
  // operates no server, and no data reaches the developer. The User Data FAQ answers exactly this case
  // (§15, a client for an internet protocol with user-specified servers), and §16 additionally exempts
  // same-machine traffic, which is where the default `http://127.0.0.1:8787` lives. So the
  // secure-transmission requirement the finding was raised under does not bite.
  advise(
    "plain-http hub endpoints are justified (decision: keep)",
    "endpoint is user-specified and no developer server is involved (User Data FAQ §15); loopback is " +
      "additionally exempt (§16). A soft hint for a non-loopback http:// host stays cheap courtesy, " +
      "not a requirement — not implemented.",
  );
}

/* -------------------------------------------------------------------------- */

console.log("webstore-compliance — Chrome Web Store program policies\n");
const { permissions, hosts } = await checkManifest();
await checkShippedCode();
await checkDashboardCopy(permissions, hosts);
adviseOnOpenQuestions(permissions, hosts);

console.log(
  `\nwebstore-compliance: ${passed + failed} check(s), ${passed} passed, ${failed} failed, ` +
    `${advice} advice note(s)`,
);
if (failed > 0) process.exit(1);
