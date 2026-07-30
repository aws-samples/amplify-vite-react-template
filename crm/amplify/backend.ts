import { defineBackend } from "@aws-amplify/backend";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import {
  AttributeType,
  BillingMode,
  Table,
  TableEncryption,
} from "aws-cdk-lib/aws-dynamodb";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";
import { processDocument } from "./functions/process-document/resource";
import { leadIntake } from "./functions/lead-intake/resource";
import { teamAdmin } from "./functions/team-admin/resource";
import { extractLead } from "./functions/extract-lead/resource";
import { certNumber } from "./functions/cert-number/resource";
import { renewalTasks } from "./functions/renewal-tasks/resource";
import {
  magicLinkDefine,
  magicLinkCreate,
  magicLinkVerify,
} from "./functions/magic-link/resource";

const backend = defineBackend({
  auth,
  data,
  storage,
  processDocument,
  leadIntake,
  teamAdmin,
  extractLead,
  certNumber,
  renewalTasks,
  magicLinkDefine,
  magicLinkCreate,
  magicLinkVerify,
});

// The OCR function drives async Textract jobs over uploaded documents.
backend.processDocument.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["textract:StartDocumentAnalysis", "textract:GetDocumentAnalysis"],
    resources: ["*"],
  })
);

// The extraction resolver re-invokes itself asynchronously (the actual
// Claude call outlives AppSync's 30s resolver limit). Wildcard resource:
// a self-referencing ARN would create a circular CFN dependency between
// the function and its role.
backend.extractLead.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["lambda:InvokeFunction"],
    resources: ["*"],
  })
);

// ── Certificate numbering counter ────────────────────────────────────
// A standalone DynamoDB table (partition key = year) holding one atomic
// counter per year. reserveCertificateNumber does a single UpdateItem ADD,
// so numbers are unique and gap-free even under concurrent COI issuance.
const certStack = backend.createStack("CertNumberStack");
const certSeqTable = new Table(certStack, "CertificateSequence", {
  partitionKey: { name: "year", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  encryption: TableEncryption.AWS_MANAGED,
  // The numbering ledger — keep it recoverable.
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
});
certSeqTable.grantReadWriteData(backend.certNumber.resources.lambda);
backend.certNumber.addEnvironment("SEQ_TABLE", certSeqTable.tableName);
backend.certNumber.addEnvironment("CERT_PREFIX", "HOA");
// Seed offsets for numbering that predates this system: 10 certificates were
// issued in 2026 (HOA-2026-00001 … HOA-2026-00010), so the counter starts at
// 10 and the first system-issued number is HOA-2026-00011. Once the 2026 row
// exists this offset is ignored (if_not_exists), so it's safe to leave.
backend.certNumber.addEnvironment(
  "CERT_SEQ_BASES",
  JSON.stringify({ "2026": 10 })
);

// ── Auth behavior ────────────────────────────────────────────────────
const { cfnUserPool, cfnUserPoolClient } = backend.auth.resources.cfnResources;

// Magic-link only: the custom auth flow is the sole sign-in path.
cfnUserPool.userPoolTier = "ESSENTIALS";
cfnUserPoolClient.explicitAuthFlows = [
  "ALLOW_CUSTOM_AUTH",
  "ALLOW_REFRESH_TOKEN_AUTH",
];

// Stay signed in for 7 days (refresh token lifetime).
cfnUserPoolClient.refreshTokenValidity = 7;
cfnUserPoolClient.tokenValidityUnits = { refreshToken: "days" };

// ── Magic link plumbing ──────────────────────────────────────────────
// Signing secret shared by the create/verify triggers (generated once per
// backend, never leaves Secrets Manager).
const magicLinkStack = backend.createStack("MagicLinkStack");
const magicLinkSecret = new Secret(magicLinkStack, "MagicLinkSigningSecret", {
  generateSecretString: { passwordLength: 64, excludePunctuation: true },
});
magicLinkSecret.grantRead(backend.magicLinkCreate.resources.lambda);
magicLinkSecret.grantRead(backend.magicLinkVerify.resources.lambda);

// Where the emailed link points, per branch (custom domains: update here).
const BRANCH_URLS: Record<string, string> = {
  staging: "https://staging.d2d4g940z91vj4.amplifyapp.com",
  main: "https://app.protectmyhoa.com",
};
const magicLinkBaseUrl =
  BRANCH_URLS[process.env.AWS_BRANCH ?? ""] ?? "http://localhost:5173";
// Sender must be SES-verified (protectmyhoa.com domain, DKIM verified).
const magicLinkFrom = "HOA Insurance Agency <noreply@protectmyhoa.com>";

backend.magicLinkCreate.addEnvironment("MAGIC_LINK_SECRET_ARN", magicLinkSecret.secretArn);
backend.magicLinkVerify.addEnvironment("MAGIC_LINK_SECRET_ARN", magicLinkSecret.secretArn);
backend.magicLinkCreate.addEnvironment("MAGIC_LINK_BASE_URL", magicLinkBaseUrl);
backend.magicLinkCreate.addEnvironment("MAGIC_LINK_FROM", magicLinkFrom);

backend.magicLinkCreate.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ses:SendEmail"],
    resources: ["*"],
  })
);

// ── Team admin (in-app invites) ──────────────────────────────────────
backend.teamAdmin.addEnvironment(
  "USER_POOL_ID",
  backend.auth.resources.userPool.userPoolId
);
backend.teamAdmin.addEnvironment("PORTAL_URL", magicLinkBaseUrl);
backend.teamAdmin.addEnvironment("INVITE_FROM", magicLinkFrom);
backend.teamAdmin.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: [
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminListGroupsForUser",
      "cognito-idp:ListUsers",
    ],
    resources: [backend.auth.resources.userPool.userPoolArn],
  })
);
backend.teamAdmin.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ses:SendEmail"],
    resources: ["*"],
  })
);
