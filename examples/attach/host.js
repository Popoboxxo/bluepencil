/**
 * Host bootstrap of the whole-system attach fixture (`examples/attach/index.html`).
 *
 * A classic script, loaded **before** the loader tag, because the loader resolves its
 * `data-gate` / `data-headers-from` paths against the host's global scope when it runs:
 *
 *   hostApp.canReview()  → the gate (`data-gate="hostApp.canReview"`)
 *   hostApp.headers()    → `data-headers-from`, evaluated on every request
 *
 * The rest of this file is the page's own diagnostic. With `?selftest=1` it probes the attach
 * contract from the *host* side — the documented `window.bluepencilAttach` surface, the mounted
 * element, a note written and read back over HTTP — and writes a machine-readable result block
 * into the page:
 *
 *   <pre id="bp-selftest" data-status="pass|fail" data-count="8/8">selftest: PASS …</pre>
 *
 * `scripts/embed-smoke.mjs` drives exactly this page in a real browser; a human does the same by
 * opening `<site>/examples/attach/?selftest=1` (see examples/attach/README.md).
 *
 * No inline event handler attributes (NFR-6); every string goes in as text (FR-9.3).
 */
(function () {
  "use strict";

  var SESSION = "attach-fixture";
  var READY_TIMEOUT_MS = 10000;

  /** Log of the loader's document events, so the probe can assert what the host actually saw. */
  var log = { ready: null, updated: [], errors: [] };
  var headerCalls = 0;
  var started = false;

  window.hostApp = {
    /** The gate: a *function* on a global path, so it is re-evaluated on every `enable()`. */
    canReview: function () {
      return true;
    },
    /** `headers-from`: called for every request — the reason a rotated token stays current. */
    headers: function () {
      headerCalls += 1;
      return { "X-Workspace": "demo-workspace" };
    },
    get headerCalls() {
      return headerCalls;
    },
    get events() {
      return log;
    },
  };

  document.addEventListener("bp-attach-ready", function (event) {
    log.ready = event.detail;
    start();
  });
  document.addEventListener("bp-attach-updated", function (event) {
    log.updated.push(event.detail);
  });
  document.addEventListener("bp-attach-error", function (event) {
    log.errors.push(String((event.detail && event.detail.message) || event.detail));
    start();
  });

  /** `true` when the page was opened with `?selftest=1` (or `?a=1&selftest=1`). */
  function wantsSelfTest() {
    return String(window.location.search || "").indexOf("selftest=1") !== -1;
  }

  /** Why the layer never arrived — the first line of any failed probe. */
  function loaderFailure() {
    return log.errors.length > 0
      ? "bp-attach-error: " + log.errors.join(" | ")
      : "the loader never became ready within " + READY_TIMEOUT_MS + " ms";
  }

  function start() {
    if (started || !wantsSelfTest()) {
      return;
    }
    started = true;
    runSelfTest().then(render, function (error) {
      render([{ name: "selftest-harness", ok: false, detail: String((error && error.message) || error) }]);
    });
  }

  /** Resolves once the layer is mounted, failed, or stayed away for the whole timeout. */
  function whenReady() {
    var deadline = Date.now() + READY_TIMEOUT_MS;
    return new Promise(function (resolve) {
      (function poll() {
        if (log.ready !== null || log.errors.length > 0 || Date.now() > deadline) {
          resolve();
          return;
        }
        setTimeout(poll, 50);
      })();
    });
  }

  /**
   * The probe. Every entry is a host-visible fact about the attach, in the order a host would
   * discover it — and nothing here reaches into the layer's internals beyond the documented
   * element API (`blueprint`, `issues`, `exportNotes()`, `destroy()`).
   */
  function runSelfTest() {
    var results = [];

    function assert(condition, message) {
      if (!condition) {
        throw new Error(message);
      }
    }

    function check(name, body) {
      return Promise.resolve()
        .then(body)
        .then(
          function (detail) {
            results.push({ name: name, ok: true, detail: detail === undefined ? "" : String(detail) });
          },
          function (error) {
            results.push({ name: name, ok: false, detail: String((error && error.message) || error) });
          },
        );
    }

    function note() {
      return window.__bpFixtureNote;
    }

    return whenReady()
      .then(function () {
        return check("attach-ready", function () {
          assert(log.ready !== null, loaderFailure());
          assert(typeof log.ready.version === "string", "detail.version is not a string");
          assert(
            /\.js($|[?#])/.test(String(log.ready.src)),
            "detail.src is not a script url: " + String(log.ready.src),
          );
          return "version=" + log.ready.version;
        });
      })
      .then(function () {
        return check("documented-api-surface", function () {
          var api = window.bluepencilAttach;
          assert(api, "window.bluepencilAttach is missing");
          assert(typeof api.version === "string", "api.version is not a string");
          assert(typeof api.src === "string", "api.src is not a string");
          assert(Array.isArray(api.instances), "api.instances is not an array");
          ["destroy", "check", "reload"].forEach(function (key) {
            assert(typeof api[key] === "function", "api." + key + " is not a function");
          });
          return "version=" + api.version + ", instances=" + api.instances.length;
        });
      })
      .then(function () {
        return check("element-mounted", function () {
          var api = window.bluepencilAttach;
          assert(api.instances.length === 1, "expected exactly one mounted element, got " + api.instances.length);
          var element = api.instances[0];
          assert(element.tagName.toLowerCase() === "bluepencil-notes", "unexpected tag " + element.tagName);
          assert(element.getAttribute("endpoint") === "/api/v1/bluepencil", "endpoint attribute not forwarded");
          assert(element.getAttribute("environment") === "dev", "environment attribute not forwarded");
          assert(element.getAttribute("session") === SESSION, "session attribute not forwarded");
          assert(element.getAttribute("language") === "de", "language attribute not forwarded");
          assert(
            /\.js($|[?#])/.test(String(element.getAttribute("attach-src"))),
            "attach-src breadcrumb missing: " + String(element.getAttribute("attach-src")),
          );
          assert(element.getAttribute("attach-version"), "attach-version breadcrumb missing");
          return "attach-version=" + element.getAttribute("attach-version");
        });
      })
      .then(function () {
        return check("layer-styles-injected", function () {
          var styles = document.querySelectorAll("style[data-bp-styles]");
          assert(styles.length === 1, "expected exactly one layer style node, got " + styles.length);
          return "1 style node";
        });
      })
      .then(function () {
        return check("note-round-trip", function () {
          var element = window.bluepencilAttach.instances[0];
          assert(element.blueprint && element.blueprint.store, "the element exposes no store");
          var body = "attach fixture note " + Date.now();
          return element.blueprint.store
            .create({
              type: "text",
              body: body,
              anchor: { hook: "kpi-revenue", route: String(window.location.pathname) },
              author: "attach-fixture",
            })
            .then(function (created) {
              assert(created && created.id, "no note came back from the store");
              return element.blueprint.store.list({ session: SESSION }).then(function (notes) {
                var found = notes.filter(function (candidate) {
                  return candidate.id === created.id;
                });
                assert(found.length === 1, "the created note is not in the session list");
                assert(found[0].body === body, "the note body changed on the round trip");
                assert(found[0].environment === "dev", "the note landed in the wrong environment");
                assert(
                  found[0].anchor && found[0].anchor.route === window.location.pathname,
                  'route="url" did not reach the anchor route',
                );
                window.__bpFixtureNote = found[0];
                return "note " + created.id;
              });
            });
        });
      })
      .then(function () {
        return check("headers-from-per-request", function () {
          assert(headerCalls > 0, "hostApp.headers was never called — headers-from is not wired");
          return headerCalls + " call(s)";
        });
      })
      .then(function () {
        return check("note-visible-over-http", function () {
          var url = "/api/v1/bluepencil/notes?session=" + encodeURIComponent(SESSION);
          return fetch(url, { headers: window.hostApp.headers(), cache: "no-store" }).then(function (response) {
            assert(response.ok, "GET " + url + " → HTTP " + response.status + " (is the API on this origin?)");
            return response.json().then(function (payload) {
              var notes = (payload && payload.notes) || [];
              var expected = note();
              var found = notes.filter(function (candidate) {
                return expected && candidate.id === expected.id;
              });
              assert(found.length === 1, "the note is not visible through the plain HTTP contract");
              return "GET /notes?session=" + SESSION + " → " + notes.length + " note(s)";
            });
          });
        });
      })
      .then(function () {
        return check("check-without-manifest", function () {
          return window.bluepencilAttach.check().then(function (updated) {
            assert(updated === 0, "check() must not swap anything without a manifest, reported " + updated);
            return "0 swap(s)";
          });
        });
      })
      .then(function () {
        return results;
      });
  }

  /** Renders the probe result into the page — the machine-readable part of the fixture. */
  function render(results) {
    var host = document.getElementById("bp-selftest");
    if (!host) {
      host = document.createElement("pre");
      host.id = "bp-selftest";
      document.body.append(host);
    }
    var passed = results.filter(function (result) {
      return result.ok;
    }).length;
    host.setAttribute("data-status", passed === results.length ? "pass" : "fail");
    host.setAttribute("data-count", passed + "/" + results.length);
    host.textContent = results
      .map(function (result) {
        return (
          "selftest: " + (result.ok ? "PASS" : "FAIL") + " " + result.name + (result.detail ? " — " + result.detail : "")
        );
      })
      .concat(["selftest: " + passed + "/" + results.length + " ok"])
      .join("\n");
  }

  // The loader defers to DOMContentLoaded while the document is still loading, so the listeners
  // above are registered first in every supported order — this call is only a safety net for a
  // host that puts the loader tag before this script.
  if (log.ready !== null || log.errors.length > 0) {
    start();
  }
})();
