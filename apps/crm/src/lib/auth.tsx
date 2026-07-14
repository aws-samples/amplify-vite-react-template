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
  office: boolean;
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
    office: false,
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
      setState({
        office: groups.includes("OFFICE"),
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
