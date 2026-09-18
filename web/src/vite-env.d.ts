/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PRIVY_APP_ID?: string;
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_TENANT_BASE_DOMAIN?: string;
  readonly VITE_TENANT_PUBLIC_ORIGIN?: string;
  readonly VITE_ARBITRUM_RPC_URL?: string;
  readonly VITE_ROBINHOOD_RPC_URL?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  Buffer: typeof import('buffer').Buffer;
}
