import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

export default defineConfig({
  integrations: [react()],
  output: 'static',
  // `site` is used for canonical URLs / sitemap generation. Override
  // via the PUBLIC_SITE env var or edit this file in your deployment.
  site: process.env.PUBLIC_SITE ?? 'https://monitor.example.com',
  server: { port: 4321, host: true },
  vite: {
    define: {
      'import.meta.env.PUBLIC_API_BASE': JSON.stringify(
        process.env.PUBLIC_API_BASE ?? '/api',
      ),
    },
  },
});
