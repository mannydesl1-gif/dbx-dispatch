const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const bwipjs = require("bwip-js");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

admin.initializeApp();

// ═══ LOGO (embedded base64 JPEG) ═══
const LOGO_B64 = "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";
let LOGO_BYTES = null;
function getLogoBytes() {
  if (LOGO_BYTES) return LOGO_BYTES;
  try {
    LOGO_BYTES = Buffer.from(LOGO_B64, "base64");
  } catch { LOGO_BYTES = null; }
  return LOGO_BYTES;
}

// ═══ GMAIL TRANSPORTER (created at runtime to read secret) ═══
function getTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: "manny@diamondbackexpress.com",
      pass: process.env.GMAIL_APP_PASSWORD || "",
    },
  });
}

// ═══ HELPER: Format date ═══
function fd(d) {
  if (!d) return "—";
  try {
    return new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch { return d; }
}

// ═══ HELPER: Draw wrapped text ═══
function drawWrapped(page, text, x, y, maxWidth, font, size, color) {
  const lines = [];
  const paragraphs = (text || "").split("\n");
  for (const para of paragraphs) {
    const words = para.split(" ");
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      const w = font.widthOfTextAtSize(test, size);
      if (w > maxWidth && line) { lines.push(line); line = word; }
      else { line = test; }
    }
    if (line) lines.push(line);
    else lines.push("");
  }
  for (const ln of lines) {
    if (y < 40) break;
    page.drawText(ln, { x, y, size, font, color });
    y -= size + 3;
  }
  return y;
}

// ═══ HELPER: Split text into wrapped lines (for pagination) ═══
function wrapLines(text, maxWidth, font, size) {
  const lines = [];
  const paragraphs = (text || "").split("\n");
  for (const para of paragraphs) {
    const words = para.split(" ");
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (font.widthOfTextAtSize(test, size) > maxWidth && line) { lines.push(line); line = word; }
      else { line = test; }
    }
    lines.push(line);
  }
  return lines;
}

// ═══ HELPER: Draw the standard top header (logo, addresses, BOL#, bill-to, client, division) ═══
// Returns the y position after the header. Used on page 1 and repeated on overflow pages.
async function drawTopHeader(pdfDoc, page, order, client, fonts, opts = {}) {
  const { helvetica, helveticaBold } = fonts;
  const black = rgb(0, 0, 0); const gray = rgb(0.4, 0.4, 0.4); const grayMid = rgb(0.45, 0.45, 0.45); const red = rgb(0.86, 0.15, 0.15);
  const W = 612; const M = 40; let y = 750;

  // ── Header strip: logo (left) | CA company (center) | US company (right) | red line ──
  const logoData = getLogoBytes();
  let logoHeight = 0;
  if (logoData) {
    try {
      const logoImg = await pdfDoc.embedJpg(logoData);
      const logoDims = logoImg.scale(0.40);
      logoHeight = logoDims.height;
      page.drawImage(logoImg, { x: M, y: y - logoDims.height, width: logoDims.width, height: logoDims.height });
    } catch {}
  }

  // Center: DBX Canada (name + address)
  const caName = "Diamond Back Express Canada";
  const caAddr = ["4515 Ebenezer Rd Unit 212", "Brampton, Ontario, L6P 2K7"];
  const centerY = y - 4;
  const caNameW = helveticaBold.widthOfTextAtSize(caName, 9);
  page.drawText(caName, { x: (W - caNameW) / 2, y: centerY, size: 9, font: helveticaBold, color: black });
  caAddr.forEach((line, i) => {
    const lw = helvetica.widthOfTextAtSize(line, 8);
    page.drawText(line, { x: (W - lw) / 2, y: centerY - 11 - (i * 10), size: 8, font: helvetica, color: grayMid });
  });

  // Right: DBX LLC (name + address)
  const usName = "Diamond Back Express LLC";
  const usAddr = ["Suite 400-K-175, 1110 Brickell Ave", "Miami, FL 33131"];
  page.drawText(usName, { x: W - M - helveticaBold.widthOfTextAtSize(usName, 9), y: centerY, size: 9, font: helveticaBold, color: black });
  usAddr.forEach((line, i) => {
    page.drawText(line, { x: W - M - helvetica.widthOfTextAtSize(line, 8), y: centerY - 11 - (i * 10), size: 8, font: helvetica, color: grayMid });
  });

  // Red horizontal line under header strip — thinner
  y = Math.min(y - Math.max(logoHeight, 36), centerY - 32);
  page.drawRectangle({ x: M, y: y, width: W - 2 * M, height: 2, color: red });
  y -= 30;

  // ── BOL number (large, left) + right-side info block ──
  const bolStartY = y;
  if (opts.title) {
    page.drawText(opts.title, { x: M, y, size: 11, font: helveticaBold, color: red });
    y -= 26;
  }
  page.drawText(`BOL ${order.bol}`, { x: M, y, size: 28, font: helveticaBold, color: red });
  y -= 28;

  // Right-side info block (aligned with BOL)
  let ry = bolStartY; const ri = W - M;
  const drawR = (l, v) => {
    const labelText = `${l}: `;
    const valueText = `${v}`;
    const lw = helveticaBold.widthOfTextAtSize(labelText, 10);
    const vw = helvetica.widthOfTextAtSize(valueText, 10);
    page.drawText(labelText, { x: ri - lw - vw, y: ry, size: 10, font: helveticaBold, color: black });
    page.drawText(valueText, { x: ri - vw, y: ry, size: 10, font: helvetica, color: black });
    ry -= 14;
  };
  drawR("Date", fd(order.reqDate));
  if (order.drvName) drawR("Driver", order.drvName);
  if (order.ref) drawR("Ref", order.ref);
  if (order.poNumber) drawR("PO #", order.poNumber);
  if (order.trkUnit) drawR("Truck", `Unit ${order.trkUnit}${order.trkPlate ? " | Plate: " + order.trkPlate : ""}`);
  if (order.trlUnit) drawR("Trailer", `Unit ${order.trlUnit}${order.trlPlate ? " | Plate: " + order.trlPlate : ""}`);

  // ── Bill to + client address (under BOL) ──
  const billToName = order.billTo || (client && client.name) || order.cliName || "";
  if (billToName) {
    const billLabel = "Bill to: ";
    const billLW = helvetica.widthOfTextAtSize(billLabel, 11);
    page.drawText(billLabel, { x: M, y, size: 11, font: helvetica, color: grayMid });
    page.drawText(billToName, { x: M + billLW, y, size: 11, font: helveticaBold, color: black });
    y -= 13;
    if (client) {
      const addrLines = [client.street, [client.city, client.provState].filter(Boolean).join(", "), client.postalZip, client.country, client.email].filter(Boolean);
      for (const line of addrLines) {
        page.drawText(line, { x: M, y, size: 9, font: helvetica, color: black });
        y -= 11;
      }
    }
  }
  y = Math.min(y, ry) - 8;

  // ── Division name — bold black text, no box ──
  if (order.divName) {
    page.drawText(order.divName, { x: M, y: y - 9, size: 10, font: helveticaBold, color: black });
    y -= 20;
  }

  // ── Event/Project badge + name ──
  if (order.orderType === "event") {
    const projLabel = "PROJECT";
    const projW = helveticaBold.widthOfTextAtSize(projLabel, 8);
    page.drawRectangle({ x: M, y: y - 11, width: projW + 12, height: 14, color: rgb(0.55, 0.36, 0.96) });
    page.drawText(projLabel, { x: M + 6, y: y - 8, size: 8, font: helveticaBold, color: rgb(1,1,1) });
    y -= 18;
  }

  // ── Location for event orders (if chosen) ──
  if (order.orderType === "event" && order.eventName) {
    page.drawText(order.eventName, { x: M, y, size: 16, font: helveticaBold, color: black });
    y -= 22;
  }
  if (order.orderType === "event" && (order.pickCo || order.pickAddr)) {
    if (order.pickCo) { page.drawText(`Location: ${order.pickCo}`, { x: M, y, size: 9, font: helveticaBold, color: gray }); y -= 12; }
    if (order.pickAddr) {
      for (const ln of String(order.pickAddr).split("\n")) {
        page.drawText(ln, { x: M, y, size: 9, font: helvetica, color: gray }); y -= 11;
      }
    }
    y -= 4;
  }

  return y - 6;
}

