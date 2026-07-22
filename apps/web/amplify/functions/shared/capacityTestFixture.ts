/**
 * TEST-ONLY — the capacity world a fake data client needs now that GL-04
 * fails CLOSED: slot ledger + claims + the GL-07 technician-day stop ledger
 * (share these maps with `memoryLockStore` so guarded adds and model reads
 * see one truth), plus empty closure/exception calendars. Spread `models`
 * into a test's fake client and register `maps` with the lock store.
 *
 * GL-07: creates enforce the REAL AppSync required-field contract — a create
 * missing a required field returns errors and no data, exactly as the
 * deployed API does. Tests must not be able to pass with impossible rows.
 */
export function capacityFixtureModels() {
  const capacityDays = new Map<string, Record<string, unknown>>();
  const capacityClaims = new Map<string, Record<string, unknown>>();
  const techDayStops = new Map<string, Record<string, unknown>>();
  const closures = new Map<string, Record<string, unknown>>();
  const exceptions = new Map<string, Record<string, unknown>>();

  const rowModel = (
    table: Map<string, Record<string, unknown>>,
    requiredFields: string[] = []
  ) => ({
    create: async (input: { id?: string } & Record<string, unknown>) => {
      // The deployed AppSync contract: a missing/null required field is a
      // validation error — the row is NOT created and errors come back.
      const missing = requiredFields.filter(
        (f) => input[f] === undefined || input[f] === null
      );
      if (missing.length > 0) {
        return {
          data: null,
          errors: missing.map((f) => ({
            message: `Variable 'input' has coerced Null value for NonNull type on field '${f}'`,
          })),
        };
      }
      const id = String(input.id ?? `${table.size + 1}`);
      if (table.has(id)) return { data: null };
      table.set(id, { ...input, id });
      return { data: { ...table.get(id)! } };
    },
    get: async ({ id }: { id: string }) => ({
      data: table.has(id) ? { ...table.get(id)! } : null,
    }),
    update: async (input: { id: string } & Record<string, unknown>) => {
      const row = table.get(input.id);
      if (!row) return { data: null };
      for (const [k, v] of Object.entries(input)) {
        if (v !== undefined) row[k] = v;
      }
      return { data: { ...row } };
    },
    delete: async ({ id }: { id: string }) => {
      const existed = table.get(id) ?? null;
      table.delete(id);
      return { data: existed };
    },
  });

  return {
    maps: { capacityDays, capacityClaims, techDayStops, closures, exceptions },
    models: {
      CapacityDay: {
        ...rowModel(capacityDays, ["date"]),
        list: async () => ({
          data: [...capacityDays.values()],
          nextToken: null,
        }),
        listCapacityDayByDate: async ({ date }: { date: string }) => ({
          data: [...capacityDays.values()].filter((r) => r.date === date),
          nextToken: null,
        }),
      },
      TechDayStops: {
        ...rowModel(techDayStops, ["date", "technicianId"]),
        list: async () => ({
          data: [...techDayStops.values()],
          nextToken: null,
        }),
        listTechDayStopsByDate: async ({ date }: { date: string }) => ({
          data: [...techDayStops.values()].filter((r) => r.date === date),
          nextToken: null,
        }),
      },
      CapacityClaim: {
        ...rowModel(capacityClaims),
        listCapacityClaimByDate: async ({ date }: { date: string }) => ({
          data: [...capacityClaims.values()].filter((r) => r.date === date),
          nextToken: null,
        }),
      },
      CompanyClosure: rowModel(closures),
      TechnicianDayException: {
        ...rowModel(exceptions),
        listTechnicianDayExceptionByDate: async ({ date }: { date: string }) => ({
          data: [...exceptions.values()].filter((r) => r.date === date),
          nextToken: null,
        }),
      },
    },
  };
}
