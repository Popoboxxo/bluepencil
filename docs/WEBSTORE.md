# Submitting to the Chrome Web Store

This page is the **only** place the dashboard copy lives, and it exists for one reason: the
*Privacy practices* form, the manifest and the shipped code have to say the same thing. A
justification that describes a permission the manifest no longer requests — or a permission with no
justification at all — is a rejection, and both are silent failures when the three are maintained
apart. `npm run smoke:webstore` checks the three against each other.

Everything in the blocks below is written to be pasted **verbatim**. The character budgets are the
form's own (1,000 per field, 2,048 for the privacy-policy URL) and each block stays well under.

> **Status: submittable.** The decisions below are taken — the host permission is kept and justified,
> `tabs` is gone, the in-product disclosure is in the options page, and the plain-http hub endpoint
> is justified rather than a gap. What is left is mechanical: enable Pages once, then fill the form
> from the blocks below.

## How to use this page

1. Enable GitHub Pages once: *Settings → Pages → Deploy from a branch*, branch `gh-pages`, folder `/`.
   `.github/workflows/pages.yml` builds the site and publishes it there; the branch appears with the
   first run, and the first run needs the workflow on `main`.
2. `npm run build:ext` and upload `extension/dist` (zipped) as a new item.
3. Fill in the **Privacy practices** tab from the copy blocks below.
4. Paste `https://popoboxxo.github.io/bluepencil/privacy/` into the *Privacy policy* field. The
   *Limited Use* paragraph is on that page, and the README links `docs/PRIVACY.md`, so the statement is
   one click from the project homepage as well.
5. `npm run smoke:webstore` — it fails if the copy, the manifest and the shipped code have drifted
   apart.

## Compliance at a glance

