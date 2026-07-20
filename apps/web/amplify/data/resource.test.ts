import { describe, expect, it } from "vitest";
import { schema } from "./resource";

/**
 * Deploy 41 failed at backend synth with "Object type extension 'Mutation'
 * cannot redeclare field createQuote": a custom mutation carried the same
 * name as the create mutation the model transformer generates for the Quote
 * model. tsc cannot see that collision — the schema is a plain object whose
 * keys never meet — so npm test checks it here, the same way deploy 40's
 * failure class got a test.
 */

/** How the transformer pluralizes for list<Models> (regular plurals only —
 *  every model name here is regular; a new irregular one weakens only the
 *  `list` check, not create/update/delete/get). */
const plural = (name: string) =>
  /(s|x|z|ch|sh)$/.test(name)
    ? `${name}es`
    : /[^aeiou]y$/.test(name)
      ? `${name.slice(0, -1)}ies`
      : `${name}s`;

/** Operation names the model transformer generates for one model. */
const generatedOps = (model: string) => [
  `create${model}`,
  `update${model}`,
  `delete${model}`,
  `get${model}`,
  `list${plural(model)}`,
  `onCreate${model}`,
  `onUpdate${model}`,
  `onDelete${model}`,
];

describe("custom operations vs generated model operations", () => {
  const sdl = schema.transform().schema;

  // Every `type X ... {` header whose directives include @model.
  const models: string[] = [];
  for (const m of sdl.matchAll(/type\s+(\w+)([^{]*)\{/g)) {
    if (/@model\b/.test(m[2])) models.push(m[1]);
  }

  // Field names declared on the custom Mutation/Query/Subscription types.
  const customOps: string[] = [];
  for (const block of sdl.matchAll(
    /(?:extend\s+)?type\s+(?:Mutation|Query|Subscription)\s*\{([\s\S]*?)\n\}/g
  )) {
    for (const field of block[1].matchAll(/^\s*(\w+)\s*[(:]/gm)) {
      customOps.push(field[1]);
    }
  }

  it("still sees the schema (regex rot guard)", () => {
    expect(models).toContain("Customer");
    expect(customOps).toContain("priceLead");
    expect(customOps).toContain("requestPricingResearch");
  });

  it("the office-sold conversion branch stays dead", () => {
    // The Quote model and the e-sign mutations were removed with the whole
    // office-sold path — the funnel is the only conversion. If any of these
    // come back, the lead lifecycle has forked again.
    expect(models).not.toContain("Quote");
    for (const op of [
      "quotePlan",
      "authorAgreement",
      "sendAgreement",
      "voidAgreement",
    ]) {
      expect(customOps).not.toContain(op);
    }
  });

  it("no custom operation redeclares a generated one", () => {
    const generated = new Set(models.flatMap(generatedOps));
    const collisions = customOps.filter((op) => generated.has(op));
    expect(
      collisions,
      `custom operation(s) ${collisions.join(", ")} collide with a ` +
        `model's generated operations — rename the custom operation ` +
        `(the deploy fails at synth, after tests pass)`
    ).toEqual([]);
  });
});

/**
 * GL-13 — technician least-privilege at the model API. A TECH token reads the
 * raw model (get/list/subscribe/pagination), so "the UI hides it" is not a
 * control. These assertions run against the transformed SDL — the actual
 * @auth directives AppSync enforces — so a model or field that quietly regains
 * TECH read fails here, not in production. Two layers are checked: row-scoping
 * (the tech-served models grant TECH no model read; the field app reads only
 * through the scoped technicianDay/technicianJob queries) and field-scoping
 * (the sensitive Customer/Technician fields carry field @auth that omits TECH,
 * as defense in depth even where a model read is granted to office/portal).
 */
describe("GL-13 technician least-privilege (SDL @auth)", () => {
  const sdl = schema.transform().schema;

  const modelBlock = (name: string) => {
    const m = sdl.match(new RegExp(`type ${name} [^{]*\\{[\\s\\S]*?\\n\\}`));
    if (!m) throw new Error(`model ${name} not found in SDL`);
    return m[0];
  };
  // The @auth on the type itself (everything before the field block). The
  // field body opens with a brace at the start of its own line; the braces
  // inside @auth(rules: [{...}]) are inline, so split on "\n{" not "{".
  const modelHeader = (name: string) => {
    const block = modelBlock(name);
    return block.slice(0, block.indexOf("\n{"));
  };
  // A field's declaration plus its own directives, up to the next field.
  const fieldText = (name: string, field: string) => {
    const lines = modelBlock(name).split("\n");
    const start = lines.findIndex((l) => new RegExp(`^  ${field}:`).test(l));
    if (start < 0) throw new Error(`field ${name}.${field} not found`);
    let end = start + 1;
    while (
      end < lines.length &&
      !/^ {2}\w+:/.test(lines[end]) &&
      !/^\}/.test(lines[end])
    ) {
      end++;
    }
    return lines.slice(start, end).join("\n");
  };

  it("still sees the schema (regex rot guard)", () => {
    expect(modelHeader("Customer")).toContain("@auth");
    expect(fieldText("Customer", "displayName")).toContain("displayName");
  });

  it("raw staff Customer.create is denied; lead intake is named-action only", () => {
    const header = modelHeader("Customer");
    expect(header).toContain('groups: ["OWNER", "OFFICE"]');
    expect(header).toContain("operations: [read]");
    expect(header).not.toContain("operations: [create, read]");
  });

  it("grants TECH no model read on any tech-served model (row-scoping)", () => {
    // A known customer/job/route/report/technician id must not reveal another
    // worker's rows through the model API. TECH reads only via the scoped
    // queries; office and the portal (accessGroups) keep their access.
    for (const model of [
      "Customer",
      "Job",
      "Route",
      "Technician",
      "ServiceReport",
      "ServiceReportAmendment",
      "ServicePlan",
      "CustomerGroup",
    ]) {
      expect(modelHeader(model), `${model} must not grant TECH`).not.toContain(
        "TECH"
      );
      expect(modelHeader(model), `${model} keeps office read`).toContain(
        'groups: ["OWNER", "OFFICE"]'
      );
    }
  });

  it("exposes the scoped read surface the field app uses instead", () => {
    // The two server-scoped queries must exist (they are the ONLY way a TECH
    // reaches job/customer/route data now).
    const queryBlock = sdl.match(/type Query[\s\S]*?\n\}/)?.[0] ?? "";
    expect(queryBlock).toContain("technicianDay");
    expect(queryBlock).toContain("technicianJob");
  });

  it("a technician cannot read billing, provider ids, portal internals, lead data, or org notes on Customer", () => {
    for (const f of [
      "billingStreet",
      "billingCity",
      "billingState",
      "billingZip",
      "leadSource",
      "leadNotes",
      "contactConsent",
      "contactConsentAt",
      "convertedAt",
      "notes",
      "stripeCustomerId",
      "paymentMethodLabel",
      "paymentMethodKind",
      "portalUserSub",
      "portalInvitedAt",
      "portalLastLoginAt",
      "bookingLinkToken",
      "accessGroups",
    ]) {
      const t = fieldText("Customer", f);
      expect(t, `Customer.${f} must have a field-level @auth`).toContain("@auth");
      expect(t, `Customer.${f} must not grant TECH`).not.toContain("TECH");
      // Office and the portal customer keep their read.
      expect(t, `Customer.${f} keeps office read`).toContain('groups: ["OWNER", "OFFICE"]');
      expect(t, `Customer.${f} keeps portal read`).toContain('groupsField: "accessGroups"');
    }
  });

  it("a technician cannot read another applicator's licence credentials", () => {
    // Defense in depth: even though TECH now has no Technician model read at
    // all, the licence fields carry their own office-only @auth.
    for (const f of ["licenseNumber", "licenseExpiresOn"]) {
      const t = fieldText("Technician", f);
      expect(t, `Technician.${f} field @auth`).toContain("@auth");
      expect(t, `Technician.${f} no TECH`).not.toContain("TECH");
    }
  });
});
