import { defineBackend } from "@aws-amplify/backend";
import { Duration } from "aws-cdk-lib";
import {
  FunctionUrlAuthType,
  HttpMethod,
  InvokeMode,
} from "aws-cdk-lib/aws-lambda";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Topic } from "aws-cdk-lib/aws-sns";
import { LambdaSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import {
  CfnConfigurationSet,
  CfnConfigurationSetEventDestination,
} from "aws-cdk-lib/aws-ses";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";
import { leadIntake } from "./functions/lead-intake/resource";
import { crmAdmin } from "./functions/crm-admin/resource";
import { crmBilling } from "./functions/crm-billing/resource";
import { stripeWebhook } from "./functions/stripe-webhook/resource";
import { crmDocs } from "./functions/crm-docs/resource";
import { dailyReminders } from "./functions/daily-reminders/resource";
import {
  createChallenge,
  verifyChallenge,
} from "./functions/auth-challenge/resource";
import { crmPricing } from "./functions/crm-pricing/resource";
import { bookingPublic } from "./functions/booking-public/resource";
import { pricingRefresh } from "./functions/pricing-refresh/resource";
import { sesEvents } from "./functions/ses-events/resource";

const backend = defineBackend({
  auth,
  data,
  storage,
  leadIntake,
  crmAdmin,
  crmBilling,
  stripeWebhook,
  crmDocs,
  dailyReminders,
  createChallenge,
  verifyChallenge,
  crmPricing,
  bookingPublic,
  pricingRefresh,
  sesEvents,
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
// GL-13/GL-14: a global sign-out revokes refresh tokens, but access/id tokens
// already issued stay valid until they expire — that window is the residual
// exposure after a demotion, offboarding, or technician deactivation. Shorten
// it from Cognito's 60-minute default to 15 minutes so "signed out now" means
// minutes, not an hour. (The code-layer active checks close the data reads
// regardless; this closes the token itself.)
backend.auth.resources.cfnResources.cfnUserPoolClient.accessTokenValidity = 15;
backend.auth.resources.cfnResources.cfnUserPoolClient.idTokenValidity = 15;
backend.auth.resources.cfnResources.cfnUserPoolClient.tokenValidityUnits = {
  accessToken: "minutes",
  idToken: "minutes",
  refreshToken: "days",
};

// Atomic-lease CAS writes (shared/atomicLock.ts): the operational locks and
// durable commands need conditional DynamoDB updates/deletes that AppSync's
// generated mutations cannot express — stale-lease takeover, nonce-fenced
// progress writes, and holder-fenced releases must each be ONE conditional
// write or two workers can both believe they own a resume. Granted by table
// NAME PATTERN (Amplify Gen2 tables are `<Model>-<apiId>-NONE`) rather than
// table object references, which would cycle the data stack (it references
// these functions as schema handlers) with the function stacks. The functions
// derive the exact table names at runtime from their data-client config.
const LOCK_MODELS = [
  "StaffAccessCommand",
  "OwnerChangeSerial",
  "CustomerLifecycleClaim",
  "CustomerLifecycleCommand",
  "PlanCancellationClaim",
  "VisitChangeClaim",
  "BookingFinalization",
  "BookingCommsSend",
  "ServiceReportFinalizeClaim",
  "TreatmentObligation",
  "WorkItem",
  "CapacityDay",
  "CapacityClaim",
] as const;
const lockTablePolicy = new PolicyStatement({
  actions: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
  resources: LOCK_MODELS.map(
    (m) => `arn:aws:dynamodb:us-east-1:*:table/${m}-*`
  ),
});
for (const fn of [
  backend.crmAdmin,
  backend.crmBilling,
  backend.crmDocs,
  backend.dailyReminders,
  backend.stripeWebhook,
  // GL-04: the public funnel takes the atomic capacity claim at checkout.
  backend.bookingPublic,
]) {
  fn.resources.lambda.addToRolePolicy(lockTablePolicy);
}

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
      "https://staging.pestbuzzkill.com",
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
  backend.dailyReminders,
  backend.crmAdmin,
  // The verify trigger emails the magic sign-in link (the request leg is
  // keyed off the challenge answer, which only verify reliably receives).
  backend.verifyChallenge,
  backend.crmPricing,
  backend.bookingPublic,
  backend.leadIntake,
  // crm-billing sends charge/refund receipts and pages the office when a
  // cancel leaves visits needing a decision — without this grant those
  // sends fail silently inside notifyOffice.
  backend.crmBilling,
  // pricing-refresh emails the office (new-rate heads-ups, the weekly
  // report) and waiting leads ("your exact prices are ready").
  backend.pricingRefresh,
]) {
  fn.resources.lambda.addToRolePolicy(sesPolicy);
  fn.addEnvironment("SES_FROM_EMAIL", "info@pestbuzzkill.com");
  fn.addEnvironment("SES_NOTIFY_EMAIL", "info@pestbuzzkill.com");
  fn.addEnvironment("CRM_APP_URL", crmUrlEnv);
  fn.addEnvironment(
    "GOOGLE_REVIEW_URL",
    "https://g.page/r/CYyHi3DH59WEEAI/review"
  );
}
docsBucket.grantReadWrite(backend.crmDocs.resources.lambda);
docsBucket.grantReadWrite(backend.crmPricing.resources.lambda);
backend.crmDocs.addEnvironment("DOCS_BUCKET", docsBucket.bucketName);
backend.crmPricing.addEnvironment("DOCS_BUCKET", docsBucket.bucketName);
docsBucket.grantWrite(backend.bookingPublic.resources.lambda);
backend.bookingPublic.addEnvironment("DOCS_BUCKET", docsBucket.bucketName);
// The webhook writes the booking agreement PDF during finalization.
docsBucket.grantWrite(backend.stripeWebhook.resources.lambda);
backend.stripeWebhook.addEnvironment("DOCS_BUCKET", docsBucket.bucketName);
backend.stripeWebhook.resources.lambda.addToRolePolicy(sesPolicy);
backend.stripeWebhook.addEnvironment("SES_FROM_EMAIL", "info@pestbuzzkill.com");
backend.stripeWebhook.addEnvironment("SES_NOTIFY_EMAIL", "info@pestbuzzkill.com");
// The dunning "your payment failed" email links the customer to the portal
// billing page (CRM_APP_URL + /billing) to update their card and pay.
backend.stripeWebhook.addEnvironment("CRM_APP_URL", crmUrlEnv);

// R80: lead-pipeline alerts route to the sales inbox, not the ops inbox. Set
// SES_LEADS_EMAIL only on the functions that send a lead email — leadIntake
// (new-lead / write-failed), bookingPublic (contact / rate-queued), crmPricing
// (pricing-escalation), and stripeWebhook (the office-booking-alert fires in
// bookingFinalize inside the webhook Lambda). Ops/money alarms stay on info@.
for (const fn of [
  backend.leadIntake,
  backend.bookingPublic,
  backend.crmPricing,
  backend.stripeWebhook,
]) {
  fn.addEnvironment("SES_LEADS_EMAIL", "sales@pestbuzzkill.com");
}

// The pricing engine reads its API keys from SSM at runtime so the deploy
// never depends on the secrets existing (they're added via the console).
const appId = process.env.AWS_APP_ID ?? "d26qpsjewk0bee";
const branch = process.env.AWS_BRANCH ?? "staging";
backend.crmPricing.addEnvironment("AMPLIFY_APP_ID", appId);
backend.crmPricing.addEnvironment("AMPLIFY_BRANCH", branch);
backend.bookingPublic.addEnvironment("AMPLIFY_APP_ID", appId);
backend.bookingPublic.addEnvironment("AMPLIFY_BRANCH", branch);
// A cold pricing miss starts the existing refresh worker immediately. The
// five-minute schedule remains the recovery sweep, so a failed async invoke
// never strands the lead.
backend.pricingRefresh.resources.lambda.grantInvoke(
  backend.bookingPublic.resources.lambda
);
backend.bookingPublic.addEnvironment(
  "PRICING_REFRESH_FUNCTION_NAME",
  backend.pricingRefresh.resources.lambda.functionName
);
// pricing-refresh is where ALL market-rate research runs now, so it needs
// the same Anthropic key lookup as the engines that used to research inline.
backend.pricingRefresh.addEnvironment("AMPLIFY_APP_ID", appId);
backend.pricingRefresh.addEnvironment("AMPLIFY_BRANCH", branch);
// The marketing-site origin, branch-derived so main never links staging.
// stripe-webhook builds the customer's cancel link from it; crm-docs and
// crm-pricing build the funnel booking link (MARKETING_URL + "/quote") — the
// only conversion path a lead is ever sent down.
const marketingUrl =
  branch === "main"
    ? "https://www.pestbuzzkill.com"
    : "https://staging.d26qpsjewk0bee.amplifyapp.com";
backend.stripeWebhook.addEnvironment("MARKETING_URL", marketingUrl);
backend.bookingPublic.addEnvironment("MARKETING_URL", marketingUrl);
backend.crmDocs.addEnvironment("MARKETING_URL", marketingUrl);
backend.crmPricing.addEnvironment("MARKETING_URL", marketingUrl);
// pricing-refresh's "your exact prices are ready" email sends the lead
// back down the funnel (MARKETING_URL + /quote).
backend.pricingRefresh.addEnvironment("MARKETING_URL", marketingUrl);
backend.bookingPublic.addEnvironment(
  "BOOKING_CORS_ORIGINS",
  branch === "main"
    ? "https://www.pestbuzzkill.com,https://pestbuzzkill.com"
    : "https://staging.d26qpsjewk0bee.amplifyapp.com,https://staging.pestbuzzkill.com,http://localhost:5173,http://localhost:5174"
);
// The API keys live as Amplify Console app-level env vars — present in the
// build container at synth time. Bake them into the Lambda env so runtime
// doesn't depend on SSM entries the Console never writes.
for (const key of ["ANTHROPIC_API_KEY", "GOOGLE_ROUTES_API_KEY"] as const) {
  const v = process.env[key];
  if (v && v !== "placeholder-set-me") {
    backend.crmPricing.addEnvironment(key, v);
    // The funnel is a pure rate READER now — it keeps Routes (drive times,
    // day matrix) but has no business holding the research key.
    if (key === "GOOGLE_ROUTES_API_KEY") {
      backend.bookingPublic.addEnvironment(key, v);
      // GL-15: report finalize uses Routes to measure the captured GPS against
      // the service address (on-site-presence review). Best-effort — its
      // absence never blocks a technician's report.
      backend.crmDocs.addEnvironment(key, v);
    }
    if (key === "ANTHROPIC_API_KEY") {
      backend.pricingRefresh.addEnvironment(key, v);
    }
  }
}
// SSM fallback for the research key, mirroring crm-pricing's grant.
backend.pricingRefresh.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ssm:GetParameter"],
    resources: [
      `arn:aws:ssm:us-east-1:*:parameter/amplify/shared/${appId}/ANTHROPIC_API_KEY`,
      `arn:aws:ssm:us-east-1:*:parameter/amplify/${appId}/${branch}/ANTHROPIC_API_KEY`,
    ],
  })
);
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
      `arn:aws:ssm:us-east-1:*:parameter/amplify/shared/${appId}/GOOGLE_ROUTES_API_KEY`,
      `arn:aws:ssm:us-east-1:*:parameter/amplify/shared/${appId}/STRIPE_SECRET_KEY`,
      `arn:aws:ssm:us-east-1:*:parameter/amplify/${appId}/${branch}/GOOGLE_ROUTES_API_KEY`,
      `arn:aws:ssm:us-east-1:*:parameter/amplify/${appId}/${branch}/STRIPE_SECRET_KEY`,
    ],
  })
);
// SSM fallback for crm-docs' on-site-presence distance check (GL-15).
backend.crmDocs.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ssm:GetParameter"],
    resources: [
      `arn:aws:ssm:us-east-1:*:parameter/amplify/shared/${appId}/GOOGLE_ROUTES_API_KEY`,
      `arn:aws:ssm:us-east-1:*:parameter/amplify/${appId}/${branch}/GOOGLE_ROUTES_API_KEY`,
    ],
  })
);

