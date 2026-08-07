// On-device OCR for warehouse label reading using Tesseract.js (WebAssembly).
// No label images are uploaded or retained — all recognition is performed locally.
// The Tesseract worker is lazily initialized on first use and reused within the session.
//
// Multi-pass strategy:
//   Pass A — Full frame at native resolution (broad coverage)
//   Pass B — Center 50%×50% crop, upscaled to ≥1600 px (main label area, higher detail)
//   Pass C — Upper 40% strip, upscaled to ≥1600 px (Nokia item codes often at label top)
//   Pass D — Upper-right 50%×40% crop, upscaled to ≥1600 px (item-type area on Nokia labels)
// Candidates from all passes are merged, fuzzy-noise-filtered, scored and deduplicated.
// The winner is selected by composite score; ambiguity is surfaced rather than guessed.

export interface OcrPassResult {
  passId:     string;   // 'A' | 'B' | 'C' | 'D'
  label:      string;   // human-readable description
  rawText:    string;   // exact Tesseract output for this pass
  confidence: number;   // 0–100 from Tesseract
  durationMs: number;
  candidates: string[]; // accepted item type tokens in this pass
}

// Per-candidate scoring detail — exposed in diagnostics so operators can see why
// a code was accepted or rejected.
export interface OcrCandidateDetail {
  text:               string;
  passes:             string[];       // pass IDs ('A'/'B'/'C'/'D') where this token appeared
  inItemMaster:       boolean;
  score:              number;         // composite score; -1000 for noise-rejected
  accepted:           boolean;
  noiseRejected:      boolean;
  rejectionReason?:   string;
  // Diagnostics — populated for every accepted candidate
  maxConf:            number;         // highest Tesseract confidence where this token appeared
  nearestMasterCode:  string | null;  // closest Item Master code by confusable-char distance
  nearestMasterDist:  number | null;  // 0=exact match, 1=one confusable sub; null=no close match
  correctedToMaster:  string | null;  // the master code this token uniquely maps to (dist=1, unique)
  decisionReason:     string;         // human-readable explanation of accept/reject/correction
}

export interface OcrResult {
  rawText:                string;                // merged text from all passes (separator: \n---\n)
  itemTypeCandidates:     string[];              // accepted candidates (backward-compat list)
  selectedItemType:       string | null;         // ranked winner after scoring; null if ambiguous/none
  candidateDetails:       OcrCandidateDetail[];  // full scoring breakdown for diagnostics
  isItemTypeAmbiguous:    boolean;               // true when multiple plausible candidates tie
  partNumberCandidates:   string[];
  serialNumberCandidates: string[];
  confidence:             number;                // average across passes
  source:                 'OCR';
  durationMs:             number;                // wall-clock total
  passes?:                OcrPassResult[];       // per-pass detail for diagnostics
  canvasWidth?:           number;                // source frame dimensions at capture time
  canvasHeight?:          number;
}

export interface ParsedLabelText {
  itemTypes:       string[];
  partNumbers:     string[];
  serialNumbers:   string[];
  rejectedTokens?: Array<{ text: string; reason: string }>; // noise tokens seen per pass
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
const ITEM_TYPE_TOKEN_RE = /\b([A-Z][A-Z0-9]{2,7})\b/g;

// Nokia equipment type code pattern: exactly 4 uppercase letters, no digits.
const NOKIA_EQUIP_CODE_RE = /^[A-Z]{4}$/;

// Words that must never be extracted as item type codes (checked first, before Item Master).
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

// ── OCR character confusion model ─────────────────────────────────────────────
// Common OCR character substitutions observed in Tesseract output on dark/low-contrast
// warehouse label text.  Used only for candidate→Item-Master correction; NOT used to
// alter raw OCR token extraction or noise rejection paths.

const CONFUSABLE_PAIRS: Array<[string, string]> = [
  ['H', 'R'], ['B', '8'], ['I', '1'], ['O', '0'],
  ['G', '6'], ['S', '5'], ['Z', '2'],
];

// Returns the number of confusable-pair substitutions needed to transform a into b.
// Returns Infinity if lengths differ or any position differs by a non-confusable pair
// (meaning a cannot be OCR-corrected to b through the confusable model).
function confusionDistance(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const confusable = CONFUSABLE_PAIRS.some(
      ([x, y]) => (a[i] === x && b[i] === y) || (a[i] === y && b[i] === x)
    );
    if (!confusable) return Infinity;
    d++;
  }
  return d;
}

