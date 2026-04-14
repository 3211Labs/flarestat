// flarestat dashboard config.
//
// Copy this file to `config.ts` and adjust for your deployment.
// `config.ts` is gitignored so your local values never get committed.

export const CONFIG = {
  // The script name of the Worker running this dashboard — must match
  // `name` in packages/api/wrangler.toml. Used on the Home screen to
  // render a "Self" card with the dashboard Worker's own metrics.
  selfScriptName: 'flarestat',

  // Day of the month your Cloudflare Workers Paid billing cycle
  // starts. Typically matches your signup date. Shown in the Billing
  // screen as "cycle MM-DD → MM-DD" and drives the rolling-rate
  // projection.
  cfBillingDay: 1,

  // Optional: display name shown in the page header / PWA title.
  brandName: 'flarestat',
} as const;
