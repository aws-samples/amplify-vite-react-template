/**
 * GL-02 — the single home for contact normalization and duplicate detection.
 *
 * Before GL-02 the codebase had three divergent normalizePhone copies and ran
 * duplicate detection at exactly ONE point (bookingFinalize, post-payment). The
 * gate requires normalization + a duplicate lookup BEFORE creation on every lead
 * path, and the system must never silently merge people — so a match returns
 * candidates for a human decision, it does not auto-merge. A read failure is
 * deliberately thrown: "could not check" is not evidence that no duplicate
 * exists.
 */

import { dataClient } from "./dataClient";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw?: string | null): string | undefined {
  const v = (raw ?? "").trim().toLowerCase();
  return v && EMAIL_RE.test(v) ? v : undefined;
}

/** Digits → E.164, tolerating an already-E.164 value (the old copies rejected it). */
export function normalizePhone(raw?: string | null): string | undefined {
  const s = (raw ?? "").trim();
  if (/^\+\d{10,15}$/.test(s)) return s;
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return undefined;
}

/** Lowercase, strip punctuation, collapse whitespace — for a name comparison. */
export function normalizeName(raw?: string | null): string | undefined {
  const v = (raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return v || undefined;
}

export function normalizeZip(raw?: string | null): string | undefined {
  const d = (raw ?? "").replace(/\D/g, "").slice(0, 5);
  return d.length === 5 ? d : undefined;
}

export type LeadCandidate = {
  id: string;
  displayName: string;
  status: string;
  email: string | null;
  phone: string | null;
  serviceCity: string | null;
  /** Why this record is a possible duplicate. */
  matchedOn: "email" | "phone" | "name+zip";
};

type CustomerRow = {
  id: string;
  displayName: string;
  contactName?: string | null;
  status?: string | null;
  email?: string | null;
  phone?: string | null;
  serviceCity?: string | null;
  serviceZip?: string | null;
};

/**
 * Find existing customers a new lead might duplicate. Matches on exact
 * normalized email OR exact normalized phone OR (normalized name AND same zip) —
 * never on address alone, since two people share a household. One paginated scan
 * (no email/phone index yet; fine at BuzzKill's volume). The collection is
 * paged to completion. Any page error fails closed rather than authorizing an
 * ordinary create with an unknown duplicate state.
 */
export async function findLeadDuplicates(input: {
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  zip?: string | null;
  excludeId?: string | null;
}): Promise<LeadCandidate[]> {
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const name = normalizeName(input.name);
  const zip = normalizeZip(input.zip);
  if (!email && !phone && !(name && zip)) return [];

  const client = await dataClient();
  const out: LeadCandidate[] = [];
  let token: string | null | undefined;
  do {
    const page = await client.models.Customer.list({
      limit: 200,
      nextToken: token,
    });
    if (page.errors?.length) {
      throw new Error(page.errors.map((error) => error.message).join("; "));
    }
      for (const raw of (page.data ?? []) as CustomerRow[]) {
        if (input.excludeId && raw.id === input.excludeId) continue;
        const cEmail = normalizeEmail(raw.email);
        const cPhone = normalizePhone(raw.phone);
        const cName = normalizeName(raw.displayName) ?? normalizeName(raw.contactName);
        const cZip = normalizeZip(raw.serviceZip);
        let matchedOn: LeadCandidate["matchedOn"] | null = null;
        if (email && cEmail && email === cEmail) matchedOn = "email";
        else if (phone && cPhone && phone === cPhone) matchedOn = "phone";
        else if (name && zip && cName && cZip && name === cName && zip === cZip) {
          matchedOn = "name+zip";
        }
        if (matchedOn) {
          out.push({
            id: raw.id,
            displayName: raw.displayName,
            status: String(raw.status ?? ""),
            email: raw.email ?? null,
            phone: raw.phone ?? null,
            serviceCity: raw.serviceCity ?? null,
            matchedOn,
          });
        }
      }
    token = page.nextToken;
  } while (token);
  return out;
}
