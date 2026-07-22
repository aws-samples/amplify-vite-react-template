import {
  PDFDocument,
  PDFFont,
  PDFPage,
  StandardFonts,
  rgb,
} from "pdf-lib";
import {
  BUZZKILL_LOGO_H,
  BUZZKILL_LOGO_PNG_BASE64,
  BUZZKILL_LOGO_W,
} from "./logoAsset";
import { PEST_ART } from "./pestArt";

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

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", {
    timeStyle: "short",
    timeZone: "America/New_York",
  });

export type AgreementImage = { bytes: Uint8Array; contentType: string };

/* -------------------------------------------------------------------------- *
 * Service Agreement — a branded, sectioned document.
 *
 * This is deliberately NOT built on PdfWriter (the linear cursor used by the
 * service report and amendment). A service agreement is a designed page:
 * a masthead, green section bands, two-column info blocks, a covered-pests
 * grid, a month-by-month subscription calendar, side-by-side money summaries,
 * and a signature block. That needs absolute placement and multi-column flow,
 * so it gets its own small layout engine below.
 * -------------------------------------------------------------------------- */

// BuzzKill green (#7ac142) — the band/masthead color, echoing the brand.
const BK_GREEN = rgb(0.478, 0.757, 0.259);
const BK_GREEN_DK = rgb(0.278, 0.51, 0.114);
const WHITE = rgb(1, 1, 1);
const CELL_TINT = rgb(0.957, 0.976, 0.933); // faint green wash for table cells
const BORDER = rgb(0.8, 0.82, 0.85);

const A_M = 40; // page margin
const A_CW = PAGE.width - A_M * 2; // content width
const A_GUTTER = 14;
const A_COLW = (A_CW - A_GUTTER) / 2;
const BAR_H = 16; // section band height
const A_BOTTOM = 44; // bottom margin

const fmtMoney = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const fmtSignedDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "America/New_York",
  });

export type AgreementCompany = {
  name: string;
  addressLines?: string[];
  phone?: string;
  email?: string;
  website?: string;
  /** Applicator/business license number. Printed only when provided. */
  license?: string;
};

/** The BuzzKill masthead identity, used when a caller supplies no company. It
 *  mirrors AGREEMENT_COMPANY so the report, quote, and agreement print the same
 *  address, contact, and applicator licence. */
const DEFAULT_COMPANY: AgreementCompany = {
  name: "BuzzKill Pest Control",
  addressLines: ["420 Lakeside Ave, Suite 104", "Marlborough, MA 01752"],
  phone: "(508) 258-9294",
  email: "info@pestbuzzkill.com",
  website: "pestbuzzkill.com",
  license: "CC-0060592",
};

/** One line in a money summary box (label left, amount right). */
export type AgreementMoneyRow = {
  label: string;
  amountCents: number;
  /** Render as a parenthesised credit, e.g. a discount: ($420.00). */
  negative?: boolean;
  /** Bold, with a rule above — used for the box's total line. */
  total?: boolean;
  /** Grey, smaller — used for a "Tax (0%)" style line. */
  muted?: boolean;
};

export type AgreementScheduleMonth = {
  label: string; // "Oct '26"
  amountCents: number;
};

/** Absolute-placement layout engine for the service agreement. */
class AgreementDoc {
  doc!: PDFDocument;
  page!: PDFPage;
  font!: PDFFont;
  bold!: PDFFont;
  italic!: PDFFont;
  y = 0; // top edge of the next block, measured from the page bottom

  static async create(): Promise<AgreementDoc> {
    const d = new AgreementDoc();
    d.doc = await PDFDocument.create();
    d.font = await d.doc.embedFont(StandardFonts.Helvetica);
    d.bold = await d.doc.embedFont(StandardFonts.HelveticaBold);
    d.italic = await d.doc.embedFont(StandardFonts.HelveticaOblique);
    d.newPage();
    return d;
  }

  newPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - A_M;
  }

  /** Break to a new page if `h` more points would cross the bottom margin. */
  need(h: number) {
    if (this.y - h < A_BOTTOM) this.newPage();
  }

  fill(x: number, top: number, w: number, h: number, color = BK_GREEN) {
    this.page.drawRectangle({ x, y: top - h, width: w, height: h, color });
  }

  box(x: number, top: number, w: number, h: number, color = BORDER, thickness = 0.75) {
    this.page.drawRectangle({
      x,
      y: top - h,
      width: w,
      height: h,
      borderColor: color,
      borderWidth: thickness,
    });
  }

  hline(x1: number, x2: number, yy: number, color = RULE, thickness = 0.75) {
    this.page.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness, color });
  }

  private lines(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const out: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) {
        out.push("");
        continue;
      }
      let line = "";
      for (const word of raw.split(/\s+/)) {
        const cand = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(cand, size) <= maxWidth) line = cand;
        else {
          if (line) out.push(line);
          line = word;
        }
      }
      out.push(line);
    }
    return out;
  }

  /**
   * Draw wrapped text starting at top edge `top`, returning the new bottom.
   * Does not paginate — callers that need flow use `flow()`.
   */
  write(
    text: string,
    x: number,
    top: number,
    opts: {
      font?: PDFFont;
      size?: number;
      color?: ReturnType<typeof rgb>;
      maxWidth?: number;
      align?: "left" | "center" | "right";
      lineGap?: number;
    } = {}
  ): number {
    const font = opts.font ?? this.font;
    const size = opts.size ?? 9.5;
    const maxWidth = opts.maxWidth ?? A_CW;
    const lh = size * 1.32 + (opts.lineGap ?? 0);
    let yy = top;
    for (const line of this.lines(text, font, size, maxWidth)) {
      if (line) {
        const tw = font.widthOfTextAtSize(line, size);
        let dx = x;
        if (opts.align === "center") dx = x + (maxWidth - tw) / 2;
        else if (opts.align === "right") dx = x + (maxWidth - tw);
        this.page.drawText(line, { x: dx, y: yy - size, size, font, color: opts.color ?? INK });
      }
      yy -= lh;
    }
    return yy;
  }

  measure(text: string, font: PDFFont, size: number, maxWidth: number, lineGap = 0): number {
    const lh = size * 1.32 + lineGap;
    return this.lines(text, font, size, maxWidth).length * lh;
  }

  /** A full- or column-width green band with white title. Advances `this.y`. */
  band(title: string, x = A_M, w = A_CW, align: "left" | "center" = "center") {
    this.need(BAR_H + 4);
    this.fill(x, this.y, w, BAR_H);
    this.write(title.toUpperCase(), x + (align === "center" ? 0 : 8), this.y - 2.5, {
      font: this.bold,
      size: 8.5,
      color: WHITE,
      maxWidth: align === "center" ? w : w - 16,
      align,
    });
    this.y -= BAR_H;
  }

  /** Paginating full-width paragraph flow. */
  flow(
    text: string,
    opts: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb>; gapAfter?: number } = {}
  ) {
    const font = opts.font ?? this.font;
    const size = opts.size ?? 9;
    const lh = size * 1.4;
    for (const line of this.lines(text, font, size, A_CW)) {
      this.need(lh);
      if (line) {
        this.page.drawText(line, {
          x: A_M,
          y: this.y - size,
          size,
          font,
          color: opts.color ?? INK,
        });
      }
      this.y -= lh;
    }
    this.y -= opts.gapAfter ?? 0;
  }
}

