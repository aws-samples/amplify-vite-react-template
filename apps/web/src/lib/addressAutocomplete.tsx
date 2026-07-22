import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Google Places (New) address autocomplete input.
 *
 * Reads VITE_GOOGLE_MAPS_API_KEY at build time; when the key is absent the
 * component renders a plain <input> so forms degrade cleanly. Uses the REST
 * Autocomplete + Place Details endpoints (no Maps JS SDK download) with a
 * per-lookup session token so Google bills the pair as one session.
 */

export type ResolvedAddress = {
  street: string;
  city: string;
  state: string;
  zip: string;
};

type Suggestion = { placeId: string; text: string };

const API_KEY: string | undefined = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

async function fetchSuggestions(
  input: string,
  sessionToken: string,
  signal: AbortSignal
): Promise<Suggestion[]> {
  const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY!,
    },
    body: JSON.stringify({
      input,
      sessionToken,
      includedRegionCodes: ["us"],
    }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    suggestions?: Array<{
      placePrediction?: { placeId?: string; text?: { text?: string } };
    }>;
  };
  return (data.suggestions ?? [])
    .map((s) => ({
      placeId: s.placePrediction?.placeId ?? "",
      text: s.placePrediction?.text?.text ?? "",
    }))
    .filter((s) => s.placeId && s.text);
}

async function fetchAddress(
  placeId: string,
  sessionToken: string
): Promise<ResolvedAddress | null> {
  const res = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?sessionToken=${sessionToken}`,
    {
      headers: {
        "X-Goog-Api-Key": API_KEY!,
        "X-Goog-FieldMask": "addressComponents",
      },
    }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    addressComponents?: Array<{
      longText?: string;
      shortText?: string;
      types?: string[];
    }>;
  };
  const comps = data.addressComponents ?? [];
  const get = (type: string, short = false) => {
    const c = comps.find((x) => x.types?.includes(type));
    return (short ? c?.shortText : c?.longText) ?? "";
  };
  const streetNumber = get("street_number");
  const route = get("route");
  return {
    street: [streetNumber, route].filter(Boolean).join(" "),
    city: get("locality") || get("postal_town") || get("sublocality_level_1"),
    state: get("administrative_area_level_1", true),
    zip: get("postal_code"),
  };
}

export function AddressAutocompleteInput({
  value,
  onChangeText,
  onResolved,
  ...inputProps
}: {
  value: string;
  onChangeText: (text: string) => void;
  onResolved: (address: ResolvedAddress) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlight, setHighlight] = useState(-1);
  const [sessionToken, setSessionToken] = useState(() => crypto.randomUUID());
  const skipNextLookup = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const enabled = useMemo(() => Boolean(API_KEY), []);

  useEffect(() => {
    if (!enabled) return;
    if (skipNextLookup.current) {
      skipNextLookup.current = false;
      return;
    }
    const query = value.trim();
    if (query.length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchSuggestions(query, sessionToken, controller.signal)
        .then((s) => {
          setSuggestions(s);
          setOpen(s.length > 0);
          setHighlight(-1);
        })
        .catch(() => {
          /* aborted or network hiccup — keep the input usable */
        });
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [value, enabled, sessionToken]);

  const select = async (s: Suggestion) => {
    skipNextLookup.current = true;
    setOpen(false);
    setSuggestions([]);
    const address = await fetchAddress(s.placeId, sessionToken);
    setSessionToken(crypto.randomUUID()); // details call ends the session
    if (address && address.street) {
      onResolved(address);
    } else {
      onChangeText(s.text); // fall back to the raw suggestion text
    }
  };

  if (!enabled) {
    return (
      <input
        {...inputProps}
        value={value}
        onChange={(e) => onChangeText(e.target.value)}
      />
    );
  }

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <input
        {...inputProps}
        value={value}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(e) => onChangeText(e.target.value)}
        onBlur={(e) => {
          inputProps.onBlur?.(e);
          // Delay so a mousedown on a suggestion can win the race.
          setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter" && highlight >= 0) {
            e.preventDefault();
            void select(suggestions[highlight]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && (
        <ul
          role="listbox"
          style={{
            position: "absolute",
            zIndex: 30,
            top: "100%",
            left: 0,
            right: 0,
            margin: "4px 0 0",
            padding: 4,
            listStyle: "none",
            background: "var(--surface, #fff)",
            color: "inherit",
            border: "1px solid rgba(0,0,0,0.15)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            maxHeight: 240,
            overflowY: "auto",
          }}
        >
          {suggestions.map((s, i) => (
            <li
              key={s.placeId}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => {
                e.preventDefault();
                void select(s);
              }}
              onMouseEnter={() => setHighlight(i)}
              style={{
                padding: "8px 10px",
                borderRadius: 6,
                cursor: "pointer",
                background: i === highlight ? "rgba(0,0,0,0.08)" : "transparent",
              }}
            >
              {s.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
