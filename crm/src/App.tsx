import { useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { Authenticator, useAuthenticator } from "@aws-amplify/ui-react";
import type { AuthUser } from "aws-amplify/auth";
import { client, listAllPages, type UserProfile } from "./lib/client";
import { useAsyncResource } from "./lib/useAsyncResource";
import {
  AdminContext,
  fetchUserGroups,
  isAdminGroup,
  roleFromGroups,
} from "./lib/auth";
import MagicLinkSignIn from "./components/MagicLinkSignIn";
import Dashboard from "./pages/Dashboard";
import AccountsList from "./pages/AccountsList";
import AccountDetail from "./pages/AccountDetail";
import NewLead from "./pages/NewLead";
import Carriers from "./pages/Carriers";
import CarrierDetail from "./pages/CarrierDetail";
import Onboarding from "./pages/Onboarding";
import Settings from "./pages/Settings";
import DocumentSearch from "./pages/DocumentSearch";
import QuotesList from "./pages/QuotesList";
import PoliciesList from "./pages/PoliciesList";
import { AllMarketingTasks } from "./components/MarketingTasks";

export default function App() {
  return (
    <Authenticator.Provider>
      <AuthGate />
    </Authenticator.Provider>
  );
}

/**
 * Magic-link only — no password UI. Authenticator.Provider supplies the
 * auth context headlessly; a successful confirmSignIn in MagicLinkSignIn
 * flips authStatus via the Amplify Hub.
 */
function AuthGate() {
  const { authStatus, user, signOut } = useAuthenticator((ctx) => [
    ctx.authStatus,
    ctx.user,
  ]);

  if (authStatus === "authenticated" && user) {
    return <ProfileGate user={user} signOut={signOut} />;
  }

  // On reload, authStatus is "configuring" while Amplify restores the
  // stored session. Show a neutral splash (not the login screen) so an
  // already-signed-in user never sees a sign-in flash. Only render the
  // sign-in screen once we're definitively unauthenticated — unless the
  // URL carries a magic-link token, which must reach MagicLinkSignIn
  // immediately to complete the flow.
  const hasMagicToken = window.location.hash.includes("magic=");
  if (authStatus === "configuring" && !hasMagicToken) {
    return <div className="auth-screen" aria-busy="true" />;
  }

  return (
    <div className="auth-screen">
      <MagicLinkSignIn />
    </div>
  );
}

function ProfileGate({ user, signOut }: { user: AuthUser; signOut: () => void }) {
  // Profile and Cognito groups resolve behind ONE loading gate: settling
  // admin status after first paint would flash the admin-only controls
  // into (or out of) a page that's already on screen. That is why this is a
  // single hook over a tuple rather than one hook per read.
  const { data, loading, error, refetch, setData } = useAsyncResource(
    async () => {
      const [rows, gs] = await Promise.all([
        listAllPages((nextToken) =>
          client.models.UserProfile.list({
            filter: { userId: { eq: user.userId } },
            nextToken,
          })
        ),
        fetchUserGroups(),
      ]);
      return { profile: rows[0] ?? null, groups: gs };
    },
    [user.userId],
    {
      initialData: { profile: null as UserProfile | null, groups: [] as string[] },
      errorMessage: "Couldn't load your profile.",
    }
  );
  const { profile, groups } = data;

  // This read used to have no catch at all: a failed profile/groups fetch
  // left "Loading…" on screen forever. It is the app's front door, so the
  // failure gets a real screen with a way out.
  if (error) {
    return (
      <div className="main">
        <div className="card" style={{ maxWidth: 480, textAlign: "center", marginTop: 40 }}>
          <h2>Couldn't load your profile</h2>
          <p className="error-text">{error}</p>
          <p className="muted small">
            You're signed in — this is the profile read failing, so a retry
            usually clears it.
          </p>
          <div className="form-actions" style={{ justifyContent: "center" }}>
            <button className="primary" onClick={() => void refetch()}>
              Try again
            </button>
            <button className="secondary" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (loading) return <div className="main">Loading…</div>;

  if (!profile || !profile.onboardingComplete) {
    return (
      <Onboarding
        user={user}
        existing={profile}
        role={roleFromGroups(groups)}
        onComplete={(p) => setData((d) => ({ ...d, profile: p }))}
      />
    );
  }

  return (
    <AdminContext.Provider value={isAdminGroup(groups)}>
      <Shell profile={profile} signOut={signOut} />
    </AdminContext.Provider>
  );
}

function NotFound() {
  return (
    <div className="card" style={{ maxWidth: 480, textAlign: "center", marginTop: 40 }}>
      <h2>Page not found</h2>
      <p className="muted small">That page doesn't exist (or moved).</p>
      <NavLink to="/">
        <button className="primary">Back to dashboard</button>
      </NavLink>
    </div>
  );
}

const iconProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function IconGrid() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg {...iconProps}>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
    </svg>
  );
}
function IconFunnel() {
  return (
    <svg {...iconProps}>
      <path d="M3 4h18l-7 8.5V19l-4 2v-8.5L3 4z" />
    </svg>
  );
}
function IconUsers() {
  return (
    <svg {...iconProps}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5" />
      <path d="M16 5a3.5 3.5 0 010 6.6M21.5 20c0-2.8-1.9-4.6-4.5-5.3" />
    </svg>
  );
}
function IconBuilding() {
  return (
    <svg {...iconProps}>
      <path d="M4 21V5a1 1 0 011-1h9a1 1 0 011 1v16" />
      <path d="M15 9h4a1 1 0 011 1v11" />
      <path d="M2 21h20" />
      <path d="M7.5 8h2M7.5 12h2M7.5 16h2M11.5 8h0M18 13h0M18 17h0" />
    </svg>
  );
}
function IconFile() {
  return (
    <svg {...iconProps}>
      <path d="M14 2H6a1 1 0 00-1 1v18a1 1 0 001 1h12a1 1 0 001-1V7l-5-5z" />
      <path d="M14 2v5h5M9 13h6M9 17h6" />
    </svg>
  );
}
function IconGear() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1.03 1.56V21a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1.03-1.56 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.7 1.7 0 00.34-1.87 1.7 1.7 0 00-1.56-1.03H3a2 2 0 110-4h.09a1.7 1.7 0 001.56-1.03 1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34h.01A1.7 1.7 0 0010 4.09V4a2 2 0 114 0v.09a1.7 1.7 0 001.03 1.56h.01a1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87v.01A1.7 1.7 0 0019.91 11H20a2 2 0 110 4h-.09a1.7 1.7 0 00-1.56 1.03z" />
    </svg>
  );
}
function IconMenu() {
  return (
    <svg {...iconProps} width={22} height={22}>
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg {...iconProps} width={22} height={22}>
      <path d="M5 5l14 14M19 5L5 19" />
    </svg>
  );
}

