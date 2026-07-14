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
import { leadIntake } from "./functions/lead-intake/resource";

const backend = defineBackend({
  auth,
  data,
  leadIntake,
});

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

// Surface the Function URL into amplify_outputs.json so the frontend
// can read it without a separate env var.
backend.addOutput({
  custom: {
    leadIntakeUrl: leadIntakeUrl.url,
  },
});
