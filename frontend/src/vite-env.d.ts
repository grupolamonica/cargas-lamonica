/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ROUTE_INFO_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
