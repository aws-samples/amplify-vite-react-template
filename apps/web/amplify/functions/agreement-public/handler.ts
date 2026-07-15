import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { dataClient } from "../shared/dataClient";
import { customerAccessGroups } from "../shared/dynamicGroups";
import { emailShell, sendEmail } from "../shared/email";
import { renderAgreementPdf } from "../shared/pdf";

const s3 = new S3Client();

const json = (
  statusCode: number,
  body: unknown
): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  if (method === "GET") {
    const token = event.queryStringParameters?.token;
    if (!token) return json(400, { error: "Missing token" });
    return getAgreement(token);
  }
  if (method === "POST") {
    let body: {
      token?: string;
      signerName?: string;
      signatureDataUrl?: string;
    };
    try {
      body = JSON.parse(
        event.isBase64Encoded
          ? Buffer.from(event.body ?? "", "base64").toString("utf8")
          : (event.body ?? "{}")
      );
    } catch {
      return json(400, { error: "Invalid JSON" });
    }
    if (!body.token || !body.signerName?.trim()) {
      return json(400, { error: "token and signerName are required" });
    }
    if (
      body.signatureDataUrl &&
      (!body.signatureDataUrl.startsWith("data:image/png;base64,") ||
        body.signatureDataUrl.length > 400_000)
    ) {
      return json(400, { error: "Invalid signature image" });
    }
    return signAgreement({
      token: body.token,
      signerName: body.signerName.trim().slice(0, 120),
      signatureDataUrl: body.signatureDataUrl ?? null,
      ip: event.requestContext.http.sourceIp,
      userAgent: event.requestContext.http.userAgent ?? "",
    });
  }
  return json(405, { error: "Method not allowed" });
};

/**
 * Idempotent quote → customer conversion: creates the ServicePlan from the
 * quoted terms, marks the quote CONVERTED, and flips a LEAD to ACTIVE.
 */
async function convertQuote(quoteId: string, signedAtIso: string) {
  const client = await dataClient();
  const { data: quote } = await client.models.Quote.get({ id: quoteId });
  if (!quote || quote.status === "CONVERTED" || quote.status === "VOID") {
    return;
  }
  const { data: customer } = await client.models.Customer.get({
    id: quote.customerId,
  });
  if (!customer) throw new Error(`Quote customer ${quote.customerId} missing`);

  const accessGroups = customerAccessGroups(
    quote.customerId,
    customer.groupId
  );
  const { data: plan, errors } = await client.models.ServicePlan.create({
    customerId: quote.customerId,
    planName: quote.planName,
    priceCents: quote.priceCents,
    serviceFrequency: quote.serviceFrequency,
    status: "ACTIVE",
    startDate: signedAtIso.slice(0, 10),
    notes: quote.notes ?? undefined,
    accessGroups,
  });
  if (!plan) {
    throw new Error(errors?.[0]?.message ?? "ServicePlan create failed");
  }
  await client.models.Quote.update({
    id: quoteId,
    status: "CONVERTED",
    convertedAt: signedAtIso,
    servicePlanId: plan.id,
  });
  if (customer.status === "LEAD") {
    await client.models.Customer.update({
      id: customer.id,
      status: "ACTIVE",
      convertedAt: signedAtIso,
    });
  }
}

async function findByToken(token: string) {
  const client = await dataClient();
  const { data: agreements } =
    await client.models.Agreement.listAgreementBySignToken({
      signToken: token,
    });
  return { client, agreement: agreements[0] ?? null };
}

async function getAgreement(token: string) {
  const { client, agreement } = await findByToken(token);
  if (!agreement || agreement.status === "VOID") {
    return json(404, { error: "Agreement not found" });
  }
  const { data: customer } = await client.models.Customer.get({
    id: agreement.customerId,
  });

  if (agreement.status === "SENT") {
    await client.models.Agreement.update({
      id: agreement.id,
      status: "VIEWED",
      viewedAt: new Date().toISOString(),
    });
  }

  return json(200, {
    title: agreement.title,
    bodyText: agreement.bodyText,
    customerName: customer?.displayName ?? "",
    status: agreement.status === "SENT" ? "VIEWED" : agreement.status,
    signedAt: agreement.signedAt ?? null,
  });
}

