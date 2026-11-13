/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_DATA_SOURCE?: 'mock' | 'api';
  readonly VITE_API_BASE?: string;
  readonly VITE_WS_URL?: string;
  readonly VITE_ALLOW_MOCK_IN_PRODUCTION?: string;
}
