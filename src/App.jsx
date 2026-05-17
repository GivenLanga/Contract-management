import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { NotificationProvider } from './context/NotificationContext';
import {
  LEGAL_FOLDER_LIFECYCLE_NOTIFICATION,
  subscribeToDesktopLifecycleIndex,
  syncLifecycleIndexFromDesktop,
} from './services/legalFolderStore';

import Sidebar from './components/Layout/Sidebar';
import Dashboard from './components/Dashboard/Dashboard';
import ContractList from './components/Contracts/ContractList';
import ContractDetail from './components/Contracts/ContractDetail';
import ContractForm from './components/Contracts/ContractForm';
import Templates from './components/Templates/Templates';
import Workflows from './components/Workflows/Workflows';
import Reports from './components/Reports/Reports';
import Settings from './components/Settings/Settings';

import Login from './components/Auth/Login';
import TaskList from './components/Tasks/TaskList';
import LegalFolder from './components/Documents/LegalFolder';
import SigningDashboard from './components/Signing/SigningDashboard';
import SigningViewer from './components/Signing/SigningViewer';
import SigningEnvelope from './components/Signing/SigningEnvelope';
import ExternalSigningPage from './components/Signing/ExternalSigningPage';
import AIAssistant from './components/AI/AIAssistant';
import NotificationCenter from './components/Notifications/NotificationCenter';
import IntakeForm from './components/LegalRequests/IntakeForm';
import LegalRequestList from './components/LegalRequests/LegalRequestList';
import LegalRequestDetail from './components/LegalRequests/LegalRequestDetail';

import './App.css';

function AppShell() {
  const { user } = useAuth();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [lifecycleToast, setLifecycleToast] = useState('');

  useEffect(() => {
    if (!user) return undefined;
    const unsubscribe = subscribeToDesktopLifecycleIndex();
    syncLifecycleIndexFromDesktop().catch(() => {});
    return unsubscribe;
  }, [user]);

  useEffect(() => {
    if (!user) return undefined;
    const onNotification = (event) => {
      const message = event.detail?.message;
      if (!message) return;
      setLifecycleToast(message);
      setTimeout(() => setLifecycleToast(''), 5000);
    };
    window.addEventListener(LEGAL_FOLDER_LIFECYCLE_NOTIFICATION, onNotification);
    return () => window.removeEventListener(LEGAL_FOLDER_LIFECYCLE_NOTIFICATION, onNotification);
  }, [user]);

  if (!user) {
    return (
      <Routes>
        <Route path="/sign/external/:token" element={<ExternalSigningPage />} />
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <NotificationProvider>
      <Routes>
        {/* Public standalone route — no sidebar, no shell */}
        <Route path="/sign/external/:token" element={<ExternalSigningPage />} />

        {/* All authenticated routes wrapped in the sidebar shell */}
        <Route path="*" element={
          <div className="app">
            <Sidebar
              collapsed={sidebarCollapsed}
              onToggle={() => setSidebarCollapsed((c) => !c)}
            />
            <main className="app__main">
              {lifecycleToast && (
                <div className="app__lifecycle-toast" role="status">
                  {lifecycleToast}
                </div>
              )}
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/contracts" element={<ContractList />} />
                <Route path="/contracts/new" element={<ContractForm />} />
                <Route path="/contracts/:id" element={<ContractDetail />} />
                <Route path="/contracts/:id/edit" element={<ContractForm />} />
                <Route path="/templates" element={<Templates />} />
                <Route path="/workflows" element={<Workflows />} />
                <Route path="/tasks" element={<TaskList />} />
                <Route path="/legal-folder" element={<LegalFolder />} />
                <Route path="/signing" element={<SigningDashboard />} />
                <Route path="/signing/view/:docId" element={<SigningViewer />} />
                <Route path="/signing/envelope/:docId" element={<SigningEnvelope />} />
                <Route path="/ai" element={<AIAssistant />} />
                <Route path="/notifications" element={<NotificationCenter />} />
                <Route path="/reports" element={<Reports />} />
                <Route path="/legal-requests"      element={<LegalRequestList />} />
                <Route path="/legal-requests/new" element={<IntakeForm />} />
                <Route path="/legal-requests/:id" element={<LegalRequestDetail />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/login" element={<Navigate to="/" replace />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </main>
          </div>
        } />
      </Routes>
    </NotificationProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </BrowserRouter>
  );
}
