/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the HiveDesk server (REST + Socket.io). */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
