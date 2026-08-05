import {
  BrowserRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { Authenticator, useAuthenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import { useState, type ReactNode } from "react";
import { myGroupIds, RolesProvider, useRoles } from "./lib/auth";
import { useAction } from "./lib/useAsync";
import { Button, EmptyState, Spinner } from "./ui/kit";
import { Icon, type IconName } from "./ui/icons";
import InstallBanner from "./components/InstallBanner";
import ScreenErrorBoundary from "./components/ScreenErrorBoundary";
import { confirmSignIn, signIn, signOut } from "aws-amplify/auth";
import { clearAllDrafts } from "./lib/reportDraft";

import Dashboard from "./office/Dashboard";
import WorkQueue from "./office/Work";
import Leads from "./office/Leads";
import Customers from "./office/Customers";
import CustomerDetail from "./office/CustomerDetail";
import GroupDetail from "./office/GroupDetail";
import PricingLog from "./office/PricingLog";
import ProductLog from "./office/ProductLog";
import Inventory from "./office/Inventory";
import ProductUsage from "./office/ProductUsage";
import MarketRates from "./office/MarketRates";
import Catalog from "./office/Catalog";
import Schedule from "./office/Schedule";
import Staff from "./office/Staff";
import PromoCodes from "./office/PromoCodes";
import VisitChangeHistory from "./pages/VisitChangeHistory";
import More from "./pages/More";
import TechToday from "./tech/Today";
import TechJob from "./tech/JobDetail";
import PortalHome from "./portal/Home";
import PortalDocs from "./portal/Docs";
import PortalBilling from "./portal/Billing";
import PortalGroup from "./portal/Group";
import PortalRequests from "./portal/Requests";
import PortalAddService from "./portal/AddService";
import Welcome from "./pages/Welcome";

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
        {/* Magic-link landing page — completes sign-in from the email link. */}
        <Route path="/welcome" element={<Welcome />} />
        <Route path="/*" element={<AuthedApp />} />
      </Routes>
    </BrowserRouter>
  );
}

function AuthHeader() {
  return (
    <div className="auth-brand">
      <img src="/icons/emblem.png" alt="" className="auth-brand-emblem" />
      <h1>
        BuzzKill <span>CRM</span>
      </h1>
      <p>Safe for families. Tough on pests.</p>
    </div>
  );
}

/** "Email me a sign-in link" — passwordless option under the password form. */
function MagicLinkFooter() {
  const { toForgotPassword } = useAuthenticator();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  // Enter is the natural way to submit this one-field form, and holding it beat
  // the disabled button — a second sign-in attempt, a second link email, and
  // the first link dead by the time they opened it.
  const send = useAction(async () => {
    try {
      const { nextStep } = await signIn({
        username: email.trim().toLowerCase(),
        options: { authFlowType: "CUSTOM_WITHOUT_SRP" },
      });
      if (nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE") {
        // The sentinel answer tells the verify trigger to email a sign-in
        // link; the sign-in itself then fails on purpose and this throwaway
        // session ends. (Keying the request off clientMetadata never worked:
        // Cognito doesn't deliver InitiateAuth metadata to the triggers.)
        await confirmSignIn({ challengeResponse: "REQUEST_LINK" });
      }
    } catch {
      /* Never reveal whether the account exists. */
    }
    setSent(true);
  });

  const request = async () => {
    if (!email.trim()) return;
    await send.run();
  };

  return (
    <div className="magic-link-footer">
      {sent ? (
        <p className="small">
          If that address has a BuzzKill account, a sign-in link is on its way.
          You can close this tab.
        </p>
      ) : open ? (
        <div className="magic-link-form">
          <input
            type="email"
            inputMode="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void request()}
          />
          <Button small loading={send.busy} onClick={() => void request()}>
            Send link
          </Button>
        </div>
      ) : (
        <div className="magic-link-options">
          <button
            className="linklike"
            onClick={() => {
              // Carry over whatever they already typed in the password form.
              const typed = document.querySelector<HTMLInputElement>(
                'input[name="username"]'
              )?.value;
              if (typed && !email) setEmail(typed);
              setOpen(true);
            }}
          >
            Prefer no password? Email me a sign-in link
          </button>
          <button className="linklike linklike-muted" onClick={toForgotPassword}>
            Forgot password?
          </button>
        </div>
      )}
    </div>
  );
}