// Find all Item Master codes within confusionDistance ≤ maxDist of token.
// Returns matches sorted by distance ascending.
function findConfusionMatches(
  token: string,
  itemTypeCodes: Set<string>,
  maxDist: number,
): Array<{ code: string; dist: number }> {
  const matches: Array<{ code: string; dist: number }> = [];
  for (const code of itemTypeCodes) {
    const d = confusionDistance(token, code);
    if (d <= maxDist) matches.push({ code, dist: d });
  }
  return matches.sort((a, b) => a.dist - b.dist);
}

// ── Fuzzy noise rejection ─────────────────────────────────────────────────────
// Catches OCR-corrupted variants of known brand/country/compliance words that
// are not caught by the EXCLUDED_TOKENS exact list (e.g. OKIA from NOKIA when
// the leading N is dropped; N0KIA/NOK1A handled by 0→O/1→I normalization).
//
// Applied ONLY to Nokia 4-letter code candidates — Item Master matches bypass this
// filter because they are already confirmed vocabulary.
//
// Conservative approach: three checks in order of increasing permissiveness.
//   1. Exact match after digit/letter confusable substitution (0→O, 1→I)
//   2. Token is a contiguous substring of a noise word (catches dropped-char reads)
//   3. Same-length hamming distance ≤ 1 (catches single-char corruption)

const FUZZY_NOISE_WORDS = [
  'NOKIA', 'CHINA', 'MADE', 'NETWORK', 'NETWORKS',
  'SOLUTIONS', 'SIDE', 'CARE', 'CE', 'EAC', 'ROHS', 'WEEE', 'CERT',
];

// Exported for unit tests
export function normalizeOcr(s: string): string {
  return s.replace(/0/g, 'O').replace(/1/g, 'I');
}

function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// Returns a rejection reason string if the token is fuzzy-noise, or null if clean.
// Exported for unit tests.
export function fuzzyNoiseCheck(token: string): string | null {
  const norm = normalizeOcr(token); // token is already uppercase from parseLabel
  for (const nw of FUZZY_NOISE_WORDS) {
    const normNw = normalizeOcr(nw);
    // 1. Exact match after 0→O / 1→I substitution (catches N0KIA, NOK1A)
    if (norm === normNw) return `normalized match "${nw}"`;
    // 2. Token is a contiguous ≥3-char substring of noise word (catches OKIA ⊂ NOKIA, NOKI ⊂ NOKIA)
    if (norm.length >= 3 && norm.length < normNw.length && normNw.includes(norm)) {
      return `partial read of "${nw}"`;
    }
    // 3. Same-length, hamming distance 1 (catches CHLNA vs CHINA)
    if (norm.length === normNw.length && hammingDistance(norm, normNw) <= 1) {
      return `1-char corruption of "${nw}"`;
    }
  }
  return null;
}

// ── Pure text parser — testable without Tesseract ────────────────────────────

