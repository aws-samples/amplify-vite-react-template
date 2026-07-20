import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { confirmResetPassword, resetPassword, signOut } from "aws-amplify/auth";
import { clearAllDrafts } from "../lib/reportDraft";
import { api, unwrap } from "../lib/api";
import { useRoles } from "../lib/auth";
import { fmtDateTime } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  ListRow,
  Page,
  Sheet,
} from "../ui/kit";

export default function More() {
  const roles = useRoles();
  const navigate = useNavigate();
  const [emailLogSheet, setEmailLogSheet] = useState(false);
  const [passwordSheet, setPasswordSheet] = useState(false);

  return (
    <Page title="More">
      <Card>
        <ListRow
          title="Signed in"
          subtitle={roles.email ?? undefined}
          meta={
            <span style={{ display: "inline-flex", gap: 4 }}>
              {roles.owner ? <Badge tone="ok">owner</Badge> : null}
              {roles.office && !roles.owner ? <Badge tone="ok">office</Badge> : null}
              {roles.finance && !roles.owner ? <Badge tone="ok">finance</Badge> : null}
              {roles.tech ? <Badge tone="info">tech</Badge> : null}
              {roles.customer ? <Badge tone="muted">customer</Badge> : null}
            </span>
          }
        />
        <ListRow
          title="Set or change password"
          subtitle="Optional — you can always use emailed sign-in links"
          onClick={() => setPasswordSheet(true)}
        />
      </Card>

      {roles.office ? (
        <Card title="Office tools">
          {roles.tech ? (
            <ListRow title="My day (technician view)" onClick={() => navigate("/tech")} />
          ) : null}
          <ListRow
            title="Pricing log"
            subtitle="Every AI-priced lead — the weekly review sheet"
            onClick={() => navigate("/pricing")}
          />
          <ListRow
            title="Product log"
            subtitle="Products techs record on service reports"
            onClick={() => navigate("/products")}
          />
          <ListRow
            title="Market rates"
            subtitle="Every AI-researched base price — review, override, pin"
            onClick={() => navigate("/market-rates")}
          />
          <ListRow
            title="Service catalog"
            subtitle="What BuzzKill sells, and public-site conflicts awaiting the CEO"
            onClick={() => navigate("/catalog")}
          />
          <ListRow
            title="Command"
            subtitle="Do customers, work, and money agree? The morning reconciliation view"
            onClick={() => navigate("/command")}
          />
          {/* Staff management (roster, roles, invites, offboarding) is OWNER-only
              server-side — it is what keeps the role split real. Non-owners get
              the honest line, not a row that errors on tap. */}
          {roles.owner ? (
            <ListRow
              title="Staff"
              subtitle="Roster, roles, invites, and offboarding"
              onClick={() => navigate("/staff")}
            />
          ) : (
            <ListRow
              title="Staff"
              subtitle="Ask the owner — staff management is owner-only"
            />
          )}
          <ListRow
            title="Email log"
            subtitle="Recent emails sent to customers"
            onClick={() => setEmailLogSheet(true)}
          />
        </Card>
      ) : null}

      {/* GL-07 R6: reachable by finance too — a finance-only user must be able to
          audit the money side of every cancel/reschedule, not just office. */}
      {roles.office || roles.finance ? (
        <Card title="Records">
          <ListRow
            title="Visit changes"
            subtitle="Every cancel/reschedule — actor, reason, money, schedule, delivery"
            onClick={() => navigate("/visit-changes")}
          />
        </Card>
      ) : null}

      <Button
        block
        variant="ghost"
        onClick={() => {
          // GL-13: cached drafts die with the session.
          clearAllDrafts();
          void signOut().then(() => window.location.assign("/"));
        }}
      >
        Sign out
      </Button>

      <Sheet open={emailLogSheet} onClose={() => setEmailLogSheet(false)} title="Email log">
        <EmailLogList />
      </Sheet>
      <Sheet open={passwordSheet} onClose={() => setPasswordSheet(false)} title="Set your password">
        <SetPassword email={roles.email ?? ""} onDone={() => setPasswordSheet(false)} />
      </Sheet>
    </Page>
  );
}