/**
 * Render a branded, sectioned service-agreement PDF: masthead, green section
 * bands, two-column service/customer blocks, an optional covered-pests grid,
 * an optional month-by-month subscription calendar, side-by-side initial and
 * recurring money summaries, the terms body, and a signature block.
 *
 * Only `title`, `bodyText`, `customerName`, `signerName` and `signedAtIso` are
 * required; every richer section renders only when its data is supplied, so a
 * minimal caller still gets a valid, well-formed agreement.
 */
export async function renderAgreementPdf(opts: {
  agreementId: string;
  title: string;
  bodyText: string;
  company?: AgreementCompany;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  customerAddress?: string;
  billingAddress?: string;
  /** Names of pests the plan covers — drawn as a grid, like the sample. */
  coveredPests?: string[];
  /** Short "how year-round protection works" explainer, drawn above pricing. */
  protectionNote?: string;
  /** Month-by-month subscription calendar (recurring plans only). */
  schedule?: { title?: string; months: AgreementScheduleMonth[] };
  /** Left money summary box (the initial service / today's charge). */
  initial?: { title?: string; rows: AgreementMoneyRow[] };
  /** Right money summary box (the recurring subscription). */
  recurring?: { title?: string; rows: AgreementMoneyRow[] };
  /** Payment-authorization terms (the EFT/auto-charge consent). */
  paymentAuthText?: string;
  /** Initial commitment length in months; printed as a closing line. */
  initialTermMonths?: number;
  signerName: string;
  signerEmail?: string;
  signatureDataUrl?: string | null;
  signedAtIso: string;
  signerIp?: string;
  signerUserAgent?: string;
  /** Legacy: pest/treatment photos. Superseded by `coveredPests` when present. */
  images?: AgreementImage[];
}): Promise<Uint8Array> {
  const d = await AgreementDoc.create();
  const co = opts.company ?? DEFAULT_COMPANY;

  // ---- Masthead: logo (left) · SERVICE AGREEMENT (center) · contact (right)
  const topY = d.y;
  const logoH = await drawLogo(d, A_M, topY, 150);
  if (logoH == null) {
    // Asset failed to embed — fall back to the text wordmark so the agreement
    // still renders a branded masthead.
    d.write("BuzzKill", A_M, topY, { font: d.bold, size: 22, color: BK_GREEN_DK });
    d.write("PEST CONTROL", A_M + 2, topY - 24, {
      font: d.bold,
      size: 7.5,
      color: MUTED,
    });
  }
  d.write("SERVICE AGREEMENT", A_M, topY - 6, {
    font: d.bold,
    size: 17,
    color: BK_GREEN_DK,
    maxWidth: A_CW,
    align: "center",
  });
  const contact = [
    co.name,
    ...(co.addressLines ?? []),
    co.phone,
    co.email,
    co.website,
    co.license ? `License #: ${co.license}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const contactBottom = d.write(contact, A_M, topY, {
    font: d.font,
    size: 8,
    color: INK,
    maxWidth: A_CW,
    align: "right",
    lineGap: 1.5,
  });
  // The rule sits below the taller of the logo (or wordmark fallback) and the
  // contact block, so a multi-line company block never overruns it.
  d.y = Math.min(topY - (logoH ?? 44), contactBottom) - 6;
  d.hline(A_M, PAGE.width - A_M, d.y, BK_GREEN, 1.5);
  d.y -= 14;

  // ---- Two-column: Service Address | Customer Information
  const infoTop = d.y;
  const rightX = A_M + A_COLW + A_GUTTER;
  const infoBlock = (x: number, title: string, rows: string[]): number => {
    d.fill(x, infoTop, A_COLW, BAR_H);
    d.write(title.toUpperCase(), x, infoTop - 2.5, {
      font: d.bold,
      size: 8.5,
      color: WHITE,
      maxWidth: A_COLW,
      align: "center",
    });
    let yy = infoTop - BAR_H - 8;
    for (const r of rows) {
      yy = d.write(r, x + 4, yy, { size: 9.5, maxWidth: A_COLW - 8, lineGap: 1 });
      yy -= 1;
    }
    return yy;
  };
  const leftRows = [opts.customerName, ...(opts.customerAddress?.split(", ") ?? [])];
  const rightRows = [
    opts.customerEmail,
    opts.customerPhone,
    opts.signerEmail && opts.signerEmail !== opts.customerEmail ? opts.signerEmail : null,
  ].filter((v): v is string => Boolean(v));
  const leftBottom = infoBlock(A_M, "Service Address", leftRows);
  const rightBottom = infoBlock(
    rightX,
    "Customer Information",
    rightRows.length ? rightRows : ["—"]
  );
  d.y = Math.min(leftBottom, rightBottom) - 8;

  // ---- Covered pests grid
  if (opts.coveredPests?.length) {
    d.band("What Your Plan Covers");
    d.y -= 6;
    const cols = 4;
    const colW = A_CW / cols;
    const rowH = 15;
    const pests = opts.coveredPests.slice(0, 32);
    const rows = Math.ceil(pests.length / cols);
    d.need(rows * rowH + 4);
    const gridTop = d.y;
    pests.forEach((pest, i) => {
      const cx = A_M + (i % cols) * colW;
      const cy = gridTop - Math.floor(i / cols) * rowH;
      d.write("•", cx, cy, { font: d.bold, size: 9.5, color: BK_GREEN });
      d.write(pest, cx + 11, cy, { size: 9, maxWidth: colW - 14 });
    });
    d.y = gridTop - rows * rowH - 6;
  }

  // ---- Year-round protection explainer
  if (opts.protectionNote) {
    d.band("Year-Round Protection");
    d.y -= 6;
    const h = d.measure(opts.protectionNote, d.font, 9, A_CW, 0.5);
    d.need(h + 4);
    d.y = d.write(opts.protectionNote, A_M, d.y, { size: 9, maxWidth: A_CW, lineGap: 0.5 });
    d.y -= 8;
  }

  // ---- Subscription calendar
  if (opts.schedule?.months.length) {
    d.band(opts.schedule.title ?? "Monthly Service Subscription");
    d.y -= 6;
    const months = opts.schedule.months.slice(0, 12);
    const perRow = 6;
    const cw = A_CW / perRow;
    const headH = 14;
    const bodyH = 16;
    const cellH = headH + bodyH;
    const gridRows = Math.ceil(months.length / perRow);
    d.need(gridRows * cellH + 4);
    const gTop = d.y;
    months.forEach((m, i) => {
      const cx = A_M + (i % perRow) * cw;
      const cy = gTop - Math.floor(i / perRow) * cellH;
      d.fill(cx, cy, cw, headH, BK_GREEN);
      d.write(m.label, cx, cy - 2, {
        font: d.bold,
        size: 7.5,
        color: WHITE,
        maxWidth: cw,
        align: "center",
      });
      d.fill(cx, cy - headH, cw, bodyH, CELL_TINT);
      d.box(cx, cy, cw, cellH, BORDER, 0.5);
      d.write(fmtMoney(m.amountCents), cx, cy - headH - 3.5, {
        size: 8.5,
        maxWidth: cw,
        align: "center",
      });
    });
    d.y = gTop - gridRows * cellH - 8;
  }

  // ---- Money summaries: Initial (left) | Recurring (right)
  if (opts.initial || opts.recurring) {
    const moneyTop = d.y;
    const moneyBlock = (
      x: number,
      title: string,
      rows: AgreementMoneyRow[]
    ): number => {
      d.fill(x, moneyTop, A_COLW, BAR_H);
      d.write(title.toUpperCase(), x, moneyTop - 2.5, {
        font: d.bold,
        size: 8.5,
        color: WHITE,
        maxWidth: A_COLW,
        align: "center",
      });
      let yy = moneyTop - BAR_H - 10;
      for (const r of rows) {
        const size = r.muted ? 8.5 : 9.5;
        const font = r.total ? d.bold : d.font;
        const color = r.muted ? MUTED : INK;
        if (r.total) {
          d.hline(x + 4, x + A_COLW - 4, yy + 4, BORDER, 0.75);
          yy -= 4;
        }
        d.write(r.label, x + 4, yy, { font, size, color, maxWidth: A_COLW - 90 });
        const amount = r.negative ? `(${fmtMoney(r.amountCents)})` : fmtMoney(r.amountCents);
        d.write(amount, x + A_COLW - 84, yy, {
          font,
          size,
          color,
          maxWidth: 80,
          align: "right",
        });
        yy -= size * 1.7;
      }
      return yy;
    };
    let lB = moneyTop - BAR_H;
    let rB = moneyTop - BAR_H;
    if (opts.initial)
      lB = moneyBlock(A_M, opts.initial.title ?? "Initial Service", opts.initial.rows);
    if (opts.recurring)
      rB = moneyBlock(rightX, opts.recurring.title ?? "Recurring Service", opts.recurring.rows);
    d.y = Math.min(lB, rB) - 10;
  }

  // ---- Terms & conditions
  d.band("Terms & Conditions");
  d.y -= 8;
  d.flow(opts.bodyText, { size: 8.5, gapAfter: 10 });

  // ---- Acceptance line
  d.need(24);
  d.write("I have read and understand this entire agreement.", A_M, d.y, {
    font: d.bold,
    size: 10,
    color: BK_GREEN_DK,
    maxWidth: A_CW,
    align: "center",
  });
  d.y -= 22;

  // ---- Billing | Payment authorization
  if (opts.billingAddress || opts.paymentAuthText) {
    const payTop = d.y;
    const billRows = (opts.billingAddress ?? opts.customerAddress ?? "")
      .split(", ")
      .filter(Boolean);
    // Billing box (left) is short; the authorization (right) can be tall — so
    // the band pair is drawn, then each side flows independently below it.
    d.fill(A_M, payTop, A_COLW, BAR_H);
    d.write("BILLING INFO", A_M, payTop - 2.5, {
      font: d.bold,
      size: 8.5,
      color: WHITE,
      maxWidth: A_COLW,
      align: "center",
    });
    d.fill(rightX, payTop, A_COLW, BAR_H);
    d.write("PAYMENT AUTHORIZATION", rightX, payTop - 2.5, {
      font: d.bold,
      size: 8.5,
      color: WHITE,
      maxWidth: A_COLW,
      align: "center",
    });
    let lY = payTop - BAR_H - 8;
    for (const r of [opts.customerName, ...billRows]) {
      lY = d.write(r, A_M + 4, lY, { size: 9.5, maxWidth: A_COLW - 8, lineGap: 1 });
      lY -= 1;
    }
    let rY = payTop - BAR_H - 8;
    if (opts.paymentAuthText) {
      rY = d.write(opts.paymentAuthText, rightX + 4, rY, {
        font: d.italic,
        size: 8,
        color: INK,
        maxWidth: A_COLW - 8,
        lineGap: 1,
      });
    }
    d.y = Math.min(lY, rY) - 12;
  }

  // ---- Signature block
  d.need(70);
  if (opts.signatureDataUrl?.startsWith("data:image/png;base64,")) {
    try {
      const png = await d.doc.embedPng(
        Buffer.from(opts.signatureDataUrl.slice("data:image/png;base64,".length), "base64")
      );
      const dims = png.scaleToFit(200, 56);
      d.page.drawImage(png, { x: A_M, y: d.y - dims.height, width: dims.width, height: dims.height });
      d.y -= dims.height + 4;
    } catch {
      d.y = d.write(opts.signerName, A_M, d.y, { font: d.italic, size: 20 }) - 4;
    }
  } else {
    d.y = d.write(opts.signerName, A_M, d.y, { font: d.italic, size: 20 }) - 4;
  }
  d.hline(A_M, A_M + 220, d.y, INK, 0.75);
  d.y -= 12;
  d.write(`Customer signed on: ${fmtSignedDate(opts.signedAtIso)}`, A_M, d.y, {
    font: d.bold,
    size: 9.5,
  });
  d.y -= 16;

  // ---- Initial-term closing line
  if (opts.initialTermMonths) {
    d.need(24);
    d.write(
      `This agreement is for an initial period of ${opts.initialTermMonths} month(s).`,
      A_M,
      d.y,
      { font: d.bold, size: 11, maxWidth: A_CW, align: "center" }
    );
    d.y -= 20;
  }

  // ---- Electronic-signature audit footer
  d.need(40);
  d.hline(A_M, PAGE.width - A_M, d.y, RULE, 0.5);
  d.y -= 10;
  const audit = [
    `Signed electronically. Agreement reference: ${opts.agreementId}.`,
    opts.signerEmail ? `Signer: ${opts.signerName} (${opts.signerEmail}).` : `Signer: ${opts.signerName}.`,
    opts.signerIp ? `IP: ${opts.signerIp}.` : null,
    opts.signerUserAgent ? `Device: ${opts.signerUserAgent.slice(0, 80)}.` : null,
    "By signing, the signer agreed to the terms above and consented to conduct this transaction electronically.",
  ]
    .filter(Boolean)
    .join(" ");
  d.flow(audit, { size: 7.5, color: MUTED });

  return d.doc.save();
}

const cadenceLabel = (frequency: string): string =>
  frequency === "MONTHLY"
    ? "Monthly"
    : frequency === "BIMONTHLY"
      ? "Every 2 months"
      : frequency === "QUARTERLY"
        ? "Quarterly"
        : frequency;

const fmtQuoteDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });

/**
 * The pest photos to show on a quote's coverage strip, chosen from the service
 * label so the lineup is honest: a mosquito plan shows the mosquito/tick/flea
 * trio it actually treats, a wasp or rodent job shows only that pest, and every
 * general home/community/commercial plan shows the full common-pest lineup.
 * Keys must exist in PEST_ART.
 */
function pestsForService(label: string): string[] {
  const l = label.toLowerCase();
  if (/mosquito/.test(l)) return ["mosquitoes", "ticks", "fleas"];
  if (/\btick|\bflea/.test(l)) return ["ticks", "fleas", "mosquitoes"];
  if (/wasp|hornet|\bbee|sting/.test(l)) return ["wasps"];
  if (/rodent|mice|mouse|\brat/.test(l)) return ["rodents"];
  if (/roach|cockroach/.test(l)) return ["cockroaches"];
  if (/spider/.test(l)) return ["spiders"];
  if (/\bant\b|ants/.test(l)) return ["ants"];
  // General home / community / commercial / "pest control" plans.
  return ["ants", "spiders", "cockroaches", "mosquitoes", "ticks", "wasps", "rodents"];
}

/**
 * Draw a green check mark whose top-left sits near (x, top), about `s` points
 * tall — Helvetica has no ✓ glyph, so it's stroked from two line segments.
 */
function drawCheck(
  d: AgreementDoc,
  x: number,
  top: number,
  s = 9,
  color = BK_GREEN_DK
) {
  const y = top - s;
  d.page.drawLine({
    start: { x, y: y + s * 0.45 },
    end: { x: x + s * 0.35, y },
    thickness: 1.6,
    color,
  });
  d.page.drawLine({
    start: { x: x + s * 0.35, y },
    end: { x: x + s, y: y + s * 0.95 },
    thickness: 1.6,
    color,
  });
}

/**
 * Draw the "pests we protect against" coverage strip: each pest photo scaled to
 * fit its column and bottom-aligned to a common baseline (so they read as a row
 * standing on a line), with a centered label beneath. Advances `d.y`. Embeds
 * are best-effort — a pest whose PNG fails to decode is skipped, never fatal.
 */
async function drawCoverageStrip(d: AgreementDoc, pests: string[]): Promise<void> {
  const keys = pests.filter((k) => PEST_ART[k]);
  if (!keys.length) return;
  const n = keys.length;
  const colW = A_CW / n;
  const imgH = n <= 2 ? 78 : 60; // a lone pest gets a larger portrait
  const labelH = 13;
  d.need(imgH + labelH + 6);
  const top = d.y;
  const baseline = top - imgH; // every image rests its bottom edge here
  for (let i = 0; i < n; i++) {
    const art = PEST_ART[keys[i]];
    const cx = A_M + i * colW + colW / 2;
    try {
      const png = await d.doc.embedPng(Buffer.from(art.b64, "base64"));
      const scale = Math.min((colW - 14) / art.w, imgH / art.h);
      const w = art.w * scale;
      const h = art.h * scale;
      d.page.drawImage(png, { x: cx - w / 2, y: baseline, width: w, height: h });
    } catch {
      // Skip an undecodable pest rather than break the quote.
    }
    d.write(art.label, A_M + i * colW, baseline - 3, {
      font: d.bold,
      size: 7.5,
      color: MUTED,
      maxWidth: colW,
      align: "center",
    });
  }
  d.y = baseline - labelH - 6;
}

/**
 * Draw the BuzzKill logo lockup with its top-left corner at (x, top), scaled to
 * `width` points, and return the drawn height so the caller can position the
 * masthead rule beneath it. Returns null if the embedded asset fails to decode,
 * letting callers fall back to the text wordmark rather than break the document.
 */
async function drawLogo(
  d: AgreementDoc,
  x: number,
  top: number,
  width: number
): Promise<number | null> {
  try {
    const png = await d.doc.embedPng(
      Buffer.from(BUZZKILL_LOGO_PNG_BASE64, "base64")
    );
    const height = (width * BUZZKILL_LOGO_H) / BUZZKILL_LOGO_W;
    d.page.drawImage(png, { x, y: top - height, width, height });
    return height;
  } catch {
    return null;
  }
}

/**
 * Render a branded one-page price quote: the same masthead and green-band
 * layout as the service agreement, a two-column service-address / quote-detail
 * header, and money boxes for the one-time treatment and/or the recurring plan.
 *
 * It is a PRICING summary, deliberately not a schedule: appointment days are
 * live and perishable (they can fill before the lead opens the email), so the
 * bookable day board stays on the interactive quote page and never prints here.
 *
 * Every figure comes straight from the stored quote — no price is computed or
 * rounded in this file. `oneTimeCents` and `plan` each render their box only
 * when supplied, so a plan-only (mosquito / community) quote shows just the
 * plan and a one-time-only quote (wasp / rodent / …) shows just the treatment.
 */
export async function renderQuotePdf(opts: {
  quoteRef: string;
  quotedAtIso: string;
  validThroughIso?: string | null;
  company?: AgreementCompany;
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  serviceAddress?: string | null;
  serviceLabel: string;
  /** The one-time treatment price, in cents. Omit for a plan-only quote. */
  oneTimeCents?: number | null;
  /** The recurring plan offer. Omit for a one-time-only quote. */
  plan?: {
    frequency: string;
    monthlyCents: number;
    initialFeeCents: number;
  } | null;
  /** A community/seasonal plan-only quote — there is no one-time option. */
  planOnly?: boolean;
  /** GL-17: an off-season seasonal enrollment (billing now, first visit April). */
  offSeason?: boolean;
  offSeasonMessage?: string | null;
}): Promise<Uint8Array> {
  const d = await AgreementDoc.create();
  const co = opts.company ?? DEFAULT_COMPANY;
  const rightX = A_M + A_COLW + A_GUTTER;

  // ---- Masthead: logo (left) · PRICE QUOTE (center) · contact (right)
  const topY = d.y;
  const logoH = await drawLogo(d, A_M, topY, 150);
  if (logoH == null) {
    // Asset failed to embed — fall back to the text wordmark so the quote still
    // renders a branded masthead.
    d.write("BuzzKill", A_M, topY, { font: d.bold, size: 22, color: BK_GREEN_DK });
    d.write("PEST CONTROL", A_M + 2, topY - 24, {
      font: d.bold,
      size: 7.5,
      color: MUTED,
    });
  }
  d.write("PRICE QUOTE", A_M, topY - 6, {
    font: d.bold,
    size: 17,
    color: BK_GREEN_DK,
    maxWidth: A_CW,
    align: "center",
  });
  const contact = [
    co.name,
    ...(co.addressLines ?? []),
    co.phone,
    co.email,
    co.website,
    co.license ? `License #: ${co.license}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const contactBottom = d.write(contact, A_M, topY, {
    font: d.font,
    size: 8,
    color: INK,
    maxWidth: A_CW,
    align: "right",
    lineGap: 1.5,
  });
  // The rule sits below the taller of the logo (or wordmark fallback) and the
  // contact block, so a multi-line company block never overruns it.
  d.y = Math.min(topY - (logoH ?? 44), contactBottom) - 6;
  d.hline(A_M, PAGE.width - A_M, d.y, BK_GREEN, 1.5);
  d.y -= 14;

  // ---- Two-column: Service Address | Quote Details
  const infoTop = d.y;
  const infoBlock = (x: number, title: string, rows: string[]): number => {
    d.fill(x, infoTop, A_COLW, BAR_H);
    d.write(title.toUpperCase(), x, infoTop - 2.5, {
      font: d.bold,
      size: 8.5,
      color: WHITE,
      maxWidth: A_COLW,
      align: "center",
    });
    let yy = infoTop - BAR_H - 8;
    for (const r of rows) {
      yy = d.write(r, x + 4, yy, { size: 9.5, maxWidth: A_COLW - 8, lineGap: 1 });
      yy -= 1;
    }
    return yy;
  };
  const leftRows = [
    opts.customerName,
    ...(opts.serviceAddress?.split(", ") ?? []),
    opts.customerEmail || null,
    opts.customerPhone || null,
  ].filter((v): v is string => Boolean(v));
  const rightRows = [
    `Service: ${opts.serviceLabel}`,
    `Quote date: ${fmtQuoteDate(opts.quotedAtIso)}`,
    opts.validThroughIso ? `Valid through: ${fmtQuoteDate(opts.validThroughIso)}` : null,
    `Reference: ${opts.quoteRef}`,
  ].filter((v): v is string => Boolean(v));
  const leftBottom = infoBlock(A_M, "Service Address", leftRows);
  const rightBottom = infoBlock(rightX, "Quote Details", rightRows);
  d.y = Math.min(leftBottom, rightBottom) - 10;

  // ---- Money summaries: One-Time (left) | Recurring Plan (right)
  const moneyTop = d.y;
  const moneyBlock = (
    x: number,
    title: string,
    rows: AgreementMoneyRow[]
  ): number => {
    d.fill(x, moneyTop, A_COLW, BAR_H);
    d.write(title.toUpperCase(), x, moneyTop - 2.5, {
      font: d.bold,
      size: 8.5,
      color: WHITE,
      maxWidth: A_COLW,
      align: "center",
    });
    let yy = moneyTop - BAR_H - 10;
    for (const r of rows) {
      const size = r.muted ? 8.5 : 9.5;
      const font = r.total ? d.bold : d.font;
      const color = r.muted ? MUTED : INK;
      if (r.total) {
        d.hline(x + 4, x + A_COLW - 4, yy + 4, BORDER, 0.75);
        yy -= 4;
      }
      d.write(r.label, x + 4, yy, { font, size, color, maxWidth: A_COLW - 90 });
      d.write(fmtMoney(r.amountCents), x + A_COLW - 84, yy, {
        font,
        size,
        color,
        maxWidth: 80,
        align: "right",
      });
      yy -= size * 1.7;
    }
    return yy;
  };
  let lB = moneyTop - BAR_H;
  let rB = moneyTop - BAR_H;
  // A one-time treatment box — unless this is a plan-only (mosquito / community)
  // quote, which is sold only as a subscription. When only one box shows (a
  // plan-only or one-time-only quote), center it instead of leaving a lopsided
  // empty column.
  const showsOneTime = !opts.planOnly && opts.oneTimeCents != null;
  const bothBoxes = showsOneTime && Boolean(opts.plan);
  const soloX = A_M + (A_CW - A_COLW) / 2;
  if (showsOneTime) {
    lB = moneyBlock(bothBoxes ? A_M : soloX, "One-Time Treatment", [
      { label: "Service total", amountCents: opts.oneTimeCents!, total: true },
    ]);
  }
  if (opts.plan) {
    rB = moneyBlock(bothBoxes ? rightX : soloX, "Recurring Plan", [
      { label: `Visits: ${cadenceLabel(opts.plan.frequency)}`, amountCents: opts.plan.monthlyCents, muted: true },
      { label: "Billed monthly", amountCents: opts.plan.monthlyCents },
      { label: "Due at booking", amountCents: opts.plan.initialFeeCents, total: true },
    ]);
  }
  d.y = Math.min(lB, rB) - 16;

  // ---- Off-season note (GL-17)
  if (opts.offSeason && opts.offSeasonMessage) {
    d.band("Seasonal Enrollment");
    d.y -= 6;
    d.y = d.write(opts.offSeasonMessage, A_M, d.y, {
      size: 9,
      maxWidth: A_CW,
      lineGap: 0.5,
    });
    d.y -= 12;
  }

  // ---- Pests We Protect Against — the coverage strip with real pest photos
  d.band("Pests We Protect Against");
  d.y -= 12;
  await drawCoverageStrip(d, pestsForService(opts.serviceLabel));
  d.y -= 6;

  // ---- Why Homeowners Choose BuzzKill — green-checked value props, two columns
  d.band("Why Homeowners Choose BuzzKill");
  d.y -= 10;
  const valueProps = [
    "Licensed, insured local technicians",
    "Complimentary re-treats between visits",
    "Safe for families and pets",
    "Products registered with the EPA",
  ];
  const propColW = A_CW / 2;
  const propRows = Math.ceil(valueProps.length / 2);
  d.need(propRows * 16 + 4);
  const propTop = d.y;
  valueProps.forEach((prop, i) => {
    const px = A_M + (i % 2) * propColW;
    const py = propTop - Math.floor(i / 2) * 16;
    drawCheck(d, px + 2, py, 9);
    d.write(prop, px + 16, py, { size: 9.5, color: INK, maxWidth: propColW - 20 });
  });
  d.y = propTop - propRows * 16 - 12;

  // ---- Booking call-to-action, in a green-tinted callout with an accent bar
  const ctaText = opts.offSeason
    ? "To reserve this price, open your quote from the email we just sent and enroll — it takes about a minute."
    : "To lock in this price, open your quote from the email we just sent and pick the day that works — booking online takes about a minute.";
  const ctaH = d.measure(ctaText, d.font, 10, A_CW - 44, 0.5) + 20;
  d.need(ctaH + 4);
  const ctaTop = d.y;
  d.fill(A_M, ctaTop, A_CW, ctaH, CELL_TINT);
  d.fill(A_M, ctaTop, 4, ctaH, BK_GREEN); // left accent bar
  d.write(ctaText, A_M + 18, ctaTop - 12, {
    font: d.bold,
    size: 10,
    color: BK_GREEN_DK,
    maxWidth: A_CW - 44,
    lineGap: 0.5,
  });
  d.y = ctaTop - ctaH - 14;

  // ---- Footer
  d.need(30);
  d.hline(A_M, PAGE.width - A_M, d.y, RULE, 0.5);
  d.y -= 10;
  const footer = [
    opts.validThroughIso
      ? `This quote is valid through ${fmtQuoteDate(opts.validThroughIso)}.`
      : null,
    `Quote reference: ${opts.quoteRef}.`,
    "Prices reflect the service and property details you provided. Final scheduling is confirmed when you book.",
  ]
    .filter(Boolean)
    .join(" ");
  d.flow(footer, { size: 7.5, color: MUTED });

  return d.doc.save();
}

