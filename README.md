# flarestat

A self-hosted monitoring PWA for your Cloudflare stack + Anthropic spend. One Worker serves both the JSON API and the Astro dashboard, gated by Cloudflare Access.

**What you get per app:**
- Auto-grouped Workers, D1, KV, R2, AI Gateway, and Anthropic API keys into "apps"
- Square-tile grid view with invocation sparklines
- Per-app detail pages: Traffic · Compute · Storage · IO · AI
- Click-to-link UI for overriding auto-detection
- 24h error log browser with dedupe + count
- Billing page with rolling-rate projection vs tier limits

---

## Prerequisites

1. Cloudflare account on the **Workers Paid plan** ($5/mo)
2. A custom domain on Cloudflare (for Access to protect the dashboard)
3. Cloudflare Zero Trust enabled (free tier is fine)
4. `pnpm` + Node 20+ locally
5. (Optional) Anthropic Admin API key for per-app spend tracking

---

## Quickstart

```bash
git clone https://github.com/3211Labs/flarestat
cd flarestat
pnpm install
```

### 1. Create the Cloudflare Access application

In the Cloudflare dashboard:

- **Zero Trust → Access → Applications → Add an application**
- Type: **Self-hosted**
- Application domain: `monitor.yourdomain.com` (whatever you want)
- Identity provider: **One-time PIN** (or Google, GitHub, etc.)
- Policy: **allow**, include rule → **Email** → your email

Copy the **AUD tag** from the Access application overview — you'll need it in a moment.

### 2. Create a Cloudflare API token

**My Profile → API Tokens → Create Token → Custom token**

Required read permissions (scope: your account):
- Account Analytics · Read
- Account Settings · Read
- Workers Scripts · Read
- Workers Observability · Read
- D1 · Read
- Workers R2 Storage · Read
- Workers KV Storage · Read
- Pages · Read
- Billing · Read
- AI Gateway · Read
- Zone Analytics · Read (include all zones)

### 3. Configure locally

```bash
cp packages/api/wrangler.toml.example packages/api/wrangler.toml
cp packages/dashboard/src/config.example.ts packages/dashboard/src/config.ts
```

Edit `packages/api/wrangler.toml`:
- `name` — what you want the Worker called
- `routes[].pattern` — your custom domain, e.g. `monitor.yourdomain.com`

**Leave the `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` blocks out** — those
are set as Cloudflare secrets in step 4, not as `[vars]` in the TOML.

Edit `packages/dashboard/src/config.ts`:
- `selfScriptName` — must match `name` in `wrangler.toml`
- `cfBillingDay` — day of month your CF billing cycle starts
- `brandName` — whatever you want in the header

### 4. First deploy (creates the Worker)

```bash
# from the repo root
pnpm --filter @flarestat/dashboard build
cd packages/api && npx wrangler deploy
```

Wrangler will prompt for `wrangler login` on first run — follow the
browser flow. After deploy, your Worker exists on Cloudflare but will
return `401` on API routes until the next step adds the auth config.

### 5. Set Cloudflare secrets

All sensitive runtime config lives on the Worker itself in Cloudflare —
never in the repo. These attach to the Worker you just deployed.

```bash
# still in packages/api

# Auth credentials
npx wrangler secret put CF_API_TOKEN         # token from step 2
npx wrangler secret put CF_ACCOUNT_ID        # your CF account ID

# Access config (from step 1)
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN  # https://yourteam.cloudflareaccess.com
npx wrangler secret put CF_ACCESS_AUD          # the AUD tag

# Optional — enables AI tab + Anthropic spend tracking
npx wrangler secret put ANTHROPIC_ADMIN_KEY  # sk-ant-admin-...
```

Secrets apply to the running Worker immediately — no redeploy needed.

### 6. Visit your dashboard

`https://monitor.yourdomain.com` — Access will prompt for login (email OTP by default), then the dashboard loads.

---

## Continuous deployment

If you want GitHub Actions to auto-deploy on push to `main`:

1. Create a second API token with **Workers Scripts: Edit** (or use "Edit Cloudflare Workers" template)
2. Add these to your repo's **Settings → Secrets and variables → Actions**:

   **Secrets** (encrypted, never visible even when the repo is public):
   - `CLOUDFLARE_API_TOKEN` — the write-capable token
   - `CLOUDFLARE_ACCOUNT_ID`
   - `WORKER_NAME` — same as `name` in your local `wrangler.toml`
   - `CUSTOM_DOMAIN` — e.g. `monitor.yourdomain.com`
   - `CF_BILLING_DAY` — e.g. `1`
   - `BRAND_NAME` — e.g. `flarestat`

   No GitHub variables needed — everything is a secret so nothing about
   your deployment is ever exposed in the public UI. The Worker's runtime
   config (Access team domain + AUD, API tokens) stays in Cloudflare via
   `wrangler secret put` and never touches this workflow.

The workflow at `.github/workflows/deploy.yml` generates `wrangler.toml` and `config.ts` from these values at build time, so nothing sensitive hits the repo.

---

## Configuration reference

See [`CONFIGURATION.md`](CONFIGURATION.md) for every knob, including the Apps auto-detection rules and how to customise them.

---

## License

MIT — see [`LICENSE`](LICENSE).
