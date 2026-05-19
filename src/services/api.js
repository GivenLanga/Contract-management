import { getApiBaseUrl } from './apiBase';
const BASE_URL = getApiBaseUrl();

const getToken = () => localStorage.getItem('clm_token');

const request = async (endpoint, options = {}) => {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${endpoint}`, { ...options, headers }).catch((err) => {
    throw Object.assign(
      new Error('ContractIQ backend is not running. Start the local backend service and try again.'),
      { cause: err }
    );
  });

  if (res.status === 401) {
    localStorage.removeItem('clm_token');
    localStorage.removeItem('clm_user');
    window.location.href = '/login';
    return;
  }

  const data = await res.json().catch(() => ({ error: 'Invalid server response' }));
  if (!res.ok) throw new Error(data.error || data.errors?.[0]?.msg || 'Request failed');
  return data;
};

const uploadRequest = async (endpoint, formData) => {
  const token = getToken();
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers,
    body: formData,
  }).catch((err) => {
    throw Object.assign(
      new Error('ContractIQ backend is not running. Start the local backend service and try again.'),
      { cause: err }
    );
  });

  if (res.status === 401) {
    localStorage.removeItem('clm_token');
    window.location.href = '/login';
    return;
  }

  const data = await res.json().catch(() => ({ error: 'Invalid server response' }));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
};

const filenameFromDisposition = (value) => {
  const header = String(value || '');
  const utfMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch) return decodeURIComponent(utfMatch[1].replace(/"/g, ''));
  const match = header.match(/filename="?([^";]+)"?/i);
  return match ? match[1] : '';
};

const fileRequest = async (endpoint) => {
  const token = getToken();
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${endpoint}`, { headers }).catch((err) => {
    throw Object.assign(
      new Error('ContractIQ backend is not running. Start the local backend service and try again.'),
      { cause: err }
    );
  });

  if (res.status === 401) {
    localStorage.removeItem('clm_token');
    localStorage.removeItem('clm_user');
    window.location.href = '/login';
    return null;
  }

  if (!res.ok) {
    const message = await res.text();
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      data = null;
    }
    throw new Error(data?.error || message || 'Download failed');
  }

  return {
    blob: await res.blob(),
    filename: filenameFromDisposition(res.headers.get('Content-Disposition')),
  };
};

