import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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
  // The quoted initial service visit becomes a chargeable one-time job so
  // the office schedules it and bills it through the normal flow.
  if (quote.initialFeeCents != null && quote.initialFeeCents > 0) {
    await client.models.Job.create({
      customerId: quote.customerId,
      servicePlanId: plan.id,
      type: "ONE_TIME",
      serviceType: "Initial service visit",
      description:
        "75-minute first service: inspection, interior flush-out, exterior barrier, web/nest removal.",
      priceCents: quote.initialFeeCents,
      status: "UNSCHEDULED",
      accessGroups,
    });
  }
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

  // Pest/treatment photos: short-lived presigned URLs for the sign page.
  // Access is already gated by the unguessable agreement token.
  const bucket = process.env.DOCS_BUCKET;
  const imageKeys = (agreement.imageKeys ?? []).filter(
    (k): k is string => typeof k === "string" && k.length > 0
  );
  const imageUrls: string[] = [];
  if (bucket) {
    for (const key of imageKeys.slice(0, 8)) {
      try {
        imageUrls.push(
          await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: bucket, Key: key }),
            { expiresIn: 900 }
          )
        );
      } catch {
        /* skip broken image */
      }
    }
  }

  return json(200, {
    title: agreement.title,
    bodyText: agreement.bodyText,
    customerName: customer?.displayName ?? "",
    status: agreement.status === "SENT" ? "VIEWED" : agreement.status,
    signedAt: agreement.signedAt ?? null,
    imageUrls,
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

  const bucket = process.env.DOCS_BUCKET;
  if (!bucket) throw new Error("DOCS_BUCKET is not configured");

  // Fetch pest/treatment photos so they're embedded in the signed PDF.
  const images: { bytes: Uint8Array; contentType: string }[] = [];
  for (const key of (agreement.imageKeys ?? []).filter(
    (k): k is string => typeof k === "string" && k.length > 0
  ).slice(0, 8)) {
    try {
      const obj = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key })
      );
      images.push({
        bytes: await obj.Body!.transformToByteArray(),
        contentType: obj.ContentType ?? "image/jpeg",
      });
    } catch {
      /* missing image never blocks a signature */
    }
  }

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
    images,
  });
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
         <p>Thanks for signing <strong>${agreement.title}</strong>. A copy is attached for your records${
           customer.portalUserSub
             ? ", and it's always available in your BuzzKill portal"
             : ""
         }.</p>`
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
