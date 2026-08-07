// On-device OCR for warehouse label reading using Tesseract.js (WebAssembly).
// No label images are uploaded or retained — all recognition is performed locally.
// The Tesseract worker is lazily initialized on first use and reused within the session.
//
// Multi-pass strategy:
//   Pass A — Full frame at native resolution (broad coverage)
//   Pass B — Center 50%×50% crop, upscaled to ≥1600 px (main label area, higher detail)
//   Pass C — Upper 40% strip, upscaled to ≥1600 px (Nokia item codes often at label top)
// Candidates from all passes are merged and deduplicated.

export interface OcrPassResult {
  passId:     string;   // 'A' | 'B' | 'C'
  label:      string;   // human-readable description
  rawText:    string;   // exact Tesseract output for this pass
  confidence: number;   // 0–100 from Tesseract
  durationMs: number;
  candidates: string[]; // item type tokens accepted in this pass
}

export interface OcrResult {
  rawText:                string;               // merged text from all passes (separator: \n---\n)
  itemTypeCandidates:     string[];
  partNumberCandidates:   string[];
  serialNumberCandidates: string[];
  confidence:             number;               // average across passes
  source:                 'OCR';
  durationMs:             number;               // wall-clock total
  passes?:                OcrPassResult[];      // per-pass detail for diagnostics
  canvasWidth?:           number;               // source frame dimensions at capture time
  canvasHeight?:          number;
}

export interface ParsedLabelText {
  itemTypes:     string[];
  partNumbers:   string[];
  serialNumbers: string[];
}

// ── Text parsing patterns ─────────────────────────────────────────────────────

// PN label prefixes: "P/N:", "Part No:", "Part Number:", "PN:"
const PN_LABELED_RE = /(?:P\/N|Part\s*N(?:o\.?|umber)?|PN)[:\s]+([A-Z0-9]{3,}(?:[.\-][A-Z0-9]+)+)/gi;
// Nokia PN standalone: 6 digits + uppercase letter + dot + 3 digits (e.g. 474254A.202)
const NOKIA_PN_RE   = /\b(\d{6}[A-Z]\.\d{3})\b/g;

// SN label prefixes: "S/N:", "Serial No:", "Serial Number:", "SN:"
const SN_LABELED_RE = /(?:S\/N|Serial(?:\s*N(?:o\.?|umber)?)?|SN)[:\s]+([A-Z0-9]{6,30})/gi;
// Nokia SN standalone patterns with common Nokia SN prefixes
const NOKIA_SN_RE   = /\b((?:DH|N9|1M)[A-Z0-9]{7,18})\b/g;

// Generic item type token: 3–8 chars starting with a letter, all uppercase alphanumeric.
// Matches Nokia type codes (AHGA, ABIO, FXDA…) and Item Master codes (variable length).
const ITEM_TYPE_TOKEN_RE = /\b([A-Z][A-Z0-9]{2,7})\b/g;

// Nokia equipment type code pattern: exactly 4 uppercase letters, no digits.
// Catches AHGA, ABIO, FXDA, FXEA, etc. without requiring a hardcoded list.
const NOKIA_EQUIP_CODE_RE = /^[A-Z]{4}$/;

// Words that must never be extracted as item type codes.
// Checked BEFORE Item Master lookup so even vocabulary words are rejected if noisy.
const EXCLUDED_TOKENS = new Set([
  // English label noise
  'FROM', 'WITH', 'THIS', 'THAT', 'MADE', 'DATE', 'OVER', 'ALSO',
  'MORE', 'THAN', 'WHEN', 'THEN', 'SOME', 'EACH', 'WILL', 'HAVE',
  'BEEN', 'THEY', 'THEM', 'MAKE', 'TAKE', 'GIVE', 'SHOW', 'KNOW',
  // Nokia brand / geography / generic hardware words
  'NOKIA', 'CHINA', 'NETWORKS', 'SOLUTIONS', 'SYSTEMS', 'OUTDOOR',
  'INDOOR', 'VENDOR', 'INTL', 'CORP', 'ORIG', 'ASSY', 'OPER',
  // Shipping / freight label words (must not false-positive as Nokia type codes)
  'CARE', 'SIDE', 'KEEP', 'COOL', 'HAND', 'FRAG', 'PACK', 'LIFT',
  'PUSH', 'PULL', 'STOP', 'READ', 'SIGN', 'NOTE', 'WARD', 'HOLD',
  // Item field label words
  'PART', 'SERIAL', 'NUMBER', 'TYPE', 'UNIT', 'CODE', 'ITEM', 'BAND',
  'PROD', 'TECH', 'SPEC', 'DATA', 'INFO',
  // OCR / standards noise
  'EAC', 'ROHS', 'WEEE', 'CERT',
]);

// ── Pure text parser — testable without Tesseract ────────────────────────────

