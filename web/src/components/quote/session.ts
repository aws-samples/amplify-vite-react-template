import type { FormData } from "./schema";
import { states } from "../../data/states";

/* ──────────────────────────────────────────────────────────
   AGENT ROSTER — rotates per session
   ────────────────────────────────────────────────────────── */
export type Agent = { name: string; photo: string };

const AGENTS: Agent[] = [
  { name: "Maya Chen",        photo: "/agents/1.jpg" },
  { name: "David Reyes",      photo: "/agents/2.jpg" },
  { name: "Sarah Kim",        photo: "/agents/3.jpg" },
  { name: "Michael O'Brien",  photo: "/agents/4.jpg" },
  { name: "Priya Patel",      photo: "/agents/5.jpg" },
  { name: "Marcus Johnson",   photo: "/agents/6.jpg" },
  { name: "Emma Hartley",     photo: "/agents/7.jpg" },
  { name: "James Walker",     photo: "/agents/8.jpg" },
];

export function pickAgent(): Agent {
  return AGENTS[Math.floor(Math.random() * AGENTS.length)];
}

/* ──────────────────────────────────────────────────────────
   PERSISTENCE — survive refresh
   ────────────────────────────────────────────────────────── */
const STORAGE_KEY = "qf:state:v1";
export const THEME_KEY = "qf:theme:v1";

type PersistedState = {
  stepIndex: number;
  data: FormData;
  role: string | null;
  agent: Agent;
  inputVal: string;
  multiVal: string[];
};

export function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (
      typeof parsed.stepIndex !== "number" ||
      !parsed.data ||
      !parsed.agent
    ) {
      return null;
    }
    return {
      stepIndex: parsed.stepIndex,
      data: parsed.data as FormData,
      role: parsed.role ?? null,
      agent: parsed.agent as Agent,
      inputVal: typeof parsed.inputVal === "string" ? parsed.inputVal : "",
      multiVal: Array.isArray(parsed.multiVal) ? parsed.multiVal : [],
    };
  } catch {
    return null;
  }
}

export function saveState(s: PersistedState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* quota exceeded or private mode — silently ignore */
  }
}

export function clearState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/* ── Smart prefill from URL params ──
   Built from states.ts, not hand-listed. The hardcoded six-state map here meant
   that once the site gained a page per state, arriving from any of the other 45
   prefilled nothing and the visitor had to pick their state manually. */
const STATE_SLUGS: Record<string, string> = Object.fromEntries(
  states.map((s) => [s.slug, s.abbr])
);

export function getPrefillFromUrl(): Partial<{ state: string }> {
  try {
    const params = new URLSearchParams(window.location.search);
    const stateParam = params.get("state");
    if (stateParam) {
      // Direct: ?state=MA
      return { state: stateParam.toUpperCase() };
    }
    // Check referrer for state slug: came from /hoa-insurance-massachusetts
    const ref = document.referrer || "";
    const match = ref.match(/hoa-insurance-([a-z-]+?)(?:\/|$)/);
    if (match) {
      const abbr = STATE_SLUGS[match[1]];
      if (abbr) return { state: abbr };
    }
  } catch {
    /* ignore */
  }
  return {};
}