// GL-03: SES delivery-event pipeline. A configuration set publishes bounce,
// complaint, and delivery events to an SNS topic; the ses-events function turns
// them into truthful delivery state — it marks the EmailLog, suppresses a dead
// address, and opens owned EMAIL_FAILURE work with an alternate-contact next
// step. Every sender stamps its sends with this configuration set so the events
// flow. (The SES account still has to enable the sending identity to publish
// these events — DKIM/SPF/DMARC verification — which is the remaining GL-21
// production step; the code path is complete and inert until then.)
const sesConfigurationSetName = `buzzkill-email-${branch}`;
const emailEventsStack = backend.sesEvents.resources.lambda.stack;
const sesEventsTopic = new Topic(emailEventsStack, "SesEventsTopic");
sesEventsTopic.grantPublish(new ServicePrincipal("ses.amazonaws.com"));
sesEventsTopic.addSubscription(
  new LambdaSubscription(backend.sesEvents.resources.lambda)
);
const sesConfigSet = new CfnConfigurationSet(
  emailEventsStack,
  "BuzzKillEmailConfigSet",
  { name: sesConfigurationSetName }
);
const sesEventDestination = new CfnConfigurationSetEventDestination(
  emailEventsStack,
  "BuzzKillEmailEventDestination",
  {
    configurationSetName: sesConfigurationSetName,
    eventDestination: {
      enabled: true,
      name: "sns-delivery-events",
      matchingEventTypes: ["bounce", "complaint", "delivery"],
      snsDestination: { topicArn: sesEventsTopic.topicArn },
    },
  }
);
sesEventDestination.addDependency(sesConfigSet);
for (const fn of [
  backend.crmDocs,
  backend.dailyReminders,
  backend.crmAdmin,
  backend.verifyChallenge,
  backend.crmPricing,
  backend.bookingPublic,
  backend.leadIntake,
  backend.crmBilling,
  backend.pricingRefresh,
  backend.stripeWebhook,
]) {
  fn.addEnvironment("SES_CONFIGURATION_SET", sesConfigurationSetName);
}

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
    bookingApiUrl: bookingApiUrl.url,
  },
});
