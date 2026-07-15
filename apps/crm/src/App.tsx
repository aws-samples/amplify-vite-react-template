import {
  BrowserRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
} from "react-router-dom";
import { Authenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import type { ReactNode } from "react";
import { myGroupIds, RolesProvider, useRoles } from "./lib/auth";
import { Button, EmptyState, Spinner } from "./ui/kit";
import { signOut } from "aws-amplify/auth";

import Dashboard from "./office/Dashboard";
import Leads from "./office/Leads";
import Customers from "./office/Customers";
import CustomerDetail from "./office/CustomerDetail";
import GroupDetail from "./office/GroupDetail";
import PlanTemplates from "./office/PlanTemplates";
import Schedule from "./office/Schedule";
import More from "./pages/More";
import TechToday from "./tech/Today";
import TechJob from "./tech/JobDetail";
import PortalHome from "./portal/Home";
import PortalDocs from "./portal/Docs";
import PortalBilling from "./portal/Billing";
import PortalGroup from "./portal/Group";
import SignPage from "./sign/SignPage";

export default function App({ backendReady }: { backendReady: boolean }) {
  if (!backendReady) {
    return (
      <div className="auth-shell">
        <EmptyState
          title="CRM is not configured"
          body="amplify_outputs.json is missing. Run `npm run outputs` locally, or check the Amplify build."
        />
      </div>
    );
  }
  return (
    <BrowserRouter>
      <Routes>
        {/* Public e-sign page — leads sign before they have a login. */}
        <Route path="/sign/:token" element={<SignPage />} />
        <Route path="/*" element={<AuthedApp />} />
      </Routes>
    </BrowserRouter>
  );
}

function AuthHeader() {
  return (
    <div className="auth-brand">
      <h1>BuzzKill CRM</h1>
      <p>Sign in with your BuzzKill account</p>
    </div>
  );
}

function AuthedApp() {
  return (
    <Authenticator hideSignUp components={{ Header: AuthHeader }}>
      <RolesProvider>
        <Shell />
      </RolesProvider>
    </Authenticator>
  );
}

function Require({ when, children }: { when: boolean; children: ReactNode }) {
  return when ? <>{children}</> : <Navigate to="/" replace />;
}

function Shell() {
  const roles = useRoles();
  if (roles.loading) return <Spinner label="Loading your account…" />;

  if (!roles.office && !roles.tech && !roles.customer) {
    return (
      <div className="auth-shell">
        <EmptyState
          title="Account not set up yet"
          body="Your login works, but no role has been assigned. Ask the BuzzKill office to finish setting up your account."
          action={
            <Button variant="ghost" onClick={() => void signOut()}>
              Sign out
            </Button>
          }
        />
      </div>
    );
  }

  const staff = roles.office;
  const techOnly = roles.tech && !roles.office && !roles.customer;
  const customerOnly = roles.customer && !roles.office && !roles.tech;

  return (
    <div className="app-frame">
      <Routes>
        <Route path="/" element={<HomeRedirect />} />

        {/* Office */}
        <Route path="/dashboard" element={<Require when={staff}><Dashboard /></Require>} />
        <Route path="/leads" element={<Require when={staff}><Leads /></Require>} />
        <Route path="/customers" element={<Require when={staff}><Customers /></Require>} />
        <Route path="/customers/:id" element={<Require when={staff || roles.tech}><CustomerDetail /></Require>} />
        <Route path="/groups/:id" element={<Require when={staff}><GroupDetail /></Require>} />
        <Route path="/schedule" element={<Require when={staff}><Schedule /></Require>} />
        <Route path="/templates" element={<Require when={staff}><PlanTemplates /></Require>} />

        {/* Technician */}
        <Route path="/tech" element={<Require when={roles.tech || staff}><TechToday /></Require>} />
        <Route path="/tech/job/:jobId" element={<Require when={roles.tech || staff}><TechJob /></Require>} />

        {/* Customer portal */}
        <Route path="/portal" element={<Require when={roles.customer}><PortalHome /></Require>} />
        <Route path="/portal/docs" element={<Require when={roles.customer}><PortalDocs /></Require>} />
        <Route path="/portal/billing" element={<Require when={roles.customer}><PortalBilling /></Require>} />
        <Route path="/portal/group" element={<Require when={roles.customer}><PortalGroup /></Require>} />

        <Route path="/more" element={<More />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <nav className="tabbar">
        <div className="tabbar-inner">
          {staff ? (
            <>
              <Tab to="/dashboard" icon="📊" label="Dashboard" />
              <Tab to="/leads" icon="✨" label="Leads" />
              <Tab to="/customers" icon="👥" label="Customers" />
              <Tab to="/schedule" icon="📅" label="Schedule" />
              <Tab to="/more" icon="⋯" label="More" />
            </>
          ) : techOnly ? (
            <>
              <Tab to="/tech" icon="🚐" label="Today" />
              <Tab to="/more" icon="⋯" label="More" />
            </>
          ) : customerOnly ? (
            <>
              <Tab to="/portal" icon="🏠" label="Home" />
              <Tab to="/portal/docs" icon="📄" label="Documents" />
              <Tab to="/portal/billing" icon="💳" label="Billing" />
              {myGroupIds(roles).length > 0 ? (
                <Tab to="/portal/group" icon="🏢" label="Group" />
              ) : null}
              <Tab to="/more" icon="⋯" label="More" />
            </>
          ) : null}
        </div>
      </nav>
    </div>
  );
}

function Tab({ to, icon, label }: { to: string; icon: string; label: string }) {
  return (
    <NavLink to={to} className={({ isActive }) => (isActive ? "active" : "")}>
      <span className="tab-icon" aria-hidden>
        {icon}
      </span>
      {label}
    </NavLink>
  );
}

function HomeRedirect() {
  const roles = useRoles();
  const to = roles.office ? "/dashboard" : roles.tech ? "/tech" : "/portal";
  return <Navigate to={to} replace />;
}