async function signAgreement(opts: {
  token: string;
  signerName: string;
  signatureDataUrl: string | null;
  ip: string;
  userAgent: string;
}) {
  const { client, agreement } = await findByToken(opts.token);
  if (!agreement || agreement.status === "VOID") {
    return json(404, { error: "Agreement not found" });
  }
  if (agreement.status === "SIGNED") {
    return json(409, { error: "This agreement has already been signed" });
  }

  const { data: customer } = await client.models.Customer.get({
    id: agreement.customerId,
  });
  const signedAtIso = new Date().toISOString();
  const serviceAddress = [
    customer?.serviceStreet,
    customer?.serviceCity,
    customer?.serviceState,
    customer?.serviceZip,
  ]
    .filter(Boolean)
    .join(", ");

  const pdf = await renderAgreementPdf({
    agreementId: agreement.id,
    title: agreement.title,
    bodyText: agreement.bodyText,
    customerName: customer?.displayName ?? opts.signerName,
    customerAddress: serviceAddress || undefined,
    signerName: opts.signerName,
    signerEmail: customer?.email ?? undefined,
    signatureDataUrl: opts.signatureDataUrl,
    signedAtIso,
    signerIp: opts.ip,
    signerUserAgent: opts.userAgent,
  });

  const bucket = process.env.DOCS_BUCKET;
  if (!bucket) throw new Error("DOCS_BUCKET is not configured");
  const pdfKey = `agreements/${agreement.customerId}/${agreement.id}.pdf`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: pdfKey,
      Body: pdf,
      ContentType: "application/pdf",
    })
  );

  await client.models.Agreement.update({
    id: agreement.id,
    status: "SIGNED",
    signedAt: signedAtIso,
    signerName: opts.signerName,
    signerEmail: customer?.email ?? undefined,
    signerIp: opts.ip,
    signerUserAgent: opts.userAgent.slice(0, 250),
    pdfKey,
  });

  // Quote-backed agreement: signing converts the quote — the lead becomes
  // an ACTIVE customer with a ServicePlan created from the quoted terms.
  // (Billing still starts explicitly once a payment method is on file.)
  if (agreement.quoteId) {
    try {
      await convertQuote(agreement.quoteId, signedAtIso);
    } catch (err) {
      // The signature itself succeeded — don't fail the signer's request.
      // The office notification below still flags the signing; the quote
      // stays SENT so the office can convert manually if this ever fires.
      console.error("Quote conversion failed for", agreement.quoteId, err);
    }
  }

  const attachment = {
    filename: "BuzzKill-Signed-Agreement.pdf",
    content: pdf,
    contentType: "application/pdf",
  };
  if (customer?.email) {
    await sendEmail({
      to: customer.email,
      subject: `Signed: ${agreement.title}`,
      template: "agreement-signed-copy",
      customerId: agreement.customerId,
      relatedId: agreement.id,
      attachments: [attachment],
      html: emailShell(
        "Your signed agreement",
        `<p>Hi ${customer.contactName ?? customer.displayName},</p>
         <p>Thanks for signing <strong>${agreement.title}</strong>. A copy is attached for your records, and it's always available in your BuzzKill portal.</p>`
      ),
    });
  }
  const office = process.env.SES_NOTIFY_EMAIL;
  if (office) {
    await sendEmail({
      to: office,
      subject: `Agreement signed: ${customer?.displayName ?? "Unknown"} — ${agreement.title}`,
      template: "agreement-signed-office",
      customerId: agreement.customerId,
      relatedId: agreement.id,
      attachments: [attachment],
      html: emailShell(
        "Agreement signed",
        `<p><strong>${opts.signerName}</strong> signed “${agreement.title}” for ${customer?.displayName ?? "unknown customer"} on ${new Date(
          signedAtIso
        ).toLocaleString("en-US", { timeZone: "America/New_York" })}.</p>`
      ),
    });
  }

  return json(200, { signed: true, signedAt: signedAtIso });
}