const NAV_ITEMS = [
  { to: "/", end: true, label: "Dashboard", icon: <IconGrid /> },
  { to: "/leads", label: "Leads", icon: <IconFunnel /> },
  { to: "/clients", label: "Clients", icon: <IconUsers /> },
  { to: "/tasks", label: "Tasks", icon: <IconCheck /> },
  { to: "/carriers", label: "Carriers", icon: <IconBuilding /> },
  { to: "/documents", label: "Documents", icon: <IconFile /> },
  { to: "/settings", label: "Settings", icon: <IconGear /> },
];

function Shell({ profile, signOut }: { profile: UserProfile; signOut: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="shell">
      <aside className={`sidebar${menuOpen ? " sidebar--open" : ""}`}>
        <div className="sidebar-top">
          <NavLink to="/" className="brand" onClick={() => setMenuOpen(false)}>
            <img src="/logo.png" alt="HOA Insurance Agency" />
          </NavLink>
          <button
            className="hamburger"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <IconClose /> : <IconMenu />}
          </button>
        </div>
        <nav onClick={() => setMenuOpen(false)}>
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end}>
              {item.icon}
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        <div className="user">
          <div>
            {profile.firstName} {profile.lastName}
          </div>
          <div className="muted small">{profile.role}</div>
          <button onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/leads" element={<AccountsList stage="LEAD" />} />
          <Route path="/leads/new" element={<NewLead />} />
          <Route path="/clients" element={<AccountsList stage="CLIENT" />} />
          <Route path="/accounts/:id" element={<AccountDetail profile={profile} />} />
          <Route path="/carriers" element={<Carriers />} />
          <Route path="/carriers/:id" element={<CarrierDetail />} />
          <Route path="/tasks" element={<AllMarketingTasks />} />
          <Route path="/quotes" element={<QuotesList />} />
          <Route path="/policies" element={<PoliciesList />} />
          <Route path="/documents" element={<DocumentSearch />} />
          <Route path="/settings" element={<Settings profile={profile} />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}