/**
 * Set (or change) a password using the standard reset flow — works even for
 * accounts that only ever signed in with magic links, since Cognito's reset
 * doesn't need the current password.
 */
function SetPassword({ email, onDone }: { email: string; onDone: () => void }) {
  const [step, setStep] = useState<"start" | "confirm" | "done">("start");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (step === "done") {
    return (
      <div className="form-grid">
        <p>Password set — you can use it (or sign-in links) from now on.</p>
        <Button block onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }

  if (step === "start") {
    return (
      <div className="form-grid">
        <p className="muted small">
          We'll email a 6-digit code to <strong>{email}</strong> to confirm
          it's you, then you pick your password.
        </p>
        <ErrorNote error={error} />
        <Button
          block
          loading={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            resetPassword({ username: email })
              .then(() => setStep("confirm"))
              .catch((err) => setError(err.message ?? "Could not send the code"))
              .finally(() => setBusy(false));
          }}
        >
          Email me the code
        </Button>
      </div>
    );
  }

  return (
    <div className="form-grid">
      <Field label="6-digit code from the email">
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </Field>
      <Field label="New password" hint="At least 8 characters">
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <ErrorNote error={error} />
      <Button
        block
        loading={busy}
        onClick={() => {
          if (!code.trim() || password.length < 8) {
            setError("Enter the code and a password of at least 8 characters");
            return;
          }
          setBusy(true);
          setError(null);
          confirmResetPassword({
            username: email,
            confirmationCode: code.trim(),
            newPassword: password,
          })
            .then(() => setStep("done"))
            .catch((err) => setError(err.message ?? "Could not set the password"))
            .finally(() => setBusy(false));
        }}
      >
        Set password
      </Button>
    </div>
  );
}

// GL-03: the true delivery state, not just "did the provider accept it". A
// message SES accepted and then bounced reads BOUNCED here, never "sent".
const DELIVERY_META: Record<string, { tone: "ok" | "warn" | "danger" | "info"; label: string }> = {
  DELIVERED: { tone: "ok", label: "delivered" },
  SENT: { tone: "info", label: "sent, not yet confirmed" },
  QUEUED: { tone: "warn", label: "queued for retry" },
  BOUNCED: { tone: "danger", label: "bounced" },
  COMPLAINED: { tone: "danger", label: "spam complaint" },
  SUPPRESSED: { tone: "danger", label: "blocked (suppressed)" },
  FAILED: { tone: "danger", label: "failed" },
};

function deliveryBadge(deliveryStatus: string | null, status: string | null) {
  // Fall back to the coarse accept/reject status for rows predating delivery
  // tracking.
  const key = deliveryStatus ?? (status === "SENT" ? "SENT" : "FAILED");
  const meta = DELIVERY_META[key] ?? { tone: "info" as const, label: key.toLowerCase() };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

function EmailLogList() {
  const [rows, setRows] = useState<
    {
      id: string;
      toEmail: string;
      subject: string;
      status: string | null;
      deliveryStatus: string | null;
      sentAt: string;
    }[] | null
  >(null);

  useEffect(() => {
    api()
      .models.EmailLog.list({ limit: 100 })
      .then((res) =>
        setRows(
          unwrap(res).sort((a, b) => b.sentAt.localeCompare(a.sentAt))
        )
      )
      .catch(() => setRows([]));
  }, []);

  if (!rows) return <p className="muted">Loading…</p>;
  if (rows.length === 0) return <p className="muted">No emails sent yet.</p>;
  return (
    <div>
      {rows.map((r) => (
        <ListRow
          key={r.id}
          title={r.subject}
          subtitle={`${r.toEmail} · ${fmtDateTime(r.sentAt)}`}
          meta={deliveryBadge(r.deliveryStatus, r.status)}
        />
      ))}
    </div>
  );
}
