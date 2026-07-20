import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { fetchAuthSession } from "aws-amplify/auth";

export type Roles = {
  /** Every staff capability: office work, money movement, invites, role
   *  changes. The consolidated staff seat (OFFICE + FINANCE folded in). */
  owner: boolean;
  /** Day-to-day office work. Alias of `owner` now that OFFICE folded into it —
   *  kept so the many `roles.office` UI branches read as intent. */
  office: boolean;
  /** May move money. Alias of `owner` now that FINANCE folded into it. */
  finance: boolean;
  tech: boolean;
  customer: boolean;
  /** All Cognito groups, including dynamic cus-/grp- groups. */
  groups: string[];
  sub: string;
  email: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

const RolesContext = createContext<Roles | null>(null);

export function RolesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<Roles, "refresh">>({
    owner: false,
    office: false,
    finance: false,
    tech: false,
    customer: false,
    groups: [],
    sub: "",
    email: null,
    loading: true,
  });

  const refresh = useCallback(async () => {
    try {
      const session = await fetchAuthSession();
      const payload = session.tokens?.accessToken.payload;
      const groups = (payload?.["cognito:groups"] as string[] | undefined) ?? [];
      const idPayload = session.tokens?.idToken?.payload;
      // Staff roles are consolidated to OWNER + TECH. office/finance are aliases
      // of owner now that OFFICE/FINANCE folded into it — this mirrors
      // callerIsOffice/callerIsFinance in amplify/functions/shared/authz.
      const owner = groups.includes("OWNER");
      setState({
        owner,
        office: owner,
        finance: owner,
        tech: groups.includes("TECH"),
        customer: groups.includes("CUSTOMER"),
        groups,
        sub: (payload?.sub as string | undefined) ?? "",
        email: (idPayload?.email as string | undefined) ?? null,
        loading: false,
      });
    } catch {
      setState((s) => ({ ...s, loading: false }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <RolesContext.Provider value={{ ...state, refresh }}>
      {children}
    </RolesContext.Provider>
  );
}

export function useRoles(): Roles {
  const ctx = useContext(RolesContext);
  if (!ctx) throw new Error("useRoles must be used inside RolesProvider");
  return ctx;
}

/** Customer ids this (portal) user can see via dynamic cus- groups. */
export function myCustomerIds(roles: Roles): string[] {
  return roles.groups
    .filter((g) => g.startsWith("cus-"))
    .map((g) => g.slice(4));
}

/** CustomerGroup ids this user belongs to via dynamic grp- groups. */
export function myGroupIds(roles: Roles): string[] {
  return roles.groups
    .filter((g) => g.startsWith("grp-"))
    .map((g) => g.slice(4));
}