function AuthedApp() {
  return (
    <Authenticator
      hideSignUp
      components={{ Header: AuthHeader, SignIn: { Footer: MagicLinkFooter } }}
    >
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
  // Read before any early return — it resets the screen error boundary below,
  // so a failure on one route does not follow you to the next.
  const { pathname } = useLocation();
  if (roles.loading) return <Spinner label="Loading your account…" />;

  if (!roles.office && !roles.finance && !roles.tech && !roles.customer) {
    return (
      <div className="auth-shell">
        <EmptyState
          title="Account not set up yet"
          body="Your login works, but no role has been assigned. Ask the BuzzKill office to finish setting up your account."
          action={
            <Button
              variant="ghost"
              onClick={() => {
                // GL-13: cached drafts die with the session.
                clearAllDrafts();
                void signOut();
              }}
            >
              Sign out
            </Button>
          }
        />
      </div>
    );
  }

  const staff = roles.office;
  const workStaff = roles.office || roles.finance;
  const techOnly = roles.tech && !roles.office && !roles.customer;
  const customerOnly = roles.customer && !roles.office && !roles.tech;

  return (
    <div className="app-frame">
      {/* Inside the frame and around the routes only, so a screen that throws
          costs you that screen and not the tab bar you need to leave it. */}
      <ScreenErrorBoundary resetKey={pathname}>
        <Routes>
          <Route path="/" element={<HomeRedirect />} />

          {/* Office */}
          <Route path="/dashboard" element={<Require when={staff}><Dashboard /></Require>} />
          <Route path="/work" element={<Require when={workStaff}><WorkQueue /></Require>} />
          <Route path="/visit-changes" element={<Require when={workStaff}><VisitChangeHistory /></Require>} />
          <Route path="/leads" element={<Require when={staff}><Leads /></Require>} />
          <Route path="/customers" element={<Require when={staff}><Customers /></Require>} />
          {/* GL-13: the office customer view exposes plans, invoices, agreements
              and every job across the customer — not a technician surface. The
              field app never links here; a tech's customer context comes scoped
              through /tech/job/:jobId. Staff only. */}
          <Route path="/customers/:id" element={<Require when={staff}><CustomerDetail /></Require>} />
          <Route path="/groups/:id" element={<Require when={staff}><GroupDetail /></Require>} />
          <Route path="/schedule" element={<Require when={staff}><Schedule /></Require>} />
          <Route path="/pricing" element={<Require when={staff}><PricingLog /></Require>} />
          <Route path="/products" element={<Require when={staff}><ProductLog /></Require>} />
          <Route path="/inventory" element={<Require when={roles.owner}><Inventory /></Require>} />
          <Route path="/product-usage" element={<Require when={roles.owner}><ProductUsage /></Require>} />
          <Route path="/market-rates" element={<Require when={staff}><MarketRates /></Require>} />
          <Route path="/catalog" element={<Require when={staff}><Catalog /></Require>} />
          <Route path="/staff" element={<Require when={roles.owner}><Staff /></Require>} />
          <Route path="/promo-codes" element={<Require when={roles.owner}><PromoCodes /></Require>} />
          {/* Staging-only database reset. OWNER-gated here; the screen itself
              hides on production hosts and the backend refuses on the main
              branch. */}

          {/* Technician */}
          <Route path="/tech" element={<Require when={roles.tech || staff}><TechToday /></Require>} />
          <Route path="/tech/job/:jobId" element={<Require when={roles.tech || staff}><TechJob /></Require>} />

          {/* Customer portal */}
          <Route path="/portal" element={<Require when={roles.customer}><PortalHome /></Require>} />
          <Route path="/portal/docs" element={<Require when={roles.customer}><PortalDocs /></Require>} />
          <Route path="/portal/billing" element={<Require when={roles.customer}><PortalBilling /></Require>} />
          <Route path="/portal/requests" element={<Require when={roles.customer}><PortalRequests /></Require>} />
          <Route path="/portal/add-service" element={<Require when={roles.customer}><PortalAddService /></Require>} />
          <Route path="/portal/group" element={<Require when={roles.customer}><PortalGroup /></Require>} />

          <Route path="/more" element={<More />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ScreenErrorBoundary>

      {workStaff || roles.tech ? <InstallBanner /> : null}

      <nav className="tabbar">
        <div className="tabbar-inner">
          {staff ? (
            <>
              <Tab to="/dashboard" icon="dashboard" label="Dashboard" />
              <Tab to="/leads" icon="leads" label="Leads" />
              <Tab to="/customers" icon="customers" label="Customers" />
              <Tab to="/schedule" icon="schedule" label="Schedule" />
              <Tab to="/more" icon="more" label="More" />
            </>
          ) : roles.finance ? (
            <>
              <Tab to="/work" icon="dashboard" label="Owned work" />
              <Tab to="/more" icon="more" label="More" />
            </>
          ) : techOnly ? (
            <>
              <Tab to="/tech" icon="route" label="Today" />
              <Tab to="/more" icon="more" label="More" />
            </>
          ) : customerOnly ? (
            <>
              <Tab to="/portal" icon="home" label="Home" />
              <Tab to="/portal/docs" icon="documents" label="Documents" />
              <Tab to="/portal/billing" icon="billing" label="Billing" />
              <Tab to="/portal/requests" icon="schedule" label="Requests" />
              {myGroupIds(roles).length > 0 ? (
                <Tab to="/portal/group" icon="group" label="Group" />
              ) : null}
              <Tab to="/more" icon="more" label="More" />
            </>
          ) : null}
        </div>
      </nav>
    </div>
  );
}

function Tab({ to, icon, label }: { to: string; icon: IconName; label: string }) {
  return (
    <NavLink to={to} className={({ isActive }) => (isActive ? "active" : "")}>
      <span className="tab-icon" aria-hidden>
        <Icon name={icon} />
      </span>
      {label}
    </NavLink>
  );
}

function HomeRedirect() {
  const roles = useRoles();
  const to = roles.office
    ? "/dashboard"
    : roles.finance
      ? "/work"
      : roles.tech
        ? "/tech"
        : "/portal";
  return <Navigate to={to} replace />;
}
