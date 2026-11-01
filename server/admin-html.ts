/**
 * The admin page, embedded as one string — no build step, no client dependency, no second origin.
 *
 * Deliberately plain: the whole surface is a login box plus four views that speak the routes this
 * repository already has (`{base}/notes`, `{base}/journal`) and the ones `server/admin.ts` adds.
 * The page keeps the admin secret in `sessionStorage` — a tab, not a disk — and sends it as
 * `x-bluepencil-admin`; for the notes it sends the same value as `x-bluepencil-auth`, which is why
 * the operator only ever types one secret.
 */
export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bluepencil — admin</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfd; --fg:#1c1c1f; --muted:#61616a; --line:#e3e3ea;
          --card:#fff; --accent:#2f5fd0; --danger:#b3261e; --ok:#1a7f37; --warn:#8a6d00; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16161a; --fg:#ececf1; --muted:#9a9aa6; --line:#2c2c34; --card:#1d1d22;
            --accent:#7aa2f7; --danger:#f28b82; --ok:#81c995; --warn:#e0b000; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; }
  main { max-width: 920px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
  h1 { font-size: 1.2rem; margin: 0 0 .25rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
  .muted { color: var(--muted); font-size: .9rem; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1rem; margin: .75rem 0; }
  input, select, button { font: inherit; padding: .45rem .6rem; border-radius: 8px; border: 1px solid var(--line);
                          background: var(--card); color: var(--fg); }
  input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  @media (prefers-color-scheme: dark) { button.primary { color: #10101a; } }
  button.danger { color: var(--danger); border-color: var(--danger); background: transparent; }
  nav.tabs { display:flex; gap:.5rem; flex-wrap:wrap; margin:1rem 0; }
  nav.tabs button[aria-selected="true"] { border-color: var(--accent); color: var(--accent); font-weight:600; }
  table { width:100%; border-collapse: collapse; font-size: .92rem; }
  th, td { text-align:left; padding:.4rem .5rem; border-bottom:1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight:600; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; }
  .status { margin-left:.6rem; font-size:.9rem; }
  .status[data-kind="ok"] { color: var(--ok); }
  .status[data-kind="error"] { color: var(--danger); }
  .status[data-kind="busy"] { color: var(--muted); }
  .row { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; margin:.5rem 0; }
  .pill { display:inline-block; padding:.05rem .5rem; border:1px solid var(--line); border-radius:999px;
          font-size:.8rem; color:var(--muted); }
  .pill.revoked { color: var(--danger); border-color: var(--danger); }
  .pill.live { color: var(--ok); border-color: var(--ok); }
  .banner { border:1px solid var(--warn); color:var(--warn); border-radius:8px; padding:.5rem .75rem; margin:.75rem 0; }
  .secret-wrap { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; }
  #login { max-width: 30rem; }
</style>
</head>
<body>
<main>
  <h1>Bluepencil <span class="muted">admin</span></h1>
  <p class="muted" id="conn-line">not connected</p>

  <section id="login" class="card">
    <h2>Connect</h2>
    <p class="muted">The hub's admin secret (<code>--admin-secret</code>). Kept in this tab only, sent as
      <code>x-bluepencil-admin</code>.</p>
    <div class="secret-wrap">
      <input type="password" id="secret" placeholder="admin secret" autocomplete="off" size="28">
      <button class="primary" id="connect">Connect</button>
    </div>
    <span class="status" id="login-status" role="status" aria-live="polite"></span>
  </section>

  <section id="app" hidden>
    <nav class="tabs" role="tablist" aria-label="Sections">
      <button role="tab" data-tab="overview" aria-selected="true">Overview</button>
      <button role="tab" data-tab="notes" aria-selected="false">Notes</button>
      <button role="tab" data-tab="devices" aria-selected="false">Devices &amp; keys</button>
      <button role="tab" data-tab="activity" aria-selected="false">Activity</button>
    </nav>

    <section data-view="overview">
      <div class="card" id="overview-card">…</div>
    </section>

    <section data-view="notes" hidden>
      <h2>Notes</h2>
      <div class="row">
        <input id="note-body" placeholder="New note — what should be looked at?" size="38">
        <input id="note-route" placeholder="route (e.g. /settings)" size="16">
        <button class="primary" id="note-create">Add</button>
        <button id="notes-reload">Reload</button>
      </div>
      <span class="status" id="notes-status" role="status" aria-live="polite"></span>
      <table><thead><tr><th>Body</th><th>Route</th><th>Status</th><th>Author</th><th></th></tr></thead>
        <tbody id="notes-body-rows"></tbody></table>
    </section>

    <section data-view="devices" hidden>
      <h2>Devices &amp; keys</h2>
      <div id="token-warning"></div>
      <div class="row">
        <input id="device-name" placeholder="device name (e.g. caro-laptop)" size="22">
        <select id="device-scope"><option value="read write">read + write</option><option value="read">read only</option></select>
        <input id="device-ttl" placeholder="lifetime days (default: hub default)" size="7" inputmode="numeric">
        <button class="primary" id="device-mint">Issue token</button>
        <button id="devices-reload">Reload</button>
      </div>
      <span class="status" id="devices-status" role="status" aria-live="polite"></span>
      <div class="card" id="mint-result" hidden></div>
      <table><thead><tr><th>Device</th><th>Scope</th><th>Issued</th><th>Expires</th><th>State</th><th>jti</th><th></th></tr></thead>
        <tbody id="devices-rows"></tbody></table>
    </section>

    <section data-view="activity" hidden>
      <h2>Activity</h2>
      <p class="muted">Every recorded change, newest first — who did what, and when.</p>
      <button id="activity-reload">Reload</button>
      <span class="status" id="activity-status" role="status" aria-live="polite"></span>
      <table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
        <tbody id="activity-rows"></tbody></table>
    </section>
  </section>
</main>
<script>
(function () {
  'use strict';
  var KEY = 'bluepencil-admin-secret';
  var BASE = location.pathname.replace(/\\/admin\\/?$/, '');
  var el = function (id) { return document.getElementById(id); };

  function secret() { return sessionStorage.getItem(KEY) || ''; }
  function say(id, message, kind) {
    var node = el(id); node.textContent = message || '';
    if (!kind) { node.removeAttribute('data-kind'); } else { node.dataset.kind = kind; }
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

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function connect() {
    var value = el('secret').value.trim();
    if (!value) { say('login-status', 'Type the admin secret first.', 'error'); return; }
    say('login-status', 'checking…', 'busy');
    sessionStorage.setItem(KEY, value);
    try {
      var status = await call('/admin/status');
      say('login-status', 'connected', 'ok');
      el('login').hidden = true;
      el('app').hidden = false;
      el('conn-line').textContent = status.name + ' · v' + status.version + ' · ' +
        status.environment + ' · ' + status.notes + ' note(s) · ' + status.devices + ' device(s)';
      renderOverview(status);
      loadNotes(); loadDevices(); loadActivity();
    } catch (error) {
      sessionStorage.removeItem(KEY);
      say('login-status', error.message, 'error');
    }
  }

  function renderOverview(status) {
    var rows = [
      ['Hub', status.name + ' (v' + status.version + ')'],
      ['Environment', status.environment],
      ['Notes', status.notes],
      ['Client credential', status.auth === 'token' ? 'signed token (--token-key)' : status.auth === 'secret' ? 'shared secret (--auth-secret)' : 'none'],
      ['Token issuing', status.tokenIssuing ? 'available' : 'not available — this hub has no --token-key'],
      ['Revocation', status.revocationDurable ? 'durable (--revoked-tokens file)' : 'live only — lost on restart (no --revoked-tokens file)'],
      ['Devices', status.devices + ' (' + status.revoked + ' revoked)'],
      ['Read-only', status.readOnly ? 'yes' : 'no'],
      ['Federates', status.federates ? 'yes (registry configured)' : 'no']
    ];
    el('overview-card').innerHTML = '<table><tbody>' + rows.map(function (pair) {
      return '<tr><th>' + esc(pair[0]) + '</th><td>' + esc(pair[1]) + '</td></tr>';
    }).join('') + '</tbody></table>';
  }

  async function loadNotes() {
    say('notes-status', 'loading…', 'busy');
    try {
      var data = await call('/notes?includeDone=true');
      var notes = data.notes || [];
      el('notes-body-rows').innerHTML = notes.map(function (note) {
        var actions = note.status === 'done'
          ? '<button data-reopen="' + esc(note.id) + '">reopen</button>'
          : '<button data-done="' + esc(note.id) + '">done</button>';
        return '<tr><td>' + esc(note.body) + '</td>' +
          '<td class="mono">' + esc((note.anchor && note.anchor.route) || '—') + '</td>' +
          '<td>' + esc(note.status) + '</td>' +
          '<td>' + esc(note.author) + ' <span class="pill">' + esc(note.authorType) + '</span></td>' +
          '<td>' + actions + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="muted">no notes yet</td></tr>';
      say('notes-status', notes.length + ' note(s)', 'ok');
    } catch (error) { say('notes-status', error.message, 'error'); }
  }

  async function loadDevices() {
    say('devices-status', 'loading…', 'busy');
    try {
      var data = await call('/admin/devices');
      var warning = el('token-warning');
      warning.innerHTML = data.tokenIssuing ? ''
        : '<div class="banner">This hub has no <code>--token-key</code>, so it cannot issue tokens. ' +
          'Client access runs on the shared secret; restart the hub with a key to mint per-device tokens.</div>';
      el('mint-result').hidden = true;
      el('devices-rows').innerHTML = (data.devices || []).slice().reverse().map(function (d) {
        var state = d.revoked ? '<span class="pill revoked">revoked</span>' : '<span class="pill live">live</span>';
        var revoke = d.revoked ? '' : '<button class="danger" data-revoke="' + esc(d.jti) + '">revoke</button>';
        return '<tr><td>' + esc(d.device) + '</td><td class="mono">' + esc((d.scope || []).join(' ')) + '</td>' +
          '<td>' + esc(String(d.createdAt).slice(0, 19).replace('T', ' ')) + '</td>' +
          '<td>' + esc(String(d.expiresAt).slice(0, 19).replace('T', ' ')) + '</td>' +
          '<td>' + state + '</td><td class="mono">' + esc(d.jti.slice(0, 8)) + '…</td><td>' + revoke + '</td></tr>';
      }).join('') || '<tr><td colspan="7" class="muted">no tokens issued yet</td></tr>';
      say('devices-status', 'ok', 'ok');
    } catch (error) { say('devices-status', error.message, 'error'); }
  }

  async function loadActivity() {
    say('activity-status', 'loading…', 'busy');
    try {
      var data = await call('/journal');
      var entries = (data.entries || data.journal || []).slice().reverse();
      el('activity-rows').innerHTML = entries.map(function (entry) {
        return '<tr><td class="mono">' + esc(String(entry.ts || '').slice(0, 19).replace('T', ' ')) + '</td>' +
          '<td>' + esc(entry.actor || '—') + '</td><td>' + esc(entry.op || '') + ' ' + esc(entry.summary || '') + '</td></tr>';
      }).join('') || '<tr><td colspan="3" class="muted">nothing recorded yet</td></tr>';
      say('activity-status', entries.length + ' entry(s)', 'ok');
    } catch (error) { say('activity-status', error.message, 'error'); }
  }

  document.addEventListener('click', async function (event) {
    var target = event.target;
    if (!(target instanceof HTMLElement)) return;
    try {
      if (target.id === 'connect') { await connect(); return; }
      if (target.id === 'notes-reload') { await loadNotes(); return; }
      if (target.id === 'devices-reload') { await loadDevices(); return; }
      if (target.id === 'activity-reload') { await loadActivity(); return; }
      if (target.id === 'note-create') {
        var body = el('note-body').value.trim();
        if (!body) { say('notes-status', 'Type a note first.', 'error'); return; }
        var route = el('note-route').value.trim() || '/';
        say('notes-status', 'adding…', 'busy');
        await call('/notes', { method: 'POST', body: JSON.stringify({
          type: 'text', body: body, anchor: { selector: 'main', route: route } }) });
        el('note-body').value = '';
        await loadNotes();
        return;
      }
      if (target.dataset.done) {
        await call('/notes/' + encodeURIComponent(target.dataset.done), { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
        await loadNotes(); return;
      }
      if (target.dataset.reopen) {
        await call('/notes/' + encodeURIComponent(target.dataset.reopen), { method: 'PATCH', body: JSON.stringify({ status: 'open' }) });
        await loadNotes(); return;
      }
      if (target.id === 'device-mint') {
        var device = el('device-name').value.trim();
        if (!device) { say('devices-status', 'Name the device first.', 'error'); return; }
        var days = el('device-ttl').value.trim();
        var payload = { device: device, scope: el('device-scope').value.split(' ') };
        if (days !== '') { payload.ttlSeconds = Math.round(parseFloat(days) * 86400); }
        say('devices-status', 'issuing…', 'busy');
        var issued = await call('/admin/devices', { method: 'POST', body: JSON.stringify(payload) });
        el('mint-result').hidden = false;
        el('mint-result').innerHTML = '<h2>Token for ' + esc(issued.device) + '</h2>' +
          '<p class="muted">Copy it now — the hub keeps the id, not the token.</p>' +
          '<div class="row"><input readonly size="48" value="' + esc(issued.token) + '">' +
          '<button id="copy-token">Copy</button></div>';
        el('device-name').value = '';
        await loadDevices();
        return;
      }
      if (target.id === 'copy-token') {
        var input = target.previousElementSibling;
        if (input instanceof HTMLInputElement) { input.select(); document.execCommand('copy'); }
        return;
      }
      if (target.dataset.revoke) {
        if (!window.confirm('Revoke this token? The device loses access at once and stays cut off after a restart.')) return;
        say('devices-status', 'revoking…', 'busy');
        await call('/admin/devices/revoke', { method: 'POST', body: JSON.stringify({ jti: target.dataset.revoke }) });
        await loadDevices();
        return;
      }
      if (target.dataset.tab) {
        var tab = target.dataset.tab;
        document.querySelectorAll('nav.tabs [role="tab"]').forEach(function (button) {
          button.setAttribute('aria-selected', button.dataset.tab === tab ? 'true' : 'false');
        });
        document.querySelectorAll('section[data-view]').forEach(function (view) {
          view.hidden = view.getAttribute('data-view') !== tab;
        });
        return;
      }
    } catch (error) {
      say('devices-status', error.message, 'error');
      say('notes-status', error.message, 'error');
    }
  });

  if (secret()) { connect(); }
})();
</script>
</body>
</html>
`;
