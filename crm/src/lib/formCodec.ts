/**
 * The two coercions that sit between form state and an Amplify write.
 *
 * Every form in this app holds its fields as strings — including the numerics,
 * because that is what an `<input>` gives back (see the audit on `string`
 * holding structured data). The schema holds nullable columns. Something has
 * to translate, and today 68 call sites each translate by hand:
 *
 *   - `x.trim() || null`            ×49
 *   - `x ? Number(x) : null`        ×19  (2 of those are search filters, not writes)
 *
 * plus a handful of `x.trim() || undefined` on create-only payloads, and three
 * separate file-local `num` declarations (`CoverageForm.tsx:42`,
 * `CarrierDetail.tsx:512`, and this module).
 *
 * `useFormState` deliberately stops short of this boundary and names what
 * belongs here: "a codec that produces `initial` and consumes `form`".
 * `inputValue` is the producing half; `str`/`num` are the consuming half.
 *
 * ## Why these return `null` and there is no `undefined` variant
 *
 * On an Amplify `update`, `undefined` is a no-op and `null` clears. That is not
 * a style question: a form whose user blanked a field means "clear it", and
 * only `null` says so. `undefined` there is a silent bug — the audit found two
 * live ones (`Onboarding.tsx:91`, `Licensing.tsx:753`, both payloads spread
 * into `update` *and* `create`, where the update path can never clear a stale
 * value).
 *
 * On `create` the two are interchangeable *in this schema*: every field written
 * by an `|| undefined` site is a plain nullable column, the schema declares
 * exactly one `.default()` (`Certificate.formType`, always passed explicitly
 * anyway), and nothing anywhere filters on `attributeExists`. So an explicit
 * `null` on create stores what omitting the key stores.
 *
 * Which means `null` is correct at all 68 sites and `undefined` is correct at
 * some — so offering both would only let a caller pick the hazardous one. If a
 * future call site genuinely needs the no-op, it should say `?? undefined` at
 * the point of use, where the reader can see the choice being made.
 *
 * ## Why these never return `NaN`
 *
 * `Number("abc")` is `NaN`, and `NaN` in an `a.float()` column is a real bug.
 * No current site can reach it — every numeric field is fed by an
 * `<input type="number">`, which sanitizes a non-numeric entry to `""` before
 * it ever reaches state — but relying on that is relying on the markup of 19
 * call sites staying correct forever. `num` returns `number | null`, and the
 * `null` is honest: there is no number here. Deciding whether the user should
 * be *told* that is a validator's job, not this one's.
 */

/**
 * A trimmed string for the column, or `null` when the user left it blank.
 *
 * Whitespace-only counts as blank. Replaces `x.trim() || null`, and evaluates
 * to exactly what that idiom evaluates to (it, too, yields the *trimmed*
 * string).
 */
export function str(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * A finite number for the column, or `null` when the field is blank or holds
 * something that isn't a number.
 *
 * `"0"` is a value, not a blank — `Number.isFinite(0)` is `true`, so `"0"`
 * writes `0`. Only `""`, whitespace, and unparseable text become `null`.
 * `Infinity` and `NaN` are unparseable for this purpose: neither belongs in a
 * numeric column.
 *
 * Number formatting is not stripped. `"1,200"` is `null`, not `1200` — no
 * `type="number"` input can produce it, and the one place that really does
 * parse formatted text (`ExtractionPanel`'s `coerce`) is a different codec with
 * a different job.
 */
export function num(v: string | null | undefined): number | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * The other direction: the string an `<input>` should show for a stored value.
 *
 * Replaces the seeding idioms `x ?? ""` and `x?.toString() ?? ""`. `0` renders
 * as `"0"`, not `""` — `String` is not `||`.
 *
 * Note for anyone migrating `CoverageForm.tsx`: its file-local `str` is *this*
 * function, not the `str` above. The two names point opposite ways.
 */
export function inputValue(v: string | number | null | undefined): string {
  return v == null ? "" : String(v);
}
