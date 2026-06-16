import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  define: {
    __TTRPG_PORT__: JSON.stringify(process.env.TTRPG_PORT ?? '8420'),
  },
  server: {
    port: Number(process.env.TTRPG_CLIENT_PORT ?? 5173),
  },
});