export function parseLabel(text: string, itemTypeCodes: Set<string>): ParsedLabelText {
  const upper = text.toUpperCase();
  const itemTypes = new Set<string>();

  // Generic candidate extraction:
  //   1. Token 3–8 chars starting with [A-Z], all [A-Z0-9]
  //   2. Reject noise words
  //   3. Accept if in Item Master vocabulary (HIGH confidence)
  //   4. Accept if matches Nokia 4-letter equipment code pattern (MEDIUM confidence)
  //      — all-uppercase 4-letter codes: AHGA, ABIO, FXDA, FXEA, etc.
  for (const m of upper.matchAll(ITEM_TYPE_TOKEN_RE)) {
    const tok = m[1];
    if (EXCLUDED_TOKENS.has(tok)) continue;
    if (itemTypeCodes.has(tok)) {
      itemTypes.add(tok);
    } else if (NOKIA_EQUIP_CODE_RE.test(tok)) {
      itemTypes.add(tok);
    }
  }

  const partNumbers = new Set<string>();
  for (const m of text.matchAll(PN_LABELED_RE)) {
    const pn = m[1].trim();
    if (pn.length >= 5) partNumbers.add(pn.toUpperCase());
  }
  for (const m of text.matchAll(NOKIA_PN_RE)) {
    partNumbers.add(m[1].toUpperCase());
  }

  const serialNumbers = new Set<string>();
  for (const m of text.matchAll(SN_LABELED_RE)) {
    const sn = m[1].trim();
    if (sn.length >= 6) serialNumbers.add(sn.toUpperCase());
  }
  for (const m of text.matchAll(NOKIA_SN_RE)) {
    serialNumbers.add(m[1].toUpperCase());
  }

  return {
    itemTypes:     [...itemTypes],
    partNumbers:   [...partNumbers],
    serialNumbers: [...serialNumbers],
  };
}

// ── Frame capture ─────────────────────────────────────────────────────────────

export function captureVideoFrame(video: HTMLVideoElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// ── Canvas utilities ──────────────────────────────────────────────────────────

// Crop a rectangular region from src (by fraction of dimensions) into a new canvas.
// Does NOT modify src — caller must discard src separately.
function cropRegion(
  src: HTMLCanvasElement,
  xf: number, yf: number,
  wf: number, hf: number,
): HTMLCanvasElement {
  const sx = Math.round(src.width  * xf);
  const sy = Math.round(src.height * yf);
  const sw = Math.max(1, Math.round(src.width  * wf));
  const sh = Math.max(1, Math.round(src.height * hf));
  const dst = document.createElement('canvas');
  dst.width  = sw;
  dst.height = sh;
  const ctx = dst.getContext('2d');
  if (ctx) ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  return dst;
}

// Preprocess for Tesseract: upscale to targetWidth (min), convert to grayscale,
// apply contrast stretch. Returns a NEW canvas — caller discards it after OCR.
function preprocessCanvas(src: HTMLCanvasElement, targetWidth = 1200): HTMLCanvasElement {
  const dst = document.createElement('canvas');
  // Use ceil so ROI crops smaller than targetWidth are always upscaled
  const scale = Math.max(1, Math.min(4, Math.ceil(targetWidth / Math.max(src.width, 1))));
  dst.width  = src.width  * scale;
  dst.height = src.height * scale;

  const ctx = dst.getContext('2d')!;
  ctx.imageSmoothingEnabled = scale > 1;
  ctx.drawImage(src, 0, 0, dst.width, dst.height);

  const imgData = ctx.getImageData(0, 0, dst.width, dst.height);
  const d = imgData.data;

  // Find luminance range for contrast stretch
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (lum < lo) lo = lum;
    if (lum > hi) hi = lum;
  }
  const range = hi - lo || 1;

  // Grayscale + contrast stretch
  for (let i = 0; i < d.length; i += 4) {
    const lum = Math.round(
      (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] - lo) / range * 255
    );
    const v = Math.max(0, Math.min(255, lum));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
  return dst;
}

// ── Tesseract.js worker singleton ─────────────────────────────────────────────

interface OcrWorker {
  recognize(img: HTMLCanvasElement): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<unknown>;
}

let workerPromise: Promise<OcrWorker> | null = null;

function getOcrWorker(): Promise<OcrWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      // Tesseract.js v7 ships as CJS. Cast via unknown to avoid battling export= types.
      const mod = await import('tesseract.js') as unknown as {
        createWorker: (lang: string) => Promise<OcrWorker>;
        default?: { createWorker: (lang: string) => Promise<OcrWorker> };
      };
      const fn = mod.createWorker ?? mod.default?.createWorker;
      if (typeof fn !== 'function') throw new Error('tesseract.js: createWorker not found');
      return fn('eng');
    })();
  }
  return workerPromise;
}

// ── Core OCR runner (private) ─────────────────────────────────────────────────
// Preprocesses the canvas at targetWidth, runs Tesseract, discards the processed copy.
// Does NOT discard the source canvas — caller manages source lifecycle.