// ═══ GENERATE BOL PDF ═══
async function generateBolPdf(order, client = null, includePricing = false) {
  const pdfDoc = await PDFDocument.create();
  let page = pdfDoc.addPage([612, 792]);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0); const gray = rgb(0.4, 0.4, 0.4); const red = rgb(0.86, 0.15, 0.15);
  const W = 612; const M = 40;
  const fonts = { helvetica, helveticaBold };

  let y = await drawTopHeader(pdfDoc, page, order, client, fonts, {});

  // Pagination: when content runs low, start a new page and redraw the header
  const ensureSpace = async (needed) => {
    if (y - needed < 70) {
      page = pdfDoc.addPage([612, 792]);
      y = await drawTopHeader(pdfDoc, page, order, client, fonts, {});
    }
  };

  const isEvent = order.orderType === "event";
  const boxW = (W - 2 * M - 12) / 2;
  const dx = M + boxW + 12;

  if (isEvent) {
    // ── Event order: reference + line items + notes (division + event name already in header) ──
    if (order.ref) {
      const refLabel = "Reference #: ";
      const refLW = helvetica.widthOfTextAtSize(refLabel, 9);
      page.drawText(refLabel, { x: M, y, size: 9, font: helvetica, color: gray });
      page.drawText(order.ref, { x: M + refLW, y, size: 9, font: helveticaBold, color: black }); y -= 18;
    }
    // Event line items table — only when pricing is requested
    const eventLines = includePricing ? ((order.price && order.price.eventLines) || []).filter(l => l.desc || parseFloat(l.unitPrice) > 0) : [];
    if (eventLines.length > 0) {
      const cur = (order.price && order.price.cur) || "CAD";
      const sym = cur === "EUR" ? "€" : cur === "GBP" ? "£" : "$";
      await ensureSpace(40);
      y -= 8;
      const drawColHeaders = () => {
        page.drawRectangle({ x: M, y: y - 14, width: W - 2 * M, height: 16, color: rgb(0.93, 0.94, 0.97) });
        page.drawText("DESCRIPTION", { x: M + 6, y: y - 10, size: 7, font: helveticaBold, color: gray });
        page.drawText("QTY", { x: M + 310, y: y - 10, size: 7, font: helveticaBold, color: gray });
        page.drawText("UNIT PRICE", { x: M + 375, y: y - 10, size: 7, font: helveticaBold, color: gray });
        page.drawText("AMOUNT", { x: W - M - 55, y: y - 10, size: 7, font: helveticaBold, color: gray });
        y -= 18;
      };
      drawColHeaders();
      let eventTotal = 0;
      for (const line of eventLines) {
        // Wrap description to fit available width (DESCRIPTION column ends at QTY = M+310)
        const descMaxWidth = 290; // M+6 to ~M+300 with safety padding
        const descLines = wrapLines(String(line.desc), descMaxWidth, helvetica, 9);
        const rowHeight = Math.max(18, descLines.length * 12 + 6);

        if (y - rowHeight < 70) { await ensureSpace(0); drawColHeaders(); }

        const qty = parseFloat(line.qty) || 0;
        const up = parseFloat(line.unitPrice) || 0;
        const amt = qty * up; eventTotal += amt;
        // Description (potentially multi-line)
        for (let i = 0; i < descLines.length; i++) {
          page.drawText(descLines[i], { x: M + 6, y: y - 10 - (i * 12), size: 9, font: helvetica, color: black });
        }
        // Other columns on first line only
        page.drawText(String(qty), { x: M + 310, y: y - 10, size: 9, font: helvetica, color: black });
        page.drawText(`${sym}${up.toFixed(2)}`, { x: M + 375, y: y - 10, size: 9, font: helvetica, color: black });
        const amtStr = `${sym}${amt.toFixed(2)}`;
        page.drawText(amtStr, { x: W - M - 6 - helveticaBold.widthOfTextAtSize(amtStr, 9), y: y - 10, size: 9, font: helveticaBold, color: black });
        page.drawLine({ start: { x: M, y: y - rowHeight + 4 }, end: { x: W - M, y: y - rowHeight + 4 }, thickness: 0.5, color: rgb(0.9, 0.9, 0.9) });
        y -= rowHeight;
      }
      await ensureSpace(30);
      y -= 4;
      page.drawRectangle({ x: M, y: y - 18, width: W - 2 * M, height: 20, color: rgb(0.95, 0.96, 0.98) });
      const totalLabel = `TOTAL ${cur}`;
      page.drawText(totalLabel, { x: M + 6, y: y - 13, size: 10, font: helveticaBold, color: red });
      const totalStr = `${sym}${eventTotal.toFixed(2)} ${cur}`;
      page.drawText(totalStr, { x: W - M - 6 - helveticaBold.widthOfTextAtSize(totalStr, 11), y: y - 13, size: 11, font: helveticaBold, color: red });
      y -= 28;
    }
    if (order.notes) {
      await ensureSpace(30);
      y -= 10;
      const noteLines = wrapLines(order.notes, W - 2 * M - 16, helvetica, 9);
      const boxH = 14 + noteLines.length * 12 + 8;
      page.drawRectangle({ x: M, y: y - boxH, width: 4, height: boxH, color: red });
      page.drawRectangle({ x: M + 4, y: y - boxH, width: W - 2 * M - 4, height: boxH, color: rgb(0.98, 0.99, 1.0) });
      page.drawText("Notes:", { x: M + 12, y: y - 11, size: 8, font: helveticaBold, color: red }); y -= 20;
      for (const ln of noteLines) {
        if (y < 70) {
          await ensureSpace(0);
          y -= 10;
          page.drawText("Notes (cont.):", { x: M + 12, y, size: 8, font: helveticaBold, color: red }); y -= 14;
        }
        page.drawText(ln, { x: M + 12, y, size: 9, font: helveticaBold, color: black });
        y -= 12;
      }
      y -= 10;
    }
  } else {
    // ── Transport order: pickup/delivery boxes + items ──
    const pickStops = (order.pickStops && order.pickStops.length) ? order.pickStops : [{ co: order.pickCo, addr: order.pickAddr, date: order.pickDate, items: order.items }];
    const delStops = (order.delStops && order.delStops.length) ? order.delStops : [{ co: order.delCo, addr: order.delAddr, date: order.delDate, items: order.items }];
    const isMultiStop = pickStops.length > 1 || delStops.length > 1;

    // Helper: which item columns actually have data across a set of items (so empty cols are hidden)
    const activeCols = (items) => {
      const has = { pcs:false, wt:false, l:false, w:false, h:false };
      for (const it of items) {
        if (it.pcs) has.pcs = true;
        if (it.wt) has.wt = true;
        if (it.l) has.l = true;
        if (it.w) has.w = true;
        if (it.h) has.h = true;
      }
      return has;
    };

    // Helper: draw an items table for a stop, only showing populated columns. Returns nothing (mutates y).
    const drawItemsTable = async (items) => {
      const its = (items || []).filter(i => i.desc || i.pcs || i.wt);
      if (its.length === 0) return;
      const has = activeCols(its);
      await ensureSpace(34);
      // Build column layout dynamically
      const cols = [];
      if (has.pcs) cols.push({ l: "Pces", x: M + 4, w: 42 });
      cols.push({ l: "Description", x: M + (has.pcs ? 50 : 4), w: 240 });
      let cx = M + 300;
      if (has.wt) { cols.push({ l: "Weight", x: cx }); cx += 75; }
      if (has.l)  { cols.push({ l: "Length", x: cx }); cx += 55; }
      if (has.w)  { cols.push({ l: "Width",  x: cx }); cx += 55; }
      if (has.h)  { cols.push({ l: "Height", x: cx }); cx += 55; }
      page.drawRectangle({ x: M, y: y - 14, width: W - 2 * M, height: 16, color: rgb(0.95, 0.96, 0.98) });
      cols.forEach(c => page.drawText(c.l, { x: c.x, y: y - 10, size: 7, font: helveticaBold, color: gray }));
      y -= 18;
      for (const item of its) {
        if (y - 16 < 70) { await ensureSpace(0); }
        if (has.pcs) page.drawText(String(item.pcs || "—"), { x: M + 4, y: y - 10, size: 9, font: helvetica, color: black });
        const descX = M + (has.pcs ? 50 : 4);
        const descBottom = drawWrapped(page, String(item.desc || "—"), descX, y - 7, 240, helvetica, 9, black);
        let mx = M + 300;
        if (has.wt) { page.drawText(`${item.wt || "—"} ${item.wUnit || ""}`.trim(), { x: mx, y: y - 10, size: 9, font: helvetica, color: black }); mx += 75; }
        if (has.l)  { page.drawText(String(item.l || "—"), { x: mx, y: y - 10, size: 9, font: helvetica, color: black }); mx += 55; }
        if (has.w)  { page.drawText(String(item.w || "—"), { x: mx, y: y - 10, size: 9, font: helvetica, color: black }); mx += 55; }
        if (has.h)  { page.drawText(String(item.h || "—"), { x: mx, y: y - 10, size: 9, font: helvetica, color: black }); mx += 55; }
        page.drawLine({ start: { x: M, y: descBottom - 8 }, end: { x: W - M, y: descBottom - 8 }, thickness: 0.5, color: rgb(0.9, 0.9, 0.9) });
        y = descBottom - 8;
      }
      y -= 6;
    };

    // Helper: draw a stop's notes (if any) as a wrapped "Notes:" line
    const drawStopNotes = async (notes) => {
      if (!notes || !String(notes).trim()) return;
      await ensureSpace(28);
      const noteLines = wrapLines(String(notes), W - 2 * M - 18, helvetica, 8);
      const boxH = 12 + noteLines.length * 11 + 6;
      page.drawRectangle({ x: M, y: y - boxH, width: 3, height: boxH, color: rgb(0.89, 0.45, 0.13) });
      page.drawRectangle({ x: M + 3, y: y - boxH, width: W - 2 * M - 3, height: boxH, color: rgb(1.0, 0.98, 0.93) });
      page.drawText("Notes:", { x: M + 9, y: y - 9, size: 7, font: helveticaBold, color: rgb(0.71, 0.33, 0.0) });
      y -= 18;
      for (const ln of noteLines) {
        if (y < 70) { await ensureSpace(0); }
        page.drawText(ln, { x: M + 9, y: y, size: 8, font: helvetica, color: black });
        y -= 11;
      }
      y -= 6;
    };
    if (!isMultiStop) {
      // ── Single pickup + single delivery: side-by-side, dynamic height ──
      const ps = pickStops[0], ds = delStops[0];

      // Measure content height for each box so both can share the taller height
      const measureBox = (s) => {
        let lines = 0;
        if (s.co) lines += 1;                                  // company name
        const addrLines = wrapLines(s.addr || "—", boxW - 12, helvetica, 8);
        lines += addrLines.length;                             // address lines
        if (s.contact || s.phone) lines += 1;                  // contact/phone line
        let noteLines = [];
        if (s.notes && String(s.notes).trim()) {
          noteLines = wrapLines(String(s.notes), boxW - 16, helvetica, 8);
          lines += 1 + noteLines.length;                       // "Notes:" label + note lines
        }
        return { addrLines, noteLines };
      };
      const pm = measureBox(ps), dm = measureBox(ds);
      // Height = header(26) + content lines*11 + padding(14)
      const linesFor = (s, m) => (s.co?1:0) + m.addrLines.length + ((s.contact||s.phone)?1:0) + (m.noteLines.length? 1 + m.noteLines.length : 0);
      const contentLines = Math.max(linesFor(ps, pm), linesFor(ds, dm));
      const boxH = Math.max(100, 34 + contentLines * 11 + 10);

      // Draw one box
      const drawBox = (bx, label, s, m) => {
        page.drawRectangle({ x: bx, y: y - boxH, width: boxW, height: boxH, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 1 });
        page.drawText(label, { x: bx + 6, y: y - 12, size: 8, font: helveticaBold, color: gray });
        if (s.date) { const dd = fd(s.date); page.drawText(dd, { x: bx + boxW - 6 - helveticaBold.widthOfTextAtSize(dd, 9), y: y - 12, size: 9, font: helveticaBold, color: black }); }
        let ly = y - 28;
        if (s.co) { page.drawText(s.co, { x: bx + 6, y: ly, size: 9, font: helveticaBold, color: black }); ly -= 12; }
        for (const ln of m.addrLines) { page.drawText(ln, { x: bx + 6, y: ly, size: 8, font: helvetica, color: black }); ly -= 11; }
        if (s.contact || s.phone) {
          const cs = [s.contact, s.phone].filter(Boolean).join("  ·  ");
          ly -= 2;
          page.drawText(cs, { x: bx + 6, y: ly, size: 8, font: helveticaBold, color: black }); ly -= 12;
        }
        if (m.noteLines.length) {
          ly -= 2;
          page.drawText("Notes:", { x: bx + 6, y: ly, size: 7, font: helveticaBold, color: rgb(0.71, 0.33, 0.0) }); ly -= 10;
          for (const ln of m.noteLines) { page.drawText(ln, { x: bx + 6, y: ly, size: 8, font: helvetica, color: black }); ly -= 11; }
        }
      };
      drawBox(M, "PICK UP", ps, pm);
      drawBox(dx, "DELIVERY", ds, dm);
      y = y - boxH - 12;
      await drawItemsTable(delStops[0].items && delStops[0].items.length ? delStops[0].items : order.items);
    } else {
      // ── Multi-stop: stacked PICK UP block(s) then DELIVERY blocks, each with items + sign-off ──
      const totalPcs = (stops) => stops.reduce((s, st) => s + (st.items || []).reduce((a, it) => a + (parseFloat(it.pcs) || 0), 0), 0);
      const pickHoldsItems = pickStops.length > 1;   // multi-pickup -> items on pickups
      const delTotalPcs = totalPcs(delStops);
      const pickTotalPcs = totalPcs(pickStops);

      // Pickup block(s)
      for (let pi = 0; pi < pickStops.length; pi++) {
        const ps = pickStops[pi];
        await ensureSpace(64);
        page.drawRectangle({ x: M, y: y - 2, width: W - 2 * M, height: 2, color: rgb(0.85, 0.86, 0.88) });
        y -= 12;
        const lbl = pickStops.length > 1 ? `PICK UP — STOP ${pi + 1}` : "PICK UP";
        page.drawText(lbl, { x: M, y: y - 8, size: 8, font: helveticaBold, color: gray });
        if (ps.date) { const pd = fd(ps.date); page.drawText(pd, { x: W - M - helveticaBold.widthOfTextAtSize(pd, 9), y: y - 8, size: 9, font: helveticaBold, color: black }); }
        y -= 22;
        if (ps.co) { page.drawText(ps.co, { x: M, y: y, size: 9, font: helveticaBold, color: black }); y -= 12; }
        const pBottom = drawWrapped(page, ps.addr || "—", M, y, (W - 2 * M) / 2, helvetica, 8, black);
        y = pBottom - 4;
        if (ps.contact || ps.phone) {
          const contactStr = [ps.contact, ps.phone].filter(Boolean).join("  ·  ");
          page.drawText(contactStr, { x: M, y: y, size: 8, font: helvetica, color: rgb(0.28, 0.35, 0.42) });
          y -= 11;
        }
        if (!pickHoldsItems && pi === 0 && delTotalPcs > 0) {
          page.drawText(`Total loaded: ${delTotalPcs} pcs`, { x: M, y: y, size: 8, font: helveticaBold, color: gray }); y -= 12;
        }
        if (pickHoldsItems) { await drawItemsTable(ps.items); }
        await drawStopNotes(ps.notes);
      }

      // Delivery block(s)
      for (let di = 0; di < delStops.length; di++) {
        const ds = delStops[di];
        // Estimate full block height so the stop + its sign-off never split across pages
        const dItems = (ds.items || []).filter(i => i.desc || i.pcs || i.wt);
        const addrLineCount = String(ds.addr || "—").split("\n").length;
        const noteLineCount = ds.notes ? wrapLines(String(ds.notes), W - 2 * M, helvetica, 8).length + 1 : 0;
        const estHeight = 14 /*divider*/ + 22 /*label*/ + 12 /*co*/ + (addrLineCount * 10) + 6
          + (dItems.length ? (18 + dItems.length * 18 + 6) : 0)
          + (noteLineCount * 10) + 8 /*notes gap*/
          + 34 /*sign-off*/ + 10;
        await ensureSpace(estHeight);
        page.drawRectangle({ x: M, y: y - 2, width: W - 2 * M, height: 2, color: rgb(0.85, 0.86, 0.88) });
        y -= 12;
        const lbl = delStops.length > 1 ? `DELIVERY — STOP ${di + 1}` : "DELIVERY";
        page.drawText(lbl, { x: M, y: y - 8, size: 8, font: helveticaBold, color: gray });
        if (ds.date) { const dd = fd(ds.date); page.drawText(dd, { x: W - M - helveticaBold.widthOfTextAtSize(dd, 9), y: y - 8, size: 9, font: helveticaBold, color: black }); }
        y -= 22;
        if (ds.co) { page.drawText(ds.co, { x: M, y: y, size: 9, font: helveticaBold, color: black }); y -= 12; }
        const dBottom = drawWrapped(page, ds.addr || "—", M, y, (W - 2 * M) / 2, helvetica, 8, black);
        y = dBottom - 4;
        if (ds.contact || ds.phone) {
          const contactStr = [ds.contact, ds.phone].filter(Boolean).join("  ·  ");
          page.drawText(contactStr, { x: M, y: y, size: 8, font: helvetica, color: rgb(0.28, 0.35, 0.42) });
          y -= 11;
        }
        if (!pickHoldsItems) { await drawItemsTable(ds.items); }
        else if (di === 0 && pickTotalPcs > 0) {
          page.drawText(`Total received: ${pickTotalPcs} pcs`, { x: M, y: y, size: 8, font: helveticaBold, color: gray }); y -= 12;
        }
        await drawStopNotes(ds.notes);
        // Per-stop sign-off: pre-fill from recorded POD if present, else blank lines for manual sign-off
        y -= 8;
        const halfW = (W - 2 * M - 20) / 2;
        const pod = ds.pod || {};
        if (pod.by) { page.drawText(pod.by, { x: M, y: y + 2, size: 9, font: helveticaBold, color: black }); }
        if (pod.date || pod.time) { const dtStr = `${pod.date ? fd(pod.date) : ""}${pod.time ? "  " + pod.time : ""}`.trim(); page.drawText(dtStr, { x: M + halfW + 20, y: y + 2, size: 9, font: helveticaBold, color: black }); }
        page.drawLine({ start: { x: M, y: y }, end: { x: M + halfW, y: y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
        page.drawLine({ start: { x: M + halfW + 20, y: y }, end: { x: W - M, y: y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
        page.drawText(pod.by ? "Received by (POD)" : "Signature & name in print", { x: M, y: y - 9, size: 7, font: helvetica, color: gray });
        page.drawText("Date & Time", { x: M + halfW + 20, y: y - 9, size: 7, font: helvetica, color: gray });
        y -= 20;
      }
    }

    if (order.notes) {
      await ensureSpace(40);
      y -= 8;
      // Amber left-border notes box
      const noteLines = wrapLines(order.notes, W - 2 * M - 16, helvetica, 9);
      const boxH = 14 + noteLines.length * 12 + 8;
      page.drawRectangle({ x: M, y: y - boxH, width: 4, height: boxH, color: rgb(0.86, 0.15, 0.15) });
      page.drawRectangle({ x: M + 4, y: y - boxH, width: W - 2 * M - 4, height: boxH, color: rgb(0.98, 0.99, 1.0) });
      page.drawText("Information / Notes", { x: M + 12, y: y - 11, size: 8, font: helveticaBold, color: red });
      y -= 20;
      for (const ln of noteLines) {
        if (y < 70) {
          await ensureSpace(0);
          y -= 10;
          page.drawText("Notes (cont.):", { x: M + 12, y, size: 8, font: helveticaBold, color: red });
          y -= 14;
        }
        page.drawText(ln, { x: M + 12, y, size: 9, font: helvetica, color: black });
        y -= 12;
      }
      y -= 10;
    }
  }

  if (order.podBy) {
    y -= 16; // breathing room before POD box
    page.drawRectangle({ x: M, y: y - 50, width: W - 2 * M, height: 52, borderColor: rgb(0.13, 0.77, 0.37), borderWidth: 1.5 });
    page.drawText("PROOF OF DELIVERY", { x: M + 8, y: y - 14, size: 8, font: helveticaBold, color: rgb(0.13, 0.77, 0.37) });
    page.drawText(`Received by: ${order.podBy}`, { x: M + 8, y: y - 28, size: 9, font: helveticaBold, color: black });
    page.drawText(`Date: ${fd(order.podDate)}    Time: ${order.podTime || "—"}`, { x: M + 8, y: y - 40, size: 9, font: helvetica, color: black });
    y -= 60;
  }

  // ── PAPS/PARS Barcode Label (CBSA compliant) ──
  // 1mm = 2.835pt exact conversions
  if (order.stickerNum && order.customsType) {
    const isPaps = order.customsType === "PAPS";
    const barcodeData = order.stickerNum.replace(/\s/g, "");
    try {
      // CBSA spec: barcode height 0.95-1.60cm = 9.5-16mm
      // Using 12mm for PARS, 10mm for PAPS (within range)
      const bcHeightMm = isPaps ? 10 : 12;
      const bcPng = await bwipjs.toBuffer({
        bcid: "code128",
        text: barcodeData,
        scaleX: 2,
        scaleY: 2,
        height: bcHeightMm,
        includetext: false,
        backgroundcolor: "ffffff",
      });
      const bcImg = await pdfDoc.embedPng(bcPng);

      y -= 10;
      page.drawLine({ start: { x: M, y: y + 4 }, end: { x: W - M, y: y + 4 }, thickness: 0.5, color: rgb(0.9, 0.9, 0.9) });
      page.drawText(`CUSTOMS — ${order.customsType}`, { x: M, y: y - 8, size: 7, font: helveticaBold, color: gray });
      y -= 16;

      if (isPaps) {
        // PAPS: 63mm x 28mm
        const lbW = 63 * 2.835;   // 178.6pt
        const lbH = 28 * 2.835;   // 79.4pt
        const fcW = 17 * 2.835;   // 48.2pt FILER CODE box width
        const fcH = 11 * 2.835;   // 31.2pt FILER CODE box height
        const pad = 2.5 * 2.835;  // 7.1pt padding
        const bcH = bcHeightMm * 2.835; // barcode height in points
        const bcW = Math.min(lbW - 2 * pad, bcImg.width * (bcH / bcImg.height)); // scale proportionally

        page.drawRectangle({ x: M, y: y - lbH, width: lbW, height: lbH, borderColor: black, borderWidth: 1.5 });
        // FILER CODE box: top-right corner
        page.drawRectangle({ x: M + lbW - fcW, y: y - fcH, width: fcW, height: fcH, borderColor: black, borderWidth: 1.5 });
        page.drawText("FILER CODE", { x: M + lbW - fcW + 4, y: y - 8, size: 5, font: helveticaBold, color: black });
        // Company name: below FILER CODE line, left-aligned
        const compY = y - (5 * 2.835) - 14; // 5mm from top + offset
        page.drawText("DIAMOND BACK EXPRESS INC", { x: M + pad, y: compY, size: 6.5, font: helveticaBold, color: black });
        // PAPS number: large, left-aligned
        page.drawText(order.stickerNum, { x: M + pad, y: compY - 14, size: 14, font: helveticaBold, color: black });
        // Barcode: below number
        page.drawImage(bcImg, { x: M + pad, y: y - lbH + pad, width: bcW, height: bcH });
        y -= lbH + 8;
      } else {
        // PARS: 90mm x 30mm
        const lbW = 90 * 2.835;   // 255pt
        const lbH = 30 * 2.835;   // 85pt
        const pad = 4 * 2.835;    // 11.3pt side padding (quiet zone)
        const topGap = 3 * 2.835; // 8.5pt top gap (CBSA: min 3mm)
        const bcH = bcHeightMm * 2.835; // barcode height in points
        const bcW = Math.min(lbW - 2 * pad, bcImg.width * (bcH / bcImg.height));
        const gap = 1 * 2.835;    // 2.8pt gap between barcode and text

        page.drawRectangle({ x: M, y: y - lbH, width: lbW, height: lbH, borderColor: black, borderWidth: 1.5 });
        // Barcode: top of label with 3mm gap from edge
        const bcY = y - topGap - bcH;
        page.drawImage(bcImg, { x: M + pad, y: bcY, width: bcW, height: bcH });
        // Human readable: below barcode, left-aligned, min 0.25cm = 7pt
        const numY = bcY - gap - 12;
        page.drawText(order.stickerNum, { x: M + pad, y: numY, size: 12, font: helveticaBold, color: black });
        // Company name: below number
        page.drawText("DIAMOND BACK EXPRESS INC", { x: M + pad, y: numY - 12, size: 7, font: helveticaBold, color: black });
        y -= lbH + 8;
      }
    } catch (bcErr) {
      console.warn("Barcode generation failed:", bcErr.message);
      y -= 10;
      page.drawText(`${order.customsType}: ${order.stickerNum}`, { x: M, y, size: 11, font: helveticaBold, color: black });
      y -= 16;
    }
  }

  // ── Signature lines at bottom (transport, single-stop only — multi-stop has per-stop sign-offs) ──
  const _nP = (order.pickStops || []).length, _nD = (order.delStops || []).length;
  const _isMulti = _nP > 1 || _nD > 1;
  if (!isEvent && !_isMulti) {
    y = 80;
    page.drawLine({ start: { x: M, y }, end: { x: M + boxW, y }, thickness: 0.5, color: black });
    page.drawText("Signature and name in print", { x: M, y: y - 10, size: 7, font: helvetica, color: gray });
    page.drawLine({ start: { x: dx, y }, end: { x: dx + boxW, y }, thickness: 0.5, color: black });
    page.drawText("Date and Time", { x: dx, y: y - 10, size: 7, font: helvetica, color: gray });
  }

  return await pdfDoc.save();
}

// ═══ TAX MODES ═══
const TAX_MODES = [{ k: "NONE", pct: 0 }, { k: "HST", pct: 13 }, { k: "GST", pct: 5 }, { k: "CUSTOM", pct: 0 }];

// ═══ GENERATE INVOICE PDF ═══
async function generateInvoicePdf(order, pricing, isBolSummary = false, client = null) {
  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0); const gray = rgb(0.4, 0.4, 0.4); const red = rgb(0.86, 0.15, 0.15);
  const blue = rgb(0.05, 0.45, 0.78); const green = rgb(0.13, 0.77, 0.37);
  const W = 612; const M = 40;
  const fonts = { helvetica, helveticaBold };

  let p1 = pdfDoc.addPage([W, 792]);
  let y = await drawTopHeader(pdfDoc, p1, order, client, fonts, { title: isBolSummary ? "BOL SUMMARY" : "INVOICE REQUEST" });
  y -= 6;

  // Pagination: when content runs low, start a new page and redraw the header
  const ensureSpace = async (needed) => {
    if (y - needed < 70) {
      p1 = pdfDoc.addPage([W, 792]);
      y = await drawTopHeader(pdfDoc, p1, order, client, fonts, { title: (isBolSummary ? "BOL SUMMARY" : "INVOICE REQUEST") + " (cont.)" });
      y -= 6;
    }
  };

  const isEvent = order.orderType === "event";

  if (isEvent) {
    // ── Event pricing: transport + additional charges with per-line taxes ──
    if (pricing) {
      const cur = pricing.cur || "CAD";
      const sym = cur === "EUR" ? "€" : cur === "GBP" ? "£" : "$";

      const getLineTaxPct = (taxMode, taxCustom) =>
        taxMode === "HST" ? 13 : taxMode === "GST" ? 5 : taxMode === "CUSTOM" ? (parseFloat(taxCustom)||0) : 0;
      const getLineTaxLabel = (taxMode, taxCustom) =>
        taxMode === "HST" ? "HST 13%" : taxMode === "GST" ? "GST 5%" : taxMode === "CUSTOM" ? `Tax ${taxCustom||0}%` : "";

      const baseAmt = parseFloat(pricing.base) || 0;
      const fuelPct = parseFloat(pricing.fuelPct) || 0;
      const fuelAmt = baseAmt * (fuelPct / 100);
      const transportSub = baseAmt + fuelAmt;
      const transportTaxPct = getLineTaxPct(pricing.taxMode, pricing.taxCustom);
      const transportTaxLabel = getLineTaxLabel(pricing.taxMode, pricing.taxCustom);
      const transportTaxAmt = transportSub * (transportTaxPct / 100);
      const transportTotal = transportSub + transportTaxAmt;
      const hasTransport = baseAmt > 0;
      const transDesc = pricing.transDesc || "";

      const eventLines = (pricing.eventLines || []).filter(l => l.desc);
      const linesCalc = eventLines.map(l => {
        const lb = (parseFloat(l.qty)||0) * (parseFloat(l.unitPrice)||0);
        const ltp = getLineTaxPct(l.taxMode, l.taxCustom);
        const lta = lb * (ltp / 100);
        return { ...l, lb, lta, ltot: lb + lta, ltaxLabel: getLineTaxLabel(l.taxMode, l.taxCustom) };
      });
      const hasLines = linesCalc.length > 0;
      const linesTotal = linesCalc.reduce((s, l) => s + l.ltot, 0);
      const grandTotal = (hasTransport ? transportTotal : 0) + (hasLines ? linesTotal : 0);

      const pl = (label, amount, bold, clr) => {
        p1.drawText(label, { x: M + 10, y, size: bold ? 10 : 9, font: bold ? helveticaBold : helvetica, color: clr || black });
        const a = `${sym}${amount.toFixed(2)} ${cur}`;
        p1.drawText(a, { x: W - M - 10 - (bold ? helveticaBold : helvetica).widthOfTextAtSize(a, bold ? 10 : 9), y, size: bold ? 10 : 9, font: bold ? helveticaBold : helvetica, color: clr || (bold ? red : black) });
        y -= 14;
      };

      // Transport section
      if (hasTransport) {
        y -= 8;
        p1.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 2, color: rgb(0.85, 0.87, 0.9) }); y -= 18;
        p1.drawText("TRANSPORT CHARGE", { x: M, y, size: 9, font: helveticaBold, color: gray }); y -= 14;
        if (transDesc) {
          pl(transDesc, baseAmt, false);
        } else {
          pl("Base Price", baseAmt, false);
        }
        if (fuelPct > 0) pl(`Fuel Surcharge (${fuelPct}%)`, fuelAmt, false);
        if (transportTaxAmt > 0) pl(transportTaxLabel, transportTaxAmt, false);
        if (hasLines) {
          p1.drawRectangle({ x: M + 10, y: y + 10, width: W - 2 * M - 20, height: 1, color: rgb(0.9, 0.9, 0.9) });
          const subStr = `${sym}${transportTotal.toFixed(2)} ${cur}`;
          p1.drawText(`Transport Subtotal: ${subStr}`, { x: W - M - 10 - helvetica.widthOfTextAtSize(`Transport Subtotal: ${subStr}`, 9), y, size: 9, font: helvetica, color: gray }); y -= 14;
        }
      }

      // Additional charges
      if (hasLines) {
        y -= 8;
        await ensureSpace(40);
        p1.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 2, color: rgb(0.85, 0.87, 0.9) }); y -= 18;
        p1.drawText("ADDITIONAL CHARGES", { x: M, y, size: 9, font: helveticaBold, color: gray }); y -= 6;
        const drawColHeaders = () => {
          p1.drawRectangle({ x: M, y: y - 14, width: W - 2 * M, height: 16, color: rgb(0.93, 0.94, 0.97) });
          p1.drawText("DESCRIPTION", { x: M + 6, y: y - 10, size: 7, font: helveticaBold, color: gray });
          p1.drawText("QTY", { x: M + 270, y: y - 10, size: 7, font: helveticaBold, color: gray });
          p1.drawText("UNIT PRICE", { x: M + 330, y: y - 10, size: 7, font: helveticaBold, color: gray });
          p1.drawText("TAX", { x: M + 405, y: y - 10, size: 7, font: helveticaBold, color: gray });
          p1.drawText("AMOUNT", { x: W - M - 55, y: y - 10, size: 7, font: helveticaBold, color: gray });
          y -= 18;
        };
        drawColHeaders();
        for (const line of linesCalc) {
          // Wrap description to fit available width (DESCRIPTION column ends at QTY = M+270)
          const descMaxWidth = 250; // M+6 to ~M+260 with safety padding
          const descLines = wrapLines(String(line.desc), descMaxWidth, helvetica, 9);
          const rowHeight = Math.max(18, descLines.length * 12 + 6);

          if (y - rowHeight < 70) { await ensureSpace(0); drawColHeaders(); }

          // Description (potentially multi-line)
          for (let i = 0; i < descLines.length; i++) {
            p1.drawText(descLines[i], { x: M + 6, y: y - 10 - (i * 12), size: 9, font: helvetica, color: black });
          }
          // Other columns on first line only
          p1.drawText(String(parseFloat(line.qty)||0), { x: M + 270, y: y - 10, size: 9, font: helvetica, color: black });
          p1.drawText(`${sym}${(parseFloat(line.unitPrice)||0).toFixed(2)}`, { x: M + 330, y: y - 10, size: 9, font: helvetica, color: black });
          p1.drawText(line.ltaxLabel || "—", { x: M + 405, y: y - 10, size: 8, font: helvetica, color: gray });
          const amtStr = `${sym}${line.ltot.toFixed(2)}`;
          p1.drawText(amtStr, { x: W - M - 6 - helveticaBold.widthOfTextAtSize(amtStr, 9), y: y - 10, size: 9, font: helveticaBold, color: black });
          p1.drawLine({ start: { x: M, y: y - rowHeight + 4 }, end: { x: W - M, y: y - rowHeight + 4 }, thickness: 0.5, color: rgb(0.9, 0.9, 0.9) });
          y -= rowHeight;
        }
        y -= 4;
      }

      // Grand Total
      await ensureSpace(30);
      y -= 4;
      p1.drawRectangle({ x: M, y: y - 18, width: W - 2 * M, height: 20, color: rgb(0.95, 0.96, 0.98) });
      p1.drawText(`TOTAL ${cur}`, { x: M + 6, y: y - 13, size: 10, font: helveticaBold, color: red });
      const totalStr = `${sym}${grandTotal.toFixed(2)} ${cur}`;
      p1.drawText(totalStr, { x: W - M - 6 - helveticaBold.widthOfTextAtSize(totalStr, 11), y: y - 13, size: 11, font: helveticaBold, color: red });
      y -= 28;

      if (order.poNumber) {
        p1.drawText(`PO #: ${order.poNumber}`, { x: M, y, size: 9, font: helveticaBold, color: black });
        y -= 14;
      }
    }
  } else {
    // ── Multi-stop detection: pricing lives per-stop on the multi side ──
    const nPick = (order.pickStops || []).length, nDel = (order.delStops || []).length;
    const isMultiStop = nPick > 1 || nDel > 1;
    if (isMultiStop) {
      const cur = (pricing && pricing.cur) || "CAD";
      const sym = cur === "EUR" ? "€" : cur === "GBP" ? "£" : "$";
      const priceSide = nDel >= nPick ? "delStops" : "pickStops";
      const stops = order[priceSide] || [];
      const sideLabel = priceSide === "delStops" ? "DELIVERY" : "PICKUP";
      const calcStop = (pr) => {
        pr = pr || {};
        const b = parseFloat(pr.base) || 0, f = pr.fuelModel === "liter" ? (parseFloat(pr.fuelAmt) || 0) : (b * ((parseFloat(pr.fuelPct) || 0) / 100)), sub = b + f;
        const oc = (c) => { const lt = c.taxMode === "HST" ? 13 : c.taxMode === "GST" ? 5 : c.taxMode === "CUSTOM" ? (parseFloat(c.taxCustom) || 0) : 0; const lb = (c.qty !== undefined || c.unitPrice !== undefined) ? (parseFloat(c.qty) || 0) * (parseFloat(c.unitPrice) || 0) : (parseFloat(c.amt) || 0); return { lb, lt: lb * (lt / 100), ltp: lt }; };
        const others = (pr.other || []).filter(c => c.desc || c.amt || c.unitPrice || c.qty);
        const ob = others.reduce((s, c) => s + oc(c).lb, 0), ot = others.reduce((s, c) => s + oc(c).lt, 0);
        const tp = pr.taxMode === "CUSTOM" ? (parseFloat(pr.taxCustom) || 0) : pr.taxMode === "HST" ? 13 : pr.taxMode === "GST" ? 5 : 0;
        const tx = (!pr.taxMode || pr.taxMode === "NONE") ? 0 : sub * (tp / 100);
        return { b, f, others, oc, ob, ot, tp, tx, total: sub + tx + ob + ot };
      };
      const pl = (label, amount, x0, bold, clr) => { p1.drawText(label, { x: x0, y, size: bold ? 10 : 9, font: bold ? helveticaBold : helvetica, color: clr || black }); const a = `${sym}${amount.toFixed(2)} ${cur}`; p1.drawText(a, { x: W - M - 10 - (bold ? helveticaBold : helvetica).widthOfTextAtSize(a, bold ? 10 : 9), y, size: bold ? 10 : 9, font: bold ? helveticaBold : helvetica, color: clr || (bold ? red : black) }); y -= 14; };

      y -= 10; p1.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 2, color: red }); y -= 18;
      p1.drawText("PRICING — PER STOP", { x: M, y, size: 12, font: helveticaBold, color: red }); y -= 18;

      let grandTotal = 0;
      for (let i = 0; i < stops.length; i++) {
        const st = stops[i];
        const c = calcStop(st.price);
        if (c.total <= 0 && !(st.price && (parseFloat(st.price.base) > 0))) continue;
        grandTotal += c.total;
        const _ai = (st.items || []).filter(it => it.desc || it.pcs || it.wt).length;
        const _aa = String(st.addr || "").split("\n").length;
        await ensureSpace(70 + _ai * 11 + _aa * 8);
        // Stop header bar
        p1.drawRectangle({ x: M, y: y - 14, width: W - 2 * M, height: 16, color: rgb(0.93, 0.94, 0.97) });
        const stopTitle = `${sideLabel} ${i + 1}${st.co ? " — " + st.co : ""}`;
        p1.drawText(stopTitle, { x: M + 6, y: y - 10, size: 8, font: helveticaBold, color: gray });
        const stStr = `${sym}${c.total.toFixed(2)} ${cur}`;
        p1.drawText(stStr, { x: W - M - 6 - helveticaBold.widthOfTextAtSize(stStr, 8), y: y - 10, size: 8, font: helveticaBold, color: black });
        y -= 22;
        // Stop address + items detail (so accounting sees what each stop covers)
        if (st.addr) { y = drawWrapped(p1, st.addr, M + 10, y, (W - 2 * M) / 2, helvetica, 8, gray); y -= 2; }
        const stItems = (st.items || []).filter(it => it.desc || it.pcs || it.wt);
        if (stItems.length > 0) {
          for (const it of stItems) {
            const parts = [];
            if (it.pcs) parts.push(`${it.pcs} pcs`);
            if (it.desc) parts.push(it.desc);
            if (it.wt) parts.push(`${it.wt} ${it.wUnit || "lbs"}`);
            if (it.l || it.w || it.h) parts.push(`${it.l || "?"}×${it.w || "?"}×${it.h || "?"} ${it.dUnit || "in"}`);
            p1.drawText("• " + parts.join(" — "), { x: M + 12, y, size: 8, font: helvetica, color: gray }); y -= 11;
          }
          y -= 2;
        }
        const stopTransDesc = (st.price && st.price.transDesc) ? st.price.transDesc : "";
        pl(stopTransDesc || "Base Price", c.b, M + 10, false);
        if (c.f > 0) {
          const fuelLabel = (st.price && st.price.fuelModel === "liter")
            ? `Fuel (${st.price.liters || "?"}L)`
            : `Fuel Surcharge (${parseFloat(st.price.fuelPct) || 0}%)`;
          pl(fuelLabel, c.f, M + 10, false);
        }
        if (c.tx > 0) pl(`Tax on Base (${c.tp}% ${st.price.taxMode})`, c.tx, M + 10, false);
        for (const oc of c.others) {
          const cc = c.oc(oc);
          const hasQty = (oc.qty !== undefined && oc.qty !== "") || (oc.unitPrice !== undefined && oc.unitPrice !== "");
          const lbl = (oc.desc || "Charge") + (hasQty ? ` (${parseFloat(oc.qty) || 0} × ${sym}${(parseFloat(oc.unitPrice) || 0).toFixed(2)})` : "");
          pl(lbl, cc.lb, M + 10, false);
          if (cc.lt > 0) { p1.drawText(`   Tax (${cc.ltp}%)`, { x: M + 14, y, size: 8, font: helvetica, color: gray }); const ta = `${sym}${cc.lt.toFixed(2)} ${cur}`; p1.drawText(ta, { x: W - M - 10 - helvetica.widthOfTextAtSize(ta, 8), y, size: 8, font: helvetica, color: gray }); y -= 12; }
        }
        y -= 6;
      }
      // Order grand total
      await ensureSpace(30);
      y -= 4;
      p1.drawRectangle({ x: M, y: y - 18, width: W - 2 * M, height: 20, color: rgb(0.95, 0.96, 0.98) });
      p1.drawText(`ORDER TOTAL ${cur}`, { x: M + 6, y: y - 13, size: 10, font: helveticaBold, color: red });
      const gStr = `${sym}${grandTotal.toFixed(2)} ${cur}`;
      p1.drawText(gStr, { x: W - M - 6 - helveticaBold.widthOfTextAtSize(gStr, 11), y: y - 13, size: 11, font: helveticaBold, color: red });
      y -= 28;
      if (order.poNumber) { p1.drawText(`PO #: ${order.poNumber}`, { x: M, y, size: 9, font: helveticaBold, color: black }); y -= 14; }
    } else {
    // ── Transport order: pickup/delivery boxes ──
    const boxW = (W - 2 * M - 12) / 2; const boxH = 100;
    p1.drawRectangle({ x: M, y: y - boxH, width: boxW, height: boxH, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 1 });
    p1.drawText("PICK UP", { x: M + 6, y: y - 12, size: 8, font: helveticaBold, color: gray });
    if (order.pickDate) { const pd = fd(order.pickDate); p1.drawText(pd, { x: M + boxW - 6 - helveticaBold.widthOfTextAtSize(pd, 9), y: y - 12, size: 9, font: helveticaBold, color: black }); }
    let py2 = y - 26;
    if (order.pickCo) { p1.drawText(order.pickCo, { x: M + 6, y: py2, size: 9, font: helveticaBold, color: black }); py2 -= 12; }
    drawWrapped(p1, order.pickAddr || "—", M + 6, py2, boxW - 12, helvetica, 8, black);
    const dx2 = M + boxW + 12;
    p1.drawRectangle({ x: dx2, y: y - boxH, width: boxW, height: boxH, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 1 });
    p1.drawText("DELIVERY", { x: dx2 + 6, y: y - 12, size: 8, font: helveticaBold, color: gray });
    if (order.delDate) { const dd = fd(order.delDate); p1.drawText(dd, { x: dx2 + boxW - 6 - helveticaBold.widthOfTextAtSize(dd, 9), y: y - 12, size: 9, font: helveticaBold, color: black }); }
    let dy2 = y - 26;
    if (order.delCo) { p1.drawText(order.delCo, { x: dx2 + 6, y: dy2, size: 9, font: helveticaBold, color: black }); dy2 -= 12; }
    drawWrapped(p1, order.delAddr || "—", dx2 + 6, dy2, boxW - 12, helvetica, 8, black);
    y = y - boxH - 14;
    const items = (order.items || []).filter(i => i.desc);
    if (items.length > 0) {
      p1.drawRectangle({ x: M, y: y - 14, width: W - 2 * M, height: 16, color: rgb(0.95, 0.96, 0.98) });
      [{ l: "Pces", x: M + 4 }, { l: "Description", x: M + 50 }, { l: "Weight", x: M + 260 }, { l: "Length", x: M + 350 }, { l: "Width", x: M + 405 }, { l: "Height", x: M + 460 }].forEach(c => p1.drawText(c.l, { x: c.x, y: y - 10, size: 7, font: helveticaBold, color: gray }));
      y -= 18;
      for (const item of items) {
        p1.drawText(String(item.pcs || "—"), { x: M + 4, y: y - 10, size: 9, font: helvetica, color: black });
        const descEnd = drawWrapped(p1, String(item.desc || "—"), M + 50, y - 7, 240, helvetica, 9, black);
        const rowBottom = Math.min(y - 18, descEnd - 6);
        p1.drawText(`${item.wt || "—"} ${item.wUnit || ""}`, { x: M + 260, y: y - 10, size: 9, font: helvetica, color: black });
        p1.drawText(String(item.l || "—"), { x: M + 350, y: y - 10, size: 9, font: helvetica, color: black });
        p1.drawText(String(item.w || "—"), { x: M + 405, y: y - 10, size: 9, font: helvetica, color: black });
        p1.drawText(String(item.h || "—"), { x: M + 460, y: y - 10, size: 9, font: helvetica, color: black });
        p1.drawLine({ start: { x: M, y: y - 14 }, end: { x: W - M, y: y - 14 }, thickness: 0.5, color: rgb(0.9, 0.9, 0.9) });
        y -= 18;
      }
      y -= 6;
    }
    // ── Pricing (transport orders) ──
    if (pricing && pricing.base) {
      const cur = pricing.cur || "CAD";
      const sym = cur === "EUR" ? "€" : cur === "GBP" ? "£" : "$";
      const baseAmt = parseFloat(pricing.base) || 0;
      const fuelPct = parseFloat(pricing.fuelPct) || 0;
      const fuelAmt = baseAmt * (fuelPct / 100);
      const subtotal = baseAmt + fuelAmt;
      const others = (pricing.other || []).filter(c => c.desc || c.amt || c.unitPrice || c.qty);
      const ocCalc = (c) => {
        const ltp = c.taxMode === "HST" ? 13 : c.taxMode === "GST" ? 5 : c.taxMode === "CUSTOM" ? (parseFloat(c.taxCustom) || 0) : 0;
        const lbase = (c.qty !== undefined || c.unitPrice !== undefined) ? (parseFloat(c.qty) || 0) * (parseFloat(c.unitPrice) || 0) : (parseFloat(c.amt) || 0);
        const ltax = lbase * (ltp / 100);
        return { ltp, lbase, ltax, ltot: lbase + ltax };
      };
      const otherBaseTotal = others.reduce((s, c) => s + ocCalc(c).lbase, 0);
      const otherTaxTotal = others.reduce((s, c) => s + ocCalc(c).ltax, 0);
      const tm = TAX_MODES.find(t => t.k === pricing.taxMode) || TAX_MODES[0];
      const taxPct = pricing.taxMode === "CUSTOM" ? (parseFloat(pricing.taxCustom) || 0) : tm.pct;
      const taxAmt = pricing.taxMode === "NONE" ? 0 : subtotal * (taxPct / 100);
      const total = subtotal + taxAmt + otherBaseTotal + otherTaxTotal;
      y -= 10; p1.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 2, color: red }); y -= 18;
      p1.drawText("PRICING", { x: M, y, size: 12, font: helveticaBold, color: red }); y -= 6;
      const transDesc = pricing.transDesc || "";
      const pl = (label, amount, bold) => { y -= 14; p1.drawText(label, { x: M + 10, y, size: bold ? 10 : 9, font: bold ? helveticaBold : helvetica, color: black }); const a = `${sym}${amount.toFixed(2)} ${cur}`; p1.drawText(a, { x: W - M - 10 - (bold ? helveticaBold : helvetica).widthOfTextAtSize(a, bold ? 10 : 9), y, size: bold ? 10 : 9, font: bold ? helveticaBold : helvetica, color: bold ? red : black }); };
      if (transDesc) {
        pl(transDesc, baseAmt, false);
      } else {
        pl("Base Price", baseAmt, false);
      }
      if (fuelPct > 0) pl(`Fuel Surcharge (${fuelPct}%)`, fuelAmt, false);
      if (pricing.taxMode !== "NONE" && taxAmt > 0) pl(`Tax on Base (${taxPct}% ${pricing.taxMode})`, taxAmt, false);
      for (const oc of others) {
        const c = ocCalc(oc);
        const hasQty = (oc.qty !== undefined && oc.qty !== "") || (oc.unitPrice !== undefined && oc.unitPrice !== "");
        const lbl = (oc.desc || "Charge") + (hasQty ? ` (${parseFloat(oc.qty)||0} × ${sym}${(parseFloat(oc.unitPrice)||0).toFixed(2)})` : "");
        pl(lbl, c.lbase, false);
        if (c.ltax > 0) { y -= 12; const tl = `   Tax (${c.ltp}%)`; p1.drawText(tl, { x: M + 14, y, size: 8, font: helvetica, color: gray }); const ta = `${sym}${c.ltax.toFixed(2)} ${cur}`; p1.drawText(ta, { x: W - M - 10 - helvetica.widthOfTextAtSize(ta, 8), y, size: 8, font: helvetica, color: gray }); }
      }
      y -= 6; p1.drawRectangle({ x: M + 10, y: y + 2, width: W - 2 * M - 20, height: 1, color: gray });
      pl("TOTAL", total, true);
      y -= 16; // breathing room after TOTAL before next section
    }
    }
  }

  // ── Notes (both order types) — paginated line by line ──
  if (order.notes) {
    await ensureSpace(40);
    y -= 10; p1.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 1, color: rgb(0.9, 0.91, 0.92) }); y -= 14;
    p1.drawText("Notes:", { x: M, y, size: 9, font: helveticaBold, color: gray }); y -= 13;
    const noteLines = wrapLines(order.notes, W - 2 * M, helvetica, 9);
    for (const ln of noteLines) {
      if (y < 70) {
        await ensureSpace(0);
        y -= 10;
        p1.drawText("Notes (cont.):", { x: M, y, size: 9, font: helveticaBold, color: gray }); y -= 13;
      }
      p1.drawText(ln, { x: M, y, size: 9, font: helvetica, color: black });
      y -= 12;
    }
    y -= 10;
  }

  // ── POD (both order types) ──
  if (order.podBy) {
    y -= 16;
    p1.drawRectangle({ x: M, y: y - 46, width: W - 2 * M, height: 48, borderColor: green, borderWidth: 1.5 });
    p1.drawText("PROOF OF DELIVERY", { x: M + 8, y: y - 14, size: 8, font: helveticaBold, color: green });
    p1.drawText(`Received by: ${order.podBy}`, { x: M + 8, y: y - 28, size: 9, font: helveticaBold, color: black });
    p1.drawText(`Date: ${fd(order.podDate)}    Time: ${order.podTime || "—"}`, { x: M + 8, y: y - 40, size: 9, font: helvetica, color: black });
    y -= 56;
  }

  // ── Signature lines at bottom (transport orders only) ──
  const boxW2 = (W - 2 * M - 12) / 2;
  const dx3 = M + boxW2 + 12;
  if (!isEvent) {
    const sigY = 80;
    p1.drawLine({ start: { x: M, y: sigY }, end: { x: M + boxW2, y: sigY }, thickness: 0.5, color: black });
    p1.drawText("Signature and name in print", { x: M, y: sigY - 10, size: 7, font: helvetica, color: gray });
    p1.drawLine({ start: { x: dx3, y: sigY }, end: { x: dx3 + boxW2, y: sigY }, thickness: 0.5, color: black });
    p1.drawText("Date and Time", { x: dx3, y: sigY - 10, size: 7, font: helvetica, color: gray });
  }

  p1.drawText("Diamond Back Express Inc. — DBX Dispatch", { x: M, y: 30, size: 7, font: helvetica, color: gray });
  return await pdfDoc.save();
}

