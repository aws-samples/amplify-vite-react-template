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
    expect(models).toContain("Quote");
    expect(customOps).toContain("quotePlan");
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