export type ReportProduct = {
  name?: string;
  epaNumber?: string;
  quantity?: string;
  /** Label rate or dilution as applied, e.g. "0.05% dilution". */
  rate?: string;
  targetPest?: string;
  /** Structured amount, preferred over parsing the `quantity` string: the
   *  numeric value and its unit, e.g. { amountValue: 2, amountUnit: "fl oz" }.
   *  `quantity` is still written ("2 fl oz") for the PDF and legacy readers, so
   *  older reports without these fields keep rendering and validating. */
  amountValue?: number;
  amountUnit?: string;
  /** The catalog Product this row was picked from, when known — the exact link
   *  for reconciliation and inventory depletion (falls back to name+EPA). */
  productId?: string;
};

export async function renderServiceReportPdf(opts: {
  reportId: string;
  company?: AgreementCompany;
  customerName: string;
  /** The on-site contact, when different from the account/display name. */
  contactName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  serviceAddress?: string;
  serviceType: string;
  serviceDateIso: string;
  technicianName: string;
  /** The applicator's certification number. A pesticide record needs one. */
  technicianLicenseNumber?: string | null;
  applicationStartIso?: string | null;
  applicationEndIso?: string | null;
  reEntryIntervalHours?: number | null;
  inspectionOnly?: boolean | null;
  servicesPerformed?: string | null;
  productsUsed?: ReportProduct[];
  targetPests?: string | null;
  areasTreated?: string | null;
  recommendations?: string | null;
  geo?: {
    lat: number;
    lng: number;
    accuracyM?: number | null;
    capturedAtIso?: string | null;
  } | null;
}): Promise<Uint8Array> {
  const d = await AgreementDoc.create();
  const co = opts.company ?? DEFAULT_COMPANY;
  const rightX = A_M + A_COLW + A_GUTTER;

  // ---- Masthead: logo (left) · SERVICE REPORT (center) · contact (right)
  const topY = d.y;
  const logoH = await drawLogo(d, A_M, topY, 150);
  if (logoH == null) {
    // Asset failed to embed — fall back to the text wordmark so the report still
    // renders a branded masthead.
    d.write("BuzzKill", A_M, topY, { font: d.bold, size: 22, color: BK_GREEN_DK });
    d.write("PEST CONTROL", A_M + 2, topY - 24, {
      font: d.bold,
      size: 7.5,
      color: MUTED,
    });
  }
  d.write("SERVICE REPORT", A_M, topY - 6, {
    font: d.bold,
    size: 17,
    color: BK_GREEN_DK,
    maxWidth: A_CW,
    align: "center",
  });
  const contact = [
    co.name,
    ...(co.addressLines ?? []),
    co.phone,
    co.email,
    co.website,
    co.license ? `License #: ${co.license}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const contactBottom = d.write(contact, A_M, topY, {
    font: d.font,
    size: 8,
    color: INK,
    maxWidth: A_CW,
    align: "right",
    lineGap: 1.5,
  });
  d.y = Math.min(topY - (logoH ?? 44), contactBottom) - 6;
  d.hline(A_M, PAGE.width - A_M, d.y, BK_GREEN, 1.5);
  d.y -= 14;

  // A column of label/value rows — bold label at the left, value flush right,
  // wrapping when long (an address, a licence). Returns the new bottom edge.
  const colRows = (
    x: number,
    top: number,
    w: number,
    rows: Array<[string, string | null | undefined]>
  ): number => {
    let yy = top;
    for (const [label, value] of rows) {
      if (!value) continue;
      const rowTop = yy;
      d.write(label, x + 6, rowTop, {
        font: d.bold,
        size: 8.5,
        color: INK,
        maxWidth: w * 0.42,
      });
      const valBottom = d.write(value, x + 6, rowTop, {
        font: d.font,
        size: 8.5,
        color: INK,
        maxWidth: w - 12,
        align: "right",
      });
      yy = Math.min(rowTop - 8.5 * 1.32, valBottom) - 3;
    }
    return yy;
  };

  // ---- Two-column: Customer Information | Service Information
  const infoTop = d.y;
  const infoBlock = (
    x: number,
    title: string,
    rows: Array<[string, string | null | undefined]>
  ): number => {
    d.fill(x, infoTop, A_COLW, BAR_H);
    d.write(title.toUpperCase(), x, infoTop - 2.5, {
      font: d.bold,
      size: 8.5,
      color: WHITE,
      maxWidth: A_COLW,
      align: "center",
    });
    return colRows(x, infoTop - BAR_H - 8, A_COLW, rows);
  };
  const address = opts.serviceAddress?.split(", ").join("\n");
  const contactName =
    opts.contactName && opts.contactName !== opts.customerName
      ? opts.contactName
      : null;
  const custRows: Array<[string, string | null | undefined]> = [
    ["Customer", opts.customerName],
    ["Contact", contactName],
    ["Address", address],
    ["Phone", opts.customerPhone],
    ["Email", opts.customerEmail],
  ];
  const svcRows: Array<[string, string | null | undefined]> = [
    ["Service", opts.serviceType],
    ["Date", fmtQuoteDate(opts.serviceDateIso)],
    ["Time In", opts.applicationStartIso ? fmtTime(opts.applicationStartIso) : null],
    ["Time Out", opts.applicationEndIso ? fmtTime(opts.applicationEndIso) : null],
    ["Technician", opts.technicianName],
    ["License #", opts.technicianLicenseNumber],
  ];
  const leftBottom = infoBlock(A_M, "Customer Information", custRows);
  const rightBottom = infoBlock(rightX, "Service Information", svcRows);
  d.y = Math.min(leftBottom, rightBottom) - 10;

  // A banded free-text section (Services Performed, Recommendations, …). Renders
  // nothing when its body is empty, so a sparse report skips it cleanly.
  const section = (title: string, body?: string | null) => {
    if (!body?.trim()) return;
    d.band(title);
    d.y -= 5;
    d.flow(body.trim(), { size: 9.5, color: INK, gapAfter: 9 });
  };

  section("Services Performed", opts.servicesPerformed);

  // ---- Products Applied
  d.band("Products Applied");
  d.y -= 5;
  if (opts.inspectionOnly) {
    d.flow("Inspection only — no pesticide was applied on this visit.", {
      size: 9.5,
      color: INK,
      gapAfter: 9,
    });
  } else if (opts.productsUsed?.length) {
    opts.productsUsed.forEach((p, i) => {
      d.need(38);
      const pTop = d.y;
      let lB = d.write(p.name ?? "Product", A_M + 4, pTop, {
        font: d.bold,
        size: 10,
        color: INK,
        maxWidth: A_COLW - 8,
      });
      if (p.epaNumber) {
        lB = d.write(`EPA Reg. # ${p.epaNumber}`, A_M + 4, lB - 2, {
          size: 8.5,
          color: MUTED,
          maxWidth: A_COLW - 8,
        });
      }
      const amount =
        p.quantity ||
        (p.amountValue != null
          ? `${p.amountValue}${p.amountUnit ? ` ${p.amountUnit}` : ""}`
          : null);
      const rB = colRows(rightX, pTop, A_COLW, [
        ["Rate", p.rate],
        ["Amount", amount],
        ["Target", p.targetPest],
      ]);
      d.y = Math.min(lB, rB) - 8;
      // A hairline between products, as on the reference document — skipped after
      // the last row so the section doesn't close on a dangling rule.
      if (i < opts.productsUsed!.length - 1) {
        d.hline(A_M, PAGE.width - A_M, d.y + 3, RULE, 0.5);
        d.y -= 4;
      }
    });
    d.y -= 5;
  } else {
    d.flow("No products were recorded for this visit.", {
      size: 9.5,
      color: MUTED,
      gapAfter: 9,
    });
  }

  // The applicator's duty to warn. An occupant who is not told when it is safe
  // to go back in has not been told the one thing this document is for.
  if (!opts.inspectionOnly && opts.reEntryIntervalHours != null) {
    section(
      "When It Is Safe to Re-Enter",
      opts.reEntryIntervalHours <= 0
        ? "Treated areas may be re-entered immediately once any applied product is dry or contained."
        : `Keep people and pets out of the treated areas for ${opts.reEntryIntervalHours} ${opts.reEntryIntervalHours === 1 ? "hour" : "hours"} from the application time above.`
    );
  }

  section("Target Pests", opts.targetPests);
  section("Areas Treated", opts.areasTreated);
  // Recommendations always open with the BuzzKill thank-you, then the
  // technician's own notes. Any thank-you the tech already typed (in whatever
  // casing) is stripped first so the canonical line is never doubled, and the
  // section always renders even when there are no further notes.
  const THANKS = "Thank you for choosing BuzzKill!";
  const recRest = (opts.recommendations ?? "")
    .trim()
    .replace(/^thank you for choosing buzzkill[!.…\s]*/i, "")
    .trim();
  section("Recommendations", recRest ? `${THANKS}\n\n${recRest}` : THANKS);
  // ServiceReport.techNotes is internal-only ("not shown to customer" in the tech
  // app) and must never be passed into this customer-facing document.

  if (opts.geo) {
    d.band("On-Site Verification");
    d.y -= 5;
    const bottom = colRows(A_M, d.y, A_CW, [
      [
        "GPS location",
        `${opts.geo.lat.toFixed(5)}, ${opts.geo.lng.toFixed(5)}` +
          (opts.geo.accuracyM ? `  (±${Math.round(opts.geo.accuracyM)} m)` : ""),
      ],
      ["Captured", opts.geo.capturedAtIso ? fmtDateTime(opts.geo.capturedAtIso) : null],
      [
        "Map",
        `https://maps.google.com/?q=${opts.geo.lat.toFixed(5)},${opts.geo.lng.toFixed(5)}`,
      ],
    ]);
    d.y = bottom - 4;
    // This states only what is true — the coordinates are device-reported and
    // are not compared to the service address (there is no geofence), so the
    // document must not imply a proof of on-site presence it does not have.
    d.y = d.write(
      "Location reported by the technician's device when the report was filed. Accuracy depends on the device and is not independently verified.",
      A_M,
      d.y,
      { size: 8, color: MUTED, maxWidth: A_CW, lineGap: 0.5 }
    );
    d.y -= 10;
  }

  // ---- Safety footer + reference
  d.need(48);
  d.hline(A_M, PAGE.width - A_M, d.y, RULE, 0.5);
  d.y -= 10;
  d.y = d.write(
    `${co.name} is committed to the safety of our customers and our environment. ` +
      "All materials used have been registered by the Environmental Protection Agency. " +
      "Please avoid unnecessary contact with materials and comply with all instructions and " +
      "recommendations from our technicians. Thank you for your patronage! " +
      "National Emergency Poison Control: (800) 222-1222",
    A_M,
    d.y,
    { size: 7.5, color: MUTED, maxWidth: A_CW, align: "center", lineGap: 0.5 }
  );
  d.y -= 6;
  d.write(`Report reference: ${opts.reportId}`, A_M, d.y, {
    size: 7.5,
    color: MUTED,
    maxWidth: A_CW,
    align: "center",
  });
  return d.doc.save();
}

