const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const xml2js = require("xml2js");
const PDFDocument = require("pdfkit");

const XPS_TO_PDF = 72 / 96;

async function main() {
  const inputDir = path.join(__dirname, "inputs");
  const outputDir = path.join(__dirname, "outputs");
  fs.mkdirSync(outputDir, { recursive: true });

  const files = fs
    .readdirSync(inputDir)
    .filter((f) => f.toLowerCase().endsWith(".dwfx"));

  if (!files.length) {
    console.error("No .dwfx files found in inputs/");
    process.exit(1);
  }

  for (const file of files) {
    const inputPath = path.join(inputDir, file);
    const outputFile = file.replace(/\.dwfx$/i, ".pdf");
    const outputPath = path.join(outputDir, outputFile);
    console.log(`Converting: ${file}`);
    const start = Date.now();
    await convertDwfxToPdf(inputPath, outputPath);
    console.log(`  -> ${outputFile} (${Date.now() - start}ms)`);
  }
}

// ── Core conversion ─────────────────────────────────────────

async function convertDwfxToPdf(inputPath, outputPath) {
  const zip = new AdmZip(inputPath);
  const pages = await findPages(zip);
  if (!pages.length) throw new Error("No pages found in DWFx file");

  const page = pages[0];
  const fpageXml = readEntry(zip, page.fpagePath);
  if (!fpageXml) throw new Error(`Cannot read page: ${page.fpagePath}`);

  const root = await parseXml(fpageXml);
  const fixedPage = root.FixedPage || Object.values(root)[0];
  const pageW = parseFloat(fixedPage.$.Width);
  const pageH = parseFloat(fixedPage.$.Height);

  const resources = {};
  await collectResources(fixedPage, zip, page.basePath, resources);

  const fonts = {};
  collectFontRefs(fixedPage, zip, page.basePath, fonts);

  const doc = new PDFDocument({
    size: [pageW * XPS_TO_PDF, pageH * XPS_TO_PDF],
    autoFirstPage: true,
    compress: true,
    margin: 0,
  });

  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  doc.save();
  doc.transform(XPS_TO_PDF, 0, 0, XPS_TO_PDF, 0, 0);
  renderChildren(doc, fixedPage, resources, fonts);
  doc.restore();
  doc.end();

  return new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

// ── DWFx/XPS navigation ────────────────────────────────────

async function findPages(zip) {
  const fdseqXml = readEntry(zip, "FixedDocumentSequence.fdseq");
  if (!fdseqXml) throw new Error("No FixedDocumentSequence found");

  const fdseq = await parseXml(fdseqXml);
  const fdseqRoot = fdseq.FixedDocumentSequence || Object.values(fdseq)[0];
  const pages = [];

  for (const child of getChildren(fdseqRoot)) {
    if (child["#name"] !== "DocumentReference") continue;
    const docSrc = child.$.Source.replace(/^\//, "");
    const docXml = readEntry(zip, docSrc);
    if (!docXml) continue;

    const docParsed = await parseXml(docXml);
    const docRoot = docParsed.FixedDocument || Object.values(docParsed)[0];

    for (const pc of getChildren(docRoot)) {
      if (pc["#name"] !== "PageContent") continue;
      const src = pc.$.Source.replace(/^\//, "");
      pages.push({ fpagePath: src, basePath: path.posix.dirname(src) });
    }
  }
  return pages;
}

// ── ZIP / XML helpers ───────────────────────────────────────

function readEntry(zip, p) {
  const clean = p.replace(/^\.\//, "").replace(/^\//, "");
  const entry = zip.getEntry(clean);
  return entry ? entry.getData().toString("utf-8") : null;
}

function readEntryBuf(zip, p) {
  const clean = p.replace(/^\.\//, "").replace(/^\//, "");
  const entry = zip.getEntry(clean);
  return entry ? entry.getData() : null;
}

async function parseXml(xml) {
  return new xml2js.Parser({
    explicitArray: false,
    preserveChildrenOrder: true,
    explicitChildren: true,
  }).parseStringPromise(xml);
}

function getChildren(node) {
  return node?.$$  || [];
}

function resolvePath(base, rel) {
  if (rel.startsWith("/")) return rel.slice(1);
  if (rel.startsWith("./")) rel = rel.slice(2);
  return path.posix.join(base, rel);
}

// ── Resource collection ─────────────────────────────────────

async function collectResources(node, zip, basePath, resources) {
  for (const child of getChildren(node)) {
    if (child["#name"] === "Canvas.Resources") {
      for (const rd of getChildren(child)) {
        if (rd["#name"] !== "ResourceDictionary") continue;
        const src = rd.$.Source;
        if (src) {
          const rdXml = readEntry(zip, resolvePath(basePath, src));
          if (rdXml) await parseResourceDict(rdXml, basePath, zip, resources);
        }
        for (const res of getChildren(rd)) loadBrush(res, basePath, zip, resources);
      }
    }
    await collectResources(child, zip, basePath, resources);
  }
}

async function parseResourceDict(xml, basePath, zip, resources) {
  const parsed = await parseXml(xml);
  const root = parsed.ResourceDictionary || Object.values(parsed)[0];
  for (const child of getChildren(root)) loadBrush(child, basePath, zip, resources);
}

function loadBrush(node, basePath, zip, resources) {
  if (node["#name"] !== "ImageBrush") return;
  const key = node.$["x:Key"] || node.$.Key;
  const imgSrc = node.$.ImageSource;
  if (!key || !imgSrc) return;
  resources[key] = {
    imageBuffer: readEntryBuf(zip, resolvePath(basePath, imgSrc)),
    transform: node.$.Transform,
    viewport: node.$.Viewport,
    viewbox: node.$.Viewbox,
  };
}

// ── Font handling ───────────────────────────────────────────

function collectFontRefs(node, zip, basePath, fonts) {
  for (const child of getChildren(node)) {
    if (child["#name"] === "Glyphs") {
      const uri = child.$.FontUri;
      if (uri && !fonts[uri]) {
        const buf = readEntryBuf(zip, resolvePath(basePath, uri));
        if (buf) fonts[uri] = deobfuscateOdttf(buf, path.basename(uri));
      }
    }
    collectFontRefs(child, zip, basePath, fonts);
  }
}

function deobfuscateOdttf(buffer, fileName) {
  const m = fileName.match(
    /([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})/i,
  );
  if (!m) return buffer;
  const h = (s, i) => parseInt(s.slice(i, i + 2), 16);
  const key = Buffer.from([
    h(m[1], 6), h(m[1], 4), h(m[1], 2), h(m[1], 0),
    h(m[2], 2), h(m[2], 0),
    h(m[3], 2), h(m[3], 0),
    h(m[4], 0), h(m[4], 2),
    h(m[5], 0), h(m[5], 2), h(m[5], 4), h(m[5], 6), h(m[5], 8), h(m[5], 10),
  ]);
  const out = Buffer.from(buffer);
  for (let i = 0; i < 32 && i < out.length; i++) out[i] ^= key[i % 16];
  return out;
}

// ── SVG path-data tokenizer ─────────────────────────────────

function tokenizePath(d) {
  const tokens = [];
  const re = /([a-df-zA-DF-Z])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
  let m;
  while ((m = re.exec(d))) tokens.push(m[1] || parseFloat(m[2]));
  return tokens;
}

// ── Draw SVG path data onto PDFKit ──────────────────────────

function drawPathData(doc, d) {
  const t = tokenizePath(d);
  let i = 0;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const num = () => t[i++];
  const isNum = () => i < t.length && typeof t[i] === "number";

  while (i < t.length) {
    const cmd = t[i++];
    switch (cmd) {
      case "F":
        break;
      case "M":
        cx = num(); cy = num(); doc.moveTo(cx, cy); sx = cx; sy = cy;
        while (isNum()) { cx = num(); cy = num(); doc.lineTo(cx, cy); }
        break;
      case "m":
        cx += num(); cy += num(); doc.moveTo(cx, cy); sx = cx; sy = cy;
        while (isNum()) { cx += num(); cy += num(); doc.lineTo(cx, cy); }
        break;
      case "L":
        while (isNum()) { cx = num(); cy = num(); doc.lineTo(cx, cy); }
        break;
      case "l":
        while (isNum()) { cx += num(); cy += num(); doc.lineTo(cx, cy); }
        break;
      case "H":
        while (isNum()) { cx = num(); doc.lineTo(cx, cy); }
        break;
      case "h":
        while (isNum()) { cx += num(); doc.lineTo(cx, cy); }
        break;
      case "V":
        while (isNum()) { cy = num(); doc.lineTo(cx, cy); }
        break;
      case "v":
        while (isNum()) { cy += num(); doc.lineTo(cx, cy); }
        break;
      case "C":
        while (isNum()) {
          const x1 = num(), y1 = num(), x2 = num(), y2 = num();
          cx = num(); cy = num();
          doc.bezierCurveTo(x1, y1, x2, y2, cx, cy);
        }
        break;
      case "c":
        while (isNum()) {
          const x1 = cx + num(), y1 = cy + num();
          const x2 = cx + num(), y2 = cy + num();
          cx += num(); cy += num();
          doc.bezierCurveTo(x1, y1, x2, y2, cx, cy);
        }
        break;
      case "Q":
        while (isNum()) {
          const qx = num(), qy = num();
          cx = num(); cy = num();
          doc.quadraticCurveTo(qx, qy, cx, cy);
        }
        break;
      case "q":
        while (isNum()) {
          const qx = cx + num(), qy = cy + num();
          cx += num(); cy += num();
          doc.quadraticCurveTo(qx, qy, cx, cy);
        }
        break;
      case "A":
        while (isNum()) {
          const rx = num(), ry = num(), rot = num(), la = num(), sw = num();
          const ex = num(), ey = num();
          emitArc(doc, cx, cy, rx, ry, rot, la, sw, ex, ey);
          cx = ex; cy = ey;
        }
        break;
      case "a":
        while (isNum()) {
          const rx = num(), ry = num(), rot = num(), la = num(), sw = num();
          const ex = cx + num(), ey = cy + num();
          emitArc(doc, cx, cy, rx, ry, rot, la, sw, ex, ey);
          cx = ex; cy = ey;
        }
        break;
      case "Z": case "z":
        doc.closePath(); cx = sx; cy = sy;
        break;
    }
  }
}

// ── SVG arc → cubic Bézier ──────────────────────────────────

function emitArc(doc, x1, y1, rx, ry, angleDeg, largeArc, sweep, x2, y2) {
  if ((x1 === x2 && y1 === y2) || rx === 0 || ry === 0) {
    doc.lineTo(x2, y2);
    return;
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (angleDeg * Math.PI) / 180;
  const cp = Math.cos(phi), sp = Math.sin(phi);

  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;

  let rxSq = rx * rx, rySq = ry * ry;
  const x1pSq = x1p * x1p, y1pSq = y1p * y1p;
  const lambda = x1pSq / rxSq + y1pSq / rySq;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s; ry *= s; rxSq = rx * rx; rySq = ry * ry;
  }

  let sq = Math.max(0,
    (rxSq * rySq - rxSq * y1pSq - rySq * x1pSq) /
    (rxSq * y1pSq + rySq * x1pSq));
  let root = Math.sqrt(sq);
  if (largeArc === sweep) root = -root;
  const cxp = root * (rx * y1p / ry);
  const cyp = root * -(ry * x1p / rx);

  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2;
  const cy = sp * cxp + cp * cyp + (y1 + y2) / 2;

  const theta1 = vecAngle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = vecAngle(
    (x1p - cxp) / rx, (y1p - cyp) / ry,
    (-x1p - cxp) / rx, (-y1p - cyp) / ry,
  );
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const segs = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / segs;
  for (let s = 0; s < segs; s++) {
    bezierArcSeg(doc, cx, cy, rx, ry, phi, theta1 + s * delta, theta1 + (s + 1) * delta);
  }
}

function vecAngle(ux, uy, vx, vy) {
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  const dot = ux * vx + uy * vy;
  const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
  return sign * Math.acos(Math.max(-1, Math.min(1, dot / (len || 1))));
}

function bezierArcSeg(doc, cx, cy, rx, ry, phi, t1, t2) {
  const alpha = (4 / 3) * Math.tan((t2 - t1) / 4);
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const c1 = Math.cos(t1), s1 = Math.sin(t1);
  const c2 = Math.cos(t2), s2 = Math.sin(t2);

  const ep = (ct, st) => [
    cp * rx * ct - sp * ry * st + cx,
    sp * rx * ct + cp * ry * st + cy,
  ];
  const [, ] = ep(c1, s1);
  const [px2, py2] = ep(c2, s2);

  const d1x = -rx * s1, d1y = ry * c1;
  const d2x = -rx * s2, d2y = ry * c2;

  doc.bezierCurveTo(
    ep(c1, s1)[0] + alpha * (cp * d1x - sp * d1y),
    ep(c1, s1)[1] + alpha * (sp * d1x + cp * d1y),
    px2 - alpha * (cp * d2x - sp * d2y),
    py2 - alpha * (sp * d2x + cp * d2y),
    px2, py2,
  );
}

// ── PDF rendering ───────────────────────────────────────────

function renderChildren(doc, node, resources, fonts) {
  for (const child of getChildren(node)) {
    renderElement(doc, child, resources, fonts);
  }
}

function renderElement(doc, node, resources, fonts) {
  switch (node["#name"]) {
    case "Canvas":
      renderCanvas(doc, node, resources, fonts);
      break;
    case "Path":
      renderPath(doc, node, resources);
      break;
    case "Glyphs":
      renderGlyphs(doc, node, fonts);
      break;
    case "Canvas.Resources":
    case "ResourceDictionary":
      break;
    default:
      renderChildren(doc, node, resources, fonts);
      break;
  }
}

function renderCanvas(doc, node, resources, fonts) {
  doc.save();

  const rt = node.$.RenderTransform;
  if (rt) {
    const m = rt.split(",").map(Number);
    doc.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  }

  const clip = node.$.Clip;
  if (clip) {
    drawPathData(doc, clip);
    doc.clip();
  }

  renderChildren(doc, node, resources, fonts);
  doc.restore();
}

function renderPath(doc, node, resources) {
  const data = node.$.Data;
  if (!data) return;

  const fill = node.$.Fill;
  const stroke = node.$.Stroke;
  if (!fill && !stroke) return;

  const thickness = parseFloat(node.$.StrokeThickness || "1");

  const resMatch = fill && fill.match(/^\{StaticResource\s+(\w+)\}$/);
  if (resMatch) {
    renderImageFill(doc, data, resMatch[1], resources, stroke, node, thickness);
    return;
  }

  doc.save();
  if (stroke) applyStrokeStyle(doc, node, thickness);

  try {
    drawPathData(doc, data);
    if (fill && stroke) {
      doc.fillAndStroke(fill, stroke);
    } else if (fill) {
      doc.fill(fill);
    } else {
      doc.stroke();
    }
  } catch (e) {
    // Skip malformed paths
  }
  doc.restore();
}

function renderImageFill(doc, data, key, resources, stroke, node, thickness) {
  const res = resources[key];
  if (!res || !res.imageBuffer) return;

  doc.save();
  try {
    drawPathData(doc, data);
    doc.clip();

    if (res.transform) {
      const t = res.transform.split(",").map(Number);
      doc.transform(t[0], t[1], t[2], t[3], t[4], t[5]);
    }

    const vp = res.viewport
      ? res.viewport.split(/[\s,]+/).map(Number)
      : [0, 0, 100, 100];
    doc.image(res.imageBuffer, vp[0], vp[1], {
      width: vp[2],
      height: vp[3],
    });
  } catch (e) {
    // Skip problematic image fills
  }
  doc.restore();

  if (stroke) {
    doc.save();
    applyStrokeStyle(doc, node, thickness);
    try {
      drawPathData(doc, data);
      doc.stroke();
    } catch (e) {
      // Skip
    }
    doc.restore();
  }
}

const registeredFonts = new Set();

function renderGlyphs(doc, node, fonts) {
  const text = node.$.UnicodeString;
  if (!text) return;

  const fill = node.$.Fill || "#000000";
  const fontSize = parseFloat(node.$.FontRenderingEmSize || "12");
  const ox = parseFloat(node.$.OriginX || "0");
  const oy = parseFloat(node.$.OriginY || "0");
  const uri = node.$.FontUri;

  doc.save();
  let fontName = "Helvetica";

  if (uri && fonts[uri]) {
    const fontId = "f_" + Buffer.from(uri).toString("hex").slice(0, 20);
    if (!registeredFonts.has(fontId)) {
      try {
        doc.registerFont(fontId, fonts[uri]);
        registeredFonts.add(fontId);
        fontName = fontId;
      } catch {
        // Fallback to Helvetica
      }
    } else {
      fontName = fontId;
    }
  }

  try {
    doc.font(fontName).fontSize(fontSize).fillColor(fill);
    doc.text(text, ox, oy - fontSize * 0.8, { lineBreak: false });
  } catch {
    // Skip problematic glyphs
  }
  doc.restore();
}

// ── Stroke styling ──────────────────────────────────────────

function applyStrokeStyle(doc, node, thickness) {
  doc.strokeColor(node.$.Stroke);
  doc.lineWidth(thickness);

  const cap = (node.$.StrokeEndLineCap || node.$.StrokeStartLineCap || "Flat").toLowerCase();
  doc.lineCap(cap === "round" ? "round" : cap === "square" ? "square" : "butt");

  const join = (node.$.StrokeLineJoin || "Miter").toLowerCase();
  doc.lineJoin(join === "round" ? "round" : join === "bevel" ? "bevel" : "miter");

  const miter = parseFloat(node.$.StrokeMiterLimit || "10");
  doc.miterLimit(miter);

  const dashStr = node.$.StrokeDashArray;
  if (dashStr && dashStr !== "1 0") {
    const dashOffset = parseFloat(node.$.StrokeDashOffset || "0");
    const parts = dashStr.split(/[\s,]+/).map((p) => parseFloat(p) * thickness);
    doc.dash(parts, { phase: Math.abs(dashOffset * thickness) });
  } else {
    doc.undash();
  }
}

// ── Entry point ─────────────────────────────────────────────

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
