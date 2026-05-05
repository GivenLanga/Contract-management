import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { NotificationProvider } from './context/NotificationContext';

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

import './App.css';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="app-loading">Loading ContractIQ...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function AppShell() {
  const { user } = useAuth();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