export function parseLabel(text: string, itemTypeCodes: Set<string>): ParsedLabelText {
  const upper = text.toUpperCase();
  const itemTypes     = new Set<string>();
  const rejectedTokens: Array<{ text: string; reason: string }> = [];

  for (const m of upper.matchAll(ITEM_TYPE_TOKEN_RE)) {
    const tok = m[1];
    // 1. Hard-excluded noise words (highest priority — bypasses Item Master)
    if (EXCLUDED_TOKENS.has(tok)) {
      rejectedTokens.push({ text: tok, reason: 'excluded token' });
      continue;
    }
    // 2. Item Master vocabulary — always accepted (known-good codes)
    if (itemTypeCodes.has(tok)) {
      itemTypes.add(tok);
      continue;
    }
    // 3. Nokia 4-letter equipment code pattern — accept only if not fuzzy-noise
    if (NOKIA_EQUIP_CODE_RE.test(tok)) {
      const noiseReason = fuzzyNoiseCheck(tok);
      if (noiseReason) {
        rejectedTokens.push({ text: tok, reason: noiseReason });
      } else {
        itemTypes.add(tok);
      }
    }
    // Other token lengths/patterns: silently ignored
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
    rejectedTokens,
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

// ── Candidate scoring ─────────────────────────────────────────────────────────
// Scores cross-pass item-type candidates from all OCR passes.
//
// Score breakdown:
//   +100  exact match in Item Master (confirmed vocabulary)
//   + 70  unique confusion-correctable to exactly one Item Master code (H↔R etc.)
//   +  5  Nokia 4-letter equipment code pattern (^[A-Z]{4}$), unknown word only
//          (deliberately low — prevents unknown words from beating Item Master codes)
//   + 10  each additional pass the token appears in (multi-pass consensus)
//   + 15  detected in Pass D (upper-right region — Nokia label item-type area)
//   0–10  OCR confidence contribution (maxConf / 10, rounded)
//   -1000 noise-rejected (effectively eliminates the candidate)
//
// Selection policy (see selectBestItemType):
//   1. Exact Item Master candidate → always selected unless tied with another master
//   2. Unique confusion-corrected → return the corrected master code
//   3. Unknown word in Pass D or 2+ passes → selected if gap ≥ 15 over second
//   4. Unknown word in single non-D pass → never auto-selected (insufficient evidence)

interface PassCandidateData {
  passes:  string[];
  maxConf: number; // highest pass-level confidence where this token appeared
}

function computeScore(
  text: string,
  data: PassCandidateData,
  inItemMaster: boolean,
  correctedToMaster: string | null,
): number {
  let score = 0;
  if (inItemMaster) {
    score += 100;
  } else if (correctedToMaster) {
    score += 70;  // unique confusion correction to Item Master — strong but below exact match
  } else if (/^[A-Z]{4}$/.test(text)) {
    score += 5;   // unknown 4-letter word — very weak signal only
  }
  score += (data.passes.length - 1) * 10;    // multi-pass consensus bonus
  if (data.passes.includes('D')) score += 15; // upper-right ROI — Nokia item-type area
  score += Math.round(data.maxConf / 10);     // 0–10 pts from OCR confidence
  return score;
}

function buildCandidateDetails(
  accepted: Map<string, PassCandidateData>,
  rejected: Map<string, { passes: string[]; reason: string }>,
  itemTypeCodes: Set<string>,
): OcrCandidateDetail[] {
  const details: OcrCandidateDetail[] = [];

  for (const [text, data] of accepted) {
    const inItemMaster = itemTypeCodes.has(text);

    // Confusion correction — only for unknown candidates not already in Item Master
    let correctedToMaster: string | null = null;
    let nearestMasterCode: string | null = null;
    let nearestMasterDist: number | null = null;

    if (inItemMaster) {
      nearestMasterCode = text;
      nearestMasterDist = 0;
    } else {
      const matches = findConfusionMatches(text, itemTypeCodes, 1);
      if (matches.length > 0) {
        nearestMasterCode = matches[0].code;
        nearestMasterDist = matches[0].dist;
        // Unique correction: exactly one Item Master code reachable by one confusable substitution
        if (matches.length === 1 && matches[0].dist === 1) {
          correctedToMaster = matches[0].code;
        }
        // Multiple matches at dist 1 → ambiguous correction, do not auto-correct
      }
    }

    const score = computeScore(text, data, inItemMaster, correctedToMaster);

    // Human-readable reason for diagnostics
    let decisionReason: string;
    if (inItemMaster) {
      decisionReason = 'exact Item Master match';
    } else if (correctedToMaster) {
      const roiNote = data.passes.includes('D') ? ' [upper-right ROI]' : '';
      decisionReason = `OCR correction of ${correctedToMaster} via confusable char${roiNote}`;
    } else if (data.passes.includes('D')) {
      decisionReason = 'upper-right ROI (Nokia item-type area)';
    } else if (data.passes.length >= 2) {
      decisionReason = `multi-pass consensus (${data.passes.join(',')})`;
    } else {
      decisionReason = 'insufficient evidence — single non-ROI-D pass';
    }

    details.push({
      text, passes: [...data.passes], inItemMaster, score,
      accepted: true, noiseRejected: false,
      maxConf: data.maxConf,
      nearestMasterCode,
      nearestMasterDist,
      correctedToMaster,
      decisionReason,
    });
  }

  for (const [text, { passes, reason }] of rejected) {
    details.push({
      text, passes: [...passes], inItemMaster: false, score: -1000,
      accepted: false, noiseRejected: true, rejectionReason: reason,
      maxConf: 0,
      nearestMasterCode: null,
      nearestMasterDist: null,
      correctedToMaster: null,
      decisionReason: `noise rejected: ${reason}`,
    });
  }

  // Sort: accepted first (by score desc), then rejected
  details.sort((a, b) => {
    if (a.accepted !== b.accepted) return a.accepted ? -1 : 1;
    return b.score - a.score;
  });
  return details;
}

// Select the best item-type candidate from scored details.
// Exported so unit tests can call it directly without browser/canvas.
//
// Decision priority:
//   1. Exact Item Master match → auto-select unless tied with another master code
//   2. Unique confusion-correction to Item Master → return the CORRECTED master code
//   3. Unknown word in Pass D or 2+ passes → auto-select if score gap ≥ 15
//   4. Unknown word in single non-D pass → null (insufficient evidence, not ambiguous)
//
// "Wrong auto-assignment is worse than requiring review."
export function selectBestItemType(
  details: OcrCandidateDetail[],
): { selectedItemType: string | null; isItemTypeAmbiguous: boolean } {
  const acc = details.filter(d => d.accepted).sort((a, b) => b.score - a.score);
  if (acc.length === 0) return { selectedItemType: null, isItemTypeAmbiguous: false };

  const top    = acc[0];
  const second = acc.length > 1 ? acc[1] : null;

  // Case 1: Exact Item Master match
  if (top.inItemMaster) {
    if (!second || !second.inItemMaster || top.score - second.score >= 15) {
      return { selectedItemType: top.text, isItemTypeAmbiguous: false };
    }
    // Two Item Master codes with close scores — cannot decide
    return { selectedItemType: null, isItemTypeAmbiguous: true };
  }

  // Case 2: Unique confusion-correction to Item Master — return the corrected master code
  if (top.correctedToMaster) {
    if (!second || top.score - second.score >= 15) {
      return { selectedItemType: top.correctedToMaster, isItemTypeAmbiguous: false };
    }
    // Another candidate is too close — ambiguous
    return { selectedItemType: null, isItemTypeAmbiguous: true };
  }

  // Case 3: Unknown word — require spatial (Pass D) or multi-pass evidence
  const hasPassD  = top.passes.includes('D');
  const multiPass = top.passes.length >= 2;

  if (hasPassD || multiPass) {
    if (!second || top.score - second.score >= 15) {
      return { selectedItemType: top.text, isItemTypeAmbiguous: false };
    }
    return { selectedItemType: null, isItemTypeAmbiguous: true };
  }

  // Case 4: Unknown word, single non-D pass — insufficient evidence
  // Return null WITHOUT flagging ambiguous (we simply didn't see enough to decide)
  return { selectedItemType: null, isItemTypeAmbiguous: false };
}

// ── Public: Multi-pass OCR on a pre-captured canvas ───────────────────────────
// Four passes with increasing ROI focus:
//   A  Full frame (broad coverage, lower per-character resolution)
//   B  Center 50%×50% crop upscaled to 1600 px (label typically centred)
//   C  Upper 40% strip upscaled to 1600 px (Nokia item codes at top of label)
//   D  Upper-right 50%×40% crop upscaled to 1600 px (item-type area on Nokia labels)
// Candidates from all passes are cross-referenced, scored, and ranked.
// The canvas is DISCARDED inside this function — do not reuse after calling.

export async function ocrCanvasFrame(
  canvas: HTMLCanvasElement,
  itemTypeCodes: Set<string>,
): Promise<OcrResult> {
  const t0 = Date.now();
  const canvasWidth  = canvas.width;
  const canvasHeight = canvas.height;

  const passes: OcrPassResult[] = [];
  const allPNs     = new Set<string>();
  const allSNs     = new Set<string>();
  const rawTexts: string[] = [];
  let sumConf = 0;

  // Cross-pass candidate tracking: token → { passes[], maxConf }
  const acceptedMap = new Map<string, PassCandidateData>();
  const rejectedMap = new Map<string, { passes: string[]; reason: string }>();

  function recordPass(
    passId: string,
    label:  string,
    text:   string,
    confidence: number,
    durationMs: number,
    parsed: ParsedLabelText,
  ): void {
    for (const tok of parsed.itemTypes) {
      const ex = acceptedMap.get(tok) ?? { passes: [], maxConf: 0 };
      if (!ex.passes.includes(passId)) ex.passes.push(passId);
      ex.maxConf = Math.max(ex.maxConf, confidence);
      acceptedMap.set(tok, ex);
    }
    for (const r of parsed.rejectedTokens ?? []) {
      if (!rejectedMap.has(r.text)) rejectedMap.set(r.text, { passes: [], reason: r.reason });
      const rec = rejectedMap.get(r.text)!;
      if (!rec.passes.includes(passId)) rec.passes.push(passId);
    }
    for (const p of parsed.partNumbers)   allPNs.add(p);
    for (const s of parsed.serialNumbers) allSNs.add(s);
    rawTexts.push(text);
    sumConf += confidence;
    passes.push({ passId, label, rawText: text, confidence, durationMs, candidates: parsed.itemTypes });
  }

  // ── Pass A: Full frame ───────────────────────────────────────────────────
  {
    const pt = Date.now();
    const { text, confidence } = await runOcrOnCanvas(canvas, 1200);
    recordPass('A', 'Full frame', text, confidence, Date.now() - pt, parseLabel(text, itemTypeCodes));
  }

  // ── Pass B: Center 50%×50% crop — label usually centred in frame ─────────
  {
    const pt = Date.now();
    const crop = cropRegion(canvas, 0.25, 0.25, 0.5, 0.5);
    const { text, confidence } = await runOcrOnCanvas(crop, 1600);
    crop.width = 0; crop.height = 0;
    recordPass('B', 'Center 50%×50%', text, confidence, Date.now() - pt, parseLabel(text, itemTypeCodes));
  }

  // ── Pass C: Upper 40% strip — Nokia item codes at top of label ───────────
  {
    const pt = Date.now();
    const crop = cropRegion(canvas, 0, 0, 1, 0.4);
    const { text, confidence } = await runOcrOnCanvas(crop, 1600);
    crop.width = 0; crop.height = 0;
    recordPass('C', 'Upper 40%', text, confidence, Date.now() - pt, parseLabel(text, itemTypeCodes));
  }

  // ── Pass D: Upper-right 50%×40% — item-type area on Nokia labels ─────────
  // Nokia hardware labels typically print the equipment code (AHGA, ABIO…) in
  // the upper-right quadrant, with the DataMatrix below it.
  {
    const pt = Date.now();
    const crop = cropRegion(canvas, 0.5, 0, 0.5, 0.4);
    const { text, confidence } = await runOcrOnCanvas(crop, 1600);
    crop.width = 0; crop.height = 0;
    recordPass('D', 'Upper-right 50%×40%', text, confidence, Date.now() - pt, parseLabel(text, itemTypeCodes));
  }

  // Discard source canvas — no label images are retained after OCR
  canvas.width  = 0;
  canvas.height = 0;

  const candidateDetails = buildCandidateDetails(acceptedMap, rejectedMap, itemTypeCodes);
  const { selectedItemType, isItemTypeAmbiguous } = selectBestItemType(candidateDetails);

  return {
    rawText:                rawTexts.join('\n\n---\n\n'),
    itemTypeCandidates:     [...acceptedMap.keys()],
    selectedItemType,
    candidateDetails,
    isItemTypeAmbiguous,
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
