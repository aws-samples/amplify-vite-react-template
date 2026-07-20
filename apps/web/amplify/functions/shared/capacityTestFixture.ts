/**
 * TEST-ONLY — the capacity world a fake data client needs now that GL-04
 * fails CLOSED: slot ledger + claims (share these maps with
 * `memoryLockStore` so guarded adds and model reads see one truth), plus
 * empty closure/exception calendars. Spread `models` into a test's fake
 * client and register `maps` with the lock store.
 */
export function capacityFixtureModels() {
  const capacityDays = new Map<string, Record<string, unknown>>();
  const capacityClaims = new Map<string, Record<string, unknown>>();
  const closures = new Map<string, Record<string, unknown>>();
  const exceptions = new Map<string, Record<string, unknown>>();

  const rowModel = (table: Map<string, Record<string, unknown>>) => ({
    create: async (input: { id?: string } & Record<string, unknown>) => {
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
    maps: { capacityDays, capacityClaims, closures, exceptions },
    models: {
      CapacityDay: {
        ...rowModel(capacityDays),
        list: async () => ({
          data: [...capacityDays.values()],
          nextToken: null,
        }),
        listCapacityDayByDate: async ({ date }: { date: string }) => ({
          data: [...capacityDays.values()].filter((r) => r.date === date),
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
