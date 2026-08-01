import { useEffect, useRef } from "react";

/**
 * Google Places address autocomplete for CRM address fields.
 *
 * Configure VITE_GOOGLE_PLACES_KEY (Amplify env var on the CRM app — same
 * Google key the marketing site uses as PUBLIC_GOOGLE_PLACES_KEY). Without
 * a key the field degrades gracefully to a plain text input.
 */

const KEY = (import.meta.env.VITE_GOOGLE_PLACES_KEY as string | undefined) ?? "";

declare global {
  interface Window {
    google?: typeof google;
  }
}

let loadPromise: Promise<boolean> | null = null;

function loadGooglePlaces(): Promise<boolean> {
  if (!KEY) return Promise.resolve(false);
  if (window.google?.maps?.places) return Promise.resolve(true);
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${KEY}&libraries=places`;
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  return loadPromise;
}

interface AddressParts {
  address: string;
  city: string;
  state: string;
  zip: string;
}

export function AddressAutocomplete({
  value,
  onChange,
  onPlace,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onPlace: (parts: AddressParts) => void;
  placeholder?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const acRef = useRef<google.maps.places.Autocomplete | null>(null);
  const onPlaceRef = useRef(onPlace);
  onPlaceRef.current = onPlace;

  useEffect(() => {
    let cancelled = false;
    loadGooglePlaces().then((ok) => {
      if (!ok || cancelled || !inputRef.current || acRef.current) return;
      try {
        const ac = new google.maps.places.Autocomplete(inputRef.current, {
          types: ["address"],
          componentRestrictions: { country: "us" },
          fields: ["address_components"],
        });
        ac.addListener("place_changed", () => {
          const place = ac.getPlace();
          const comps = place.address_components ?? [];
          const get = (type: string, short = false) =>
            comps.find((c) => c.types.includes(type))?.[short ? "short_name" : "long_name"] ?? "";
          const streetNumber = get("street_number");
          const route = get("route");
          onPlaceRef.current({
            address: [streetNumber, route].filter(Boolean).join(" "),
            city: get("locality") || get("sublocality") || get("postal_town"),
            state: get("administrative_area_level_1", true).toUpperCase(),
            zip: get("postal_code"),
          });
        });
        acRef.current = ac;
      } catch {
        /* Maps failed to initialize — plain input still works */
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <input
      ref={inputRef}
      value={value}
      placeholder={placeholder ?? "Start typing an address…"}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
