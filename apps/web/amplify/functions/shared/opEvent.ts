/**
 * Amplify Gen 2 custom-operation resolvers invoke the Lambda with
 * `fieldName`/`typeName` at the TOP LEVEL of the payload (unlike classic
 * AppSync Lambda resolvers, where they live under `info`). Support both so
 * handlers keep working if the resolver shape changes.
 */
export function opFieldName(event: unknown): string {
  const e = event as {
    fieldName?: string;
    info?: { fieldName?: string };
  };
  const name = e.fieldName ?? e.info?.fieldName;
  if (!name) throw new Error("Cannot determine operation field name");
  return name;
}