async function runOcrOnCanvas(
  canvas: HTMLCanvasElement,
  targetWidth = 1200,
): Promise<{ text: string; confidence: number; durationMs: number }> {
  const t0 = Date.now();
  const processed = preprocessCanvas(canvas, targetWidth);
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(processed);
  processed.width = 0; processed.height = 0; // discard preprocessed copy immediately
  return { text: data.text, confidence: Math.round(data.confidence), durationMs: Date.now() - t0 };
}

// ── Public: Multi-pass OCR on a pre-captured canvas ───────────────────────────
// Three passes with increasing ROI focus:
//   A  Full frame (broad coverage, lower per-character resolution)
//   B  Center 50%×50% crop upscaled to 1600 px (label typically centred)
//   C  Upper 40% strip upscaled to 1600 px (Nokia item codes at top of label)
// Candidates and fields from all passes are merged and deduplicated.
// The canvas is DISCARDED inside this function — do not reuse after calling.

export async function ocrCanvasFrame(
  canvas: HTMLCanvasElement,
  itemTypeCodes: Set<string>,
): Promise<OcrResult> {
  const t0 = Date.now();
  const canvasWidth  = canvas.width;
  const canvasHeight = canvas.height;

  const passes: OcrPassResult[]  = [];
  const allTypes   = new Set<string>();
  const allPNs     = new Set<string>();
  const allSNs     = new Set<string>();
  const rawTexts: string[] = [];
  let sumConf = 0;

  // ── Pass A: Full frame ───────────────────────────────────────────────────
  {
    const pt = Date.now();
    const { text, confidence } = await runOcrOnCanvas(canvas, 1200);
    const parsed = parseLabel(text, itemTypeCodes);
    parsed.itemTypes.forEach(t => allTypes.add(t));
    parsed.partNumbers.forEach(p => allPNs.add(p));
    parsed.serialNumbers.forEach(s => allSNs.add(s));
    rawTexts.push(text);
    sumConf += confidence;
    passes.push({
      passId: 'A', label: 'Full frame',
      rawText: text, confidence, durationMs: Date.now() - pt,
      candidates: parsed.itemTypes,
    });
  }

  // ── Pass B: Center 50%×50% crop — label usually centred in frame ─────────
  {
    const pt = Date.now();
    const crop = cropRegion(canvas, 0.25, 0.25, 0.5, 0.5);
    const { text, confidence } = await runOcrOnCanvas(crop, 1600);
    crop.width = 0; crop.height = 0;
    const parsed = parseLabel(text, itemTypeCodes);
    parsed.itemTypes.forEach(t => allTypes.add(t));
    parsed.partNumbers.forEach(p => allPNs.add(p));
    parsed.serialNumbers.forEach(s => allSNs.add(s));
    rawTexts.push(text);
    sumConf += confidence;
    passes.push({
      passId: 'B', label: 'Center 50%',
      rawText: text, confidence, durationMs: Date.now() - pt,
      candidates: parsed.itemTypes,
    });
  }

  // ── Pass C: Upper 40% strip — Nokia item codes printed above DataMatrix ───
  {
    const pt = Date.now();
    const crop = cropRegion(canvas, 0, 0, 1, 0.4);
    const { text, confidence } = await runOcrOnCanvas(crop, 1600);
    crop.width = 0; crop.height = 0;
    const parsed = parseLabel(text, itemTypeCodes);
    parsed.itemTypes.forEach(t => allTypes.add(t));
    parsed.partNumbers.forEach(p => allPNs.add(p));
    parsed.serialNumbers.forEach(s => allSNs.add(s));
    rawTexts.push(text);
    sumConf += confidence;
    passes.push({
      passId: 'C', label: 'Upper 40%',
      rawText: text, confidence, durationMs: Date.now() - pt,
      candidates: parsed.itemTypes,
    });
  }

  // Discard source canvas — no label images are retained after OCR
  canvas.width  = 0;
  canvas.height = 0;

  return {
    rawText:                rawTexts.join('\n\n---\n\n'),
    itemTypeCandidates:     [...allTypes],
    partNumberCandidates:   [...allPNs],
    serialNumberCandidates: [...allSNs],
    confidence:             Math.round(sumConf / passes.length),
    source:                 'OCR',
    durationMs:             Date.now() - t0,
    passes,
    canvasWidth,
    canvasHeight,
  };
}

// ── Public: OCR from live video (manual fallback) ─────────────────────────────

export async function readLabel(
  video: HTMLVideoElement,
  itemTypeCodes: Set<string>,
): Promise<OcrResult> {
  const canvas = captureVideoFrame(video);
  return ocrCanvasFrame(canvas, itemTypeCodes); // canvas discarded inside
}

// Call on component unmount to release WebAssembly memory
export function terminateOcrWorker(): void {
  if (workerPromise) {
    workerPromise.then(w => w.terminate()).catch(() => {});
    workerPromise = null;
  }
}
