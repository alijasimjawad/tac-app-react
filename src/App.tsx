import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import AppLayout from './components/AppLayout';
import Login from './pages/Login';
import MyAttendance from './pages/MyAttendance';
import DailyActivities from './pages/DailyActivities';
import SitesDB from './pages/SitesDB';
import Dashboard from './pages/Dashboard';
import MyExpenses from './pages/MyExpenses';
import MyTrips from './pages/MyTrips';
import LiveTrips from './pages/LiveTrips';
import RoutePlanner from './pages/RoutePlanner';
import HrProfiles from './pages/HrProfiles';
import AttendanceAdmin from './pages/AttendanceAdmin';
import NetworkScopes from './pages/NetworkScopes';
import SiteLookup from './pages/SiteLookup';
import FinTeam from './pages/FinTeam';
import FinRevenue from './pages/FinRevenue';
import FinGenExp from './pages/FinGenExp';
import FinProjExp from './pages/FinProjExp';
import FinDashboard from './pages/FinDashboard';
import FinReport from './pages/FinReport';
import FinClients from './pages/FinClients';
import FinInvoices from './pages/FinInvoices';
import FinExpClaims from './pages/FinExpClaims';
import ActivityLog from './pages/ActivityLog';
import UserManagement from './pages/UserManagement';
import BackupRestore from './pages/BackupRestore';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/attendance"        element={<MyAttendance />} />
            <Route path="/my-expenses"      element={<MyExpenses />} />
            <Route path="/my-trips"         element={<MyTrips />} />
            <Route path="/live-trips"       element={<LiveTrips />} />
            <Route path="/route-planner"    element={<RoutePlanner />} />
            <Route path="/daily-activities" element={<DailyActivities />} />
            <Route path="/sites-db"         element={<SitesDB />} />
            <Route path="/hr-profiles"          element={<HrProfiles />} />
            <Route path="/attendance-admin"          element={<AttendanceAdmin />} />
            <Route path="/network-scopes/:proj/:sec" element={<NetworkScopes />} />
            <Route path="/network-scopes"            element={<NetworkScopes />} />
            <Route path="/site-lookup"               element={<SiteLookup />} />
            <Route path="/finance/team"              element={<FinTeam />} />
            <Route path="/finance/revenue"           element={<FinRevenue />} />
            <Route path="/finance/general-expenses"  element={<FinGenExp />} />
            <Route path="/finance/project-expenses"  element={<FinProjExp />} />
            <Route path="/finance/dashboard"          element={<FinDashboard />} />
            <Route path="/finance/monthly-report"     element={<FinReport />} />
            <Route path="/finance/clients"            element={<FinClients />} />
            <Route path="/finance/invoices"           element={<FinInvoices />} />
            <Route path="/finance/expense-claims"     element={<FinExpClaims />} />
            <Route path="/activity-log"              element={<ActivityLog />} />
            <Route path="/user-management"           element={<UserManagement />} />
            <Route path="/backup-restore"            element={<BackupRestore />} />
            <Route path="/dashboard"                 element={<Dashboard />} />
            <Route path="/"           element={<Navigate to="/attendance" replace />} />
          </Route>
          <Route path="*" element={<Navigate to="/attendance" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
