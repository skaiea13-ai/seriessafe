import { defineConfig } from 'vite';

/**
 * `base` follows the deploy target: GitHub Pages serves the site from
 * /seriessafe/, while local dev and any root-domain host serve from /.
 */
export default defineConfig({
  base: process.env.DEPLOY_BASE ?? '/',
  build: { target: 'es2022', sourcemap: true },
});