// ═══ BUILD BOL HTML — same layout as dispatch UI (clean white format) ═══
const LOGO_URL = "https://firebasestorage.googleapis.com/v0/b/dbx-prod.firebasestorage.app/o/assets%2Fdbx%20logo.jpg?alt=media&token=d8372047-6d1d-470a-9f72-7352cfa4d410";
const CA_DIV = { name:"Diamond Back Express Canada", addr:"4515 Ebenezer Rd Unit 212\nBrampton, Ontario, L6P 2K7" };
const US_DIV = { name:"Diamond Back Express LLC",    addr:"Suite 400-K-175, 1110 Brickell Ave\nMiami, FL 33131" };
const DIVS_CF = [CA_DIV, US_DIV];

function fdCF(d) { return d ? new Date(d+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "—"; }

function buildBolHtmlCF(o, includePod=false, includePricing=false, client=null) {
  const isEvent = o.orderType === "event";
  const drv = { drvName:o.drvName, trkUnit:o.trkUnit, trkPlate:o.trkPlate, trlUnit:o.trlUnit, trlPlate:o.trlPlate };
  const billingDiv = DIVS_CF.find(d=>d.id===o.divId) || DIVS_CF[0];
  const safeRef = typeof o.ref === "string" ? o.ref : (o.ref?.value || "");
  const p = o.price||{}; const sym = ({CAD:"$",USD:"$",EUR:"€",GBP:"£"})[p.cur||"CAD"]||"$";
  const items = (o.items||[]).filter(i=>i.desc||i.pcs||i.wt);
  const itemRows = items.map(i=>`<tr>
    <td style="padding:8px 10px;font-size:12px;border-bottom:1px solid #e2e8f0">${i.pcs||"—"}</td>
    <td style="padding:8px 10px;font-size:12px;border-bottom:1px solid #e2e8f0">${i.desc||"—"}</td>
    <td style="padding:8px 10px;font-size:12px;border-bottom:1px solid #e2e8f0">${i.wt||"—"} ${i.wUnit||""}</td>
    <td style="padding:8px 10px;font-size:12px;border-bottom:1px solid #e2e8f0">${i.l||"—"}</td>
    <td style="padding:8px 10px;font-size:12px;border-bottom:1px solid #e2e8f0">${i.w||"—"}</td>
    <td style="padding:8px 10px;font-size:12px;border-bottom:1px solid #e2e8f0">${i.h||"—"}</td>
  </tr>`).join("");
  const podSection = (o.podBy&&includePod) ? `<div style="border:2px solid #22c55e;border-radius:8px;padding:14px;margin-top:20px;margin-bottom:16px"><div style="font-weight:700;font-size:11px;color:#22c55e;text-transform:uppercase;margin-bottom:6px">Proof of Delivery</div><div style="font-size:13px;line-height:1.6">Received by: <strong>${o.podBy}</strong><br>Date: ${fdCF(o.podDate)}<br>Time: ${o.podTime||"—"}</div></div>` : "";

  // Pricing
  const resolveLineTax = (taxMode,taxCustom) => ({ pct: taxMode==="HST"?13:taxMode==="GST"?5:taxMode==="CUSTOM"?(parseFloat(taxCustom)||0):0, label: taxMode==="HST"?"HST (13%)":taxMode==="GST"?"GST (5%)":taxMode==="CUSTOM"?`Tax (${taxCustom||0}%)`:null });
  const eventLines = (p.eventLines||[]).filter(l=>l.desc||parseFloat(l.unitPrice)>0);
  const th=`padding:6px 8px;text-align:left;font-size:10px;text-transform:uppercase;font-weight:700;background:#f1f5f9`;
  const thR=`${th};text-align:right`;
  const td=`padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12px`;
  const tdR=`${td};text-align:right`;

  let eventPricingSection = "";
  if (isEvent && includePricing) {
    const baseAmt2=parseFloat(p.base)||0, fuelPct2=parseFloat(p.fuelPct)||0, fuelAmt2=baseAmt2*(fuelPct2/100);
    const transTax=resolveLineTax(p.taxMode,p.taxCustom), transTaxAmt=(baseAmt2+fuelAmt2)*(transTax.pct/100);
    const transTotal=baseAmt2+fuelAmt2+transTaxAmt, hasTransport=baseAmt2>0;
    const linesCalc=eventLines.map(l=>{const lb=(parseFloat(l.qty)||0)*(parseFloat(l.unitPrice)||0),lt=resolveLineTax(l.taxMode,l.taxCustom),lta=lb*(lt.pct/100);return{...l,lb,lta,ltot:lb+lta,lt};});
    const hasLines=linesCalc.length>0, grandTotal=(hasTransport?transTotal:0)+linesCalc.reduce((s,l)=>s+l.ltot,0);
    if (hasTransport||hasLines) {
      eventPricingSection=`<div style="margin-bottom:16px">`;
      if(hasTransport) eventPricingSection+=`<table style="width:100%;border-collapse:collapse;margin-bottom:8px"><thead><tr><th style="${th}">Transport</th><th style="${thR}">Amount</th></tr></thead><tbody><tr><td style="${td}">Base Price</td><td style="${tdR};font-weight:600">${sym}${baseAmt2.toFixed(2)}</td></tr>${fuelAmt2>0?`<tr><td style="${td}">Fuel Surcharge (${fuelPct2}%)</td><td style="${tdR}">${sym}${fuelAmt2.toFixed(2)}</td></tr>`:""}${transTaxAmt>0?`<tr><td style="${td}">${transTax.label}</td><td style="${tdR}">${sym}${transTaxAmt.toFixed(2)}</td></tr>`:""}</tbody></table>`;
      if(hasLines) eventPricingSection+=`<table style="width:100%;border-collapse:collapse"><thead><tr><th style="${th}">Additional Charges</th><th style="${thR}">Qty</th><th style="${thR}">Unit Price</th><th style="${thR}">Tax</th><th style="${thR}">Amount</th></tr></thead><tbody>${linesCalc.map(l=>`<tr><td style="${td}">${l.desc||"Charge"}</td><td style="${tdR}">${l.qty}</td><td style="${tdR}">${sym}${parseFloat(l.unitPrice).toFixed(2)}</td><td style="${tdR};font-size:10px;color:#888">${l.lt.label||"—"}</td><td style="${tdR};font-weight:600">${sym}${l.ltot.toFixed(2)}</td></tr>`).join("")}</tbody></table>`;
      eventPricingSection+=`<div style="display:flex;justify-content:space-between;padding:10px 8px;background:#f8fafc;border-top:2px solid #e2e8f0;margin-top:4px"><span style="font-weight:700;color:#dc2626;text-transform:uppercase;font-size:12px">Total ${p.cur||"CAD"}</span><span style="font-weight:700;font-size:15px;color:#dc2626">${sym}${grandTotal.toFixed(2)} ${p.cur||"CAD"}</span></div></div>`;
    }
  }

  const baseAmt=parseFloat(p.base)||0, fuelPct=parseFloat(p.fuelPct)||0, fuelAmt=baseAmt*(fuelPct/100), taxPct=p.taxMode==="HST"?13:p.taxMode==="GST"?5:p.taxMode==="CUSTOM"?(parseFloat(p.taxCustom)||0):0, taxAmt=(baseAmt+fuelAmt)*(taxPct/100);
  const otherTotal=(p.other||[]).reduce((s,c)=>{const lb=(c.qty!==undefined&&c.unitPrice!==undefined)?(parseFloat(c.qty)||0)*(parseFloat(c.unitPrice)||0):(parseFloat(c.amt)||0);const lt=(c.taxMode==="HST"?13:c.taxMode==="GST"?5:c.taxMode==="CUSTOM"?(parseFloat(c.taxCustom)||0):0);return s+lb+lb*(lt/100);},0);
  const total=baseAmt+fuelAmt+taxAmt+otherTotal;
  const pricingSection = (!isEvent&&includePricing&&p.base&&parseFloat(p.base)>0) ? `<div style="border:2px solid #dc2626;border-radius:8px;padding:14px;margin-bottom:16px"><div style="font-weight:700;font-size:11px;color:#dc2626;text-transform:uppercase;margin-bottom:10px">Pricing (${p.cur||"CAD"})</div><table style="width:100%;font-size:12px;border-collapse:collapse"><tr><td style="padding:3px 0;color:#666">Base Price</td><td style="text-align:right;font-weight:600">${sym}${baseAmt.toFixed(2)}</td></tr>${fuelAmt>0?`<tr><td style="padding:3px 0;color:#666">Fuel Surcharge (${fuelPct}%)</td><td style="text-align:right">${sym}${fuelAmt.toFixed(2)}</td></tr>`:""}${taxAmt>0?`<tr><td style="padding:3px 0;color:#666">Tax (${taxPct}%)</td><td style="text-align:right">${sym}${taxAmt.toFixed(2)}</td></tr>`:""}<tr style="border-top:1.5px solid #cbd5e1"><td style="padding:6px 0 0;font-weight:700;font-size:14px">Total</td><td style="text-align:right;font-weight:700;font-size:14px">${sym}${total.toFixed(2)} ${p.cur||"CAD"}</td></tr></table></div>` : "";

  const picks = o.pickStops || [{co:o.pickCo||"",addr:o.pickAddr||"",date:o.pickDate||"",contact:o.pickContact||"",phone:o.pickPhone||"",notes:o.pickNotes||""}];
  const dels = o.delStops || [{co:o.delCo||"",addr:o.delAddr||"",date:o.delDate||"",contact:o.delContact||"",phone:o.delPhone||"",notes:o.delNotes||""}];
  const stopRows = !isEvent ? Array.from({length:Math.max(picks.length,dels.length)},(_,i)=>{
    const pk=picks[i], dl=dels[i];
    const pLabel=picks.length>1?`Pick Up — Stop ${i+1}`:"Pick Up";
    const dLabel=dels.length>1?`Delivery — Stop ${i+1}`:"Delivery";
    const stopBox=(label,s)=>s?`<div style="border:1.5px solid #cbd5e1;border-radius:8px;padding:14px;min-height:80px;background:#f8fafc">
      <div style="font-weight:700;font-size:10px;text-transform:uppercase;color:#94a3b8;margin-bottom:6px;letter-spacing:0.5px">${label}${s.date?` <span style="color:#000;font-size:13px;font-weight:700;text-transform:none;letter-spacing:0">— ${fdCF(s.date)}</span>`:""}</div>
      ${s.co?`<div style="font-weight:700;font-size:14px;margin-bottom:3px">${s.co}</div>`:""}
      <div style="font-size:12px;line-height:1.6;color:#334155">${(s.addr||"—").replace(/\n/g,"<br>")}</div>
      ${s.contact?`<div style="font-size:11px;color:#475569;margin-top:5px">👤 ${s.contact}${s.phone?` · 📞 ${s.phone}`:""}</div>`:s.phone?`<div style="font-size:11px;color:#475569;margin-top:5px">📞 ${s.phone}</div>`:""}
      ${s.notes?`<div style="font-size:11px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:4px;padding:5px 8px;margin-top:6px;line-height:1.5;white-space:pre-wrap">📌 ${s.notes}</div>`:""}
    </div>` : `<div></div>`;
    return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:10px">${stopBox(pLabel,pk)}${stopBox(dLabel,dl)}</div>`;
  }).join("") : "";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @media print { .no-print{display:none!important} body{margin:0} }
    body{font-family:'Helvetica Neue',Arial,sans-serif;color:#000;margin:0;padding:24px;background:#fff}
  </style></head><body>
<div style="max-width:800px;margin:0 auto">
  <div style="display:grid;grid-template-columns:auto 1fr 1fr;gap:20px;align-items:center;border-bottom:2px solid #dc2626;padding-bottom:14px;margin-bottom:0">
    <img src="${LOGO_URL}" style="height:56px;object-fit:contain" alt="DBX">
    <div style="text-align:center;font-size:10px;line-height:1.7;color:#444"><b style="font-size:11px;color:#000">${CA_DIV.name}</b><br>${CA_DIV.addr.replace(/\n/g,"<br>")}</div>
    <div style="text-align:right;font-size:10px;line-height:1.7;color:#444"><b style="font-size:11px;color:#000">${US_DIV.name}</b><br>${US_DIV.addr.replace(/\n/g,"<br>")}</div>
  </div>
  <div style="display:flex;justify-content:space-between;align-items:flex-start;background:#f8fafc;border:1.5px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:20px 18px 14px;margin-bottom:18px">
    <div>
      ${isEvent?`<div style="font-size:10px;font-weight:700;color:#dc2626;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px">${includePricing?"INVOICE REQUEST":"BOL SUMMARY"}</div>`:""}
      <div style="font-size:30px;font-weight:900;letter-spacing:-1px;color:#dc2626;line-height:1">BOL ${o.bol}</div>
      ${isEvent&&o.eventName?`<div style="font-size:15px;font-weight:700;color:#111;margin-top:4px">${o.eventName}</div>`:""}
      <div style="color:#555;font-size:12px;margin-top:6px">Bill to: <strong style="color:#000">${o.billTo||o.cliName||"DBX"}</strong></div>
      ${client?`${[client.street,[client.city,client.provState].filter(Boolean).join(", "),client.postalZip,client.country].filter(Boolean).map(l=>`<div style="font-size:11px;color:#555">${l}</div>`).join("")}${client.email?`<div style="font-size:11px;color:#555">${client.email}</div>`:""}`:""}
      ${isEvent&&(o.pickCo||o.pickAddr)?`<div style="font-size:11px;color:#555;margin-top:6px"><strong>Location:</strong> ${o.pickCo||""}</div>${o.pickAddr?`<div style="font-size:11px;color:#555;white-space:pre-line">${o.pickAddr}</div>`:""}`:""}
    </div>
    <div style="text-align:right;font-size:12px;line-height:2;color:#333">
      <div><span style="font-weight:700;color:#dc2626">Date:</span> ${fdCF(o.reqDate||o.pickDate)}</div>
      ${safeRef?`<div><span style="font-weight:700;color:#dc2626">Ref:</span> ${safeRef}</div>`:""}
      ${o.poNumber?`<div><span style="font-weight:700;color:#dc2626">PO #:</span> ${o.poNumber}</div>`:""}
      ${!isEvent&&drv.drvName?`<div><span style="font-weight:700">Driver:</span> ${drv.drvName}</div>`:""}
      ${!isEvent&&drv.trkUnit?`<div><span style="font-weight:700">Truck:</span> Unit ${drv.trkUnit}${drv.trkPlate?` | Plate: ${drv.trkPlate}`:""}</div>`:""}
      ${!isEvent&&drv.trlUnit?`<div><span style="font-weight:700">Trailer:</span> Unit ${drv.trlUnit}${drv.trlPlate?` | Plate: ${drv.trlPlate}`:""}</div>`:""}
      <div style="margin-top:6px;font-size:11px;font-weight:700;color:#000">${billingDiv.name||CA_DIV.name}</div>
    </div>
  </div>
  ${stopRows}
  ${!isEvent&&items.length?`<table style="width:100%;border-collapse:collapse;margin-bottom:18px"><thead><tr>${["Pces","Description","Weight","Length","Width","Height"].map(h=>`<th style="background:#f1f5f9;padding:8px 10px;text-align:left;font-weight:700;font-size:10px;border-bottom:2px solid #cbd5e1;text-transform:uppercase">${h}</th>`).join("")}</tr></thead><tbody>${itemRows}</tbody></table>`:""}
  ${o.notes?`<div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:6px;padding:14px;font-size:12px;margin-bottom:18px;white-space:pre-line;line-height:1.6"><b style="font-size:11px;text-transform:uppercase;letter-spacing:0.3px;color:#64748b">Information / Notes</b><br><br>${o.notes}</div>`:""}
  ${eventPricingSection}
  ${pricingSection}
  ${podSection}
  ${!isEvent?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:100px"><div><div style="border-top:1.5px solid #000;padding-top:8px;font-size:10px;color:#666">Signature and name in print</div></div><div><div style="border-top:1.5px solid #000;padding-top:8px;font-size:10px;color:#666">Date and Time</div></div></div>`:""}
  <div style="margin-top:32px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:9px;color:#94a3b8;text-align:center">Diamond Back Express Inc. — DBX Dispatch</div>
</div>
</body></html>`;
}


exports.sendBolEmail = onRequest({ cors: true, secrets: ["GMAIL_APP_PASSWORD"] }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).send("Method not allowed"); return; }
  try {
    const { order, toEmail, subject, includeAttachments, client } = req.body;
    if (!order || !toEmail) { res.status(400).json({ error: "Missing order or toEmail" }); return; }
    // Build clean HTML BOL for the email body — same look as dispatch PDF button
    const bolHtml = buildBolHtmlCF(order, false, false, client || null);
    // Also generate a matching clean PDF to attach
    const pdfBytes = await generateBolPdf(order, client || null);
    const attachments = [{ filename: `BOL_${order.bol}.pdf`, content: Buffer.from(pdfBytes), contentType: "application/pdf" }];
    if (includeAttachments && order.files && order.files.length > 0) {
      attachments.push(...order.files.filter(f => f.url).map(f => ({ filename: f.name, path: f.url })));
    }
    await getTransporter().sendMail({
      from: '"DBX Dispatch" <manny@diamondbackexpress.com>', to: toEmail,
      subject: subject || `BOL ${order.bol} — ${order.cliName || "DBX"}`,
      html: bolHtml,
      attachments,
    });
    res.json({ success: true });
  } catch (error) { console.error(error); res.status(500).json({ error: error.message }); }
});

// ═══ DOWNLOAD BOL PDF (returns PDF binary — same generator as email) ═══
// Used by the dispatch UI to download the same PDF that gets emailed
exports.downloadBolPdf = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).send("Method not allowed"); return; }
  try {
    const { order, client, pricing, includePricing } = req.body;
    if (!order) { res.status(400).json({ error: "Missing order" }); return; }
    let pdfBytes;
    if (includePricing) {
      // Use invoice generator (includes pricing) — same one used by sendInvoiceEmail
      const p = pricing || order.price || {};
      pdfBytes = await generateInvoicePdf(order, p, true, client || null);
    } else {
      // Use BOL generator — same one used by sendBolEmail
      pdfBytes = await generateBolPdf(order, client || null, false);
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="BOL_${order.bol}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (error) { console.error("downloadBolPdf error:", error); res.status(500).json({ error: error.message }); }
});

// ═══ HELPER: Download file from URL as Buffer ═══
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (response) => {
      // Follow redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return downloadFile(response.headers.location).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    }).on("error", reject);
  });
}

// ═══ SEND INVOICE EMAIL (2nd Gen) ═══
exports.sendInvoiceEmail = onRequest({ cors: true, secrets: ["GMAIL_APP_PASSWORD"] }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).send("Method not allowed"); return; }
  try {
    const { order, pricing, toEmail, subject, orderFiles, xeroInvoiceUrl, xeroInvoiceFileName, xeroCSVBase64, xeroCSVFilename, client, emailMsg } = req.body;
    if (!order || !toEmail) { res.status(400).json({ error: "Missing order or toEmail" }); return; }
    const p = pricing || order.price || {};
    const sym = (p.cur === "EUR" ? "€" : p.cur === "GBP" ? "£" : "$");
    const baseAmt = parseFloat(p.base) || 0; const fuelPct = parseFloat(p.fuelPct) || 0;
    const fuelAmt = baseAmt * (fuelPct / 100); const subtotal = baseAmt + fuelAmt;
    const otherTotal = (p.other || []).reduce((s, c) => s + (parseFloat(c.amt) || 0), 0);
    const tm = TAX_MODES.find(t => t.k === p.taxMode) || TAX_MODES[0];
    const taxPct = p.taxMode === "CUSTOM" ? (parseFloat(p.taxCustom) || 0) : tm.pct;
    const taxAmt = p.taxMode === "NONE" ? 0 : (subtotal + otherTotal) * (taxPct / 100);
    const total = subtotal + otherTotal + taxAmt;
    const isBolSummary = !!xeroInvoiceUrl;
    const pdfBytes = await generateInvoicePdf(order, p, isBolSummary, client);

    // Build attachments array — start with the invoice PDF
    const attachments = [{ filename: isBolSummary ? `BOL_Summary_${order.bol}.pdf` : `Invoice_BOL_${order.bol}.pdf`, content: Buffer.from(pdfBytes), contentType: "application/pdf" }];

    // Attach Xero PDF if provided
    if (xeroInvoiceUrl) {
      try {
        const xeroBuffer = await downloadFile(xeroInvoiceUrl);
        attachments.push({
          filename: xeroInvoiceFileName || "Xero_Invoice.pdf",
          content: xeroBuffer,
          contentType: "application/pdf"
        });
      } catch (xeroErr) {
        console.error("[sendInvoiceEmail] ERROR downloading Xero PDF:", xeroErr.message);
      }
    }

    // Attach Xero CSV if provided (base64-encoded string from client)
    if (xeroCSVBase64) {
      try {
        const csvBuffer = Buffer.from(xeroCSVBase64, "base64");
        attachments.push({
          filename: xeroCSVFilename || `Xero_BOL${order.bol}.csv`,
          content: csvBuffer,
          contentType: "text/csv",
        });
        console.log("[sendInvoiceEmail] Xero CSV attached:", xeroCSVFilename);
      } catch (csvErr) {
        console.error("[sendInvoiceEmail] ERROR attaching Xero CSV:", csvErr.message);
      }
    }

    // Download and attach order files if provided
    if (orderFiles && orderFiles.length > 0) {
      for (const file of orderFiles) {
        if (file.url) {
          try {
            const fileBuffer = await downloadFile(file.url);
            attachments.push({ filename: file.name || "attachment", content: fileBuffer });
          } catch (dlErr) { console.warn(`Could not download ${file.name}:`, dlErr.message); }
        }
      }
    }

    // Build file list HTML for the email body
    const fileListHtml = (orderFiles && orderFiles.length > 0) ? `<hr><p><b>Order Attachments (${orderFiles.length}):</b></p>${orderFiles.map(f => `<p>📎 ${f.name}</p>`).join("")}` : "";

    await getTransporter().sendMail({
      from: '"DBX Dispatch" <manny@diamondbackexpress.com>', to: toEmail,
      subject: subject || `Invoice — BOL ${order.bol} — ${order.cliName || "DBX"}`,
      html: `<h2>Invoice — BOL ${order.bol}</h2><p>${order.cliName ? `<b>Client:</b> ${order.cliName}<br>` : ""}${order.billTo ? `<b>Bill To:</b> ${order.billTo}<br>` : ""}${order.ref ? `<b>Reference #:</b> ${order.ref}<br>` : ""}${order.drvName ? `<b>Driver:</b> ${order.drvName}<br>` : ""}</p>${order.podBy ? `<p><b>POD:</b> ${order.podBy} — ${fd(order.podDate)} ${order.podTime || ""}</p>` : ""}${order.orderType !== "event" && p.base ? `<h3>Pricing (${p.cur || "CAD"})</h3><p>Base: ${sym}${baseAmt.toFixed(2)}${fuelPct ? `<br>Fuel (${fuelPct}%): ${sym}${fuelAmt.toFixed(2)}` : ""}${(p.other || []).filter(c => c.desc || c.amt).map(c => `<br>${c.desc || "Other"}: ${sym}${(parseFloat(c.amt) || 0).toFixed(2)}`).join("")}${taxAmt > 0 ? `<br>Tax (${taxPct}%): ${sym}${taxAmt.toFixed(2)}` : ""}</p><p><b>TOTAL: ${sym}${total.toFixed(2)} ${p.cur || "CAD"}</b></p>` : ""}${emailMsg && emailMsg.trim() ? `<div style="margin:16px 0;padding:14px 16px;background:#fff8f0;border-left:4px solid #b45309;border-radius:4px"><p style="margin:0 0 6px;font-size:10px;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:0.05em">Message to Accounting</p><p style="margin:0;font-size:13px;color:#1a1a1a;white-space:pre-wrap">${emailMsg.trim()}</p></div>` : ""}<p>See attached PDF for full details.</p>${fileListHtml}<hr><p style="font-size:10px;color:#888">DBX Dispatch</p>`,
      attachments,
    });
    res.json({ success: true });
  } catch (error) { console.error(error); res.status(500).json({ error: error.message }); }
});

// ═══ DAILY PICKUP REMINDER (runs every day at 7:00 AM ET) ═══
exports.dailyPickupReminder = onSchedule({
  schedule: "0 7 * * *",
  timeZone: "America/Toronto",
  secrets: ["GMAIL_APP_PASSWORD"],
}, async (event) => {
  try {
    const db = admin.firestore();
    const ordersSnap = await db.collection("orders").get();
    const orders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Get tomorrow's date in YYYY-MM-DD format (Eastern Time)
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const todayStr = now.toISOString().slice(0, 10);

    // Find orders with pickup tomorrow or today that aren't completed/invoiced/cancelled
    const upcoming = orders.filter(o => {
      if (["completed", "invoiced", "cancelled"].includes(o.status)) return false;
      return o.pickDate === tomorrowStr || o.pickDate === todayStr;
    });

    if (upcoming.length === 0) {
      console.log("No upcoming pickups for today/tomorrow");
      return;
    }

    const todayOrders = upcoming.filter(o => o.pickDate === todayStr);
    const tomorrowOrders = upcoming.filter(o => o.pickDate === tomorrowStr);

    let html = `<h2>📋 DBX Dispatch — Pickup Reminder</h2>`;

    if (todayOrders.length > 0) {
      html += `<h3 style="color:#ef4444">🔴 TODAY's Pickups (${todayOrders.length})</h3><table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px">`;
      html += `<tr style="background:#f1f5f9"><th>BOL</th><th>Client</th><th>Pickup</th><th>Delivery</th><th>Driver</th><th>Status</th></tr>`;
      todayOrders.forEach(o => {
        html += `<tr><td><b>${o.bol}</b></td><td>${o.cliName || "—"}</td><td>${o.pickCo || "—"}<br><small>${o.pickAddr || ""}</small></td><td>${o.delCo || "—"}<br><small>${o.delAddr || ""}</small></td><td>${o.drvName || "<span style='color:red'>NOT ASSIGNED</span>"}</td><td>${o.status}</td></tr>`;
      });
      html += `</table>`;
    }

    if (tomorrowOrders.length > 0) {
      html += `<h3 style="color:#f97316">🟠 TOMORROW's Pickups (${tomorrowOrders.length})</h3><table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px">`;
      html += `<tr style="background:#f1f5f9"><th>BOL</th><th>Client</th><th>Pickup</th><th>Delivery</th><th>Driver</th><th>Status</th></tr>`;
      tomorrowOrders.forEach(o => {
        html += `<tr><td><b>${o.bol}</b></td><td>${o.cliName || "—"}</td><td>${o.pickCo || "—"}<br><small>${o.pickAddr || ""}</small></td><td>${o.delCo || "—"}<br><small>${o.delAddr || ""}</small></td><td>${o.drvName || "<span style='color:red'>NOT ASSIGNED</span>"}</td><td>${o.status}</td></tr>`;
      });
      html += `</table>`;
    }

    html += `<br><p style="font-size:11px;color:#888">This is an automated daily reminder from DBX Dispatch.<br>View all orders at <a href="https://dbx.cargodx.ca">dbx.cargodx.ca</a></p>`;

    await getTransporter().sendMail({
      from: '"DBX Dispatch" <manny@diamondbackexpress.com>',
      to: "manny@diamondbackexpress.com",
      subject: `DBX Pickup Reminder — ${todayOrders.length} today, ${tomorrowOrders.length} tomorrow`,
      html,
    });

    console.log(`Reminder sent: ${todayOrders.length} today, ${tomorrowOrders.length} tomorrow`);
  } catch (error) {
    console.error("Reminder error:", error);
  }
});
// Thu May  7 10:51:56 PM UTC 2026

