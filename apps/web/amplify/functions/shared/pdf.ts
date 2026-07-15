import {
  PDFDocument,
  PDFFont,
  PDFPage,
  StandardFonts,
  rgb,
} from "pdf-lib";

const PAGE = { width: 612, height: 792 }; // US Letter
const MARGIN = 54;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.44, 0.48);
const RULE = rgb(0.85, 0.86, 0.88);

/** Cursor that adds pages as content flows past the bottom margin. */
class PdfWriter {
  doc!: PDFDocument;
  page!: PDFPage;
  y = 0;
  font!: PDFFont;
  bold!: PDFFont;
  italic!: PDFFont;

  static async create(): Promise<PdfWriter> {
    const w = new PdfWriter();
    w.doc = await PDFDocument.create();
    w.font = await w.doc.embedFont(StandardFonts.Helvetica);
    w.bold = await w.doc.embedFont(StandardFonts.HelveticaBold);
    w.italic = await w.doc.embedFont(StandardFonts.HelveticaOblique);
    w.addPage();
    return w;
  }

  addPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
  }

  ensure(height: number) {
    if (this.y - height < MARGIN) this.addPage();
  }

  wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const out: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
      if (!rawLine.trim()) {
        out.push("");
        continue;
      }
      let line = "";
      for (const word of rawLine.split(/\s+/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
          line = candidate;
        } else {
          if (line) out.push(line);
          line = word;
        }
      }
      out.push(line);
    }
    return out;
  }

  text(
    text: string,
    opts: {
      font?: PDFFont;
      size?: number;
      color?: ReturnType<typeof rgb>;
      gapAfter?: number;
      x?: number;
      maxWidth?: number;
    } = {}
  ) {
    const font = opts.font ?? this.font;
    const size = opts.size ?? 10.5;
    const x = opts.x ?? MARGIN;
    const maxWidth = opts.maxWidth ?? PAGE.width - MARGIN - x;
    const lineHeight = size * 1.45;
    for (const line of this.wrap(text, font, size, maxWidth)) {
      this.ensure(lineHeight);
      if (line) {
        this.page.drawText(line, {
          x,
          y: this.y - size,
          size,
          font,
          color: opts.color ?? INK,
        });
      }
      this.y -= lineHeight;
    }
    this.y -= opts.gapAfter ?? 0;
  }

  labelValue(label: string, value: string) {
    const size = 10.5;
    this.ensure(size * 1.5);
    this.page.drawText(label.toUpperCase(), {
      x: MARGIN,
      y: this.y - size,
      size: 7.5,
      font: this.bold,
      color: MUTED,
    });
    this.page.drawText(value, {
      x: MARGIN + 130,
      y: this.y - size,
      size,
      font: this.font,
      color: INK,
    });
    this.y -= size * 1.7;
  }

  rule(gap = 12) {
    this.ensure(gap * 2);
    this.y -= gap;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE.width - MARGIN, y: this.y },
      thickness: 0.75,
      color: RULE,
    });
    this.y -= gap;
  }

  heading(text: string) {
    this.ensure(40);
    this.text(text, { font: this.bold, size: 13, gapAfter: 4 });
  }

  header(docTitle: string) {
    this.text("BuzzKill Pest Control", { font: this.bold, size: 17 });
    this.text(docTitle, { size: 11, color: MUTED, gapAfter: 6 });
    this.rule(8);
  }

  async save(): Promise<Uint8Array> {
    return this.doc.save();
  }
}

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "America/New_York",
  });

export type AgreementImage = { bytes: Uint8Array; contentType: string };

