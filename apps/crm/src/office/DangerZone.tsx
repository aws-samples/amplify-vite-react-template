import { useCallback, useEffect, useState } from "react";
import { api, opResult, unwrap } from "../lib/api";
import { useRoles } from "../lib/auth";
import { isProductionCrm } from "../lib/bookingLink";
import { fmtDateTime } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  ListRow,
  Page,
  Sheet,
  Spinner,
  SuccessNote,
} from "../ui/kit";

/**
 * STAGING-ONLY Danger Zone. One button wipes every record in the database for a
 * clean start; every wipe first archives a full snapshot you can roll back to
 * for 30 days.
 *
 * This screen is defended in depth: it is OWNER-only, it hides itself entirely
 * on the production CRM hostname, and the wipe requires typing an exact
 * confirmation phrase. None of that is the real backstop, though — the backend
 * refuses to wipe when it is deployed on the main branch, so even a bug here
 * cannot touch production data. See amplify/functions/shared/databaseReset.ts.
 */

const WIPE_PHRASE = "WIPE STAGING";

type ResetSummary = {
  archiveId?: string;
  totalRecords: number;
  counts: Record<string, number>;
  models: number;
};

type Archive = {
  id: string;
  label?: string | null;
  branch?: string | null;
  takenAt: string;
  expiresAt: string;
  totalRecords: number;
  status?: "ACTIVE" | "RESTORED" | "EXPIRED" | null;
  restoredAt?: string | null;
};

export default function DangerZone() {
  const roles = useRoles();
  const production = isProductionCrm();

  const [archives, setArchives] = useState<Archive[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [wipeOpen, setWipeOpen] = useState(false);
  const [restore, setRestore] = useState<Archive | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api().models.DatabaseArchive.list({ limit: 200 });
      const rows = unwrap(res) as unknown as Archive[];
      rows.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
      setArchives(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load archives");
      setArchives([]);
    }
  }, []);

  useEffect(() => {
    if (roles.owner && !production) void load();
  }, [roles.owner, production, load]);

  if (roles.loading) return <Spinner label="Loading…" />;

  if (!roles.owner) {
    return (
      <Page title="Danger Zone" back="/more">
        <EmptyState
          title="Owners only"
          body="Resetting the database is owner-only."
        />
      </Page>
    );
  }

  // Belt-and-braces: never render the wipe controls on production, even though
  // the backend would refuse anyway.
  if (production) {
    return (
      <Page title="Danger Zone" back="/more">
        <EmptyState
          title="Not available on production"
          body="The database reset tool only exists on the staging environment."
        />
      </Page>
    );
  }

  return (
    <Page title="Danger Zone" back="/more">
      <Card>
        <div style={{ padding: "4px 2px", display: "grid", gap: 8 }}>
          <Badge tone="danger">Staging only</Badge>
          <p className="muted small" style={{ margin: 0 }}>
            <strong>Clean start</strong> deletes every customer, job, invoice,
            plan, report and lead in this staging database. Before deleting, it
            saves a full snapshot you can restore for 30 days. This is
            irreversible except by restoring an archive, and it never runs on
            production.
          </p>
          <Button variant="danger" onClick={() => setWipeOpen(true)}>
            Wipe the database…
          </Button>
        </div>
      </Card>

      <SuccessNote message={notice} />
      <ErrorNote error={error} />

      <Card title="Archives (restore points)">
        {archives === null ? (
          <Spinner label="Loading archives…" />
        ) : archives.length === 0 ? (
          <EmptyState
            title="No archives yet"
            body="Each wipe creates a restore point here. Archives are kept for 30 days."
          />
        ) : (
          archives.map((a) => {
            const expired = new Date(a.expiresAt).getTime() < Date.now();
            const canRestore = !expired && a.status !== "EXPIRED";
            return (
              <ListRow
                key={a.id}
                title={a.label || `Snapshot ${fmtDateTime(a.takenAt)}`}
                subtitle={`${a.totalRecords.toLocaleString()} records · taken ${fmtDateTime(
                  a.takenAt
                )} · ${
                  expired
                    ? "expired"
                    : `expires ${fmtDateTime(a.expiresAt)}`
                }`}
                meta={
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    {a.status === "RESTORED" ? (
                      <Badge tone="info">restored</Badge>
                    ) : null}
                    {expired ? <Badge tone="muted">expired</Badge> : null}
                    {canRestore ? (
                      <Button small variant="subtle" onClick={() => setRestore(a)}>
                        Restore
                      </Button>
                    ) : null}
                  </span>
                }
              />
            );
          })
        )}
      </Card>

      <Sheet open={wipeOpen} onClose={() => setWipeOpen(false)} title="Wipe the database">
        <WipeForm
          onDone={(summary) => {
            setWipeOpen(false);
            setNotice(
              `Wiped ${summary.totalRecords.toLocaleString()} records across ${summary.models} models. A restore point was saved.`
            );
            void load();
          }}
        />
      </Sheet>

      <Sheet
        open={restore !== null}
        onClose={() => setRestore(null)}
        title="Restore this archive"
      >
        {restore ? (
          <RestoreForm
            archive={restore}
            onDone={(summary) => {
              setRestore(null);
              setNotice(
                `Restored ${summary.totalRecords.toLocaleString()} records from the archive.`
              );
              void load();
            }}
          />
        ) : null}
      </Sheet>
    </Page>
  );
}

