import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { auth as authApi } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('clm_token');
    const saved = localStorage.getItem('clm_user');
    if (token && saved) {
      try {
        setUser(JSON.parse(saved));
      } catch {}
    }
    setLoading(false);
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await authApi.login(email, password);
    localStorage.setItem('clm_token', data.token);
    localStorage.setItem('clm_user', JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('clm_token');
    localStorage.removeItem('clm_user');
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const data = await authApi.me();
      localStorage.setItem('clm_user', JSON.stringify(data.user));
      setUser(data.user);
    } catch {}
  }, []);

  const isAdmin = user?.role === 'admin';
  const isManager = ['admin', 'manager'].includes(user?.role);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser, isAdmin, isManager }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
};