export async function renderAgreementPdf(opts: {
  agreementId: string;
  title: string;
  bodyText: string;
  customerName: string;
  customerAddress?: string;
  signerName: string;
  signerEmail?: string;
  signatureDataUrl?: string | null;
  signedAtIso: string;
  signerIp?: string;
  signerUserAgent?: string;
  images?: AgreementImage[];
}): Promise<Uint8Array> {
  const w = await PdfWriter.create();
  w.header("Service Agreement");

  w.text(opts.title, { font: w.bold, size: 14, gapAfter: 8 });
  w.labelValue("Customer", opts.customerName);
  if (opts.customerAddress) w.labelValue("Service address", opts.customerAddress);
  w.rule();

  w.text(opts.bodyText, { gapAfter: 10 });

  // Pest / treatment photos from the plan template.
  if (opts.images?.length) {
    w.heading("Covered pests");
    const maxW = PAGE.width - MARGIN * 2;
    for (const img of opts.images.slice(0, 8)) {
      try {
        const ct = img.contentType.toLowerCase();
        if (!ct.includes("png") && !ct.includes("jpeg") && !ct.includes("jpg")) {
          continue; // pdf-lib can only embed PNG/JPEG
        }
        const embedded = ct.includes("png")
          ? await w.doc.embedPng(img.bytes)
          : await w.doc.embedJpg(img.bytes);
        const dims = embedded.scaleToFit(Math.min(maxW, 300), 220);
        w.ensure(dims.height + 12);
        w.page.drawImage(embedded, {
          x: MARGIN,
          y: w.y - dims.height,
          width: dims.width,
          height: dims.height,
        });
        w.y -= dims.height + 10;
      } catch {
        // Unsupported/corrupt image — the agreement still renders.
      }
    }
  }

  w.rule();
  w.heading("Electronic signature");

  if (opts.signatureDataUrl?.startsWith("data:image/png;base64,")) {
    try {
      const png = await w.doc.embedPng(
        Buffer.from(
          opts.signatureDataUrl.slice("data:image/png;base64,".length),
          "base64"
        )
      );
      const dims = png.scaleToFit(220, 70);
      w.ensure(dims.height + 10);
      w.page.drawImage(png, {
        x: MARGIN,
        y: w.y - dims.height,
        width: dims.width,
        height: dims.height,
      });
      w.y -= dims.height + 8;
    } catch {
      // Fall through to the typed-signature rendering below.
    }
  } else {
    w.text(opts.signerName, { font: w.italic, size: 20, gapAfter: 6 });
  }

  w.labelValue("Signed by", opts.signerName);
  if (opts.signerEmail) w.labelValue("Email", opts.signerEmail);
  w.labelValue("Signed at", fmtDateTime(opts.signedAtIso));
  if (opts.signerIp) w.labelValue("IP address", opts.signerIp);
  if (opts.signerUserAgent) {
    w.labelValue("Device", opts.signerUserAgent.slice(0, 80));
  }
  w.text(
    `Signed electronically via the BuzzKill customer portal. Agreement reference: ${opts.agreementId}. ` +
      "By signing, the signer agreed to the terms above and consented to conduct this transaction electronically.",
    { size: 8.5, color: MUTED }
  );

  return w.save();
}

export type ReportProduct = {
  name?: string;
  epaNumber?: string;
  quantity?: string;
  targetPest?: string;
};

export async function renderServiceReportPdf(opts: {
  reportId: string;
  customerName: string;
  serviceAddress?: string;
  serviceType: string;
  serviceDateIso: string;
  technicianName: string;
  servicesPerformed?: string | null;
  productsUsed?: ReportProduct[];
  targetPests?: string | null;
  areasTreated?: string | null;
  recommendations?: string | null;
  techNotes?: string | null;
  geo?: {
    lat: number;
    lng: number;
    accuracyM?: number | null;
    capturedAtIso?: string | null;
  } | null;
}): Promise<Uint8Array> {
  const w = await PdfWriter.create();
  w.header("Service Report");

  w.labelValue("Customer", opts.customerName);
  if (opts.serviceAddress) w.labelValue("Service address", opts.serviceAddress);
  w.labelValue("Service", opts.serviceType);
  w.labelValue("Service date", fmtDateTime(opts.serviceDateIso));
  w.labelValue("Technician", opts.technicianName);
  w.rule();

  const section = (title: string, body?: string | null) => {
    if (!body?.trim()) return;
    w.heading(title);
    w.text(body, { gapAfter: 10 });
  };

  section("Services performed", opts.servicesPerformed);

  if (opts.productsUsed?.length) {
    w.heading("Products applied");
    for (const p of opts.productsUsed) {
      const parts = [
        p.name ?? "Product",
        p.epaNumber ? `EPA #${p.epaNumber}` : null,
        p.quantity ? `Qty: ${p.quantity}` : null,
        p.targetPest ? `Target: ${p.targetPest}` : null,
      ].filter(Boolean);
      w.text(`•  ${parts.join("   —   ")}`, { size: 10 });
    }
    w.y -= 10;
  }

  section("Target pests", opts.targetPests);
  section("Areas treated", opts.areasTreated);
  section("Recommendations", opts.recommendations);
  section("Technician notes", opts.techNotes);

  if (opts.geo) {
    w.rule();
    w.heading("On-site verification");
    w.labelValue(
      "GPS location",
      `${opts.geo.lat.toFixed(5)}, ${opts.geo.lng.toFixed(5)}` +
        (opts.geo.accuracyM ? `  (±${Math.round(opts.geo.accuracyM)} m)` : "")
    );
    if (opts.geo.capturedAtIso) {
      w.labelValue("Captured", fmtDateTime(opts.geo.capturedAtIso));
    }
    w.labelValue(
      "Map",
      `https://maps.google.com/?q=${opts.geo.lat.toFixed(5)},${opts.geo.lng.toFixed(5)}`
    );
    w.text(
      "Location captured from the technician's device at the time the report was filed, confirming on-site presence.",
      { size: 8.5, color: MUTED }
    );
  }

  w.rule();
  w.text(`Report reference: ${opts.reportId}`, { size: 8.5, color: MUTED });
  return w.save();
}
