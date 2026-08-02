/**
 * GL-18 — the exception (owned-work) policy, for the CRM work queue.
 *
 * The registry itself lives in amplify/functions/shared/workPolicy.ts and is
 * re-exported here. This file used to be a hand-kept mirror of the UI-facing
 * fields, which meant the queue could offer a button the server would refuse,
 * or describe an exception differently from the system that raised it.
 *
 * What stays local is presentation only: how a severity is coloured and worded
 * in this UI. The server has no opinion on either, and should not.
 */

export type {
  ExternalAction as CrmExternalAction,
  ManualReason as CrmManualReason,
  VerifiedResolution as CrmVerifiedAction,
  WorkPolicy as CrmWorkPolicy,
  WorkSeverity,
} from "../../../web/amplify/functions/shared/workPolicy";
export {
  isVerifiable,
  workPolicy,
  WORK_POLICY,
} from "../../../web/amplify/functions/shared/workPolicy";

import type { WorkSeverity } from "../../../web/amplify/functions/shared/workPolicy";

export const SEVERITY_TONE: Record<
  WorkSeverity,
  "danger" | "warn" | "info"
> = {
  CRITICAL: "danger",
  HIGH: "warn",
  ROUTINE: "info",
};

export const SEVERITY_LABEL: Record<WorkSeverity, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  ROUTINE: "Routine",
};
