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

// Known Nokia equipment type codes printed on physical carton labels
const NOKIA_TYPE_RE = /\b(ABIO|FXDA|FXEA|AHIB|ASIA|ABIA|FHEA|FGEA|FCEA|FCEB|FPGA|SRIA|AHEC|FSMF)\b/gi;

// PN label prefixes: "P/N:", "Part No:", "Part Number:", "PN:"
const PN_LABELED_RE = /(?:P\/N|Part\s*N(?:o\.?|umber)?|PN)[:\s]+([A-Z0-9]{3,}(?:[.\-][A-Z0-9]+)+)/gi;
// Nokia PN standalone: 6 digits + uppercase letter + dot + 3 digits (e.g. 474254A.202)
const NOKIA_PN_RE   = /\b(\d{6}[A-Z]\.\d{3})\b/g;

// SN label prefixes: "S/N:", "Serial No:", "Serial Number:", "SN:"
const SN_LABELED_RE = /(?:S\/N|Serial(?:\s*N(?:o\.?|umber)?)?|SN)[:\s]+([A-Z0-9]{6,30})/gi;
// Nokia SN standalone patterns with common Nokia SN prefixes
const NOKIA_SN_RE   = /\b((?:DH|N9|1M)[A-Z0-9]{7,18})\b/g;

// Common label words that are NOT item type codes — excluded from Item Master token matching
const EXCLUDED_TOKENS = new Set([
  'FROM', 'WITH', 'THIS', 'THAT', 'MADE', 'NOKIA', 'CHINA', 'DATE',
  'PART', 'SERIAL', 'NUMBER', 'TYPE', 'UNIT', 'CODE', 'ITEM', 'BAND',
  'PROD', 'ASSY', 'OPER', 'TECH', 'CORP', 'INTL', 'ORIG',
]);

// ── Pure text parser — testable without Tesseract ────────────────────────────

export function parseLabel(text: string, itemTypeCodes: Set<string>): ParsedLabelText {
  const upper = text.toUpperCase();
  const itemTypes = new Set<string>();

  // Match known Nokia type codes (case-insensitive, word-boundary anchored)
  for (const m of upper.matchAll(NOKIA_TYPE_RE)) {
    itemTypes.add(m[1]);
  }

  // Match 4+ char all-caps tokens against Item Master vocabulary
  for (const tok of upper.split(/\W+/)) {
    if (
      tok.length >= 4 &&
      /^[A-Z][A-Z0-9]+$/.test(tok) &&
      !EXCLUDED_TOKENS.has(tok) &&
      itemTypeCodes.has(tok)
    ) {
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

// ── Tesseract.js worker singleton ─────────────────────────────────────────────
// Minimal interface describing only what we call on the worker.

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

// ── Public OCR entry point ────────────────────────────────────────────────────

export async function readLabel(
  video: HTMLVideoElement,
  itemTypeCodes: Set<string>,
): Promise<OcrResult> {
  const t0     = Date.now();
  const canvas = captureVideoFrame(video);

  const worker = await getOcrWorker();
  const { data } = await worker.recognize(canvas);

  // Discard the captured frame immediately — no label images are retained
  canvas.width  = 0;
  canvas.height = 0;

  const parsed = parseLabel(data.text, itemTypeCodes);

  return {
    rawText:                data.text,
    itemTypeCandidates:     parsed.itemTypes,
    partNumberCandidates:   parsed.partNumbers,
    serialNumberCandidates: parsed.serialNumbers,
    confidence:             Math.round(data.confidence),
    source:                 'OCR',
    durationMs:             Date.now() - t0,
  };
}

// Call on component unmount to release WebAssembly memory
export function terminateOcrWorker(): void {
  if (workerPromise) {
    workerPromise.then(w => w.terminate()).catch(() => {});
    workerPromise = null;
  }
}
