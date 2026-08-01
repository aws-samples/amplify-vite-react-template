import { useEffect, useState } from "react";
import { client, fmtDate, friendlyError, type UserProfile } from "../lib/client";
import SignatureManager from "../components/SignatureManager";
import { useSort, SortTh } from "../lib/useSort";

interface TeamUser {
  userId: string;
  email: string;
  createdAt: string | null;
  groups: string[];
}

// Stable identity for "not loaded yet", so the sort memo isn't rebuilt on
// every render while the team list is still in flight.
const NO_USERS: TeamUser[] = [];

/**
 * ADMIN-only. Rendered only for the Cognito ADMIN group (Settings gates the
 * tab on it), and enforced server-side by the group rule on the mutations —
 * so there's no check of its own here.
 */
export default function Team({ profile }: { profile: UserProfile }) {
  const [users, setUsers] = useState<TeamUser[] | null>(null);
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("STAFF");
  const [inviting, setInviting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const parse = (raw: unknown): Record<string, unknown> => {
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    }
    return (raw as Record<string, unknown>) ?? {};
  };

  async function load() {
    setError("");
    try {
      const { data, errors } = await client.queries.listTeamUsers();
      if (errors?.length) throw new Error(errors[0].message);
      const body = parse(data);
      setUsers((body.users as TeamUser[]) ?? []);
    } catch (err) {
      setError(friendlyError(err, "Failed to load team"));
      setUsers([]);
    }
    client.models.UserProfile.list().then(({ data }) => setProfiles(data));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function invite() {
    if (!email.trim()) return;
    setInviting(true);
    setNotice("");
    setError("");
    try {
      const { data, errors } = await client.mutations.inviteUser({
        email: email.trim().toLowerCase(),
        role,
      });
      if (errors?.length) throw new Error(errors[0].message);
      const body = parse(data);
      if (!body.ok) throw new Error(String(body.error ?? "Invite failed"));
      setNotice(
        `Invited ${email.trim().toLowerCase()} as ${role}. They'll get an email with the portal link — they sign in with a magic link, no password.`
      );
      setEmail("");
      load();
    } catch (err) {
      setError(friendlyError(err, "Invite failed"));
    } finally {
      setInviting(false);
    }
  }

  const profileFor = (u: TeamUser) =>
    profiles.find((p) => p.userId === u.userId || p.email === u.email);

  // By email; a user with no email sorts last, which useSort does for nulls
  // in either direction.
  const { sorted, sortKey, dir, toggle } = useSort(
    users ?? NO_USERS,
    {
      email: (u) => u.email,
      name: (u) => {
        const p = profileFor(u);
        return p ? `${p.firstName} ${p.lastName}` : null;
      },
      role: (u) => u.groups[0] ?? profileFor(u)?.role,
      onboarded: (u) => (profileFor(u)?.onboardingComplete ? "Yes" : "Invited"),
      invited: (u) => u.createdAt,
    },
    "email"
  );

  return (
    <>
      <div className="card">
        <h2>Team — invite someone</h2>
        <p className="muted small">
          Invited staff and producers sign in with an emailed link — no
          passwords. Admin only.
        </p>
        <div className="form-grid" style={{ maxWidth: 640 }}>
          <div className="field">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && invite()}
            />
          </div>
          <div className="field">
            <label>Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="ADMIN">Admin</option>
              <option value="PRODUCER">Producer</option>
              <option value="STAFF">Staff</option>
            </select>
          </div>
        </div>
        <div className="form-actions">
          <button
            className="primary"
            disabled={inviting || !email.trim()}
            onClick={invite}
          >
            {inviting ? "Inviting…" : "Send invite"}
          </button>
          {notice && (
            <span className="small" style={{ color: "var(--green)" }}>
              {notice}
            </span>
          )}
          {error && <span className="error-text">{error}</span>}
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Producers complete their licensing details during first sign-in.
          The role you pick here is the user's Cognito group, and it's what
          admin-only screens and the team mutations check — so it does
          restrict access.
        </p>
      </div>

      <div className="card">
        <h2>Team members</h2>
        {users === null ? (
          <p className="muted small">Loading…</p>
        ) : users.length === 0 ? (
          <p className="muted small">No users found.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="Email" colKey="email" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Name" colKey="name" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Role" colKey="role" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Onboarded" colKey="onboarded" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <th>Signature</th>
                  <SortTh label="Invited" colKey="invited" sortKey={sortKey} dir={dir} onToggle={toggle} />
                </tr>
              </thead>
              <tbody>
                {sorted.map((u) => {
                  const p = profileFor(u);
                  return (
                    <tr key={u.userId}>
                      <td>
                        {u.email}
                        {u.email === profile.email && (
                          <span className="badge blue" style={{ marginLeft: 6 }}>
                            you
                          </span>
                        )}
                      </td>
                      <td>
                        {p ? `${p.firstName} ${p.lastName}` : <span className="muted">—</span>}
                      </td>
                      <td>
                        <span className="badge gray">
                          {u.groups[0] ?? p?.role ?? "—"}
                        </span>
                      </td>
                      <td>
                        {p?.onboardingComplete ? (
                          <span className="badge green">Yes</span>
                        ) : (
                          <span className="badge amber">Invited</span>
                        )}
                      </td>
                      <td>
                        <SignatureManager
                          compact
                          profile={p ?? null}
                          onChange={(updated) =>
                            setProfiles((ps) =>
                              ps.map((x) => (x.id === updated.id ? updated : x))
                            )
                          }
                        />
                      </td>
                      <td className="small">
                        {fmtDate(u.createdAt?.slice(0, 10))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