export type AmendmentChange = { label: string; from: string; to: string };

/**
 * A correction to an already-issued service report. It is its own document: it
 * names the original, states why the correction was made and by whom, and shows
 * each changed fact as was → now. The original report is preserved unchanged;
 * this rides alongside it as part of the record.
 */
export async function renderAmendmentPdf(opts: {
  amendmentId: string;
  originalReportId: string;
  company?: AgreementCompany;
  customerName: string;
  serviceAddress?: string;
  serviceType: string;
  originalServiceDateIso: string;
  reason: string;
  changes: AmendmentChange[];
  authorName: string;
  authorEmail?: string | null;
  issuedAtIso: string;
}): Promise<Uint8Array> {
  const d = await AgreementDoc.create();
  const co = opts.company ?? DEFAULT_COMPANY;
  const rightX = A_M + A_COLW + A_GUTTER;

  // ---- Masthead: logo (left) · SERVICE REPORT AMENDMENT (center) · contact
  const topY = d.y;
  const logoH = await drawLogo(d, A_M, topY, 150);
  if (logoH == null) {
    d.write("BuzzKill", A_M, topY, { font: d.bold, size: 22, color: BK_GREEN_DK });
    d.write("PEST CONTROL", A_M + 2, topY - 24, { font: d.bold, size: 7.5, color: MUTED });
  }
  // Centered across the full width but kept small enough that this longer title
  // clears the logo on the left and the contact block on the right.
  d.write("SERVICE REPORT AMENDMENT", A_M, topY - 8, {
    font: d.bold,
    size: 13,
    color: BK_GREEN_DK,
    maxWidth: A_CW,
    align: "center",
  });
  const contact = [
    co.name,
    ...(co.addressLines ?? []),
    co.phone,
    co.email,
    co.website,
    co.license ? `License #: ${co.license}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const contactBottom = d.write(contact, A_M, topY, {
    font: d.font,
    size: 8,
    color: INK,
    maxWidth: A_CW,
    align: "right",
    lineGap: 1.5,
  });
  d.y = Math.min(topY - (logoH ?? 44), contactBottom) - 6;
  d.hline(A_M, PAGE.width - A_M, d.y, BK_GREEN, 1.5);
  d.y -= 14;

  // ---- Correction notice banner: this is a correction, stated up front
  const noticeH = 22;
  d.fill(A_M, d.y, A_CW, noticeH, CELL_TINT);
  d.fill(A_M, d.y, 4, noticeH, BK_GREEN);
  d.write(
    "This document corrects a previously issued service report. The original report is preserved unchanged.",
    A_M + 18,
    d.y - 7,
    { font: d.bold, size: 9, color: BK_GREEN_DK, maxWidth: A_CW - 34 }
  );
  d.y -= noticeH + 14;

  // Shared label/value column (bold label left, value flush right, wrapping).
  const colRows = (
    x: number,
    top: number,
    wid: number,
    rows: Array<[string, string | null | undefined]>
  ): number => {
    let yy = top;
    for (const [label, value] of rows) {
      if (!value) continue;
      const rowTop = yy;
      d.write(label, x + 6, rowTop, { font: d.bold, size: 8.5, color: INK, maxWidth: wid * 0.42 });
      const valBottom = d.write(value, x + 6, rowTop, {
        font: d.font,
        size: 8.5,
        color: INK,
        maxWidth: wid - 12,
        align: "right",
      });
      yy = Math.min(rowTop - 8.5 * 1.32, valBottom) - 3;
    }
    return yy;
  };

  // ---- Two-column: Customer Information | Amendment Details
  const infoTop = d.y;
  const infoBlock = (
    x: number,
    title: string,
    rows: Array<[string, string | null | undefined]>
  ): number => {
    d.fill(x, infoTop, A_COLW, BAR_H);
    d.write(title.toUpperCase(), x, infoTop - 2.5, {
      font: d.bold,
      size: 8.5,
      color: WHITE,
      maxWidth: A_COLW,
      align: "center",
    });
    return colRows(x, infoTop - BAR_H - 8, A_COLW, rows);
  };
  const address = opts.serviceAddress?.split(", ").join("\n");
  const leftBottom = infoBlock(A_M, "Customer Information", [
    ["Customer", opts.customerName],
    ["Address", address],
    ["Service", opts.serviceType],
  ]);
  const rightBottom = infoBlock(rightX, "Amendment Details", [
    ["Original report", fmtDateTime(opts.originalServiceDateIso)],
    ["Amendment issued", fmtDateTime(opts.issuedAtIso)],
    ["Issued by", opts.authorName],
    ["Contact", opts.authorEmail],
  ]);
  d.y = Math.min(leftBottom, rightBottom) - 12;

  // ---- Reason for the Correction
  d.band("Reason for the Correction");
  d.y -= 5;
  d.flow(opts.reason.trim(), { size: 9.5, color: INK, gapAfter: 12 });

  // ---- What Was Corrected — each change as a before/after pair
  d.band("What Was Corrected");
  d.y -= 8;
  opts.changes.forEach((c, i) => {
    d.need(46);
    const top = d.y;
    d.write(c.label, A_M + 2, top, { font: d.bold, size: 10, color: INK, maxWidth: A_CW - 4 });
    const cellTop = top - 15;
    // Left cell: previously (muted). Right cell: corrected to (green).
    const cell = (x: number, tag: string, value: string, tagColor: ReturnType<typeof rgb>, valColor: ReturnType<typeof rgb>) => {
      d.write(tag, x + 6, cellTop, { font: d.bold, size: 7, color: tagColor, maxWidth: A_COLW - 12 });
      return d.write(value || "—", x + 6, cellTop - 9, {
        size: 9.5,
        color: valColor,
        maxWidth: A_COLW - 12,
        lineGap: 0.5,
      });
    };
    const lB = cell(A_M, "PREVIOUSLY", c.from, MUTED, MUTED);
    const rB = cell(rightX, "CORRECTED TO", c.to, BK_GREEN_DK, INK);
    d.y = Math.min(lB, rB) - 8;
    if (i < opts.changes.length - 1) {
      d.hline(A_M, PAGE.width - A_M, d.y + 3, RULE, 0.5);
      d.y -= 4;
    }
  });
  d.y -= 6;

  // ---- Footer
  d.need(44);
  d.hline(A_M, PAGE.width - A_M, d.y, RULE, 0.5);
  d.y -= 10;
  d.y = d.write(
    `This amendment corrects the service report issued ${fmtDateTime(opts.originalServiceDateIso)} and forms part of that record. ` +
      "The original report is preserved unchanged.",
    A_M,
    d.y,
    { size: 7.5, color: MUTED, maxWidth: A_CW, align: "center", lineGap: 0.5 }
  );
  d.y -= 6;
  d.write(`Amendment reference: ${opts.amendmentId}`, A_M, d.y, {
    size: 7.5,
    color: MUTED,
    maxWidth: A_CW,
    align: "center",
  });
  return d.doc.save();
}
