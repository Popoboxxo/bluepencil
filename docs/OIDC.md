# OIDC-Anbindung (Zitadel, Keycloak, …)

Seit 0.16.0 akzeptiert der Hub **RS256-Bearer-Tokens eines externen Identity Providers** auf den
Notes-Routen. Der Provider bleibt die einzige Stelle für Benutzer, Passwörter, 2FA, Passwort-Reset,
Sperren und Audit. Der Hub prüft nur Signatur, Claims und Rollen.

## Was das ist – und was nicht

| | Credential | Wem gehört es |
|---|---|---|
| Menschen / eigene UI | OIDC-Bearer-Token (RS256) | Identity Provider |
| Agenten, MCP, CLI, Cron | HMAC-Geräte-Token (`--token-key`) | dieser Hub |
| Operator-Fläche `/admin` | `--admin-secret` | dieser Hub |

Die drei Welten bleiben getrennt. Ein OIDC-Token öffnet **kein** `/admin` und **kein** `/mcp`;
ein Geräte-Token wird nicht durch den IdP ausgestellt. Wer später MCP-OAuth will, braucht ein
eigenes Vorhaben – das hier ersetzt die Geräte-Tokens nicht.

## Flags

```bash
node dist/server.js --store notes.bluepencil.json \
  --oidc-issuer https://login.example.com \
  --oidc-audience bluepencil \
  --oidc-jwks-url https://login.example.com/oauth/v2/keys   # optional
```

| Flag | Env | Bedeutung |
|---|---|---|
| `--oidc-issuer` | `BLUEPENCIL_OIDC_ISSUER` | Issuer-URL; muss exakt zum `iss`-Claim passen. Pflicht mit Audience. |
| `--oidc-audience` | `BLUEPENCIL_OIDC_AUDIENCE` | Erwartete Audience. Pflicht mit Issuer. |
| `--oidc-jwks-url` | `BLUEPENCIL_OIDC_JWKS_URL` | JWKS-URL; sonst Discovery über `{issuer}/.well-known/openid-configuration`. |
| `--oidc-roles-claim` | – | Rollen-Claim (Default `urn:zitadel:iam:user:roles`, Fallback `roles`). |
| `--oidc-admin-role` | – | Default `bp-admin` |
| `--oidc-reviewer-role` | – | Default `bp-reviewer` |
| `--oidc-viewer-role` | – | Default `bp-viewer` |

## Rollen

- `bp-viewer` → `GET` auf Notes erlaubt.
- `bp-reviewer`, `bp-admin` → Lesen **und** Schreiben.
- Unbekannte Rolle → `403 insufficient_scope`.

Der Rollen-Claim darf ein String, ein Array oder ein Objekt sein (Zitadel liefert ein
projekt-keyertes Objekt). Alle verschachtelten Werte werden eingesammelt.

## Zitadel-Minimalaufbau

1. In Zitadel ein Projekt und eine App vom Typ **Web** anlegen; Redirect-URI der eigenen UI.
2. In den Projekt-Rollen `bp-viewer`, `bp-reviewer`, `bp-admin` anlegen und den Nutzern zuweisen.
3. Den Rollen-Scope aktivieren, damit die Token den Claim `urn:zitadel:iam:user:roles` tragen.
4. Dem Hub Issuer + Audience geben (Audience = Client-ID der App).
5. Die eigene UI holt das Token mit Authorization Code + PKCE und sendet es als
   `Authorization: Bearer <token>` an `GET/POST {base}/notes`.

Der Journal-Actor ist `oidc:<sub>` – damit ist jede Notiz einem Stable Subject des IdP
zugeordnet, ohne dass der Hub eine eigene User-Tabelle führt.

## Sicherheit

- **Kein Proxy-Header-Vertrauen.** `X-Forwarded-User`/`-Groups` werden für keine Entscheidung
  benutzt. Der Hub prüft die Signatur selbst.
- **Synchron geprüft.** JWKS wird beim Start geholt und alle 10 Minuten aktualisiert; pro Request
  genügt ein `crypto.verify` gegen den gecachten Public Key. Keine Runtime-Dependency, kein
  `node_modules` im Container.
- **Fail closed.** Ist der Provider beim Start nicht erreichbar, startet der Hub nicht. Ein
  unbekannter `kid` wird abgelehnt, bis die nächste Aktualisierung den Schlüssel liefert.
- **RS256 only.** EC-/EdDSA-Schlüssel im JWKS werden ignoriert.

## Grenzen

- `/admin` bleibt zunächst am `--admin-secret`.
- `/mcp` bleibt bei den HMAC-Geräte-Tokens.
- Kein Self-Service und keine Login-UI im Hub – das liegt beim IdP und bei deiner eigenen UI.
