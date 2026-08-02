import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { remove } from "aws-amplify/storage";
import {
  client,
  friendlyError,
  listAllPages,
  type Account,
} from "../../lib/client";
import { useIsAdmin } from "../../lib/auth";
import ConfirmButton from "../../components/ConfirmButton";

/**
 * Leads (and only leads — clients carry bound policies and stay for the
 * audit trail) can be deleted along with their quotes and documents.
 *
 * Admin-only: this cascades through the quotes, the documents and their S3
 * objects, so it's gated here rather than at the call site — the zone can't
 * be rendered without the check coming with it.
 */
export function DeleteLeadZone({ account }: { account: Account }) {
  const isAdmin = useIsAdmin();
  const [error, setError] = useState("");
  const navigate = useNavigate();

  // Throws rather than swallowing: <ConfirmButton> keeps the pair armed on a
  // rejection, so a failed cascade can be retried or backed out of, and the
  // message lands in `error` via onError.
  async function deleteLead() {
    setError("");
    const quotes = await listAllPages((nextToken) =>
      client.models.Quote.list({
        filter: { accountId: { eq: account.id } },
        nextToken,
      })
    );
    await Promise.all(quotes.map((q) => client.models.Quote.delete({ id: q.id })));

    const docs = await listAllPages((nextToken) =>
      client.models.Document.list({
        filter: { entityId: { eq: account.id } },
        nextToken,
      })
    );
    await Promise.all(
      docs.map(async (d) => {
        if (d.s3Key && d.s3Key !== "pending") {
          await remove({ path: d.s3Key }).catch(() => {});
        }
        await client.models.Document.delete({ id: d.id });
      })
    );

    const { errors } = await client.models.Account.delete({ id: account.id });
    if (errors?.length) throw new Error(errors[0].message);
    navigate("/leads");
  }

  if (!isAdmin) return null;

  return (
    <div className="card" style={{ borderColor: "#eec8c4" }}>
      <h2 style={{ color: "var(--red)" }}>Danger zone</h2>
      <div className="form-actions" style={{ marginTop: 0 }}>
        <ConfirmButton
          label="Delete this lead…"
          className="secondary"
          confirmLabel="Yes, delete this lead"
          cancelClassName="secondary"
          message={`Permanently delete ${account.name} and its quotes and documents? This can't be undone.`}
          onConfirm={deleteLead}
          onError={(err) => setError(friendlyError(err, "Delete failed"))}
        />
        <span className="muted small">
          Removes the lead, its quotes, and its documents.
        </span>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