// ─── TIMESHEET RECAP EMAIL WITH PDF ATTACHMENT ───────────────────────────────
async function generateRecapPdf(empName, empEmail, empPhone, entries, expenses, cfg, event, message) {
  const pdfDoc = await PDFDocument.create();
  const fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold:    await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };
  const W = 595, H = 842, M = 40;
  const red = rgb(0.863, 0.149, 0.149);
  const black = rgb(0, 0, 0);
  const gray = rgb(0.4, 0.4, 0.4);
  const lightGray = rgb(0.95, 0.95, 0.95);

  let page = pdfDoc.addPage([W, H]);
  let y = H - M;

  const newPage = () => { page = pdfDoc.addPage([W, H]); y = H - M; };
  const ensureSpace = (needed) => { if (y < M + needed) newPage(); };

  // ── Header ──
  page.drawRectangle({ x: 0, y: H - 56, width: W, height: 56, color: rgb(0.06, 0.06, 0.06) });
  // Logo
  const logoData = getLogoBytes();
  let logoW = 0;
  if (logoData) {
    try {
      const logoImg = await pdfDoc.embedJpg(logoData);
      const dims = logoImg.scale(0.22);
      page.drawImage(logoImg, { x: M, y: H - 52, width: dims.width, height: dims.height });
      logoW = dims.width + 10;
    } catch(e) { /* skip logo if error */ }
  }
  page.drawText("DIAMOND BACK EXPRESS INC.", { x: M + logoW, y: H - 36, size: 14, font: fonts.bold, color: rgb(1,1,1) });
  const eventLabel = (event && event !== "__all__") ? event : "";
  if (eventLabel) {
    let evtSize = 10;
    while (evtSize > 6 && fonts.bold.widthOfTextAtSize(eventLabel, evtSize) > 200) evtSize -= 0.5;
    page.drawText(eventLabel, { x: W - M - fonts.bold.widthOfTextAtSize(eventLabel, evtSize), y: H - 36, size: evtSize, font: fonts.bold, color: red });
  }
  page.drawText("TIMESHEET RECAP", { x: M + logoW, y: H - 50, size: 8, font: fonts.regular, color: rgb(0.6,0.6,0.6) });
  y = H - 72;

  // ── Employee info ──
  page.drawText(empName, { x: M, y, size: 16, font: fonts.bold, color: black });
  y -= 16;
  page.drawText(`${empEmail}  ·  ${empPhone||""}`, { x: M, y, size: 9, font: fonts.regular, color: gray });
  y -= 20;
  page.drawLine({ start:{x:M,y}, end:{x:W-M,y}, thickness:1, color:black });
  y -= 14;

  // ── Message block ──
  if (message && message.trim()) {
    page.drawText("MESSAGE FROM MANAGEMENT", { x: M, y, size: 7, font: fonts.bold, color: red });
    y -= 12;
    const msgLines = message.trim().split("\n");
    for (const line of msgLines) {
      ensureSpace(12);
      const words = line.split(" ");
      let cur = "";
      for (const w of words) {
        const test = cur ? cur + " " + w : w;
        if (fonts.regular.widthOfTextAtSize(test, 8.5) > W - M*2) {
          page.drawText(cur, { x: M, y, size: 8.5, font: fonts.regular, color: black });
          y -= 11;
          cur = w;
        } else { cur = test; }
      }
      if (cur) { page.drawText(cur, { x: M, y, size: 8.5, font: fonts.regular, color: black }); y -= 11; }
      y -= 2;
    }
    y -= 6;
    page.drawLine({ start:{x:M,y}, end:{x:W-M,y}, thickness:0.5, color:rgb(0.8,0.8,0.8) });
    y -= 12;
  }

  // ── Daily entries table ──
  const fmtDate = (d) => { const dt = new Date(d+"T12:00:00"); return dt.toLocaleDateString("en-CA",{weekday:"short",month:"short",day:"numeric",year:"numeric"}); };
  const calcMins = (s, e) => { if(!s||!e) return 0; const [sh,sm]=s.split(":").map(Number); const [eh,em]=e.split(":").map(Number); let m=(eh*60+em)-(sh*60+sm); if(m<=0) m+=24*60; return m; };
  const fmtH = (m) => { const h=Math.floor(m/60),mn=m%60; return `${h}h${mn>0?` ${mn}m`:""}`; };

  // Build per-entry detail lines
  const getEntryDetails = (e) => {
    const lines = [];
    const mins = calcMins(e.startTime, e.endTime);
    if (mins > 0 && !["non-working","per-diem","working-day"].includes(e.dayType)) {
      const r = parseFloat(e.hourlyOverride)||(parseFloat(cfg?.hourly)||0);
      lines.push(`${e.startTime} -> ${e.endTime}  (${fmtH(mins)}${r>0?` x $${r.toFixed(2)}/h`:""})`);
    }
    const wd = (parseFloat(e.numDays)||0) + (e.dayType==="working-day"?1:0);
    if (wd > 0) { const r=parseFloat(e.dayRateOverride)||(parseFloat(cfg?.workDay)||0); lines.push(`${wd} working day${wd>1?"s":""}${r>0?` x $${r.toFixed(2)}`:""}`);}
    const nw = (parseFloat(e.numNwDays)||0) + (e.dayType==="non-working"?1:0);
    if (nw > 0) { const r=parseFloat(e.nwDayRateOverride)||(parseFloat(cfg?.nonWorkDay)||0); lines.push(`${nw} non-working day${nw>1?"s":""}${r>0?` x $${r.toFixed(2)}`:""}`);}
    const pd = (parseFloat(e.numPerDiem)||0) + (e.dayType==="per-diem"?1:0);
    if (pd > 0) { const r=parseFloat(e.perDiemRateOverride)||(parseFloat(cfg?.perDiem)||0); lines.push(`${pd} per diem${r>0?` x $${r.toFixed(2)}`:""}`);}
    const tr = parseFloat(e.numTrips)||0;
    if (tr > 0) { const r=parseFloat(e.tripRateOverride)||(parseFloat(cfg?.tripRate)||0); lines.push(`${tr} trip${tr>1?"s":""}${r>0?` x $${r.toFixed(2)}`:""}`);}
    if ((parseFloat(e.expenseAmt)||0)>0 && e.expenseDesc) { const r=e.expenseTax==="HST on Purchases - 13%"?0.13:e.expenseTax==="GST on Purchases - 5%"?0.05:0; const taxLbl=r>0?` (incl. $${((parseFloat(e.expenseAmt)||0)*(r/(1+r))).toFixed(2)} ${e.expenseTax.includes("HST")?"HST":"GST"})`:""; lines.push(`Expense: ${e.expenseDesc} $${(parseFloat(e.expenseAmt)||0).toFixed(2)}${taxLbl}`); }
    if (e.notes) lines.push(e.notes.substring(0,40));
    return lines.length ? lines : ["—"];
  };

  page.drawText("DAILY ENTRIES", { x: M, y, size: 8, font: fonts.bold, color: gray });
  y -= 14;
  const drawTableHeader = () => {
    page.drawRectangle({ x: M, y: y-2, width: W-M*2, height: 14, color: rgb(0.06,0.06,0.06) });
    page.drawText("DATE", { x: M+4, y: y+2, size: 7, font: fonts.bold, color: rgb(1,1,1) });
    page.drawText("DETAILS", { x: M+155, y: y+2, size: 7, font: fonts.bold, color: rgb(1,1,1) });
    y -= 14;
  };
  drawTableHeader();

  const sorted = [...(entries||[])].sort((a,b)=>(a.date||"").localeCompare(b.date||""));
  let totalMins = 0, rowIdx = 0;
  for (const e of sorted) {
    const details = getEntryDetails(e);
    const rowH = Math.max(14, details.length * 12 + 4);
    if (y - rowH < M + 30) { newPage(); page.drawText("DAILY ENTRIES (cont.)", { x: M, y, size: 8, font: fonts.bold, color: gray }); y -= 14; drawTableHeader(); rowIdx = 0; }
    if (rowIdx % 2 === 0) page.drawRectangle({ x: M, y: y-rowH+12, width: W-M*2, height: rowH, color: lightGray });
    page.drawText(fmtDate(e.date), { x: M+4, y, size: 7.5, font: fonts.bold, color: black });
    const mins = calcMins(e.startTime, e.endTime);
    if (mins > 0 && !["non-working","per-diem","working-day"].includes(e.dayType)) totalMins += mins;
    details.forEach((line, li) => {
      const lineY = y - li * 12;
      const isHrs = li===0 && line.includes("->");
      page.drawText(line.substring(0,60), { x: M+155, y: lineY, size: 7.5, font: fonts.regular, color: isHrs?red:black });
    });
    y -= rowH; rowIdx++;
  }
  page.drawLine({ start:{x:M,y:y+4}, end:{x:W-M,y:y+4}, thickness:1, color:black });
  y -= 6;
  page.drawText(`TOTAL HOURS: ${fmtH(totalMins)}`, { x: M, y, size: 10, font: fonts.bold, color: red });
  y -= 22;

  // ── Pay summary ──
  ensureSpace(80);
  page.drawText("PAY SUMMARY", { x: M, y, size: 8, font: fonts.bold, color: gray });
  y -= 14;
  const addRow = (label, val) => {
    ensureSpace(14);
    page.drawText(label, { x: M, y, size: 9, font: fonts.regular, color: black });
    page.drawText(val, { x: W-M-100, y, size: 9, font: fonts.bold, color: black });
    y -= 13;
  };
  let grandTotal = 0;

  // Hours — group by rate
  const hoursByRate = {};
  sorted.forEach(e => {
    const m = calcMins(e.startTime, e.endTime);
    if (m > 0 && !["non-working","per-diem","working-day"].includes(e.dayType)) {
      const r = parseFloat(e.hourlyOverride)||(parseFloat(cfg?.hourly)||0);
      if (r > 0) { const k=r.toFixed(2); hoursByRate[k]=(hoursByRate[k]||0)+m; }
    }
  });
  Object.entries(hoursByRate).forEach(([rate,mins]) => {
    const amt = (mins/60)*parseFloat(rate);
    addRow(`${fmtH(mins)} x $${rate}/h`, `CAD ${amt.toFixed(2)}`);
    grandTotal += amt;
  });

  // Working days — group by rate
  const wdByRate = {};
  sorted.forEach(e => {
    const d=(parseFloat(e.numDays)||0)+(e.dayType==="working-day"?1:0);
    if(d>0){const r=parseFloat(e.dayRateOverride)||(parseFloat(cfg?.workDay)||0); if(r>0){const k=r.toFixed(2); wdByRate[k]=(wdByRate[k]||0)+d;}}
  });
  Object.entries(wdByRate).forEach(([rate,days]) => {
    const amt=days*parseFloat(rate); addRow(`${days} working day${days>1?"s":""} x $${rate}`, `CAD ${amt.toFixed(2)}`); grandTotal+=amt;
  });

  // Non-working days — group by rate
  const nwByRate = {};
  sorted.forEach(e => {
    const d=(parseFloat(e.numNwDays)||0)+(e.dayType==="non-working"?1:0);
    if(d>0){const r=parseFloat(e.nwDayRateOverride)||(parseFloat(cfg?.nonWorkDay)||0); if(r>0){const k=r.toFixed(2); nwByRate[k]=(nwByRate[k]||0)+d;}}
  });
  Object.entries(nwByRate).forEach(([rate,days]) => {
    const amt=days*parseFloat(rate); addRow(`${days} non-working day${days>1?"s":""} x $${rate}`, `CAD ${amt.toFixed(2)}`); grandTotal+=amt;
  });

  // Per diem — group by rate
  const pdByRate = {};
  sorted.forEach(e => {
    const d=(parseFloat(e.numPerDiem)||0)+(e.dayType==="per-diem"?1:0);
    if(d>0){const r=parseFloat(e.perDiemRateOverride)||(parseFloat(cfg?.perDiem)||0); if(r>0){const k=r.toFixed(2); pdByRate[k]=(pdByRate[k]||0)+d;}}
  });
  Object.entries(pdByRate).forEach(([rate,days]) => {
    const amt=days*parseFloat(rate); addRow(`${days} per diem x $${rate}`, `CAD ${amt.toFixed(2)}`); grandTotal+=amt;
  });

  // Trips — group by rate
  const tripsByRate = {};
  sorted.forEach(e => {
    const t=parseFloat(e.numTrips)||0;
    if(t>0){const r=parseFloat(e.tripRateOverride)||(parseFloat(cfg?.tripRate)||0); if(r>0){const k=r.toFixed(2); tripsByRate[k]=(tripsByRate[k]||0)+t;}}
  });
  Object.entries(tripsByRate).forEach(([rate,trips]) => {
    const amt=trips*parseFloat(rate); addRow(`${trips} trip${trips>1?"s":""} x $${rate}`, `CAD ${amt.toFixed(2)}`); grandTotal+=amt;
  });

  // Inline expenses from entries
  const inlineExp = {};
  sorted.forEach(e => {
    const amt=parseFloat(e.expenseAmt)||0;
    if(amt>0&&e.expenseDesc){inlineExp[e.expenseDesc]=(inlineExp[e.expenseDesc]||0)+amt;}
  });
  Object.entries(inlineExp).forEach(([desc,amt]) => {
    addRow(`Expense: ${desc}`, `CAD ${amt.toFixed(2)}`); grandTotal+=amt;
  });

  // Approved submitted expenses
  const appExp = {};
  (expenses||[]).filter(e=>e.status==="approved").forEach(e => {
    const t=e.type||"Miscellaneous"; appExp[t]=(appExp[t]||0)+(parseFloat(e.amount)||0);
  });
  Object.entries(appExp).forEach(([type,amt]) => {
    addRow(`Expense: ${type}`, `CAD ${amt.toFixed(2)}`); grandTotal+=amt;
  });

  ensureSpace(30);
  page.drawLine({ start:{x:M,y:y+4}, end:{x:W-M,y:y+4}, thickness:1, color:black });
  y -= 6;
  page.drawText("GROSS TOTAL", { x: M, y, size: 11, font: fonts.bold, color: black });
  page.drawText(`CAD ${grandTotal.toFixed(2)}`, { x: W-M-100, y, size: 12, font: fonts.bold, color: red });
  y -= 22;

  // ── Footer (on every page) ──
  const pages = pdfDoc.getPages();
  pages.forEach(pg => {
    pg.drawRectangle({ x: 0, y: 0, width: W, height: 28, color: rgb(0.95,0.95,0.95) });
    pg.drawText("Diamond Back Express Inc.  ·  4515 Ebenezer Rd Unit 212, Brampton, Ontario, L6P 2K7", { x: M, y: 10, size: 7, font: fonts.regular, color: gray });
  });

  return await pdfDoc.save();
}

