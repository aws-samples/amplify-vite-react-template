import { describe, expect, it } from "vitest";
import { WORK_POLICY as CRM_POLICY } from "./workPolicy";
// The server registry is authoritative (it enforces which closes are allowed).
// The CRM keeps a UI-facing mirror; this test fails the build if the two drift,
// so a new server kind can never ship with an empty override dropdown again.
import {
  WORK_POLICY as SERVER_POLICY,
  isValidManualReason,
} from "../../../web/amplify/functions/shared/workPolicy";

describe("GL-18 CRM work-policy mirror stays in step with the server", () => {
  it("mirrors every server kind — no kind is left un-overridable", () => {
    for (const kind of Object.keys(SERVER_POLICY)) {
      const crm = CRM_POLICY[kind];
      expect(crm, `CRM mirror is missing "${kind}" — its override dropdown would be empty`).toBeTruthy();
      // Every mirrored kind must offer at least one override reason.
      expect(crm.manualReasons.length, kind).toBeGreaterThan(0);
      expect(crm.manualReasons.some((r) => r.code === "OTHER"), kind).toBe(true);
    }
  });

  it("carries no kind the server doesn't know about", () => {
    for (const kind of Object.keys(CRM_POLICY)) {
      expect(SERVER_POLICY[kind as keyof typeof SERVER_POLICY], `CRM has an unknown kind "${kind}"`).toBeTruthy();
    }
  });

  it("severity matches the server for every kind", () => {
    for (const [kind, crm] of Object.entries(CRM_POLICY)) {
      const server = SERVER_POLICY[kind as keyof typeof SERVER_POLICY];
      if (!server) continue;
      expect(crm.severity, kind).toBe(server.severity);
    }
  });

  it("offers only reason codes the server will accept", () => {
    for (const [kind, crm] of Object.entries(CRM_POLICY)) {
      for (const reason of crm.manualReasons) {
        expect(
          isValidManualReason(kind, reason.code),
          `CRM offers "${reason.code}" for ${kind}, but the server rejects it`
        ).toBe(true);
      }
    }
  });
});
