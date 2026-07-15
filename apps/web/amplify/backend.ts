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
import { createChallenge } from "./functions/auth-challenge/resource";
import { crmPricing } from "./functions/crm-pricing/resource";
import { bookingPublic } from "./functions/booking-public/resource";

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
  createChallenge,
  crmPricing,
  bookingPublic,
});

// CRM logins are invite-only (office provisions staff and portal users via
// adminCreateUser) — block public self-signup. Invites go out as single-use
// magic sign-in links (crm-admin + the auth-challenge triggers), not
// temporary passwords, so enable the custom auth flow on the app client.
backend.auth.resources.cfnResources.cfnUserPool.adminCreateUserConfig = {
  allowAdminCreateUserOnly: true,
};
backend.auth.resources.cfnResources.cfnUserPoolClient.explicitAuthFlows = [
  "ALLOW_USER_SRP_AUTH",
  "ALLOW_CUSTOM_AUTH",
  "ALLOW_REFRESH_TOKEN_AUTH",
];
// The magic-link token attributes are written only by backend admin calls —
// without this, Cognito's default lets any signed-in user updateUserAttributes
// their own custom:loginTokenHash and mint themselves sign-in links.
backend.auth.resources.cfnResources.cfnUserPoolClient.writeAttributes = [
  "email",
  "name",
];

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
// Resolved at build time. CRM_APP_URL (hosting env var) wins; otherwise
// derive from the branch being built so main never emails staging links.
const crmUrlEnv =
  process.env.CRM_APP_URL ??
  (process.env.AWS_BRANCH === "main"
    ? "https://main.d5ln2hbbp9s2j.amplifyapp.com"
    : "https://staging.d5ln2hbbp9s2j.amplifyapp.com");

for (const fn of [
  backend.crmDocs,
  backend.agreementPublic,
  backend.dailyReminders,
  backend.crmAdmin,
  backend.createChallenge,
  backend.crmPricing,
  backend.bookingPublic,
]) {
  fn.resources.lambda.addToRolePolicy(sesPolicy);
  fn.addEnvironment("SES_FROM_EMAIL", "info@pestbuzzkill.com");
  fn.addEnvironment("SES_NOTIFY_EMAIL", "info@pestbuzzkill.com");
  fn.addEnvironment("CRM_APP_URL", crmUrlEnv);
}
docsBucket.grantReadWrite(backend.crmDocs.resources.lambda);
docsBucket.grantWrite(backend.agreementPublic.resources.lambda);
docsBucket.grantRead(backend.agreementPublic.resources.lambda);
docsBucket.grantReadWrite(backend.crmPricing.resources.lambda);
backend.crmDocs.addEnvironment("DOCS_BUCKET", docsBucket.bucketName);
backend.agreementPublic.addEnvironment("DOCS_BUCKET", docsBucket.bucketName);
backend.crmPricing.addEnvironment("DOCS_BUCKET", docsBucket.bucketName);
docsBucket.grantWrite(backend.bookingPublic.resources.lambda);
backend.bookingPublic.addEnvironment("DOCS_BUCKET", docsBucket.bucketName);
// The webhook writes the booking agreement PDF during finalization.
docsBucket.grantWrite(backend.stripeWebhook.resources.lambda);
backend.stripeWebhook.addEnvironment("DOCS_BUCKET", docsBucket.bucketName);
backend.stripeWebhook.resources.lambda.addToRolePolicy(sesPolicy);
backend.stripeWebhook.addEnvironment("SES_FROM_EMAIL", "info@pestbuzzkill.com");
backend.stripeWebhook.addEnvironment("SES_NOTIFY_EMAIL", "info@pestbuzzkill.com");

