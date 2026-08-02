import { useEffect } from "react";
import { api, opResult } from "../lib/api";
import { useAction } from "../lib/useAsync";
import { Button } from "../ui/kit";

/** Opens a stored PDF via an entitlement-checked presigned URL. */
export default function DocButton({
  docKey,
  label = "View PDF",
}: {
  docKey: string;
  label?: string;
}) {
  const open = useAction(async () => {
    const res = await api().queries.getDocumentUrl({ key: docKey });
    const { url } = opResult<{ url?: string }>(res) ?? {};
    if (url) window.open(url, "_blank", "noopener");
  }, "Could not open document");

  // This button still reports failures with alert() rather than an ErrorNote;
  // swapping that is tracked on its own. The text is the action's error.
  useEffect(() => {
    if (open.error) alert(open.error);
  }, [open.error]);

  return (
    <Button
      variant="ghost"
      small
      loading={open.busy}
      onClick={() => void open.run()}
    >
      {label}
    </Button>
  );
}
