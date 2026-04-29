const BASE_URL = import.meta.env.VITE_API_URL || '/api';

const getToken = () => localStorage.getItem('clm_token');

const request = async (endpoint, options = {}) => {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${endpoint}`, { ...options, headers });

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
  list: (params = {}) => request(`/tasks?${new URLSearchParams(params)}`),
  get: (id) => request(`/tasks/${id}`),
  create: (data) => request('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id) => request(`/tasks/${id}`, { method: 'DELETE' }),
};

export const documents = {
  list: (params = {}) => request(`/documents?${new URLSearchParams(params)}`),
  get: (id) => request(`/documents/${id}`),
  upload: (formData) => uploadRequest('/documents/upload', formData),
  updateStatus: (id, status) => request(`/documents/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  lock: (id, password) => request(`/documents/${id}/lock`, { method: 'PUT', body: JSON.stringify({ password }) }),
  unlock: (id, password) => request(`/documents/${id}/unlock`, { method: 'POST', body: JSON.stringify({ password }) }),
  delete: (id) => request(`/documents/${id}`, { method: 'DELETE' }),
  downloadUrl: (id) => `${BASE_URL}/documents/${id}/download?token=${getToken()}`,
  getComments: (id) => request(`/documents/${id}/comments`),
  addComment: (id, data) => request(`/documents/${id}/comments`, { method: 'POST', body: JSON.stringify(data) }),
  resolveComment: (docId, commentId) => request(`/documents/${docId}/comments/${commentId}/resolve`, { method: 'PUT' }),
};

export const templates = {
  list: (params = {}) => request(`/templates?${new URLSearchParams(params)}`),
  get: (id) => request(`/templates/${id}`),
  upload: (formData) => uploadRequest('/templates/upload', formData),
  draft: (id, data) => request(`/templates/${id}/draft`, { method: 'POST', body: JSON.stringify(data) }),
  downloadUrl: (id) => `${BASE_URL}/templates/${id}/download?token=${getToken()}`,
  delete: (id) => request(`/templates/${id}`, { method: 'DELETE' }),
};

export const signing = {
  pending: () => request('/signing/pending'),
  getSignatures: (docId) => request(`/signing/${docId}/signatures`),
  sign: (docId, data) => request(`/signing/${docId}/sign`, { method: 'POST', body: JSON.stringify(data) }),
  requestSigning: (docId, data) => request(`/signing/${docId}/request`, { method: 'POST', body: JSON.stringify(data) }),
  auditTrail: (docId) => request(`/signing/${docId}/audit-trail`),
};

export const ai = {
  query: (query) => request('/ai/query', { method: 'POST', body: JSON.stringify({ query }) }),
  suggestions: () => request('/ai/suggestions'),
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
};

export const fileUrl = (filename) => `/${filename}`;
