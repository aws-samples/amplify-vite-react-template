import { defineBackend } from "@aws-amplify/backend";
import { Duration } from "aws-cdk-lib";
import {
  FunctionUrlAuthType,
  HttpMethod,
  InvokeMode,
} from "aws-cdk-lib/aws-lambda";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";
import { leadIntake } from "./functions/lead-intake/resource";
import { crmAdmin } from "./functions/crm-admin/resource";
import { crmBilling } from "./functions/crm-billing/resource";
import { stripeWebhook } from "./functions/stripe-webhook/resource";
import { crmDocs } from "./functions/crm-docs/resource";
import { agreementPublic } from "./functions/agreement-public/resource";
import { dailyReminders } from "./functions/daily-reminders/resource";

const backend = defineBackend({
  auth,
  data,
  storage,
  leadIntake,
  crmAdmin,
  crmBilling,
  stripeWebhook,
  crmDocs,
  agreementPublic,
  dailyReminders,
});

// CRM logins are invite-only (office provisions staff and portal users via
// adminCreateUser) — block public self-signup and brand the invite email.
// The CRM URL is overridable per-branch via hosting env vars if a custom
// domain is added later.
const crmUrl = process.env.CRM_APP_URL ?? "https://staging.d5ln2hbbp9s2j.amplifyapp.com";
backend.auth.resources.cfnResources.cfnUserPool.adminCreateUserConfig = {
  allowAdminCreateUserOnly: true,
  inviteMessageTemplate: {
    emailSubject: "Your BuzzKill Pest Control account",
    emailMessage:
      "Welcome! An account has been created for you at BuzzKill Pest Control. " +
      `Sign in at ${crmUrl} with username {username} and temporary password {####} — ` +
      "you'll choose your own password on first sign-in.",
  },
};

// Grant SES send permissions to the lead-intake function
backend.leadIntake.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ses:SendEmail", "ses:SendRawEmail"],
    resources: ["*"],
  }),
);

// Public Function URL for the contact-form proxy. CORS is locked to the
// production + staging origins (and localhost for dev). Auth is NONE
// because the form is unauthenticated — protection comes from CORS +
// the function's own validation.
const leadIntakeUrl = backend.leadIntake.resources.lambda.addFunctionUrl({
  authType: FunctionUrlAuthType.NONE,
  invokeMode: InvokeMode.BUFFERED,
  cors: {
    allowedOrigins: [
      "https://www.pestbuzzkill.com",
      "https://pestbuzzkill.com",
      "https://buzzkill-pest-control.squarespace.com",
      "http://localhost:5173",
    ],
    allowedMethods: [HttpMethod.POST],
    allowedHeaders: ["Content-Type"],
    maxAge: Duration.seconds(86400),
  },
});

// Stripe webhook receiver: public URL, protected by Stripe signature
// verification inside the handler (register it in the Stripe dashboard).
const stripeWebhookUrl = backend.stripeWebhook.resources.lambda.addFunctionUrl({
  authType: FunctionUrlAuthType.NONE,
  invokeMode: InvokeMode.BUFFERED,
});

// Public e-sign API for the CRM's /sign/<token> page. Unauthenticated by
// design (leads sign before they have logins); access is gated by the
// unguessable per-agreement token, plus CORS to the CRM origins.
const crmOrigins = [
  "https://staging.d5ln2hbbp9s2j.amplifyapp.com",
  "https://main.d5ln2hbbp9s2j.amplifyapp.com",
  "http://localhost:5174",
];
const agreementPublicUrl =
  backend.agreementPublic.resources.lambda.addFunctionUrl({
    authType: FunctionUrlAuthType.NONE,
    invokeMode: InvokeMode.BUFFERED,
    cors: {
      allowedOrigins: crmOrigins,
      allowedMethods: [HttpMethod.GET, HttpMethod.POST],
      allowedHeaders: ["Content-Type"],
      maxAge: Duration.seconds(86400),
    },
  });

// Documents bucket + SES wiring for the functions that produce PDFs and
// send mail. Grants are explicit CDK (rather than storage/access rules) so
// each function gets exactly what it needs.
const docsBucket = backend.storage.resources.bucket;
const sesPolicy = new PolicyStatement({
  actions: ["ses:SendEmail", "ses:SendRawEmail"],
  resources: ["*"],
});
const crmUrlEnv = process.env.CRM_APP_URL ?? "https://staging.d5ln2hbbp9s2j.amplifyapp.com";

for (const fn of [backend.crmDocs, backend.agreementPublic, backend.dailyReminders]) {
  fn.resources.lambda.addToRolePolicy(sesPolicy);
  fn.addEnvironment("SES_FROM_EMAIL", "info@pestbuzzkill.com");
  fn.addEnvironment("SES_NOTIFY_EMAIL", "info@pestbuzzkill.com");
  fn.addEnvironment("CRM_APP_URL", crmUrlEnv);
}
docsBucket.grantReadWrite(backend.crmDocs.resources.lambda);
docsBucket.grantWrite(backend.agreementPublic.resources.lambda);
backend.crmDocs.addEnvironment("DOCS_BUCKET", docsBucket.bucketName);
backend.agreementPublic.addEnvironment("DOCS_BUCKET", docsBucket.bucketName);

// Surface the Function URLs into amplify_outputs.json so the frontends
// (and the Stripe dashboard setup) can read them without separate env vars.
backend.addOutput({
  custom: {
    leadIntakeUrl: leadIntakeUrl.url,
    stripeWebhookUrl: stripeWebhookUrl.url,
    agreementPublicUrl: agreementPublicUrl.url,
  },
});
