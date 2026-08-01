/**
 * Which job types the office may complete without a technician's report.
 *
 * One copy, on the server: the office "✓ Complete" button shows only for a
 * serviceType in this set, and crm-docs' completeJob enforces the same set —
 * so hiding the button is a courtesy, not the guarantee. Adding a type there
 * changes both surfaces at once.
 */
export {
  ADMIN_JOB_SERVICE_TYPES,
  isOfficeCompletableServiceType,
} from "../../../web/amplify/functions/shared/adminJobTypes";
