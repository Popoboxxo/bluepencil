# Privacy policy

**Bluepencil** — the browser extension, the embeddable library, and the optional hub server.
Last updated: 2026-10-02.

Bluepencil is a review tool. It lets a person point at an element on a web page and leave a note about
that element's wording or its appearance, and it lets the set of notes be exported and handed to a
developer or an AI agent. This policy describes what the software handles, why, and what it does with
it. It applies to the Chrome extension and to the library when it is embedded in a page.

## Short version

Bluepencil keeps your notes, and nothing else, in your own browser profile. There is no account, no
server operated by the developer, no analytics and no advertising. Nothing leaves your machine unless
you yourself configure a hub URL and point Bluepencil at it.

## What we collect

"Collect" here means: what the software reads and stores. There is no separate party that receives
data from us.

**Notes you create.** When you annotate an element, the note stores:

- the text you typed,
- the reference to the element the note is attached to (its tag, CSS selector or classes),
- for design notes, the element's computed styles, its position and size, and the current theme and
  viewport,
- the URL of the page the note was taken on, and the time it was taken,
- the author name, if you are using the author mode that asks for one.

**Your settings.** Interface language, the environment badge, which storage mode you chose, and — only
if you enable the hub mode — the hub URL and the credential you entered.

**Your credential, only if you supply one.** If you configure the hub mode, the shared secret or
signed token you paste is kept in the browser's extension storage on your machine.

Bluepencil does **not** collect your browsing history, the pages you visit, your clicks or keystrokes,
your location, health or financial information, or any form data. It has no access to any page you have
not explicitly invoked it on.

## How we use it

The data is used for exactly one thing: showing you your own notes and letting you export them. The
notes are read back to render them on the page and in the notes panel; the settings are read to
configure the interface. Nothing is used for advertising, profiling, ranking, credit assessment or any
other purpose.

Bluepencil does not run analytics or telemetry. It does not measure how you use it.

## What we share

Nothing, by default. In the default storage mode the notes never leave your browser profile and no
network request is made at all.

If you choose the hub mode and enter a URL, the notes you create are sent to **that URL** — a
server you host and control, or one you were given access to. That transmission happens only for the
URL you typed, and the note content is the only thing sent. The developer operates no server and
receives nothing. No data is sold, transferred or disclosed to advertisers, data brokers or any other
third party.

You can point Bluepencil at a local hub (the default, `http://127.0.0.1:8787`), in which case
nothing leaves your computer at all, or at a remote one, in which case the note data travels to that
host. Traffic to a remote host should use HTTPS; a hub on the same computer is not affected by
that requirement.

## Where the data lives, and for how long

Notes and settings are kept in your browser's own storage for the extension, in your browser profile.
They stay there until you delete them: uninstalling the extension removes them, and the notes panel
lets you remove individual notes. If you use the hub mode, the notes also live in the hub's
own store, on a machine you control, for as long as you keep them there.

## Your choices

- Do not invoke Bluepencil on a page: nothing is captured on a page you have not switched it on for.
- Choose the "in this tab only" storage mode: notes are discarded when the tab is reloaded.
- Choose "leave the notes anonymous": no author name is stored.
- Leave the hub mode switched off: nothing is transmitted anywhere.
- Uninstall: the extension's storage is removed with it.

## Security

Note data is kept inside the browser profile. When a hub is used, transmissions to a remote host
are expected to run over HTTPS; a loopback hub needs no transport encryption because the data does
not leave the machine. Credentials are stored in the extension's own storage, are never rendered into
a page, and are sent only to the hub URL you configured. No authentication, payment or financial
information is published or disclosed by this software.

## Children

Bluepencil is a developer and designer tool. It is not directed at children and collects no data from
them.

## Changes

If a future version changes what is collected or how it is used, this page will be updated before that
version is published, and the change will be stated in the release notes.

## Limited Use

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy,
including the Limited Use requirements. Data obtained through the extension's permissions is used only
to provide the single purpose described above (taking and organising review notes on a page the user
has explicitly invoked the tool on), is not transferred to any third party, is never used or
transferred for personalised advertising, and is not read by any human except with the user's explicit
consent, or where required for security or by law.

## Contact

Questions about this policy, or a request concerning your data, can be raised as an issue at
<https://github.com/Popoboxxo/bluepencil/issues>.
