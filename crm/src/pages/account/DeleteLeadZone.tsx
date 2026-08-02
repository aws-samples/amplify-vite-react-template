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
 * Admin-only, and now enforced where it counts: `Account` and `Quote` carry
 * `allow.groups(["ADMIN"])` for delete in amplify/data/resource.ts. The
 * `!isAdmin` return below hides the zone; it is not what stops a non-admin,
 * because a client-side check never was. Do not add a gate here without the
 * matching model rule — that pairing is the whole point.
 *
 * `Document` is deliberately NOT admin-gated: staff delete documents as part
 * of normal work, and the S3-object-then-row ordering below means restricting
 * the row delete would destroy the file and leave the row behind.
 */
/**
 * Amplify reports a refused write by *resolving* with an `errors` array, so a
 * batch of deletes has to be inspected rather than awaited. Throws on the
 * first refusal it finds.
 */
function throwFirstError(results: { errors?: { message: string }[] }[]) {
  for (const r of results) {
    if (r.errors?.length) throw new Error(r.errors[0].message);
  }
}

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
    // Each step checks `errors`. A delete rejected by the API resolves — it
    // does not reject — so ignoring the result let a half-completed cascade
    // navigate away reporting success, leaving orphaned quotes and documents
    // behind. Failing on the first refusal keeps the account on screen with
    // the reason, which is also the only way an admin-rule regression would
    // ever be noticed.
    const quoteResults = await Promise.all(
      quotes.map((q) => client.models.Quote.delete({ id: q.id }))
    );
    throwFirstError(quoteResults);

    const docs = await listAllPages((nextToken) =>
      client.models.Document.list({
        filter: { entityId: { eq: account.id } },
        nextToken,
      })
    );
    const docResults = await Promise.all(
      docs.map(async (d) => {
        if (d.s3Key && d.s3Key !== "pending") {
          // A stray object is recoverable; a stray row is not, so the row
          // delete is what the cascade reports on.
          await remove({ path: d.s3Key }).catch(() => {});
        }
        return client.models.Document.delete({ id: d.id });
      })
    );
    throwFirstError(docResults);

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
