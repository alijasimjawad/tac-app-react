// On-device OCR for warehouse label reading using Tesseract.js (WebAssembly).
// No label images are uploaded or retained — all recognition is performed locally.
// The Tesseract worker is lazily initialized on first use and reused within the session.

export interface OcrResult {
  rawText:                string;
  itemTypeCandidates:     string[];
  partNumberCandidates:   string[];
  serialNumberCandidates: string[];
  confidence:             number;   // 0–100 from Tesseract
  source:                 'OCR';
  durationMs:             number;
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

// Generic item type token: 3–8 chars, starts with letter, all uppercase alphanumeric
const ITEM_TYPE_TOKEN_RE = /\b([A-Z][A-Z0-9]{2,7})\b/g;

// Nokia equipment type code pattern: exactly 4 uppercase letters (AHGA, ABIO, FXDA…)
// No digits — distinguishes codes from alphanumeric SNs/PNs
const NOKIA_EQUIP_CODE_RE = /^[A-Z]{4}$/;

// Common label words that must NOT be extracted as item type codes.
// Checked before Item Master lookup so vocabulary entries that are also noise words
// (e.g. MADE, NOKIA) are still rejected.
const EXCLUDED_TOKENS = new Set([
  // English label noise
  'FROM', 'WITH', 'THIS', 'THAT', 'MADE', 'DATE', 'OVER', 'ALSO',
  'MORE', 'THAN', 'WHEN', 'THEN', 'SOME', 'EACH', 'WILL', 'HAVE',
  'BEEN', 'THEY', 'THEM', 'MAKE', 'TAKE', 'GIVE', 'SHOW', 'KNOW',
  // Nokia brand / geography / generic hardware words
  'NOKIA', 'CHINA', 'NETWORKS', 'SOLUTIONS', 'SYSTEMS', 'OUTDOOR',
  'INDOOR', 'VENDOR', 'INTL', 'CORP', 'ORIG', 'ASSY', 'OPER',
  // Shipping / freight label words
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
  //   1. Token 3–8 chars starting with letter (catches AHGA, ABIO, etc.)
  //   2. Reject known noise words
  //   3. Add if in Item Master vocabulary (HIGH confidence)
  //   4. OR if it matches Nokia 4-letter equipment code pattern (MEDIUM confidence)
  //      — these are all-uppercase 4-letter codes like AHGA, ABIO, FXDA
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

// ── Image preprocessing ───────────────────────────────────────────────────────
// Upscales if too small, converts to grayscale, and stretches contrast.
// Better Tesseract accuracy on phone camera frames (often low-contrast, small).
// The returned canvas is a NEW canvas — caller must discard it after OCR.

function preprocessCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const dst = document.createElement('canvas');
  // Upscale to at least 1200 px wide for Tesseract accuracy; cap at 3×
  const scale = Math.max(1, Math.min(3, Math.round(1200 / Math.max(src.width, 1))));
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
    // alpha (d[i+3]) unchanged
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

async function runOcrOnCanvas(
  canvas: HTMLCanvasElement,
): Promise<{ text: string; confidence: number; durationMs: number }> {
  const t0 = Date.now();
  const processed = preprocessCanvas(canvas);
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(processed);
  processed.width = 0; processed.height = 0; // discard preprocessed copy
  return { text: data.text, confidence: Math.round(data.confidence), durationMs: Date.now() - t0 };
}

// ── Public: OCR on a pre-captured canvas (Phase B auto-capture flow) ──────────
// The caller captures the frame synchronously at barcode-decode time, then passes
// the canvas here for async processing. Caller must NOT reuse or discard the
// canvas before this returns — this function discards it after OCR.

export async function ocrCanvasFrame(
  canvas: HTMLCanvasElement,
  itemTypeCodes: Set<string>,
): Promise<OcrResult> {
  const { text, confidence, durationMs } = await runOcrOnCanvas(canvas);
  // Discard source frame immediately — no label images are retained
  canvas.width = 0; canvas.height = 0;
  const parsed = parseLabel(text, itemTypeCodes);
  return {
    rawText:                text,
    itemTypeCandidates:     parsed.itemTypes,
    partNumberCandidates:   parsed.partNumbers,
    serialNumberCandidates: parsed.serialNumbers,
    confidence,
    source:    'OCR',
    durationMs,
  };
}

// ── Public: OCR from live video (manual fallback) ─────────────────────────────
// Captures a frame from the video element, runs preprocessing, then OCR.
// Use ocrCanvasFrame() instead when you need to capture at barcode-decode time.

export async function readLabel(
  video: HTMLVideoElement,
  itemTypeCodes: Set<string>,
): Promise<OcrResult> {
  const canvas = captureVideoFrame(video);
  return ocrCanvasFrame(canvas, itemTypeCodes);
}

// Call on component unmount to release WebAssembly memory
export function terminateOcrWorker(): void {
  if (workerPromise) {
    workerPromise.then(w => w.terminate()).catch(() => {});
    workerPromise = null;
  }
}