export const auth = {
  login: (email, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (data) => request('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
  me: () => request('/auth/me'),
  users: () => request('/auth/users'),
  updateProfile: (data) => request('/auth/profile', { method: 'PUT', body: JSON.stringify(data) }),
};

export const contracts = {
  list: (params = {}) => request(`/contracts?${new URLSearchParams(params)}`),
  get: (id) => request(`/contracts/${id}`),
  create: (data) => request('/contracts', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => request(`/contracts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  approve: (id, data) => request(`/contracts/${id}/approve`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id) => request(`/contracts/${id}`, { method: 'DELETE' }),
};

export const tasks = {
  list:             (params = {}) => request(`/tasks?${new URLSearchParams(params)}`),
  get:              (id) => request(`/tasks/${id}`),
  stats:            () => request('/tasks/stats'),
  create:           (data) => request('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  update:           (id, data) => request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete:           (id) => request(`/tasks/${id}`, { method: 'DELETE' }),
  findByTrackerKey: (trackerRowKey) => request(`/tasks?${new URLSearchParams({ trackerRowKey, limit: 1 })}`),
  findBySourceType: (sourceType, extra = {}) => request(`/tasks?${new URLSearchParams({ sourceType, ...extra })}`),
};

export const documents = {
  list: (params = {}) => request(`/documents?${new URLSearchParams(params)}`),
  get: (id) => request(`/documents/${id}`),
  upload: (formData) => uploadRequest('/documents/upload', formData),
  updateStatus: (id, status) => request(`/documents/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  lock: (id, password) => request(`/documents/${id}/lock`, { method: 'PUT', body: JSON.stringify({ password }) }),
  unlock: (id, password) => request(`/documents/${id}/unlock`, { method: 'POST', body: JSON.stringify({ password }) }),
  delete: (id) => request(`/documents/${id}`, { method: 'DELETE' }),
  viewUrl: (id) => `${BASE_URL}/documents/${id}/view?token=${encodeURIComponent(getToken() || '')}`,
  downloadUrl: (id) => `${BASE_URL}/documents/${id}/download?token=${getToken()}`,
  getComments: (id) => request(`/documents/${id}/comments`),
  addComment: (id, data) => request(`/documents/${id}/comments`, { method: 'POST', body: JSON.stringify(data) }),
  resolveComment: (docId, commentId) => request(`/documents/${docId}/comments/${commentId}/resolve`, { method: 'PUT' }),
};

export const templates = {
  list: (params = {}) => request(`/templates?${new URLSearchParams(params)}`),
  get: (id) => request(`/templates/${id}`),
  facets: () => request('/templates/facets'),
  upload: (formData) => uploadRequest('/templates', formData),
  uploadLegacy: (formData) => uploadRequest('/templates/upload', formData),
  discover: (candidates = [], legalFolderSource = null) => request('/templates/discover', { method: 'POST', body: JSON.stringify({ candidates, legalFolderSource }) }),
  disconnectSource: (legalFolderSourceId) => request('/templates/disconnect-source', { method: 'POST', body: JSON.stringify({ legalFolderSourceId }) }),
  diagnostics: () => request('/templates/diagnostics'),
  draft: (id, data) => request(`/templates/${id}/draft`, { method: 'POST', body: JSON.stringify(data) }),
  // createDraft handles 409 TEMPLATE_FILE_UNAVAILABLE as a typed error so the
  // frontend can show a specific "file not available" state without losing the code.
  createDraft: async (templateId, payload) => {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${BASE_URL}/templates/${encodeURIComponent(templateId)}/draft`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (res.status === 401) {
      localStorage.removeItem('clm_token');
      localStorage.removeItem('clm_user');
      window.location.href = '/login';
      return;
    }

    const data = await res.json().catch(() => ({ error: 'Invalid server response' }));

    if (res.status === 409) {
      const err = new Error(data.message || 'Template file unavailable for drafting.');
      err.code = data.code;
      err.status = 409;
      err.actions = data.actions;
      throw err;
    }

    if (!res.ok) throw new Error(data.error || 'Failed to create draft.');
    return data;
  },
  downloadUrl: (id) => `${BASE_URL}/templates/${id}/download?token=${getToken()}`,
  delete: (id) => request(`/templates/${id}`, { method: 'DELETE' }),
};

export const signing = {
  pending: () => request('/signing/pending'),
  prepare: (docId, data) => request(`/signing/${docId}/prepare`, { method: 'POST', body: JSON.stringify(data) }),
  getSignatures: (docId) => request(`/signing/${docId}/signatures`),
  sign: (docId, data) => request(`/signing/${docId}/sign`, { method: 'POST', body: JSON.stringify(data) }),
  requestSigning: (docId, data) => request(`/signing/${docId}/request`, { method: 'POST', body: JSON.stringify(data) }),
  ronSession: (docId, data) => request(`/signing/${docId}/ron/session`, { method: 'POST', body: JSON.stringify(data) }),
  ronRecording: (docId, formData) => uploadRequest(`/signing/${docId}/ron/recording`, formData),
  ronStamp: (docId, formData) => uploadRequest(`/signing/${docId}/ron/stamp`, formData),
  auditTrail: (docId) => request(`/signing/${docId}/audit-trail`),
  completionCertificate: (docId) => fileRequest(`/signing/${docId}/completion-certificate`),
  remind: (docId, signerEmail) => request(`/signing/${docId}/remind/${encodeURIComponent(signerEmail)}`, { method: 'POST', body: JSON.stringify({}) }),
  reject: (docId, reason) => request(`/signing/${docId}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
  metadata: (docId) => request(`/signing/${docId}/metadata`),
  publicSignerInfo: (token) => request(`/signing/public/sign/${token}`),
  publicSign: (token, data) => request(`/signing/public/sign/${token}`, { method: 'POST', body: JSON.stringify(data) }),
  rejectViaToken: (token, reason) => request(`/signing/reject-token/${token}`, { method: 'POST', body: JSON.stringify({ reason }) }),
};

export const ai = {
  chat: (message, sessionId) => request('/ai/chat', { method: 'POST', body: JSON.stringify({ message, sessionId }) }),
  confirm: (confirmationId) => request('/ai/confirm', { method: 'POST', body: JSON.stringify({ confirmationId }) }),
  clearSession: (sessionId) => request(`/ai/session?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
  suggestions: () => request('/ai/suggestions'),
  health: () => request('/ai/health'),
  status: () => request('/ai/status'),
  models: () => request('/ai/models'),
  downloadModel: (modelId) => request(`/ai/models/${encodeURIComponent(modelId)}/download`, { method: 'POST' }),
  cancelDownload: (modelId) => request(`/ai/models/${encodeURIComponent(modelId)}/download/cancel`, { method: 'POST' }),
  verifyModel: (modelId) => request(`/ai/models/${encodeURIComponent(modelId)}/verify`, { method: 'POST' }),
  start: (modelId) => request('/ai/start', { method: 'POST', body: JSON.stringify({ modelId }) }),
  stop: () => request('/ai/stop', { method: 'POST' }),
  disable: () => request('/ai/disable', { method: 'POST' }),
  enable: () => request('/ai/enable', { method: 'POST' }),
  syncLegalFolderRag: (data) => request('/ai/rag/legal-folder/sync', { method: 'POST', body: JSON.stringify(data) }),
  legalFolderRagStatus: () => request('/ai/rag/legal-folder/status'),
  syncSigningState: (data) => request('/ai/signing-state/sync', { method: 'POST', body: JSON.stringify(data) }),
  signingStateStatus: () => request('/ai/signing-state/status'),
  backendRagStatus: () => request('/ai/rag/backend/status'),
  reindexBackendRag: () => request('/ai/rag/backend/reindex', { method: 'POST' }),
  // Legacy
  query: (query) => request('/ai/query', { method: 'POST', body: JSON.stringify({ query }) }),
};

export const notifications = {
  list: (params = {}) => request(`/notifications?${new URLSearchParams(params)}`),
  markRead: (id) => request(`/notifications/${id}/read`, { method: 'PUT' }),
  markAllRead: () => request('/notifications/read-all', { method: 'PUT' }),
  delete: (id) => request(`/notifications/${id}`, { method: 'DELETE' }),
};

export const reports = {
  tasks: (params = {}) => request(`/reports/tasks?${new URLSearchParams(params)}`),
  contracts: () => request('/reports/contracts'),
  audit: (params = {}) => request(`/reports/audit?${new URLSearchParams(params)}`),
  kpis: () => request('/reports/kpis'),
  summary: (params = {}) => request(`/reports/summary?${new URLSearchParams(params)}`),
};

export const fileUrl = (filename) => `/${filename}`;
