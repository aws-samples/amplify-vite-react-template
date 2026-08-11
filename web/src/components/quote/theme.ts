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

/**
 * Brand light theme: white ground, near-black type, gold field borders.
 *
 * Gold is the border and the focus colour so the form matches the logo, while
 * navy carries the buttons and the progress fill — gold-on-white cannot hold
 * white button text at an accessible contrast, so it stays an edge colour rather
 * than a fill. Resting borders use a softened gold; the full brand gold appears
 * on hover, focus and selection, which gives the form somewhere to go.
 */
export const LIGHT: Palette = {
  bg: "#ffffff",
  card: "#ffffff",
  cardHover: "#fffaf0",
  border: "#e8d5a8",
  borderActive: "#d4a940",
  accent: "#1a365d",
  accentHover: "#132a4a",
  accentDim: "rgba(229,193,106,0.14)",
  accentGlow: "rgba(26,54,93,0.20)",
  text: "#0b0d10",
  textMuted: "#5c6470",
  white: "#ffffff",
  error: "#c0392b",
  success: "#1f8b4c",
};

/* Day = 6:00 → 17:59 local time. Night otherwise. */
export function isDaytime(d = new Date()): boolean {
  const h = d.getHours();
  return h >= 6 && h < 18;
}

export const ThemeContext = createContext<Palette>(DARK);
export const useTheme = () => useContext(ThemeContext);

export type ThemeMode = "auto" | "light" | "dark";
