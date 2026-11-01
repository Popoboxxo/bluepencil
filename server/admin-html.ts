/**
 * The admin page, rendered from one typed string table (`server/admin-i18n.ts`) — plain HTML/JS, no
 * build step, no client dependency, no second origin.
 *
 * What this page is, and what it deliberately is not:
 *
 * - **One secret.** The hub's admin secret (`--admin-secret`) is sent as `x-bluepencil-admin`; the
 *   ordinary notes and journal routes accept the same value as `x-bluepencil-auth`, so the
 *   operator types exactly one credential and the page never asks for the hub's client secret.
 * - **Memory by default.** The secret lives in a closure variable for as long as the page is open.
 *   Writing it to `sessionStorage` is opt-in ("Remember in this tab"): only then is a reload able to
 *   reconnect without re-entry, and the page warns next to the box that any same-origin script can
 *   read a remembered secret. A failed connect clears both the in-memory value and the stored one.
 * - **The minted token persists.** `#mint-result` is not hidden by the device-list refresh that
 *   follows a mint: the token stays visible, selectable and copyable until the operator dismisses
 *   it, reloads the device list, or mints another one. The hub keeps the id, not the token.
 * - **The notes bridge.** Notes are edited through the existing notes API with the admin secret;
 *   there is exactly one note implementation in this repository.
 * - **i18n (FR-11.1).** Every user-visible string comes from `AdminStrings` (`en`/`de`), selected by
 *   the request's `Accept-Language` through `adminLanguage()`. The runtime table is injected as a
 *   JSON value with `<` (and U+2028/U+2029) escaped, so no translation can close the script element.
 * - **CSS contract.** Every class is `bp-` prefixed and every custom property is `--bp-*`. The page
 *   is standalone and loads no external resource.
 * - **XSS-safe rendering.** Static labels are escaped when interpolated into the template; rows that
 *   carry hub data (notes, devices, activity) are built with `document.createElement` +
 *   `textContent`, never concatenated HTML.
 */
import { ADMIN_STRINGS, type AdminStrings } from "./admin-i18n";

/** Escapes a string for HTML text and quoted attributes, including the single quote. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serializes the string table for the page's `<script>`. `<` is escaped so a value containing
 * `</script>` cannot end the element; U+2028/U+2029 are escaped because they are line terminators
 * in JavaScript source but legal JSON.
 */
