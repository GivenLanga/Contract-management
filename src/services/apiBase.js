// Central API base URL resolver.
//
// Priority:
//   1. VITE_API_BASE_URL   — explicit override (any environment, new var name)
//   2. window.contractiq   — Electron desktop detected at runtime
//   3. VITE_API_URL        — legacy var (kept for browser production deployments;
//                            intentionally ranked below desktop detection so that
//                            .env VITE_API_URL=/api doesn't mask the Electron path)
//   4. '/api'              — browser dev default (Vite proxy → localhost:5000)

export function getApiBaseUrl() {
  if (import.meta.env.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL.replace(/\/$/, '');
  }

  if (typeof window !== 'undefined' &&
      (window.contractiq?.isDesktop || typeof window.contractiq?.getDesktopStatus === 'function')) {
    return 'http://127.0.0.1:5000/api';
  }

  return import.meta.env.VITE_API_URL?.replace(/\/$/, '') || '/api';
}
