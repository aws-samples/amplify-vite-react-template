import { createContext, useContext } from "react";

/* ──────────────────────────────────────────────────────────
   PALETTES — dark (night) + light (day)
   Auto-switched based on local time of day.
   ────────────────────────────────────────────────────────── */
type Palette = {
  bg: string;
  card: string;
  cardHover: string;
  border: string;
  borderActive: string;
  accent: string;
  accentHover: string;
  accentDim: string;
  accentGlow: string;
  text: string;
  textMuted: string;
  white: string;
  error: string;
  success: string;
};

export const DARK: Palette = {
  bg: "#0b1220",
  card: "#131c2e",
  cardHover: "#182339",
  border: "#1f2a40",
  borderActive: "#4da6ff",
  accent: "#4da6ff",
  accentHover: "#79bbff",
  accentDim: "rgba(77,166,255,0.10)",
  accentGlow: "rgba(77,166,255,0.35)",
  text: "#e6edf3",
  textMuted: "#8b95a8",
  white: "#ffffff",
  error: "#f85149",
  success: "#3fb950",
};

export const LIGHT: Palette = {
  bg: "#f6f8fc",
  card: "#ffffff",
  cardHover: "#f0f4fb",
  border: "#dfe5ef",
  borderActive: "#1f7ae0",
  accent: "#1f7ae0",
  accentHover: "#1668c4",
  accentDim: "rgba(31,122,224,0.08)",
  accentGlow: "rgba(31,122,224,0.22)",
  text: "#0f172a",
  textMuted: "#5b6776",
  white: "#ffffff",
  error: "#d92d20",
  success: "#16a34a",
};

/* Day = 6:00 → 17:59 local time. Night otherwise. */
export function isDaytime(d = new Date()): boolean {
  const h = d.getHours();
  return h >= 6 && h < 18;
}

export const ThemeContext = createContext<Palette>(DARK);
export const useTheme = () => useContext(ThemeContext);

export type ThemeMode = "auto" | "light" | "dark";
