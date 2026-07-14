const SECTIONS = [
  { title: "Customers", blurb: "Accounts, contacts, and service addresses" },
  { title: "Jobs", blurb: "Work orders, recurring services, and history" },
  { title: "Schedule", blurb: "Routes, technician days, and dispatch" },
];

export default function App({ backendConnected }: { backendConnected: boolean }) {
  return (
    <div className="shell">
      <header>
        <h1>BuzzKill CRM</h1>
        <span className={backendConnected ? "pill ok" : "pill warn"}>
          {backendConnected ? "Backend connected" : "No backend config"}
        </span>
      </header>
      <main>
        {SECTIONS.map((s) => (
          <section key={s.title} className="card">
            <h2>{s.title}</h2>
            <p>{s.blurb}</p>
            <p className="soon">Coming soon</p>
          </section>
        ))}
      </main>
    </div>
  );
}