exports.sendRecapEmail = onRequest({ cors: true, secrets: ["GMAIL_APP_PASSWORD"] }, async (req, res) => {
  try {
    const { empName, empEmail, empPhone, entries, expenses, cfg, event, message, extraEmails, ccManny } = req.body;
    if (!empEmail || !empName) { res.status(400).json({ error: "Missing employee info" }); return; }

    // Generate PDF
    const pdfBytes = await generateRecapPdf(empName, empEmail, empPhone||"", entries||[], expenses||[], cfg||null, event||"", message||"");

    // Build HTML body
    const fmtDate = (d) => new Date(d+"T12:00:00").toLocaleDateString("en-CA",{weekday:"short",month:"short",day:"numeric",year:"numeric"});
    const calcMins = (s,e) => { if(!s||!e) return 0; const [sh,sm]=s.split(":").map(Number); const [eh,em]=e.split(":").map(Number); let m=(eh*60+em)-(sh*60+sm); if(m<=0) m+=24*60; return m; };
    const fmtH = (m) => { const h=Math.floor(m/60),mn=m%60; return `${h}h${mn>0?` ${mn}m`:""}`; };
    const sorted = [...(entries||[])].sort((a,b)=>(a.date||"").localeCompare(b.date||""));
    const totalMins = sorted.reduce((a,e)=>a+calcMins(e.startTime,e.endTime),0);
    const esc = (s) => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const msgHtml = (message||"").trim() ? `<div style="margin:16px 0;padding:14px 16px;background:#fff8f0;border-left:4px solid #b45309;border-radius:4px"><p style="margin:0 0 6px;font-size:10px;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:0.05em">Message from Management</p><p style="margin:0;font-size:13px;color:#1a1a1a;white-space:pre-wrap">${esc(message)}</p></div>` : "";
    const dayRows = sorted.map(e=>{
      const m=calcMins(e.startTime,e.endTime);
      const parts=[];
      if(m>0&&!["non-working","per-diem","working-day"].includes(e.dayType)) parts.push(`<span style="color:#d42b2b;font-weight:700">${e.startTime} → ${e.endTime} (${fmtH(m)})</span>`);
      const wd=(parseFloat(e.numDays)||0)+(e.dayType==="working-day"?1:0); if(wd>0){const r=parseFloat(e.dayRateOverride)||(parseFloat(cfg?.workDay)||0); parts.push(`${wd} working day${wd>1?"s":""}${r>0?` × $${r.toFixed(2)}`:""}`);}
      const nw=(parseFloat(e.numNwDays)||0)+(e.dayType==="non-working"?1:0); if(nw>0){const r=parseFloat(e.nwDayRateOverride)||(parseFloat(cfg?.nonWorkDay)||0); parts.push(`${nw} NW day${nw>1?"s":""}${r>0?` × $${r.toFixed(2)}`:""}`);}
      const pd=(parseFloat(e.numPerDiem)||0)+(e.dayType==="per-diem"?1:0); if(pd>0){const r=parseFloat(e.perDiemRateOverride)||(parseFloat(cfg?.perDiem)||0); parts.push(`${pd} per diem${r>0?` × $${r.toFixed(2)}`:""}`);}
      const tr=parseFloat(e.numTrips)||0; if(tr>0){const r=parseFloat(e.tripRateOverride)||(parseFloat(cfg?.tripRate)||0); parts.push(`${tr} trip${tr>1?"s":""}${r>0?` × $${r.toFixed(2)}`:""}`);}
      if((parseFloat(e.expenseAmt)||0)>0&&e.expenseDesc) { const r=e.expenseTax==="HST on Purchases - 13%"?0.13:e.expenseTax==="GST on Purchases - 5%"?0.05:0; const taxLbl=r>0?` (incl. $${((parseFloat(e.expenseAmt)||0)*(r/(1+r))).toFixed(2)} ${e.expenseTax.includes("HST")?"HST":"GST"})`:""; parts.push(`Expense: ${esc(e.expenseDesc)} $${(parseFloat(e.expenseAmt)||0).toFixed(2)}${taxLbl}`); }
      if(e.notes) parts.push(`<em style="color:#888">${esc(e.notes)}</em>`);
      return `<tr><td style="padding:8px 10px;border-bottom:1px solid #eee;font-weight:600;white-space:nowrap;vertical-align:top">${fmtDate(e.date)}</td><td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:12px">${parts.join("<br>") || "—"}</td></tr>`;
    }).join("");
    let payRows = "";
    let grandTot = 0;
    // Hours by rate
    const hByR={}; sorted.forEach(e=>{const m=calcMins(e.startTime,e.endTime); if(m>0&&!["non-working","per-diem","working-day"].includes(e.dayType)){const r=parseFloat(e.hourlyOverride)||(parseFloat(cfg?.hourly)||0); if(r>0){const k=r.toFixed(2);hByR[k]=(hByR[k]||0)+m;}}});
    Object.entries(hByR).forEach(([rate,mins])=>{const a=(mins/60)*parseFloat(rate); payRows+=`<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${fmtH(mins)} × $${rate}/h</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600">CAD ${a.toFixed(2)}</td></tr>`; grandTot+=a;});
    // WD by rate
    const wdByR={}; sorted.forEach(e=>{const d=(parseFloat(e.numDays)||0)+(e.dayType==="working-day"?1:0); if(d>0){const r=parseFloat(e.dayRateOverride)||(parseFloat(cfg?.workDay)||0); if(r>0){const k=r.toFixed(2);wdByR[k]=(wdByR[k]||0)+d;}}});
    Object.entries(wdByR).forEach(([rate,d])=>{const a=d*parseFloat(rate); payRows+=`<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${d} working day${d>1?"s":""} × $${rate}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600">CAD ${a.toFixed(2)}</td></tr>`; grandTot+=a;});
    // NW by rate
    const nwByR={}; sorted.forEach(e=>{const d=(parseFloat(e.numNwDays)||0)+(e.dayType==="non-working"?1:0); if(d>0){const r=parseFloat(e.nwDayRateOverride)||(parseFloat(cfg?.nonWorkDay)||0); if(r>0){const k=r.toFixed(2);nwByR[k]=(nwByR[k]||0)+d;}}});
    Object.entries(nwByR).forEach(([rate,d])=>{const a=d*parseFloat(rate); payRows+=`<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${d} non-working day${d>1?"s":""} × $${rate}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600">CAD ${a.toFixed(2)}</td></tr>`; grandTot+=a;});
    // PD by rate
    const pdByR={}; sorted.forEach(e=>{const d=(parseFloat(e.numPerDiem)||0)+(e.dayType==="per-diem"?1:0); if(d>0){const r=parseFloat(e.perDiemRateOverride)||(parseFloat(cfg?.perDiem)||0); if(r>0){const k=r.toFixed(2);pdByR[k]=(pdByR[k]||0)+d;}}});
    Object.entries(pdByR).forEach(([rate,d])=>{const a=d*parseFloat(rate); payRows+=`<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${d} per diem × $${rate}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600">CAD ${a.toFixed(2)}</td></tr>`; grandTot+=a;});
    // Trips by rate
    const trByR={}; sorted.forEach(e=>{const t=parseFloat(e.numTrips)||0; if(t>0){const r=parseFloat(e.tripRateOverride)||(parseFloat(cfg?.tripRate)||0); if(r>0){const k=r.toFixed(2);trByR[k]=(trByR[k]||0)+t;}}});
    Object.entries(trByR).forEach(([rate,t])=>{const a=t*parseFloat(rate); payRows+=`<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${t} trip${t>1?"s":""} × $${rate}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600">CAD ${a.toFixed(2)}</td></tr>`; grandTot+=a;});
    // Inline expenses
    const iExp={}; sorted.forEach(e=>{const a=parseFloat(e.expenseAmt)||0; if(a>0&&e.expenseDesc){iExp[e.expenseDesc]=(iExp[e.expenseDesc]||0)+a;}});
    Object.entries(iExp).forEach(([desc,a])=>{payRows+=`<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">Expense: ${desc}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600">CAD ${a.toFixed(2)}</td></tr>`; grandTot+=a;});
    // Approved submitted expenses
    const appE={}; (expenses||[]).filter(e=>e.status==="approved").forEach(e=>{const t=e.type||"Misc";appE[t]=(appE[t]||0)+(parseFloat(e.amount)||0);});
    Object.entries(appE).forEach(([t,a])=>{payRows+=`<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">Expense: ${t}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600">CAD ${a.toFixed(2)}</td></tr>`; grandTot+=a;});
    if(grandTot>0) payRows+=`<tr style="background:#f5f5f5"><td style="padding:8px 10px;font-weight:700;font-size:13px">GROSS TOTAL</td><td style="padding:8px 10px;text-align:right;font-weight:700;font-size:14px;color:#d42b2b">CAD ${grandTot.toFixed(2)}</td></tr>`;
    const evtLabel = (event && event !== "__all__") ? event : "";
    const htmlBody = `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto"><div style="background:#0f0f0f;padding:14px 24px;display:flex;justify-content:space-between;align-items:center"><div style="display:flex;align-items:center;gap:14px"><img src="data:image/jpeg;base64,${LOGO_B64}" style="height:36px;display:block;" alt="DBX"/><div style="color:#fff;font-size:15px;font-weight:700">DIAMOND BACK EXPRESS INC.</div></div><div style="color:#dc2626;font-size:11px;font-weight:600">${esc(evtLabel)}</div></div><div style="padding:18px 24px;background:#f5f5f5;border-bottom:1px solid #ddd"><div style="font-size:18px;font-weight:700">${esc(empName)}</div><div style="font-size:11px;color:#666;margin-top:2px">${esc(empEmail)} · ${esc(empPhone||"")}</div></div>${msgHtml}<div style="padding:16px 24px;display:flex;gap:32px;background:#fff;border-bottom:1px solid #eee"><div><div style="font-size:26px;font-weight:700;color:#d42b2b">${fmtH(totalMins)}</div><div style="font-size:9px;text-transform:uppercase;color:#888">Total Hours</div></div><div><div style="font-size:26px;font-weight:700">${sorted.length}</div><div style="font-size:9px;text-transform:uppercase;color:#888">Days on Record</div></div></div><div style="padding:18px 24px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#666;margin-bottom:8px;border-bottom:2px solid #000;padding-bottom:4px">Daily Entries</div><table style="width:100%;border-collapse:collapse"><thead><tr style="background:#f0f0f0"><th style="text-align:left;padding:7px 10px;font-size:9px;text-transform:uppercase;color:#666;width:160px">Date</th><th style="text-align:left;padding:7px 10px;font-size:9px;text-transform:uppercase;color:#666">Details</th></tr></thead><tbody>${dayRows}</tbody></table></div>${payRows?`<div style="padding:0 24px 18px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#666;margin-bottom:8px;border-bottom:2px solid #000;padding-bottom:4px">Pay Summary</div><table style="width:100%;border-collapse:collapse">${payRows}</table></div>`:""}<div style="padding:14px 24px;background:#f5f5f5;border-top:1px solid #ddd;font-size:10px;color:#888;text-align:center">Diamond Back Express Inc. · 4515 Ebenezer Rd Unit 212, Brampton, Ontario, L6P 2K7<br>Generated ${new Date().toLocaleDateString("en-CA",{month:"long",day:"numeric",year:"numeric"})}</div></div>`;

    const safeName = empName.replace(/[^a-zA-Z0-9]+/g,"_");
    const attachment = { filename: `Recap_${safeName}_${(evtLabel||"DBX").replace(/[^a-zA-Z0-9]+/g,"_")}.pdf`, content: Buffer.from(pdfBytes), contentType: "application/pdf" };
    const subject = `DBX Timesheet Recap${evtLabel?` — ${evtLabel}`:""}`;
    const allTo = [empEmail, ...(extraEmails||[]).filter(Boolean)];
    const failures = [];
    for (const to of allTo) {
      try {
        await getTransporter().sendMail({ from: '"DBX Dispatch" <manny@diamondbackexpress.com>', to, subject, html: htmlBody, attachments: [attachment] });
      } catch (mailErr) {
        console.error(`[sendRecapEmail] Failed to send to ${to}:`, mailErr.message);
        failures.push(to);
      }
    }
    if (ccManny !== false) {
      try {
        await getTransporter().sendMail({ from: '"DBX Dispatch" <manny@diamondbackexpress.com>', to: "manny@diamondbackexpress.com", subject: `[CC] ${subject} — ${empName}`, html: htmlBody, attachments: [attachment] });
      } catch (ccErr) { console.error("[sendRecapEmail] CC failed:", ccErr.message); }
    }
    if (failures.length === allTo.length) {
      res.status(500).json({ error: `Failed to send to all recipients: ${failures.join(", ")}` });
      return;
    }
    res.json({ success: true, sent: allTo.length - failures.length, failures });
  } catch (err) {
    console.error("[sendRecapEmail] ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});
