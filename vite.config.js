import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'client',
  define: {
    __TTRPG_PORT__: JSON.stringify(process.env.TTRPG_PORT ?? '8420'),
  },
  server: {
    port: Number(process.env.TTRPG_CLIENT_PORT ?? 5173),
  },
  build: {
    // Multi-page: the player client (index.html) + the DMView (dm.html).
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./client/index.html', import.meta.url)),
        dm: fileURLToPath(new URL('./client/dm.html', import.meta.url)),
      },
    },
  },
});
