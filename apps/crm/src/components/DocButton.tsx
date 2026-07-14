import { useState } from "react";
import { api } from "../lib/api";
import { Button } from "../ui/kit";

/** Opens a stored PDF via an entitlement-checked presigned URL. */
export default function DocButton({
  docKey,
  label = "View PDF",
}: {
  docKey: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const res = await api().queries.getDocumentUrl({ key: docKey });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      const { url } = (res.data as { url?: string } | null) ?? {};
      if (url) window.open(url, "_blank", "noopener");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not open document");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="ghost" small loading={busy} onClick={() => void open()}>
      {label}
    </Button>
  );
}
