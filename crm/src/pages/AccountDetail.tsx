import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  client,
  fmtDate,
  type Account,
  type UserProfile,
} from "../lib/client";
import { Badge, statusBadge, ACCOUNT_STAGE_BADGE } from "../lib/badges";
import DocumentsPanel from "../components/DocumentsPanel";
import QuotesPanel from "../components/QuotesPanel";
import AccountMarketingTasks from "../components/MarketingTasks";
import PropertyPanel from "../components/PropertyPanel";
import FormsTab from "../components/FormsTab";
import ExtractionPanel from "../components/ExtractionPanel";
import Celebration from "../components/Celebration";
import { OverviewTab } from "./account/OverviewTab";
import { DeleteLeadZone } from "./account/DeleteLeadZone";
import { PoliciesTab } from "./account/PoliciesTab";
import { CertificatesTab } from "./account/CertificatesTab";

type Tab = "overview" | "quotes" | "policies" | "documents" | "certificates";

const VALID_TABS: Tab[] = [
  "overview",
  "quotes",
  "policies",
  "documents",
  "certificates",
];

export default function AccountDetail({ profile }: { profile: UserProfile }) {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get("tab") as Tab | null;
  const [account, setAccount] = useState<Account | null>(null);
  const [tab, setTab] = useState<Tab>(
    initialTab && VALID_TABS.includes(initialTab) ? initialTab : "overview"
  );
  const [notFound, setNotFound] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const prevStage = useRef<string | null>(null);

  // Fire the celebration on a LEAD → CLIENT transition (quote bound).
  useEffect(() => {
    const stage = account?.stage ?? null;
    if (prevStage.current === "LEAD" && stage === "CLIENT") setCelebrate(true);
    prevStage.current = stage;
  }, [account?.stage]);

  useEffect(() => {
    if (!id) return;
    client.models.Account.get({ id }).then(({ data }) => {
      if (data) setAccount(data);
      else setNotFound(true);
    });
  }, [id]);

  if (notFound) return <p>Account not found.</p>;
  if (!account) return <p className="muted">Loading…</p>;

  return (
    <>
      {celebrate && (
        <Celebration name={account.name} onDone={() => setCelebrate(false)} />
      )}
      <h1>
        {account.name}{" "}
        {/* Reads "Client"/"Lead" now, not "CLIENT"/"LEAD" — the shared table
            has one spelling and the dashboard's sentence case is it. */}
        <Badge {...statusBadge(ACCOUNT_STAGE_BADGE, account.stage)} />
      </h1>
      <p className="sub">
        {account.type} · {[account.city, account.state].filter(Boolean).join(", ") || "no location"}
        {account.convertedAt && ` · client since ${fmtDate(account.convertedAt.slice(0, 10))}`}
      </p>

      <div className="tabs">
        {(
          [
            ["overview", "Overview"],
            ["quotes", "Quotes"],
            ["policies", "Policies"],
            ["documents", "Documents"],
            ["certificates", "Certificates"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <>
          <OverviewTab account={account} onChange={setAccount} />
          <PropertyPanel account={account} onChange={setAccount} />
          {account.stage === "LEAD" && <DeleteLeadZone account={account} />}
        </>
      )}
      {tab === "quotes" && (
        <>
          <div className="card">
            <QuotesPanel account={account} onAccountChange={setAccount} />
          </div>
          <AccountMarketingTasks
            accountId={account.id}
            completedByName={`${profile.firstName} ${profile.lastName}`}
          />
        </>
      )}
      {tab === "policies" && <PoliciesTab accountId={account.id} />}
      {tab === "documents" && (
        <>
          <div className="card">
            <DocumentsPanel entityType="ACCOUNT" entityId={account.id} />
          </div>
          <ExtractionPanel account={account} onChange={setAccount} />
          <FormsTab account={account} profile={profile} />
        </>
      )}
      {tab === "certificates" && (
        <CertificatesTab account={account} profile={profile} />
      )}
    </>
  );
}