function scriptJson(value: unknown): string {
  const json = JSON.stringify(value) ?? "null";
  return json
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Renders the complete admin page in the given language. One template, no runtime dependencies:
 * `server/admin.ts` calls this per request with `ADMIN_STRINGS[adminLanguage(header)]`.
 */
export function renderAdminHtml(strings: AdminStrings): string {
  const s = strings;
  return `<!doctype html>
<html lang="${escapeHtml(s.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(s.title)}</title>
<style>
  :root { color-scheme: light dark; --bp-bg:#fbfbfd; --bp-fg:#1c1c1f; --bp-muted:#61616a; --bp-line:#e3e3ea;
          --bp-card:#fff; --bp-accent:#2f5fd0; --bp-danger:#b3261e; --bp-ok:#1a7f37; --bp-warn:#8a6d00; }
  @media (prefers-color-scheme: dark) {
    :root { --bp-bg:#16161a; --bp-fg:#ececf1; --bp-muted:#9a9aa6; --bp-line:#2c2c34; --bp-card:#1d1d22;
            --bp-accent:#7aa2f7; --bp-danger:#f28b82; --bp-ok:#81c995; --bp-warn:#e0b000; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bp-bg); color:var(--bp-fg); font:15px/1.5 system-ui, sans-serif; }
  main { max-width: 920px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
  h1 { font-size: 1.2rem; margin: 0 0 .25rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
  .bp-muted { color: var(--bp-muted); font-size: .9rem; }
  .bp-card { background: var(--bp-card); border: 1px solid var(--bp-line); border-radius: 10px; padding: 1rem; margin: .75rem 0; }
  input, select, button { font: inherit; padding: .45rem .6rem; border-radius: 8px; border: 1px solid var(--bp-line);
                          background: var(--bp-card); color: var(--bp-fg); }
  input:focus-visible, select:focus-visible { outline: 2px solid var(--bp-accent); outline-offset: 1px; }
  button:focus-visible { outline: 2px solid var(--bp-accent); outline-offset: 2px; }
  button { cursor: pointer; }
  button.bp-primary { background: var(--bp-accent); border-color: var(--bp-accent); color: #fff; }
  @media (prefers-color-scheme: dark) { button.bp-primary { color: #10101a; } }
  button.bp-danger { color: var(--bp-danger); border-color: var(--bp-danger); background: transparent; }
  .bp-tabs { display:flex; gap:.5rem; flex-wrap:wrap; margin:1rem 0; }
  .bp-tabs button[aria-selected="true"] { border-color: var(--bp-accent); color: var(--bp-accent); font-weight:600; }
  table { width:100%; border-collapse: collapse; font-size: .92rem; }
  th, td { text-align:left; padding:.4rem .5rem; border-bottom:1px solid var(--bp-line); vertical-align: top; }
  th { color: var(--bp-muted); font-weight:600; }
  code, .bp-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; }
  .bp-status { margin-left:.6rem; font-size:.9rem; }
  .bp-status[data-kind="ok"] { color: var(--bp-ok); }
  .bp-status[data-kind="error"] { color: var(--bp-danger); }
  .bp-status[data-kind="busy"] { color: var(--bp-muted); }
  .bp-row { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; margin:.5rem 0; }
  .bp-pill { display:inline-block; padding:.05rem .5rem; border:1px solid var(--bp-line); border-radius:999px;
             font-size:.8rem; color:var(--bp-muted); }
  .bp-pill.bp-revoked { color: var(--bp-danger); border-color: var(--bp-danger); }
  .bp-pill.bp-live { color: var(--bp-ok); border-color: var(--bp-ok); }
  .bp-banner { border:1px solid var(--bp-warn); color:var(--bp-warn); border-radius:8px; padding:.5rem .75rem; margin:.75rem 0; }
  .bp-secret-wrap { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; }
  .bp-kv { display:grid; grid-template-columns: max-content 1fr; gap:.35rem .75rem; margin:0; }
  .bp-kv dt { color: var(--bp-muted); font-weight:600; }
  .bp-kv dd { margin:0; }
  .bp-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden;
                clip:rect(0 0 0 0); white-space:nowrap; border:0; }
  #login { max-width: 30rem; }
  #token-value { flex: 1 1 22rem; min-width: 12rem; }
</style>
</head>
<body>
<main>
  <h1>Bluepencil <span class="bp-muted">${escapeHtml(s.brandAdmin)}</span></h1>
  <p class="bp-muted" id="conn-line">${escapeHtml(s.notConnected)}</p>

  <section id="login" class="bp-card">
    <h2>${escapeHtml(s.connectHeading)}</h2>
    <p class="bp-muted">${escapeHtml(s.connectHelp)}</p>
    <div class="bp-secret-wrap">
      <input type="password" id="secret" placeholder="${escapeHtml(s.secretPlaceholder)}" aria-label="${escapeHtml(s.secretLabel)}" autocomplete="off" size="28">
      <button type="button" class="bp-primary" id="connect">${escapeHtml(s.connectButton)}</button>
    </div>
    <div class="bp-row">
      <label class="bp-muted"><input type="checkbox" id="remember"> ${escapeHtml(s.rememberLabel)}</label>
    </div>
    <p class="bp-muted">${escapeHtml(s.rememberWarning)}</p>
    <span class="bp-status" id="login-status" role="status" aria-live="polite"></span>
  </section>

  <section id="app" hidden>
    <div class="bp-banner" id="app-warning" hidden></div>
    <nav class="bp-tabs" role="tablist" aria-label="${escapeHtml(s.sectionsLabel)}">
      <button type="button" role="tab" id="tab-overview" data-tab="overview" aria-controls="panel-overview" aria-selected="true" tabindex="0">${escapeHtml(s.tabOverview)}</button>
      <button type="button" role="tab" id="tab-notes" data-tab="notes" aria-controls="panel-notes" aria-selected="false" tabindex="-1">${escapeHtml(s.tabNotes)}</button>
      <button type="button" role="tab" id="tab-devices" data-tab="devices" aria-controls="panel-devices" aria-selected="false" tabindex="-1">${escapeHtml(s.tabDevices)}</button>
      <button type="button" role="tab" id="tab-activity" data-tab="activity" aria-controls="panel-activity" aria-selected="false" tabindex="-1">${escapeHtml(s.tabActivity)}</button>
    </nav>

    <section role="tabpanel" id="panel-overview" aria-labelledby="tab-overview" tabindex="0" data-view="overview">
      <div class="bp-card" id="overview-card"></div>
    </section>

    <section role="tabpanel" id="panel-notes" aria-labelledby="tab-notes" tabindex="0" data-view="notes" hidden>
      <h2>${escapeHtml(s.notesHeading)}</h2>
      <div class="bp-row">
        <input id="note-body" placeholder="${escapeHtml(s.notePlaceholder)}" aria-label="${escapeHtml(s.noteLabel)}" size="38">
        <input id="note-route" placeholder="${escapeHtml(s.routePlaceholder)}" aria-label="${escapeHtml(s.routeLabel)}" size="16">
        <button type="button" class="bp-primary" id="note-create">${escapeHtml(s.addButton)}</button>
        <button type="button" id="notes-reload">${escapeHtml(s.reloadButton)}</button>
      </div>
      <span class="bp-status" id="notes-status" role="status" aria-live="polite"></span>
      <table>
        <thead><tr>
          <th scope="col">${escapeHtml(s.colBody)}</th>
          <th scope="col">${escapeHtml(s.colRoute)}</th>
          <th scope="col">${escapeHtml(s.colStatus)}</th>
          <th scope="col">${escapeHtml(s.colAuthor)}</th>
          <th scope="col"><span class="bp-sr-only">${escapeHtml(s.colActions)}</span></th>
        </tr></thead>
        <tbody id="notes-body-rows"></tbody>
      </table>
    </section>

    <section role="tabpanel" id="panel-devices" aria-labelledby="tab-devices" tabindex="0" data-view="devices" hidden>
      <h2>${escapeHtml(s.devicesHeading)}</h2>
      <div class="bp-banner" id="token-warning" hidden></div>
      <div class="bp-row">
        <input id="device-name" placeholder="${escapeHtml(s.deviceNamePlaceholder)}" aria-label="${escapeHtml(s.deviceNameLabel)}" maxlength="200" size="22">
        <select id="device-scope" aria-label="${escapeHtml(s.scopeLabel)}">
          <option value="read write">${escapeHtml(s.scopeReadWrite)}</option>
          <option value="read">${escapeHtml(s.scopeReadOnly)}</option>
        </select>
        <input id="device-ttl" type="number" min="1" max="365" step="1" placeholder="${escapeHtml(s.deviceTtlPlaceholder)}" aria-label="${escapeHtml(s.deviceTtlLabel)}" size="7">
        <button type="button" class="bp-primary" id="device-mint">${escapeHtml(s.mintButton)}</button>
        <button type="button" id="devices-reload">${escapeHtml(s.reloadButton)}</button>
      </div>
      <span class="bp-status" id="devices-status" role="status" aria-live="polite"></span>
      <div class="bp-card" id="presence-card" aria-labelledby="presence-heading">
        <h2 id="presence-heading">${escapeHtml(s.presenceHeading)}</h2>
        <p class="bp-muted">${escapeHtml(s.presenceHelp)}</p>
        <dl class="bp-kv" id="presence-rows"></dl>
      </div>
      <div class="bp-card" id="mint-result" hidden aria-labelledby="mint-heading">
        <h2 id="mint-heading"></h2>
        <p class="bp-muted">${escapeHtml(s.tokenHelp)}</p>
        <div class="bp-row">
          <input id="token-value" type="text" readonly autocomplete="off" spellcheck="false" aria-label="${escapeHtml(s.tokenLabel)}" size="48">
          <button type="button" class="bp-primary" id="copy-token">${escapeHtml(s.copyButton)}</button>
          <button type="button" id="dismiss-token">${escapeHtml(s.dismissButton)}</button>
        </div>
        <span class="bp-status" id="token-status" role="status" aria-live="polite"></span>
      </div>
      <table>
        <thead><tr>
          <th scope="col">${escapeHtml(s.colDevice)}</th>
          <th scope="col">${escapeHtml(s.colScope)}</th>
          <th scope="col">${escapeHtml(s.colIssued)}</th>
          <th scope="col">${escapeHtml(s.colExpires)}</th>
          <th scope="col">${escapeHtml(s.colState)}</th>
          <th scope="col">${escapeHtml(s.colJti)}</th>
          <th scope="col"><span class="bp-sr-only">${escapeHtml(s.colActions)}</span></th>
        </tr></thead>
        <tbody id="devices-rows"></tbody>
      </table>
      <p class="bp-muted" id="devices-note">${escapeHtml(s.devicesInventoryNote)}</p>
    </section>

    <section role="tabpanel" id="panel-activity" aria-labelledby="tab-activity" tabindex="0" data-view="activity" hidden>
      <h2>${escapeHtml(s.activityHeading)}</h2>
      <p class="bp-muted">${escapeHtml(s.activityHelp)}</p>
      <button type="button" id="activity-reload">${escapeHtml(s.reloadButton)}</button>
      <span class="bp-status" id="activity-status" role="status" aria-live="polite"></span>
      <table>
        <thead><tr>
          <th scope="col">${escapeHtml(s.colWhen)}</th>
          <th scope="col">${escapeHtml(s.colWho)}</th>
          <th scope="col">${escapeHtml(s.colWhat)}</th>
        </tr></thead>
        <tbody id="activity-rows"></tbody>
      </table>
    </section>
  </section>
</main>
<script>
(function () {
  'use strict';
  var T = ${scriptJson(s)};
  var KEY = 'bluepencil-admin-secret';
  var memorySecret = '';
  var pathName = location.pathname;
  var adminIndex = pathName.lastIndexOf('/admin');
  var BASE = adminIndex === -1 ? '' : pathName.slice(0, adminIndex);
  var el = function (id) { return document.getElementById(id); };

  function readStored() {
    try { return sessionStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }
  function writeStored(value) {
    try { sessionStorage.setItem(KEY, value); } catch (e) { /* storage unavailable */ }
  }
  function clearStored() {
    try { sessionStorage.removeItem(KEY); } catch (e) { /* storage unavailable */ }
  }

  // The secret the page sends: the closure, never a DOM value read on every call.
  function secret() { return memorySecret; }

  function say(id, message, kind) {
    var node = el(id);
    if (!node) return;
    node.textContent = message || '';
    if (!kind) { node.removeAttribute('data-kind'); } else { node.dataset.kind = kind; }
  }

  function fmt(template, vars) {
    return String(template).replace(/{([A-Za-z0-9_]+)}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match;
    });
  }

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDate(value) {
    var text = String(value === undefined || value === null ? '' : value);
    return text ? text.slice(0, 19).replace('T', ' ') : '—';
  }

  async function call(path, init) {
    var headers = { 'x-bluepencil-admin': secret(), 'Content-Type': 'application/json' };
    // The notes and journal are the ordinary API routes; the admin secret doubles as their
    // credential, so this page never needs the hub's own secret.
    if (path.indexOf('/admin') === -1) { headers['x-bluepencil-auth'] = secret(); }
    var response = await fetch(BASE + path, Object.assign({ headers: headers }, init || {}));
    var text = await response.text();
    var body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    if (!response.ok) {
      var message = body && body.error && body.error.message ? body.error.message : 'HTTP ' + response.status;
      throw new Error(message);
    }
    return body;
  }

  async function connect(value) {
    var presented = String(value === undefined || value === null ? '' : value).trim();
    if (!presented) { say('login-status', T.typeSecretFirst, 'error'); return; }
    memorySecret = presented;
    say('login-status', T.checking, 'busy');
    try {
      var status = await call('/admin/status');
      if (el('remember').checked) { writeStored(presented); } else { clearStored(); }
      say('login-status', T.connected, 'ok');
      el('secret').value = '';
      el('login').hidden = true;
      el('app').hidden = false;
      var warning = el('app-warning');
      if (status.devicesError) {
        warning.textContent = fmt(T.devicesErrorBanner, { message: String(status.devicesError) });
        warning.hidden = false;
      } else {
        warning.textContent = '';
        warning.hidden = true;
      }
      // status.devices is the issued-credential registry size (the JSON key keeps its old name for
      // compatibility); the label says so and the presence card says what is *not* tracked.
      el('conn-line').textContent = fmt(T.connectionLine, {
        name: status.name,
        version: status.version,
        environment: status.environment,
        notes: status.notes,
        issued: status.devices
      });
      renderOverview(status);
      renderPresence(status);
      loadNotes();
      loadDevices();
      loadActivity();
    } catch (error) {
      memorySecret = '';
      clearStored();
      el('remember').checked = false;
      say('login-status', error.message, 'error');
    }
  }

  function credentialKinds(status) {
    return Array.isArray(status.credentials) ? status.credentials : [];
  }

  function credentialNames(status) {
    return credentialKinds(status).map(function (kind) {
      if (kind === 'token') return T.credentialKindToken;
      if (kind === 'secret') return T.credentialKindSecret;
      return String(kind);
    });
  }

  function credentialLabel(status) {
    var names = credentialNames(status);
    if (status.auth === 'token+secret') return T.credentialTokenAndSecret;
    if (status.auth === 'token') return T.credentialToken;
    if (status.auth === 'secret') return T.credentialSecret;
    // A mode this page does not know yet must not read as "none" while the payload lists
    // accepted credentials: saying "none" about a gated hub is the one wrong answer.
    if (names.length > 0) return names.join(' + ');
    return T.credentialNone;
  }

  function renderOverview(status) {
    var accepted = credentialNames(status);
    var rows = [
      [T.overviewHub, status.name + ' (v' + status.version + ')'],
      [T.overviewEnvironment, status.environment],
      [T.overviewNotes, String(status.notes)],
      [T.overviewClientCredential, credentialLabel(status)],
      [T.overviewTokenIssuing, status.tokenIssuing ? T.issuingAvailable : T.issuingUnavailable],
      [T.overviewRevocation, status.revocationDurable ? T.revocationDurable : T.revocationLive],
      [T.overviewIssuedCredentials, fmt(T.issuedCredentialsSummary, { issued: status.devices, revoked: status.revoked })],
      [T.overviewReadOnly, status.readOnly ? T.yes : T.no],
      [T.overviewFederates, status.federates ? T.federatesYes : T.federatesNo]
    ];
    if (accepted.length > 0) {
      rows.splice(5, 0, [T.overviewAcceptedCredentials, accepted.join(' + ')]);
    }
    var card = el('overview-card');
    card.textContent = '';
    var list = document.createElement('dl');
    list.className = 'bp-kv';
    rows.forEach(function (pair) {
      var dt = document.createElement('dt');
      dt.textContent = pair[0];
      var dd = document.createElement('dd');
      dd.textContent = String(pair[1]);
      list.appendChild(dt);
      list.appendChild(dd);
    });
    card.appendChild(list);
  }

  // What the hub can and cannot see. The two stamps are the only "is anyone there" signal this
  // hub has; the paragraph above them states the limit rather than letting the table imply a
  // client list. Presence is memory-only, so a restart shows "not seen since this hub started".
  function renderPresence(status) {
    var presence = status.presence || {};
    var list = el('presence-rows');
    list.textContent = '';
    [
      [T.presenceToken, presence.token],
      [T.presenceSecret, presence.secret]
    ].forEach(function (pair) {
      var dt = document.createElement('dt');
      dt.textContent = pair[0];
      var dd = document.createElement('dd');
      dd.textContent = pair[1] === undefined || pair[1] === null || pair[1] === ''
        ? T.presenceNever
        : fmtDate(pair[1]);
      list.appendChild(dt);
      list.appendChild(dd);
    });
  }

  function emptyRow(colspan, primary, note) {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = colspan;
    td.className = 'bp-muted';
    td.textContent = primary;
    if (note) {
      td.appendChild(document.createElement('br'));
      td.appendChild(document.createTextNode(note));
    }
    tr.appendChild(td);
    return tr;
  }

  function cell(tr, text, className) {
    var td = document.createElement('td');
    td.textContent = text === undefined || text === null ? '—' : String(text);
    if (className) { td.className = className; }
    tr.appendChild(td);
    return td;
  }

  function pill(tr, text, className) {
    var td = document.createElement('td');
    var span = document.createElement('span');
    span.className = className ? 'bp-pill ' + className : 'bp-pill';
    span.textContent = text;
    td.appendChild(span);
    tr.appendChild(td);
    return td;
  }

  function actionButton(tr) {
    var td = document.createElement('td');
    tr.appendChild(td);
    return td;
  }

  async function loadNotes() {
    say('notes-status', T.loading, 'busy');
    try {
      var data = await call('/notes?includeDone=true');
      var notes = data.notes || [];
      var tbody = el('notes-body-rows');
      tbody.textContent = '';
      if (notes.length === 0) {
        tbody.appendChild(emptyRow(5, T.notesEmpty));
      } else {
        notes.forEach(function (note) {
          var tr = document.createElement('tr');
          cell(tr, note.body);
          cell(tr, note.anchor && note.anchor.route ? note.anchor.route : '—', 'bp-mono');
          var statusText = note.status === 'done' ? T.statusDone : note.status === 'open' ? T.statusOpen : note.status;
          cell(tr, statusText);
          var authorTd = document.createElement('td');
          authorTd.textContent = note.author === undefined || note.author === null ? '—' : String(note.author);
          var authorPill = document.createElement('span');
          authorPill.className = 'bp-pill';
          authorPill.textContent = note.authorType === undefined || note.authorType === null ? '' : String(note.authorType);
          authorTd.appendChild(document.createTextNode(' '));
          authorTd.appendChild(authorPill);
          tr.appendChild(authorTd);
          var actionTd = actionButton(tr);
          var button = document.createElement('button');
          button.type = 'button';
          if (note.status === 'done') {
            button.dataset.reopen = String(note.id);
            button.textContent = T.reopenButton;
          } else {
            button.dataset.done = String(note.id);
            button.textContent = T.doneButton;
          }
          actionTd.appendChild(button);
          tbody.appendChild(tr);
        });
      }
      say('notes-status', fmt(T.notesCount, { count: notes.length }), 'ok');
    } catch (error) {
      say('notes-status', error.message, 'error');
    }
  }

  function hideMint() {
    el('mint-heading').textContent = '';
    el('token-value').value = '';
    say('token-status', '', '');
    el('mint-result').hidden = true;
  }

  async function loadDevices(options) {
    var keepMint = !!(options && options.keepMint === true);
    say('devices-status', T.loading, 'busy');
    try {
      var data = await call('/admin/devices');
      var warning = el('token-warning');
      if (data.tokenIssuing) {
        warning.textContent = '';
        warning.hidden = true;
      } else {
        warning.textContent = T.noIssuingBanner;
        warning.hidden = false;
      }
      if (!keepMint) { hideMint(); }
      var tbody = el('devices-rows');
      tbody.textContent = '';
      var devices = data.devices || [];
      if (devices.length === 0) {
        tbody.appendChild(emptyRow(7, T.devicesEmpty));
      } else {
        devices.slice().reverse().forEach(function (device) {
          var tr = document.createElement('tr');
          cell(tr, device.device);
          cell(tr, (device.scope || []).join(' '), 'bp-mono');
          cell(tr, fmtDate(device.createdAt));
          cell(tr, fmtDate(device.expiresAt));
          pill(tr, device.revoked ? T.stateRevoked : T.stateLive, device.revoked ? 'bp-revoked' : 'bp-live');
          cell(tr, String(device.jti === undefined || device.jti === null ? '' : device.jti).slice(0, 8) + '…', 'bp-mono');
          var actionTd = actionButton(tr);
          // A hub without a durable revocation list may report a stale "revoked" flag after a
          // restart, so the operator must still be able to re-revoke that record.
          if (!device.revoked || data.revocationDurable !== true) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'bp-danger';
            button.dataset.revoke = String(device.jti);
            button.textContent = T.revokeButton;
            actionTd.appendChild(button);
          }
          tbody.appendChild(tr);
        });
      }
      say('devices-status', T.statusOk, 'ok');
    } catch (error) {
      // A 500 from /admin/devices carries the registry message; showing it here is the whole point
      // of the status line — the page keeps working, the operator sees what the hub said.
      say('devices-status', error.message, 'error');
    }
  }

  async function loadActivity() {
    say('activity-status', T.loading, 'busy');
    try {
      var data = await call('/journal');
      var entries = (data.entries || data.journal || []).slice().reverse();
      var tbody = el('activity-rows');
      tbody.textContent = '';
      if (entries.length === 0) {
        tbody.appendChild(emptyRow(3, T.activityEmpty));
      } else {
        entries.forEach(function (entry) {
          var tr = document.createElement('tr');
          cell(tr, fmtDate(entry.ts), 'bp-mono');
          cell(tr, entry.actor === undefined || entry.actor === null ? '—' : String(entry.actor));
          cell(tr, String(entry.op === undefined || entry.op === null ? '' : entry.op) + ' ' +
            String(entry.summary === undefined || entry.summary === null ? '' : entry.summary));
          tbody.appendChild(tr);
        });
      }
      say('activity-status', fmt(T.activityCount, { count: entries.length }), 'ok');
    } catch (error) {
      say('activity-status', error.message, 'error');
    }
  }

  function activateTab(name) {
    var tabs = document.querySelectorAll('.bp-tabs [role="tab"]');
    Array.prototype.forEach.call(tabs, function (tab) {
      var active = tab.getAttribute('data-tab') === name;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
    });
    var panels = document.querySelectorAll('[role="tabpanel"][data-view]');
    Array.prototype.forEach.call(panels, function (panel) {
      panel.hidden = panel.getAttribute('data-view') !== name;
    });
  }

  function legacyCopy(input) {
    input.focus();
    input.select();
    var copied = document.execCommand ? document.execCommand('copy') : false;
    if (!copied) { throw new Error('copy failed'); }
  }

  async function copyToken() {
    var input = el('token-value');
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(input.value);
      } else {
        legacyCopy(input);
      }
      say('token-status', T.copied, 'ok');
    } catch (error) {
      try {
        legacyCopy(input);
        say('token-status', T.copied, 'ok');
      } catch (fallbackError) {
        say('token-status', T.copyFailed, 'error');
      }
    }
  }

  var tablist = document.querySelector('.bp-tabs');
  if (tablist) {
    tablist.addEventListener('keydown', function (event) {
      var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
      var index = tabs.indexOf(document.activeElement);
      if (index === -1) { return; }
      var next = null;
      if (event.key === 'ArrowRight') { next = tabs[(index + 1) % tabs.length]; }
      else if (event.key === 'ArrowLeft') { next = tabs[(index - 1 + tabs.length) % tabs.length]; }
      else if (event.key === 'Home') { next = tabs[0]; }
      else if (event.key === 'End') { next = tabs[tabs.length - 1]; }
      if (!next) { return; }
      event.preventDefault();
      var targetTab = next.getAttribute('data-tab');
      if (targetTab) { activateTab(targetTab); }
      next.focus();
    });
  }

  document.addEventListener('click', async function (event) {
    var target = event.target;
    if (!(target instanceof HTMLElement)) return;
    try {
      if (target.id === 'connect') { await connect(el('secret').value); return; }
      if (target.id === 'notes-reload') { await loadNotes(); return; }
      if (target.id === 'devices-reload') { await loadDevices(); return; }
      if (target.id === 'activity-reload') { await loadActivity(); return; }
      if (target.id === 'copy-token') { await copyToken(); return; }
      if (target.id === 'dismiss-token') { hideMint(); return; }
      if (target.id === 'token-value' && target instanceof HTMLInputElement) {
        target.focus();
        target.select();
        return;
      }
      if (target.getAttribute('role') === 'tab' && target.getAttribute('data-tab')) {
        activateTab(target.getAttribute('data-tab'));
        return;
      }
      if (target.id === 'note-create') {
        var body = el('note-body').value.trim();
        if (!body) { say('notes-status', T.typeNoteFirst, 'error'); return; }
        var route = el('note-route').value.trim() || '/';
        say('notes-status', T.adding, 'busy');
        await call('/notes', { method: 'POST', body: JSON.stringify({
          type: 'text', body: body, anchor: { selector: 'main', route: route } }) });
        el('note-body').value = '';
        await loadNotes();
        return;
      }
      if (target.dataset.done) {
        await call('/notes/' + encodeURIComponent(target.dataset.done), { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
        await loadNotes();
        return;
      }
      if (target.dataset.reopen) {
        await call('/notes/' + encodeURIComponent(target.dataset.reopen), { method: 'PATCH', body: JSON.stringify({ status: 'open' }) });
        await loadNotes();
        return;
      }
      if (target.id === 'device-mint') {
        var device = el('device-name').value.trim();
        if (!device) { say('devices-status', T.nameDeviceFirst, 'error'); return; }
        var rawTtl = el('device-ttl').value.trim();
        var payload = { device: device, scope: el('device-scope').value.split(' ') };
        if (rawTtl !== '') {
          var days = Number(rawTtl);
          if (!Number.isInteger(days) || days < 1 || days > 365) {
            say('devices-status', T.ttlError, 'error');
            return;
          }
          payload.ttlSeconds = days * 86400;
        }
        say('devices-status', T.issuing, 'busy');
        var issued = await call('/admin/devices', { method: 'POST', body: JSON.stringify(payload) });
        el('mint-heading').textContent = fmt(T.tokenHeading, { device: issued.device });
        el('token-value').value = issued.token;
        say('token-status', '', '');
        el('mint-result').hidden = false;
        el('device-name').value = '';
        // Refresh the list without touching the panel: the token stays visible until dismissed,
        // reloaded or replaced by the next mint.
        await loadDevices({ keepMint: true });
        var tokenInput = el('token-value');
        tokenInput.focus();
        tokenInput.select();
        return;
      }
      if (target.dataset.revoke) {
        if (!window.confirm(T.revokeConfirm)) return;
        say('devices-status', T.revoking, 'busy');
        var result = await call('/admin/devices/revoke', { method: 'POST', body: JSON.stringify({ jti: target.dataset.revoke }) });
        // A revoke refreshes the list like any other refresh: the mint panel keeps its token.
        await loadDevices({ keepMint: true });
        // The refresh writes "ok"; the revoke answer is the one that carries the truth (a durable
        // revocation note, or a registry/revocation-list write error), so it is said last.
        var trouble = result && (result.revocationError || result.registryError);
        if (trouble) {
          say('devices-status', String(trouble), 'error');
        } else if (result && result.note) {
          say('devices-status', String(result.note), 'ok');
        }
        return;
      }
    } catch (error) {
      say('devices-status', error.message, 'error');
      say('notes-status', error.message, 'error');
    }
  });

  // Auto-connect only when a value was explicitly remembered in this tab; otherwise a reload
  // starts at the login box again.
  var remembered = readStored();
  if (remembered) {
    el('remember').checked = true;
    connect(remembered);
  }
})();
</script>
</body>
</html>
`;
}

/** English rendering kept as a constant for existing importers. */
export const ADMIN_HTML: string = renderAdminHtml(ADMIN_STRINGS.en);