function WipeForm({ onDone }: { onDone: (summary: ResetSummary) => void }) {
  const [label, setLabel] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = confirm.trim().toUpperCase() === WIPE_PHRASE;

  return (
    <div className="form-grid">
      <p className="muted small" style={{ margin: 0 }}>
        This deletes <strong>everything</strong> in the staging database. A full
        snapshot is saved first so you can roll back within 30 days.
      </p>
      <Field label="Label for this restore point" hint="Optional — helps you find it later">
        <input
          value={label}
          placeholder="e.g. before demo reset"
          onChange={(e) => setLabel(e.target.value)}
        />
      </Field>
      <Field label={`Type "${WIPE_PHRASE}" to confirm`}>
        <input
          value={confirm}
          autoCapitalize="characters"
          autoComplete="off"
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>
      <ErrorNote error={error} />
      <Button
        block
        variant="danger"
        loading={busy}
        disabled={!ready}
        onClick={() => {
          if (!ready) return;
          setBusy(true);
          setError(null);
          api()
            .mutations.wipeDatabase({ label: label.trim() || undefined })
            .then((res) => {
              const summary = opResult<ResetSummary>(res);
              if (!summary) throw new Error("The wipe did not return a result");
              onDone(summary);
            })
            .catch((err) =>
              setError(err instanceof Error ? err.message : "The wipe failed")
            )
            .finally(() => setBusy(false));
        }}
      >
        Wipe the database now
      </Button>
    </div>
  );
}

function RestoreForm({
  archive,
  onDone,
}: {
  archive: Archive;
  onDone: (summary: ResetSummary) => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = confirm.trim().toUpperCase() === "RESTORE";

  return (
    <div className="form-grid">
      <p className="muted small" style={{ margin: 0 }}>
        This <strong>replaces</strong> the current staging database with the
        snapshot from{" "}
        <strong>{archive.label || fmtDateTime(archive.takenAt)}</strong> (
        {archive.totalRecords.toLocaleString()} records). Current data is
        deleted first.
      </p>
      <Field label='Type "RESTORE" to confirm'>
        <input
          value={confirm}
          autoCapitalize="characters"
          autoComplete="off"
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>
      <ErrorNote error={error} />
      <Button
        block
        variant="danger"
        loading={busy}
        disabled={!ready}
        onClick={() => {
          if (!ready) return;
          setBusy(true);
          setError(null);
          api()
            .mutations.rollbackDatabase({ archiveId: archive.id })
            .then((res) => {
              const summary = opResult<ResetSummary>(res);
              if (!summary) throw new Error("The restore did not return a result");
              onDone(summary);
            })
            .catch((err) =>
              setError(err instanceof Error ? err.message : "The restore failed")
            )
            .finally(() => setBusy(false));
        }}
      >
        Restore this archive now
      </Button>
    </div>
  );
}
