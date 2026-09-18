import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

/**
 * BuilderPad web console (Vite).
 * Privy signTypedData uses Node `buffer` in the browser —
 * https://docs.privy.io/basics/troubleshooting/react-frameworks#vite
 *
 * Local / Vercel preview keep path routes / /create /t/:slug.
 * Production apps are `{slug}.builderpad.xyz`.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const proxyTarget = (env.VITE_PROXY_TARGET || 'http://127.0.0.1:8000').replace(/\/$/, '');
  return {
    plugins: [
      nodePolyfills({
        include: ['buffer', 'process'],
        globals: { Buffer: true, process: true, global: true },
      }),
      react(),
      tailwindcss(),
    ],
    optimizeDeps: {
      include: ['@privy-io/react-auth', 'buffer', 'lightweight-charts', '@nktkas/hyperliquid', 'viem'],
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: proxyTarget, changeOrigin: true },
      },
    },
    preview: {
      port: 5173,
    },
  };
});