// The pricing engine reads its API keys from SSM at runtime so the deploy
// never depends on the secrets existing (they're added via the console).
const appId = process.env.AWS_APP_ID ?? "d26qpsjewk0bee";
const branch = process.env.AWS_BRANCH ?? "staging";
backend.crmPricing.addEnvironment("AMPLIFY_APP_ID", appId);
backend.crmPricing.addEnvironment("AMPLIFY_BRANCH", branch);
backend.bookingPublic.addEnvironment("AMPLIFY_APP_ID", appId);
backend.bookingPublic.addEnvironment("AMPLIFY_BRANCH", branch);
// finalizeBooking() runs inside the webhook Lambda — it builds the
// customer's cancel link, so it needs the same marketing URL.
backend.stripeWebhook.addEnvironment(
  "MARKETING_URL",
  branch === "main"
    ? "https://www.pestbuzzkill.com"
    : "https://staging.d26qpsjewk0bee.amplifyapp.com"
);
backend.bookingPublic.addEnvironment(
  "MARKETING_URL",
  branch === "main"
    ? "https://www.pestbuzzkill.com"
    : "https://staging.d26qpsjewk0bee.amplifyapp.com"
);
backend.bookingPublic.addEnvironment(
  "BOOKING_CORS_ORIGINS",
  branch === "main"
    ? "https://www.pestbuzzkill.com,https://pestbuzzkill.com"
    : "https://staging.d26qpsjewk0bee.amplifyapp.com,http://localhost:5173,http://localhost:5174"
);
// The API keys live as Amplify Console app-level env vars — present in the
// build container at synth time. Bake them into the Lambda env so runtime
// doesn't depend on SSM entries the Console never writes.
for (const key of ["ANTHROPIC_API_KEY", "GOOGLE_ROUTES_API_KEY"] as const) {
  const v = process.env[key];
  if (v && v !== "placeholder-set-me") {
    backend.crmPricing.addEnvironment(key, v);
    backend.bookingPublic.addEnvironment(key, v);
  }
}
backend.crmPricing.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ssm:GetParameter"],
    resources: [
      `arn:aws:ssm:us-east-1:*:parameter/amplify/shared/${appId}/ANTHROPIC_API_KEY`,
      `arn:aws:ssm:us-east-1:*:parameter/amplify/shared/${appId}/GOOGLE_ROUTES_API_KEY`,
      `arn:aws:ssm:us-east-1:*:parameter/amplify/${appId}/${branch}/ANTHROPIC_API_KEY`,
      `arn:aws:ssm:us-east-1:*:parameter/amplify/${appId}/${branch}/GOOGLE_ROUTES_API_KEY`,
    ],
  })
);
backend.bookingPublic.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ssm:GetParameter"],
    resources: [
      `arn:aws:ssm:us-east-1:*:parameter/amplify/shared/${appId}/ANTHROPIC_API_KEY`,
      `arn:aws:ssm:us-east-1:*:parameter/amplify/shared/${appId}/GOOGLE_ROUTES_API_KEY`,
      `arn:aws:ssm:us-east-1:*:parameter/amplify/shared/${appId}/STRIPE_SECRET_KEY`,
      `arn:aws:ssm:us-east-1:*:parameter/amplify/${appId}/${branch}/ANTHROPIC_API_KEY`,
      `arn:aws:ssm:us-east-1:*:parameter/amplify/${appId}/${branch}/GOOGLE_ROUTES_API_KEY`,
      `arn:aws:ssm:us-east-1:*:parameter/amplify/${appId}/${branch}/STRIPE_SECRET_KEY`,
    ],
  })
);

// Public booking-funnel API for the marketing site.
const bookingApiUrl = backend.bookingPublic.resources.lambda.addFunctionUrl({
  authType: FunctionUrlAuthType.NONE,
});

// Surface the Function URLs into amplify_outputs.json so the frontends
// (and the Stripe dashboard setup) can read them without separate env vars.
backend.addOutput({
  custom: {
    leadIntakeUrl: leadIntakeUrl.url,
    stripeWebhookUrl: stripeWebhookUrl.url,
    agreementPublicUrl: agreementPublicUrl.url,
    bookingApiUrl: bookingApiUrl.url,
  },
});