Checked against the [Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
(read 2026-10-02). Every row is enforced by a `PASS`/`FAIL` in `scripts/webstore-compliance.mjs`
unless it is marked *manual*.

| Policy | Requirement | Status |
| --- | --- | --- |
| Technical → MV3 | Manifest V3, logic self-contained | ✅ `manifest_version: 3` |
| Technical → MV3 §1 | No remote code, no string evaluation | ✅ no `eval`, no `new Function`, no dynamic `import()`, CSP `script-src 'self'` |
| Technical → Code Readability | Not obfuscated | ✅ no packer artefacts; minification only |
| Technical → API Use | Chrome APIs used for their purpose | ✅ `scripting`/`storage`/`activeTab` only |
| Privacy → Use of Permissions | Narrowest permission set | ✅ `tabs` dropped (D2), host access kept and justified by behaviour (D1) |
| Privacy → Disclosure | In-product disclosure + consent | ✅ options page, before any field; checked + contrast-measured |
| Privacy → Privacy Policy | Accurate policy, posted in the dashboard | ✅ `docs/PRIVACY.md`, published at `/privacy/` (live) |
| Privacy → Limited Use | Affirmative statement on a project page | ✅ live at `/privacy/` + linked from the README |
| Privacy → Handling | Secure transmission of user data | ✅ hub endpoint is user-specified (FAQ §15), loopback exempt (§16) |
| Quality → Single purpose | One narrow purpose | ✅ annotation layer, one sentence, nothing else |
| Quality → Minimum Functionality | Real, working functionality | ✅ 47-check smoke in a real Chrome |
| Marketing → Ads / Affiliate | No ads, no affiliate injection | ✅ none, and no permission that could inject |
| Marketing → Impersonation | No Chrome/OS mimicry, no fake badges | ✅ name and listing copy avoid both |
| Listing → Requirements | Icon, screenshots, accurate metadata | *manual* — dashboard upload, not code |
| Technical → 2-Step Verification | 2SV enabled on the publisher account | *manual* — account setting |

## Decisions taken

All four are settled. Each names the evidence, because the next person to touch the manifest or the
options page has to know *why* it looks the way it does — otherwise the first well-meaning cleanup
undoes it.

### D1 — the `http(s)://*/*` host permission stays, justified by behaviour

**Decision: keep.** The registration in `sw.ts` (`ensureBootstrapRegistered`) is what keeps the overlay
alive when the user navigates within a page they switched the layer on for; without it the user's notes
would look lost on the first navigation. The dashboard text below justifies the permission by exactly
that user-facing behaviour, and by nothing else.

**What must not be written in the form.** `extension/smoke.mjs` and `docs/EXTENSION.md` say the
up-front grant is what makes the round trip testable in a headless browser. That is true, and it is not
a justification the store accepts — "Use of Permissions" is about the feature, not the test. The
justification block deliberately does not repeat it. The cost of this choice is a slower review, which
is the honest trade.

### D2 — `tabs` is gone

**Decision: removed from the manifest.** It was needed by nothing:

- `chrome.tabs.query` and `tab.id` never required a permission.
- `tab.url` only ever fed the `tabUrl` field of the mount configuration, and nothing reads that field:
  the page a note belongs to comes from the element's own `route="url"`, which reads the page's
  `location.href` **in the page itself**.
- For the tabs that remain in scope, the `http(s)://*/*` host permission already grants `url`.

It is not needed by the on/off switch either: the options page asks the worker over
`chrome.runtime.sendMessage` and never touches `chrome.tabs` (the `wireToggle` declaration in
`options.ts` says so, and the code does not lie). `npm run smoke:webstore` fails if `tabs` comes back,
and `sw.ts` records the reasoning next to the `chrome.tabs` declaration, so the decision is visible
where a future reader would look.

### D3 — the in-product disclosure is in the options page

**Decision: implemented.** `extension/options.html` opens with a *What Bluepencil stores* section,
before any field: it names the categories that are actually stored (the notes, the settings, and — only
in hub mode — the URL plus credential), says what is *not* touched, and links the policy. The
compliance check fails if the block or its link disappears, and `npm run smoke:ext` measures its
contrast in both colour schemes.

The residual, stated rather than hidden: the options page is not shown automatically, so a notice at the
first mount would be the stronger form of "before user data is handled". Judged sufficient, because a
note only ever exists after the user's own explicit annotate action.

### D4 — the plain-http hub endpoint is justified, not a gap

**Decision: keep.** The hub is a **user-specified** server: the user types the URL, the developer
operates no server, and no data reaches the developer. The User Data FAQ answers exactly that shape
(§15, a client for an internet protocol with user-specified servers) — the Limited Use section and the
secure-transmission requirement do not apply to traffic with the user's own server — and §16 additionally
exempts same-machine traffic, which is where the default `http://127.0.0.1:8787` lives. So
"Handling Requirements" §2 does not bite. A soft hint for a non-loopback `http://` host would still be
cheap courtesy; it is not a requirement, and is not implemented.

### D5 — the policy is published, from one source

`docs/PRIVACY.md` is the single source. `scripts/build-site.mjs` (`npm run build:site`) renders it into
`site/privacy/index.html` plus a one-screen landing page, and `.github/workflows/pages.yml` publishes
`site/` to the `gh-pages` branch — so there is no second prose copy of the policy that can drift away
from the dashboard fields. The workflow greps the rendered page for the *Limited Use* sentence before
publishing, so a render that lost the paragraph stops instead of being served.

**It is live, not a plan:** Pages is enabled on this repository with source `gh-pages`, and

    https://popoboxxo.github.io/bluepencil/privacy/

returns the policy (verified: 200, and the Limited Use sentence is in the page).

## Copy for the *Privacy practices* tab

### **Data usage**

Recommended, with the reasoning — this is the one place where under-ticking is the dangerous
direction (the FAQ treats a dashboard/policy/behaviour mismatch as a violation):

| Category | Tick? | Why |
| --- | --- | --- |
| **Website content** | ✅ yes | A note stores the annotated element's text, its CSS selector/classes and computed styles, and the page URL. This is the *content* of a page the user explicitly annotated. |
| **Personally identifiable information** | ✅ yes | With the default *"ask me once, then remember"* author mode a note carries the name the user typed. |
| **Authentication information** | ✅ yes | If the user configures a hub, the credential they paste is kept in `chrome.storage.local`. |
| **Web history** | ❌ no | The extension builds no list of visited pages. It records one URL per note the user chose to create, which is covered by *Website content*. If a reviewer reads `route: "url"` strictly, ticking this too is the safe over-disclosure — but it is not what the code does. |
| Personal communications | ❌ no | No mail, SMS or chat. |
| Health, Financial, Location | ❌ no | Never touched. |
| User activity | ❌ no | No clicks/keystrokes/scroll telemetry. The annotation is user-initiated, not measured. |

**The three certifications** — all three are true and all three must be ticked:

- *"I do not sell or transfer user data to third parties, outside of the approved use cases"* — there
  are no third parties. The only outbound path is the hub URL the **user** configured, and it is
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
   (only if the user opts into the hub mode) the hub URL and the credential the user entered;
2. the review notes the user creates, in the default store mode, so that notes taken on a page are
   still there on the next visit and are visible across tabs.

Nothing in chrome.storage.local is transmitted anywhere unless the user explicitly switches the notes
store to a hub URL they supply themselves. There is no server, no account and no telemetry.
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

Not requested. The manifest no longer contains it, so the form will not show a field for it, and
`npm run smoke:webstore` fails if anyone adds it back. Kept here because the *reason* is the part that
gets lost: nothing reads a tab URL. The worker's `chrome.tabs.query` and `tab.id` never needed a
permission, `tab.url` fed only a configuration field nothing consumes (the note's page comes from the
element's own `route="url"` in the page), and the http/https host permission covers the URL of every tab
that matters anyway. See **D2**.

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
only network call in the package belongs to the optional hub adapter, which the user configures
themselves, and it exchanges note data — never code.
```

### **In-product disclosure** (not a dashboard field)

Required by "Disclosure Requirements" §2 and User Data FAQ §10: the prominent disclosure and the consent
have to happen **in the product's own UI**, and the FAQ says a store description does not satisfy it.
This is the copy that ships in `extension/options.html`, as the first thing on the page — before any
field, because "before" is the requirement:

```
What Bluepencil stores

Everything stays in this browser profile unless you point Bluepencil at a hub URL of your own.

- The notes you create — the text you type, the element each note is anchored to, and the page it was
  taken on.
- The settings on this page, and — only if you switch the notes store to a hub — the URL you enter
  and the credential you paste.
- Nothing else: no account, no analytics, no ads, and no browsing history.

A note is sent only to the hub URL you enter yourself; with the default store nothing leaves your
machine. Privacy policy: https://popoboxxo.github.io/bluepencil/privacy/
```

If the wording is ever changed, change it in `extension/options.html` too — `npm run smoke:webstore`
checks the options page itself, not this page, and the two failing to agree is exactly the
behaviour/declaration mismatch the store rejects.

### **Privacy policy URL**

```
https://popoboxxo.github.io/bluepencil/privacy/
```

That is the rendered `docs/PRIVACY.md`, published by `.github/workflows/pages.yml` from a single source
(see **D5**). It must stay reachable for as long as the item is published; the workflow re-publishes it
whenever the policy changes, and it greps the rendered page for the *Limited Use* sentence before
publishing, so a half-rendered page cannot be served.

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
• If you switch on the optional hub mode: the URL you entered and the credential you pasted. Both
  stay in your browser profile, and both are only ever sent to the URL you supplied.

WHAT IT DOES NOT DO
• No account, no sign-up, no analytics, no telemetry.
• No ads and no affiliate links.
• No browsing history: it never records the pages you visit, only the page a note was made on.
• Nothing runs until you click — the extension does not touch a page you have not invoked it on.

The default store keeps your notes in the browser profile. Nothing leaves your machine unless you
configure a hub yourself.

Privacy policy: https://popoboxxo.github.io/bluepencil/privacy/
```

## The *Limited Use* statement

The policy asks for an affirmative statement on a page belonging to the extension ("Limited Use" §6).
`docs/PRIVACY.md` carries it, and the README links that page. The sentence that has to appear:

```
The use of information received from Google APIs will adhere to the Chrome Web Store User Data
Policy, including the Limited Use requirements.
```

## Checklist before the first submission

- [ ] **D1** decided: host permission kept, justified by behaviour only (never by testability)
- [ ] **D2** `tabs` removed from the manifest — and still absent (`npm run smoke:webstore`)
- [ ] **D3** in-product disclosure in the options page, and its wording matches this page
- [ ] **D4** plain-http endpoint justified, not changed (FAQ §15/§16)
- [ ] **D5** Pages serving `https://popoboxxo.github.io/bluepencil/privacy/` (it is, as of 2026-10-02)
- [ ] `npm run build:ext` and `npm run smoke:ext` green on the exact zip that is uploaded
- [ ] `npm run smoke:webstore` green (manifest ↔ dashboard copy ↔ shipped code ↔ options page in step)
- [ ] Icon, screenshots and category filled in the dashboard ("Listing Requirements" §1)
- [ ] The short-description field matches the manifest's `description` (the block in "Listing copy")
- [ ] 2-Step Verification enabled on the publisher account ("2-Step Verification" §1)
- [ ] Contact e-mail address in the developer account is correct and reachable (Best Practices §7)

## Where these rules come from

- [Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies) — read 2026-10-02
- [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) — read 2026-10-02
- [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) — read 2026-10-02

Policies change and the developer is responsible for keeping up (Best Practices §10). When a policy
section moves, update this page and `scripts/webstore-compliance.mjs` together — the check names the
clause it enforces so the two can be compared.
