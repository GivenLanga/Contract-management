import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getApiBaseUrl } from '../apiBase';

beforeEach(() => {
  delete window.contractiq;
  vi.unstubAllEnvs();
});

afterEach(() => {
  delete window.contractiq;
  vi.unstubAllEnvs();
});

describe('getApiBaseUrl', () => {
  it('returns /api when no env var and no desktop bridge', () => {
    expect(getApiBaseUrl()).toBe('/api');
  });

  it('returns VITE_API_BASE_URL when set, stripping trailing slash', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://remote.example.com/api/');
    expect(getApiBaseUrl()).toBe('http://remote.example.com/api');
  });

  it('returns VITE_API_BASE_URL without trailing slash unchanged', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://remote.example.com/api');
    expect(getApiBaseUrl()).toBe('http://remote.example.com/api');
  });

  it('falls back to VITE_API_URL when VITE_API_BASE_URL is absent', () => {
    vi.stubEnv('VITE_API_URL', 'http://legacy.example.com/api');
    expect(getApiBaseUrl()).toBe('http://legacy.example.com/api');
  });

  it('VITE_API_BASE_URL takes priority over VITE_API_URL', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://new.example.com/api');
    vi.stubEnv('VITE_API_URL', 'http://old.example.com/api');
    expect(getApiBaseUrl()).toBe('http://new.example.com/api');
  });

  it('returns desktop address when window.contractiq.isDesktop is true', () => {
    window.contractiq = { isDesktop: true };
    expect(getApiBaseUrl()).toBe('http://127.0.0.1:5000/api');
  });

  it('returns desktop address when window.contractiq.getDesktopStatus is a function', () => {
    window.contractiq = { getDesktopStatus: () => ({}) };
    expect(getApiBaseUrl()).toBe('http://127.0.0.1:5000/api');
  });

  it('desktop detection wins over VITE_API_URL so .env VITE_API_URL=/api does not mask Electron', () => {
    window.contractiq = { isDesktop: true };
    vi.stubEnv('VITE_API_URL', '/api');
    expect(getApiBaseUrl()).toBe('http://127.0.0.1:5000/api');
  });

  it('VITE_API_BASE_URL overrides desktop bridge', () => {
    window.contractiq = { isDesktop: true };
    vi.stubEnv('VITE_API_BASE_URL', 'http://custom.example.com/api');
    expect(getApiBaseUrl()).toBe('http://custom.example.com/api');
  });

  it('returns /api when window.contractiq exists but has no desktop markers', () => {
    window.contractiq = {};
    expect(getApiBaseUrl()).toBe('/api');
  });
});
