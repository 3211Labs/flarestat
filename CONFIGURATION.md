# Configuration reference

Every configurable value in flarestat lives in one of two files, both gitignored:

| File | Template | Purpose |
|---|---|---|
| `packages/api/wrangler.toml` | `wrangler.toml.example` | Worker deploy config (name, domain, Access) |
| `packages/dashboard/src/config.ts` | `config.example.ts` | Dashboard runtime behaviour (billing day, brand, self-script) |

Two ways to populate them:

- **Manual deploy** — copy the templates locally, edit the values, `wrangler deploy`.
- **CI deploy** — the workflow at `.github/workflows/deploy.yml` materialises both files from repo secrets (`WORKER_NAME`, `CUSTOM_DOMAIN`, `CF_BILLING_DAY`, `BRAND_NAME`) at build time, so the repo stays share-safe.

---

## `wrangler.toml`

| Key | Example | Notes |
|---|---|---|
| `name` | `flarestat` | Script name. Must match `selfScriptName` in `config.ts` so the Home "Self" card identifies the dashboard's own Worker. |
| `routes[].pattern` | `monitor.example.com` | Custom domain. With `custom_domain = true`, wrangler auto-provisions DNS on deploy. |
| `vars.EXTRA_CORS_ORIGINS` | `http://localhost:3000,https://alt-domain.example.com` | Optional comma-separated list of origins that can send credentialed CORS requests. Same-origin traffic never needs to be listed. |

### Secrets (set via `wrangler secret put`)

All sensitive runtime config lives on the Worker itself in Cloudflare,
never in `wrangler.toml` or anywhere in the repo. This means public
forks can share the same TOML without leaking anything.

| Secret | Required | Purpose |
|---|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | yes | Your Zero Trust team URL, e.g. `https://yourteam.cloudflareaccess.com`. Used by `jose` to fetch the JWKS for validating Access JWTs. |
| `CF_ACCESS_AUD` | yes | AUD tag of the Access application protecting the dashboard. From Zero Trust → Access → Applications → yours. |
| `CF_API_TOKEN` | yes | Read-only Cloudflare API token — see README for the exact scope list. |
| `CF_ACCOUNT_ID` | yes | Your Cloudflare account ID. |
| `ANTHROPIC_ADMIN_KEY` | no | `sk-ant-admin-…` from the Anthropic Console. If unset, the AI tab and per-app Anthropic cost cards will simply show no data. |

---

## `config.ts`

```ts
export const CONFIG = {
  selfScriptName: 'flarestat',  // must match wrangler.toml `name`
  cfBillingDay: 1,              // 1..31
  brandName: 'flarestat',       // shown in header + PWA title
} as const;
```

### `selfScriptName`

The Home screen renders a "Self · this dashboard" card showing the monitoring Worker's own invocations + latest deploy. This value must exactly match the `name` in `wrangler.toml` or the card will show zero data.

### `cfBillingDay`

The Billing screen's rolling-rate projection and "Cycle MM-DD → MM-DD" label pivot on this day. Typically matches your Cloudflare signup date. If unsure, check a past invoice — the issue date is your billing day.

### `brandName`

Appears in:
- The page header on Home (`"<brandName>"`)
- Every `<title>` tag (`"Home · <brandName>"`)
- The Settings page

---

## Apps auto-detection rules

The Apps tab groups Workers into "apps" by stripping common suffixes from the Worker script name:

```
-api  -worker  -app  -frontend  -backend  -cron
-prod  -production  -staging  -dev  -development
```

So `the-edge-api` and `the-edge-frontend` both map to the app id `the-edge`.

### Matching Anthropic keys + AI Gateways

For each detected app, any Anthropic API key or AI Gateway whose **name contains the app id** gets auto-linked. Example: the app id `the-edge` auto-links a key named `the-edge-prod-key` or a gateway called `the-edge-main`.

### Overriding the auto-detection

Tap the ⚙ icon on any tile to open Edit mode. Tick / untick individual Workers, keys, and gateways. Your overrides are stored in `localStorage` under `flarestat:apps-overrides:v1` and survive across refreshes (per browser, not synced across devices).

Auto-detection still runs on every load — your overrides layer on top, so removing a Worker from CF makes it disappear from its linked app automatically.

---

## Leak-check CI

`.github/workflows/leak-check.yml` greps the repo for a list of forbidden strings on every push. Extend `PATTERNS` in that file as you add new sensitive values to your deployment:

```yaml
PATTERNS=(
  'my-company-internal'
  'sk-ant-admin-[[:alnum:]]\{10\}'  # real Anthropic admin keys; prose mentions of the prefix are OK
  # Add your own account-specific strings here
)
```

Anything matched fails the build, so you can't accidentally commit a hardcoded token or account ID.
