import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function ngrokOrigin(value: string | undefined) {
  if (!value?.trim()) return '';
  const parsed = new URL(value.trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('NGROK_URL must be an HTTP(S) origin without a path, query, or fragment.');
  }
  return parsed.origin;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repositoryRoot, '');
  const backendOrigin = ngrokOrigin(env.NGROK_URL || env.VITE_API_BASE_URL);
  const developmentProxySecret = env.TUTUPBUKU_DEV_PROXY_SECRET?.trim();
  if (mode === 'production' && !backendOrigin) {
    throw new Error('Set NGROK_URL (or VITE_API_BASE_URL) to the backend HTTPS origin before building the frontend.');
  }
  if (mode !== 'production' && backendOrigin && !developmentProxySecret) {
    throw new Error('Set TUTUPBUKU_DEV_PROXY_SECRET in the repository .env before using the ngrok backend from the local frontend.');
  }

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(mode === 'production' ? backendOrigin : ''),
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': {
          target: backendOrigin || 'http://127.0.0.1:3000',
          changeOrigin: true,
          secure: true,
          ...(backendOrigin ? { headers: { 'ngrok-skip-browser-warning': 'true', 'x-tutupbuku-dev-proxy': developmentProxySecret! } } : {}),
        },
        '/month-end-api': {
          target: 'http://127.0.0.1:8765',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/month-end-api/u, '/api'),
        },
      },
    },
  };
});
