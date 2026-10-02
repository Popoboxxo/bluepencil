# Submitting to the Chrome Web Store

This page is the **only** place the dashboard copy lives, and it exists for one reason: the
*Privacy practices* form, the manifest and the shipped code have to say the same thing. A
justification that describes a permission the manifest no longer requests — or a permission with no
justification at all — is a rejection, and both are silent failures when the three are maintained
apart. `npm run smoke:webstore` checks the three against each other.

Everything in the blocks below is written to be pasted **verbatim**. The character budgets are the
form's own (1,000 per field, 2,048 for the privacy-policy URL) and each block stays well under.

> **Status: not yet compliant.** Four items in [Findings](#findings--decide-before-submitting) need a
> decision before the first submission. Nothing in the manifest's permission set may be justified
> until they are settled, because F1/F2 change what the justification fields have to say.

## How to use this page

1. Settle the findings below. F1 and F2 are manifest changes; F3 and F4 are small UI changes.
2. `npm run build:ext` and upload `extension/dist` (zipped) as a new item.
3. Fill in the **Privacy practices** tab from the copy blocks below.
4. Host `docs/PRIVACY.md` and paste the rendered URL into the *Privacy policy* field. The
   *Limited Use* paragraph must be reachable one click from the project homepage — the README links
   it for exactly that reason.
5. `npm run smoke:webstore` — it fails if the copy and the manifest have drifted apart.

## Compliance at a glance

Checked against the [Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
(read 2026-10-02). Every row is enforced by a `PASS`/`FAIL` in `scripts/webstore-compliance.mjs`
unless it is marked *manual*.

| Policy | Requirement | Status |
| --- | --- | --- |
| Technical → MV3 | Manifest V3, logic self-contained | ✅ `manifest_version: 3` |
| Technical → MV3 §1 | No remote code, no string evaluation | ✅ no `eval`, no `new Function`, no dynamic `import()`, CSP `script-src 'self'` |
| Technical → Code Readability | Not obfuscated | ✅ no packer artefacts; minification only |
| Technical → API Use | Chrome APIs used for their purpose | ✅ `scripting`/`storage`/`activeTab`/`tabs` |
| Privacy → Use of Permissions | Narrowest permission set | ⚠️ see **F1**, **F2** |
| Privacy → Disclosure | In-product disclosure + consent | ⚠️ see **F3** |
| Privacy → Privacy Policy | Accurate policy, posted in the dashboard | ⚠️ see **F5** — `docs/PRIVACY.md` exists, not yet hosted |
| Privacy → Limited Use | Affirmative statement on a project page | ✅ `docs/PRIVACY.md` §Limited Use + README link |
| Privacy → Handling | Secure transmission of user data | ⚠️ see **F4** |
| Quality → Single purpose | One narrow purpose | ✅ annotation layer, one sentence, nothing else |
| Quality → Minimum Functionality | Real, working functionality | ✅ 46-check smoke in a real Chrome |
| Marketing → Ads / Affiliate | No ads, no affiliate injection | ✅ none, and no permission that could inject |
| Marketing → Impersonation | No Chrome/OS mimicry, no fake badges | ✅ name and listing copy avoid both |
| Listing → Requirements | Icon, screenshots, accurate metadata | *manual* — dashboard upload, not code |
| Technical → 2-Step Verification | 2SV enabled on the publisher account | *manual* — account setting |

## Findings — decide before submitting

### F1 — `http://*/*` + `https://*/*` host access is broad (blocker)

**What the code does.** `sw.ts` registers a MAIN-world content script for `http://*/*` and
`https://*/*` (`ensureBootstrapRegistered`), which is why the host permission is declared. The
registration is what keeps the overlay alive when the user navigates within a page they switched the
layer on for.

**Why it is a risk.** "Use of Permissions" asks for the narrowest scope that implements the existing
feature, and the store warns that a host permission gets a thorough review. The reason written down
in this repository (`extension/smoke.mjs`, `docs/EXTENSION.md`) is that the up-front grant is what
makes the round trip testable in a headless browser — **true, and not a justification the store
accepts.** The dashboard copy below therefore justifies it by user-facing behaviour only, which is
also the only honest way to fill that field.

**Two ways out, pick one:**

- **A — keep it, justify it by behaviour.** The text in
  [Justification — host permission](#justification--host-permission) already does this. Fastest, and
  honest; the cost is a slower review and a permission prompt at install.
- **B — drop it (recommended).** Remove `host_permissions`, drop `ensureBootstrapRegistered`, and
  inject `bootstrap.js` + `bridge.js` with `chrome.scripting.executeScript` under the `activeTab`
  grant that the toolbar click already provides (the mount path already does this for the current
  tab — only the *persistent* registration is left). Result: no host permission at all, and `tabs`
  goes with it (F2). Cost: the layer no longer reappears by itself after a navigation; the user
  clicks again. The smoke test's host permission exemption would need rework, since CI loads the
  extension with `Extensions.loadUnpacked` and can drive `executeScript` on a granted tab.

### F2 — `tabs` can be dropped (recommended)

`tabs` unlocks `url`/`title` for tabs the extension has **no host access to**. With `http://*/*` and
`https://*/*` declared, the active tab's URL is readable without it — `chrome.tabs.query` itself never
needed a permission. Everywhere the worker reads `tab.url` (`action.onClicked`, `commands.onCommand`,
the `bluepencil:mount` message) it is either inside the host scope or after an `activeTab` grant.
Requesting it is exactly the "extra permission" the minimum-permission policy is about.

Removing it is a two-line change (`extension/manifest.json`, and the `chrome.tabs` declaration in
`sw.ts` loses nothing). It pairs with **F1 option B**; under **F1 option A** the loopback test host is
still covered by the host permission, so the smoke stays green either way.

### F3 — the in-product disclosure is missing

The User Data FAQ is explicit: the prominent disclosure and the consent must happen **in the
product's UI**, and a store description does not satisfy it. The extension today says nothing about
what it stores before it stores it. A short paragraph plus the privacy-policy link, shown in the
options page and on the first mount, is the standard shape and is enough — the notes are created by
the user's own explicit action, so the consent is a confirmation rather than a gate.

### F4 — a non-loopback `http://` sidecar endpoint transmits in the clear

Loopback is exempt (User Data FAQ §16), so the default `http://127.0.0.1:8787` is fine. The options
page accepts *any* URL, though, and notes sent to a remote `http://` host would travel unencrypted —
which "Handling Requirements" §2 forbids. A warning (or a refusal) for a non-loopback `http://`
endpoint closes it.

### F5 — the privacy policy has to be hosted

A policy is required even though the default store never leaves the browser profile (User Data FAQ
§14). `docs/PRIVACY.md` is written and complete; it needs a URL. GitHub Pages on this repository, or
any page you control, works. The README links it so the *Limited Use* statement is one click from the
project homepage, which is what "Limited Use" §6 asks for.

## Copy for the *Privacy practices* tab

### **Data usage**

Recommended, with the reasoning — this is the one place where under-ticking is the dangerous
direction (the FAQ treats a dashboard/policy/behaviour mismatch as a violation):

| Category | Tick? | Why |
| --- | --- | --- |
| **Website content** | ✅ yes | A note stores the annotated element's text, its CSS selector/classes and computed styles, and the page URL. This is the *content* of a page the user explicitly annotated. |
| **Personally identifiable information** | ✅ yes | With the default *"ask me once, then remember"* author mode a note carries the name the user typed. |
| **Authentication information** | ✅ yes | If the user configures a sidecar, the credential they paste is kept in `chrome.storage.local`. |
| **Web history** | ❌ no | The extension builds no list of visited pages. It records one URL per note the user chose to create, which is covered by *Website content*. If a reviewer reads `route: "url"` strictly, ticking this too is the safe over-disclosure — but it is not what the code does. |
| Personal communications | ❌ no | No mail, SMS or chat. |
| Health, Financial, Location | ❌ no | Never touched. |
| User activity | ❌ no | No clicks/keystrokes/scroll telemetry. The annotation is user-initiated, not measured. |

**The three certifications** — all three are true and all three must be ticked:

- *"I do not sell or transfer user data to third parties, outside of the approved use cases"* — there
  are no third parties. The only outbound path is the sidecar URL the **user** configured, and it is
  optional and off by default.
- *"I do not use or transfer user data for purposes that are unrelated to my item's single purpose"* —
  the single purpose is taking review notes; nothing else reads the data.
- *"I do not use or transfer user data to determine creditworthiness or for lending purposes"* — not
  applicable in any way.

### **Single purpose description**

```
Bluepencil adds a review layer to a web page so that a reviewer can point at any element and leave a
note about its content or its appearance.

When you click the toolbar button (or press Alt+Shift+B) on a page, the extension injects an
annotation overlay into that page only. You click an element and type a note; the note is anchored to
that element and kept in your browser profile, so a set of notes can later be exported as Markdown or
JSON and handed to a developer or an AI agent to work off.

That is the extension's entire purpose: taking and organising review notes on a page you are already
looking at. It has no other feature — it does not block ads, manage tabs, change your search engine,
track your browsing or collect analytics. It runs only on the tab you invoke it on, and only while you
are looking at that page.
```

### Permission justifications

Each block answers: *why this permission and not a narrower one.* Keep the permission names visible —
`npm run smoke:webstore` fails if a permission in the manifest has no block that names it.

#### **Justification — `scripting`**

```
chrome.scripting injects the extension's annotation overlay into the page the user chose to annotate.
Two files and one function are injected, all into the active tab only:

1. the review layer itself, into the page's own JavaScript world (a custom element can only be
   registered there — in an isolated world the customElements registry is null);
2. a small relay script that carries messages between the page and the extension's service worker;
3. a function that hands the layer the user's settings.

chrome.scripting is also what switches the overlay off again on the same tab. Both injection calls run
only after an explicit user action — the toolbar button or the Alt+Shift+B keyboard shortcut. No other
tab and no other page is touched.
```

#### **Justification — `storage`**

```
chrome.storage.local holds two things, both inside the user's own browser profile and never synced:

1. the extension's settings — interface language, the environment badge, which notes store to use, and
   (only if the user opts into the sidecar mode) the sidecar URL and the credential the user entered;
2. the review notes the user creates, in the default store mode, so that notes taken on a page are
   still there on the next visit and are visible across tabs.

Nothing in chrome.storage.local is transmitted anywhere unless the user explicitly switches the notes
store to a sidecar URL they supply themselves. There is no server, no account and no telemetry.
```

#### **Justification — `activeTab`**

```
activeTab is the extension's core privacy property. The annotation overlay is injected only into the
tab the user is actively looking at, and only as the result of an explicit action — a toolbar click or
the Alt+Shift+B keyboard shortcut. The grant expires when the user navigates away.

Without activeTab the extension would have to hold standing access to every tab in order to decide on
its own when to annotate. It deliberately does not work that way: access is per-tab, granted by the
user, and temporary.
```

#### **Justification — `tabs`**

```
The extension reads the currently active tab so that a note can record which page it was taken on:
chrome.tabs.query({ active: true, currentWindow: true }) returns the tab id the overlay is injected
into, and its URL is stored with the note so an exported note set names its source page.

It never lists, searches or enumerates other tabs, and it never reads a tab's URL in the background —
the query runs only in response to the user invoking the extension.
```

#### **Justification — host permission**

```
http://*/* and https://*/* are required for the registration of one small content script that must run
in the page's own JavaScript world. That registration is what keeps the annotation overlay alive when
the user navigates within a page they have switched the layer on for; without it the overlay would
simply disappear on the first navigation and the user's notes would appear to be lost.

The script does nothing until the user has invoked the extension on that tab: it waits for a
configuration object that the extension writes only after the user clicks the toolbar button. Access
is limited to http and https — file://, ftp:// and chrome:// are not requested, and <all_urls> is not
used.
```

### **Remote code**

Select **"No, I am not using remote code."** This is verifiable and verified: the shipped JavaScript
contains no `eval`, no `new Function`, no dynamic `import()`, and the extension pages run under
`script-src 'self'`. Everything the overlay executes is bundled into the package; the only thing that
crosses a process boundary at runtime is the user's settings object, which is data.

The justification field is not required for a "No" answer. If a reviewer asks, the one line is:

```
All logic ships inside the package. The extension's own build inlines the review layer into the
content script that is registered in the page's world; no code is fetched or evaluated at runtime. The
only network call in the package belongs to the optional sidecar adapter, which the user configures
themselves, and it exchanges note data — never code.
```

### **Privacy policy URL**

Paste the public URL of `docs/PRIVACY.md` (rendered, e.g. via GitHub Pages — a raw text URL works but
reads poorly). Suggested: `https://<host>/bluepencil/privacy`. The policy must stay reachable for as
long as the item is published.

## Listing copy

Keep the listing consistent with the privacy fields; a description that contradicts the dashboard is
itself a violation ("Listing Requirements" §3). Both blocks below state plainly what the extension
does *and* what it stores, which also covers the requirement that the set of promised functionalities
be clear before installation ("Deceptive Installation Tactics" §1).

**Short description** (the manifest `description`, ≤132 characters):

```
Annotate and review any page: design and text notes, kept across tabs and sites.
```

**Detailed description:**

```
Bluepencil turns any web page into a review surface. Click the toolbar button (or press Alt+Shift+B),
click the element you want to talk about, and leave a note — about the wording, or about how it looks.
The note is anchored to that element, so it survives a later edit elsewhere on the page.

Notes can be exported as Markdown or JSON and handed to a developer or an AI coding agent, which can
read a whole review round and work it off.

WHAT IT STORES
• The notes you create: the text you type, which element it is attached to, and the page it was taken
  on.
• Your settings: interface language, environment badge, and the notes store you picked.
• If you switch on the optional sidecar mode: the URL you entered and the credential you pasted. Both
  stay in your browser profile, and both are only ever sent to the URL you supplied.

WHAT IT DOES NOT DO
• No account, no sign-up, no analytics, no telemetry.
• No ads and no affiliate links.
• No browsing history: it never records the pages you visit, only the page a note was made on.
• Nothing runs until you click — the extension does not touch a page you have not invoked it on.

The default store keeps your notes in the browser profile. Nothing leaves your machine unless you
configure a sidecar yourself.

Privacy policy: <URL of docs/PRIVACY.md>
```

## The *Limited Use* statement

The policy asks for an affirmative statement on a page belonging to the extension ("Limited Use" §6).
`docs/PRIVACY.md` carries it, and the README links that page. The sentence that has to appear:

```
The use of information received from Google APIs will adhere to the Chrome Web Store User Data
Policy, including the Limited Use requirements.
```

## Checklist before the first submission

- [ ] **F1** decided (keep + justify, or drop the host permission)
- [ ] **F2** `tabs` removed from the manifest (pairs with F1-B)
- [ ] **F3** in-product disclosure added (options page + first mount)
- [ ] **F4** non-loopback `http://` endpoint warned about or refused
- [ ] **F5** `docs/PRIVACY.md` hosted and linked from the README
- [ ] `npm run build:ext` and `npm run smoke:ext` green on the exact zip that is uploaded
- [ ] `npm run smoke:webstore` green (manifest ↔ dashboard copy ↔ shipped code in step)
- [ ] Icon, screenshots and category filled in the dashboard ("Listing Requirements" §1)
- [ ] 2-Step Verification enabled on the publisher account ("2-Step Verification" §1)
- [ ] Contact e-mail address in the developer account is correct and reachable (Best Practices §7)

## Where these rules come from

- [Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies) — read 2026-10-02
- [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) — read 2026-10-02
- [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) — read 2026-10-02

Policies change and the developer is responsible for keeping up (Best Practices §10). When a policy
section moves, update this page and `scripts/webstore-compliance.mjs` together — the check names the
clause it enforces so the two can be compared.
