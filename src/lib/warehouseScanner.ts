// ── Warehouse Scanner Abstraction ─────────────────────────────────────────────
//
// Architecture:
//  1. parseScan()          — stateless parser registry (manufacturer profiles pluggable)
//  2. classifyScan()       — classifies parsed output before adding to session
//  3. CameraScanner        — owns the MediaStream + decode loop lifecycle
//  4. UsbScanner           — hooks into rapid-keystroke input for USB barcode scanners
//  5. getScanDiagnostics() — async capability probe for debugging
//
// Decoder priority:
//  1. BarcodeDetector (Chrome/Android native) — fastest, runs natively
//  2. @zxing/browser                          — fallback (iOS Safari, Firefox, desktop)
//
// Camera startup is independent from decoder availability.
// The camera opens as soon as getUserMedia succeeds; the decoder initialises
// in the background. If the decoder fails, onError is surfaced but the
// camera STAYS OPEN so manual entry or USB can still be used.

import type { ScanClassification } from './warehouseTypes';
export type { ScanClassification };

// ── Parsing status ────────────────────────────────────────────────────────────

export type ParsingStatus = 'resolved' | 'partially_resolved' | 'unresolved';

// ── DI field decoder (investigation utility) ──────────────────────────────────
//
// Decodes a single GS-separated field from a Nokia / ANSI MH10.8.2 DataMatrix
// payload. Used for diagnostics — does NOT affect extraction logic.
//
// DI table:  [C] = confirmed from real Nokia carton scans
//            [P] = probable (referenced in ANSI MH10.8.2 / Nokia documentation)
//            [?] = speculative / unconfirmed
// Ordered longest-first to prevent shorter DIs from matching as prefix.

export interface DIField {
  di:      string;        // Data Identifier prefix
  value:   string;        // Value after stripping the DI
  meaning: string | null; // Null = not in known-DI table (unknown DI)
}

const NOKIA_DI_TABLE: Array<{ di: string; meaning: string }> = [
  // 3-char DIs
  { di: '13Q', meaning: 'Quantity [P]' },
  { di: '14S', meaning: 'Hardware Type / Model [?]' },
  // 2-char DIs
  { di: '1P',  meaning: 'Supplier Part Number [C]' },
  { di: '4L',  meaning: 'Item Description [P]' },
  { di: '9S',  meaning: 'Product Code [P]' },
  { di: '2P',  meaning: 'Customer Part Number [P]' },
  // 1-char DIs
  { di: 'S',   meaning: 'Serial Number [C]' },
  { di: 'Q',   meaning: 'Quantity [C]' },
  { di: 'V',   meaning: 'Vendor ID [C]' },
  { di: 'P',   meaning: 'Customer Part Number [P]' },
  { di: 'T',   meaning: 'Task / Work Order [?]' },
  { di: 'D',   meaning: 'Date Code [?]' },
  { di: 'W',   meaning: 'Date [?]' },
  { di: 'N',   meaning: 'Serial Number (alt) [?]' },
];

export function decodeDIField(rawField: string): DIField {
  const f = rawField.trim();
  for (const { di, meaning } of NOKIA_DI_TABLE) {
    if (f.startsWith(di)) {
      return { di, value: f.slice(di.length), meaning };
    }
  }
  // Unknown DI — expose the entire field so the user can identify it manually
  return { di: '??', value: f, meaning: null };
}

// Splits a raw Nokia DataMatrix payload on control-character separators and
// decodes every field. Used for diagnostic display — does not alter extraction.
export function decodeAllDIFields(rawValue: string): DIField[] {
  return rawValue
    .split(/[\x1d\x1e\x04]/)
    .filter(Boolean)
    .map(decodeDIField);
}

// ── Parsed scan result ────────────────────────────────────────────────────────

export interface ParsedScan {
  rawValue:       string;
  symbology:      string;           // 'CODE_128' | 'DATA_MATRIX' | 'QR_CODE' | etc.
  serialNumber:   string | null;
  partNumber:     string | null;
  itemType:       string | null;
  manufacturer:   string | null;    // 'Nokia' | 'Huawei' | 'Ericsson' | null
  rawFields:      string[];
  parsingProfile: string;
  confidence:     'HIGH' | 'MEDIUM' | 'LOW';
  status:         ParsingStatus;
  diFields?:      DIField[];        // Populated for Nokia DI payloads — diagnostic only
}

// ── Parser profile interface ──────────────────────────────────────────────────

interface ParserProfile {
  name:     string;
  canParse: (raw: string) => boolean;
  parse:    (raw: string) => Omit<ParsedScan, 'rawValue' | 'symbology'>;
}

// ── Standard GS1 Application Identifier (AI) parser ─────────────────────────
// Handles AI (01) = GTIN and AI (21) = Serial Number.
// Used for labels conforming to the GS1 standard (retail, pharma, logistics).
// Nokia telecom labels use Data Identifiers (DIs) instead — see parseNokiaDI().

function parseGS1(fields: string[]): Omit<ParsedScan, 'rawValue' | 'symbology'> {
  let partNumber:   string | null = null;
  let serialNumber: string | null = null;

  for (const f of fields) {
    // AI (01) = GTIN/product code
    const m01 = f.match(/^\(?01\)?([\dX]{8,14})$/i);
    if (m01) { partNumber = m01[1]; continue; }

    // AI (21) = serial number
    const m21 = f.match(/^\(?21\)?(.{1,20})$/i);
    if (m21) { serialNumber = m21[1].trim().toUpperCase(); continue; }

    // AI (10) = lot/batch — ignored in Phase 1
  }

  const status: ParsingStatus =
    serialNumber && partNumber ? 'resolved' :
    serialNumber || partNumber ? 'partially_resolved' : 'unresolved';

  return {
    serialNumber, partNumber, itemType: null, manufacturer: null,
    rawFields: fields, parsingProfile: 'gs1',
    confidence: serialNumber ? 'HIGH' : 'MEDIUM',
    status,
  };
}

// ── Nokia / Telcordia ANSI MH10.8.2 Data Identifier (DI) parser ──────────────
//
// Nokia telecom equipment uses ANSI MH10.8.2 Data Identifiers — NOT GS1 AIs.
// DI codes seen on Nokia cartons:
//   1P  → Part Number   (e.g. 1P475266B.102  → PN = 475266B.102)
//   S   → Serial Number (e.g. SDH252030925   → SN = DH252030925)
//   V   → Vendor/Manufacturer (ignored for now)
//   Q   → Quantity (ignored for now)
//
// The identifier characters are NEVER part of the value.
// Fields are separated by GS (0x1D), RS (0x1E), or EOT (0x04) in the raw payload.
//
// This parser is invoked when the genericParser detects Nokia DI codes after
// splitting on control-character separators.

// Detect Nokia DI context: 1P is a definitive Nokia Part Number DI.
// It is not used in standard GS1 barcodes, so its presence confirms DI encoding.
export function hasNokiaDI(fields: string[]): boolean {
  return fields.some(f => f.startsWith('1P'));
}

export function parseNokiaDI(fields: string[]): Omit<ParsedScan, 'rawValue' | 'symbology'> {
  let partNumber:   string | null = null;
  let serialNumber: string | null = null;

  // Decode every field for diagnostics — no fields are discarded from this record
  const diFields = fields.filter(Boolean).map(f => decodeDIField(f.trim()));

  for (const field of fields) {
    const f = field.trim();
    if (!f) continue;

    // Check 2-char DIs before 1-char to avoid prefix ambiguity (e.g. '1P' vs '1')
    if (f.startsWith('1P')) {
      partNumber = f.slice(2) || null;
      continue;
    }

    if (f.length > 1 && f[0] === 'S') {
      // Confirmed Nokia DI context (1P present) → S is unambiguously Serial Number DI
      serialNumber = f.slice(1) || null;
      continue;
    }
    // All other DIs (V, Q, 4L, 9S, etc.) are captured in diFields above.
    // They are NOT silently discarded — the diagnostic display exposes them.
  }

  const status: ParsingStatus =
    serialNumber && partNumber ? 'resolved' :
    serialNumber || partNumber ? 'partially_resolved' : 'unresolved';

  return {
    itemType: null,
    partNumber,
    serialNumber,
    manufacturer: 'Nokia',
    rawFields:    fields,
    parsingProfile: 'nokia-gs1',
    confidence: (partNumber || serialNumber) ? 'HIGH' : 'LOW',
    status,
    diFields,
  };
}

// Pattern for a STANDALONE Nokia SN encoded with the S Data Identifier prefix.
// Structure: S + 1–3 alphanumeric chars (Nokia prefix) + 6–15 digits.
// Nokia prefixes can start with a digit (e.g. 1M) or letters (e.g. DH).
// Examples: SDH252030925 → SN=DH252030925  |  S1M241909797 → SN=1M241909797
// NOT matched (S is part of the value):
//   SERIAL001 (E-R-I = 3 alnum but then AL001 breaks the digit-only suffix)
//   SFULL12345 (F-U-L-L starts alpha run that leaves non-digits before the suffix)
const NOKIA_SN_DI_RE = /^S([A-Z0-9][A-Z0-9]{0,2}[0-9]{6,15})$/;

// ── Nokia parser ──────────────────────────────────────────────────────────────
// Nokia telecom equipment labels typically encode one of:
//   a) Semicolon-delimited:  ABIO;474123-001.001;N90001234567
//   b) GS1 DataMatrix:       AI(01)+PN  AI(21)+SN
//   c) Plain SN barcode:     N9XXXXXXXXX / NXXXXXXXXXXXXXXX
//
// Nokia SN patterns observed: starts with N followed by digits/letters,
// or a 12+ alphanumeric string on serialized radio units.
// Nokia PN pattern: numeric prefix, dash, decimal suffix (e.g. 474234-200.001)

const NOKIA_PN_RE     = /^\d{6}-\d{3}\.\d{3}$/;           // legacy dash format: 474234-200.001
const NOKIA_ALT_PN_RE = /^\d{6}[A-Z]\.\d{3}$/;            // letter format: 474254A.202
const NOKIA_SN_RE     = /^N[0-9A-Z]{8,18}$/i;             // N-series SN: N is part of the value

const nokiaParser: ParserProfile = {
  name: 'nokia',
  canParse: (raw: string) => {
    const clean = raw.trim().toUpperCase();
    // Semicolon-delimited with Nokia item types
    if (/^(ABIO|FXDA|FXEA|AHIB|ASIA|ABIA|FHEA|FGEA|FCEA|FCEB|FPGA|SRIA|AHEC|FSMF)/i.test(clean)) return true;
    // Nokia legacy PN barcode (e.g. 474234-200.001)
    if (NOKIA_PN_RE.test(clean)) return true;
    // Nokia alt-format PN barcode (letter format: 474254A.202)
    if (NOKIA_ALT_PN_RE.test(clean)) return true;
    // Nokia PN barcode with 1P DI prefix as standalone linear barcode (e.g. '1P474800A.102')
    if (clean.startsWith('1P') && (NOKIA_PN_RE.test(clean.slice(2)) || NOKIA_ALT_PN_RE.test(clean.slice(2)))) return true;
    // Nokia N-series SN barcode (N is part of the SN, not a DI)
    if (NOKIA_SN_RE.test(clean)) return true;
    // Nokia standalone SN with S Data Identifier prefix (e.g. SDH252030925)
    if (NOKIA_SN_DI_RE.test(clean)) return true;
    return false;
  },
  parse: (raw: string) => {
    const clean = raw.trim();
    const upper = clean.toUpperCase();

    // Semicolon TYPE;PN;SN  or  TYPE;SN
    const scFields = clean.split(';').filter(Boolean);
    if (scFields.length >= 2) {
      const itField = scFields[0].trim().toUpperCase();
      const pnField = scFields.length >= 3 ? scFields[1].trim() : null;
      const snField = (scFields[scFields.length - 1]).trim().toUpperCase();
      return {
        itemType:   itField || null,
        partNumber: pnField || null,
        serialNumber: snField || null,
        manufacturer: 'Nokia',
        rawFields: scFields,
        parsingProfile: 'nokia-semicolon',
        confidence: 'HIGH',
        status: (itField && snField ? 'resolved' : 'partially_resolved') as ParsingStatus,
      };
    }

    // Nokia PN barcode with 1P DI prefix (standalone linear barcode, e.g. '1P474800A.102')
    // The 1P Data Identifier is stripped; the remaining value is the Nokia PN.
    if (upper.startsWith('1P')) {
      const pnValue = clean.slice(2);
      if (NOKIA_PN_RE.test(pnValue) || NOKIA_ALT_PN_RE.test(pnValue)) {
        return {
          itemType: null, serialNumber: null, manufacturer: 'Nokia',
          partNumber: pnValue,
          rawFields: [clean], parsingProfile: 'nokia-pn-only',
          confidence: 'MEDIUM', status: 'partially_resolved' as const,
        };
      }
    }

    // Standalone Nokia SN with S DI prefix: strip S, return remaining as SN
    const diMatch = NOKIA_SN_DI_RE.exec(upper);
    if (diMatch) {
      return {
        itemType: null, partNumber: null, manufacturer: 'Nokia',
        serialNumber: diMatch[1],
        rawFields: [clean], parsingProfile: 'nokia-sn-di',
        confidence: 'MEDIUM', status: 'partially_resolved' as const,
      };
    }

    // Pure Nokia PN barcode — legacy dash format (474234-200.001) or letter format (474254A.202)
    if (NOKIA_PN_RE.test(clean) || NOKIA_ALT_PN_RE.test(clean)) {
      return {
        itemType: null, serialNumber: null, manufacturer: 'Nokia',
        partNumber: clean,
        rawFields: [clean], parsingProfile: 'nokia-pn-only',
        confidence: 'MEDIUM', status: 'partially_resolved' as const,
      };
    }

    // Nokia N-series SN (N is part of the value, NOT a DI — do not strip)
    if (NOKIA_SN_RE.test(upper)) {
      return {
        itemType: null, partNumber: null, manufacturer: 'Nokia',
        serialNumber: upper,
        rawFields: [clean], parsingProfile: 'nokia-sn-only',
        confidence: 'MEDIUM', status: 'partially_resolved' as const,
      };
    }

    // Fallback: treat as Nokia item type label
    return {
      itemType: upper, serialNumber: null, partNumber: null, manufacturer: 'Nokia',
      rawFields: [clean], parsingProfile: 'nokia-type-only',
      confidence: 'LOW', status: 'partially_resolved' as const,
    };
  },
};

// ── Generic parser (registered last — always matches) ─────────────────────────

const genericParser: ParserProfile = {
  name: 'generic',
  canParse: () => true,
  parse: (raw: string) => {
    const clean = raw.trim();
    const upper = clean.toUpperCase();

    // DataMatrix with control-character separators: GS (0x1D), RS (0x1E), EOT (0x04)
    const gsFields = clean.split(/[\x1d\x1e\x04]/).filter(Boolean);
    if (gsFields.length > 1) {
      // Route to Nokia DI parser when Nokia Data Identifiers are present.
      // hasNokiaDI() checks for '1P' (Part Number DI) — absent from standard GS1.
      if (hasNokiaDI(gsFields)) return parseNokiaDI(gsFields);
      return parseGS1(gsFields);
    }

    // Parenthesised GS1: "(01)12345678(21)SN001"
    const aiFields = clean.match(/\(\d{2}\)[^(]+/g);
    if (aiFields && aiFields.length > 1) return parseGS1(aiFields);

    // Semicolon-delimited: TYPE;PN;SN  or  PN;SN
    const scFields = clean.split(';').filter(Boolean);
    if (scFields.length === 3) {
      return {
        itemType:     scFields[0].trim().toUpperCase() || null,
        partNumber:   scFields[1].trim() || null,
        serialNumber: scFields[2].trim().toUpperCase() || null,
        manufacturer: null,
        rawFields: scFields, parsingProfile: 'generic-semicolon',
        confidence: 'MEDIUM',
        status: 'resolved' as const,
      };
    }
    if (scFields.length === 2) {
      return {
        itemType: null,
        partNumber:   scFields[0].trim() || null,
        serialNumber: scFields[1].trim().toUpperCase() || null,
        manufacturer: null,
        rawFields: scFields, parsingProfile: 'generic-semicolon-2',
        confidence: 'LOW', status: 'partially_resolved' as const,
      };
    }

    // Pure serial number (alphanumeric, 6–30 chars)
    if (/^[A-Z0-9\-\/\.]{6,30}$/i.test(clean)) {
      return {
        serialNumber: upper, partNumber: null, itemType: null, manufacturer: null,
        rawFields: [clean], parsingProfile: 'generic-sn-only',
        confidence: 'LOW', status: 'partially_resolved' as const,
      };
    }

    // Unrecognized
    return {
      serialNumber: null, partNumber: null, itemType: null, manufacturer: null,
      rawFields: [clean], parsingProfile: 'generic-unknown',
      confidence: 'LOW', status: 'unresolved' as const,
    };
  },
};

// ── Scan classification ───────────────────────────────────────────────────────
//
// Auxiliary codes are metadata fields (quantity, vendor, lot) often co-encoded
// alongside real item data on Nokia labels. They must not be added as scan entries.
// Examples: Q1, 8569, 915208, Q001 — short/pure-numeric/quantity-DI patterns.

function isAuxiliaryCode(raw: string): boolean {
  const t = raw.trim();
  if (t.length <= 2) return true;           // Q1, single chars, two-char codes
  if (/^\d{1,8}$/.test(t)) return true;    // pure numeric ≤ 8 digits (site/qty codes)
  if (/^Q\d+$/i.test(t)) return true;      // Nokia quantity DI: Q001, Q005
  return false;
}

export function classifyScan(parsed: ParsedScan): ScanClassification {
  if (isAuxiliaryCode(parsed.rawValue)) return 'AUXILIARY_CODE';
  // Standalone Nokia PN-only barcode — auxiliary metadata, not a distinct carton
  if (parsed.parsingProfile === 'nokia-pn-only') return 'AUXILIARY_CODE';
  if (!parsed.serialNumber && !parsed.partNumber) return 'UNKNOWN_CODE';
  if (parsed.serialNumber && parsed.confidence !== 'LOW') return 'VALID_ITEM';
  if (parsed.partNumber || parsed.serialNumber) return 'PARTIAL_ITEM';
  return 'UNKNOWN_CODE';
}

// ── Parser registry ───────────────────────────────────────────────────────────
// Profiles are checked in order; first canParse() match wins.
// Add Huawei and Ericsson profiles here in Phase 2.

const PARSERS: ParserProfile[] = [
  nokiaParser,
  // huaweiParser,   // Phase 2
  // ericssonParser, // Phase 2
  genericParser,
];

export function parseScan(raw: string, symbology: string): ParsedScan {
  for (const p of PARSERS) {
    if (p.canParse(raw)) {
      return { rawValue: raw, symbology, ...p.parse(raw) };
    }
  }
  return {
    rawValue: raw, symbology,
    serialNumber: null, partNumber: null, itemType: null, manufacturer: null,
    rawFields: [raw], parsingProfile: 'none', confidence: 'LOW', status: 'unresolved',
  };
}

// ── Camera permission check ───────────────────────────────────────────────────

export type CameraPermission = 'granted' | 'denied' | 'unsupported' | 'unknown';

export async function checkCameraPermission(): Promise<CameraPermission> {
  if (!window.isSecureContext)              return 'unsupported';
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  if (navigator.permissions) {
    try {
      const s = await navigator.permissions.query({ name: 'camera' as PermissionName });
      if (s.state === 'granted') return 'granted';
      if (s.state === 'denied')  return 'denied';
    } catch {
      // Some browsers (Firefox, Safari) don't support querying 'camera'
    }
  }
  return 'unknown';
}

// ── Scan diagnostics ──────────────────────────────────────────────────────────

export interface ScanDiagnostics {
  secureContext:            boolean;
  mediaDevicesAvailable:    boolean;
  getUserMediaAvailable:    boolean;
  barcodeDetectorAvailable: boolean;
  barcodeDetectorFormats:   string[];
  zxingAvailable:           boolean;
  cameraPermission:         CameraPermission;
}

export async function getScanDiagnostics(): Promise<ScanDiagnostics> {
  const secureContext            = window.isSecureContext;
  const mediaDevicesAvailable    = !!navigator.mediaDevices;
  const getUserMediaAvailable    = !!(navigator.mediaDevices?.getUserMedia);
  const barcodeDetectorAvailable = 'BarcodeDetector' in window;

  let barcodeDetectorFormats: string[] = [];
  if (barcodeDetectorAvailable) {
    try {
      const BD = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
      barcodeDetectorFormats = await BD.getSupportedFormats();
    } catch { /* ignore */ }
  }

  let zxingAvailable = false;
  try {
    const mod = await import('@zxing/browser');
    zxingAvailable = !!mod.BrowserMultiFormatReader;
  } catch { /* ignore */ }

  const cameraPermission = await checkCameraPermission();

  return {
    secureContext, mediaDevicesAvailable, getUserMediaAvailable,
    barcodeDetectorAvailable, barcodeDetectorFormats, zxingAvailable, cameraPermission,
  };
}

// ── BarcodeDetector type shim ─────────────────────────────────────────────────

interface BarcodeDetectorResult {
  rawValue: string;
  format:   string;
}

interface BarcodeDetectorCtor {
  new (opts?: { formats: string[] }): {
    detect(source: HTMLVideoElement | ImageBitmap): Promise<BarcodeDetectorResult[]>;
  };
  getSupportedFormats(): Promise<string[]>;
}

const NATIVE_FORMATS = [
  'code_128', 'code_39', 'code_93', 'ean_13', 'ean_8',
  'upc_a', 'upc_e', 'itf', 'qr_code', 'data_matrix', 'pdf417', 'aztec',
];

// ── Map DOMException names to user-friendly messages ─────────────────────────

export function cameraErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const name = (err as DOMException).name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera permission denied. Allow camera access in your browser settings and try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera found on this device.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Camera is already in use by another app. Close it and try again.';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'Camera constraints could not be satisfied. Trying a simpler configuration…';
    case 'SecurityError':
      return 'Camera blocked by browser security policy. Ensure the page is served over HTTPS.';
    case 'AbortError':
      return 'Camera request was cancelled.';
    default:
      return err.message || 'Unknown camera error.';
  }
}

// ── CameraScanner class ───────────────────────────────────────────────────────

export interface ScannerCallbacks {
  onScan:   (raw: string, symbology: string) => void;
  onError?: (msg: string) => void;
  onStart?: () => void;
}

export class CameraScanner {
  private stream:       MediaStream | null = null;
  private rafId:        number | null = null;
  private zxingCleaner: (() => void) | null = null;
  private paused       = false;
  private lastRaw      = '';
  private lastAt       = 0;
  private facingMode:  'environment' | 'user' = 'environment';
  private readonly COOLDOWN_MS = 1500;

  async start(
    videoEl: HTMLVideoElement,
    opts: ScannerCallbacks,
    facingMode: 'environment' | 'user' = 'environment',
  ): Promise<void> {
    // Defensive: cancel any existing decode loop before starting a new one.
    // This guards against double-start (e.g., if start() is called without stop()).
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    this.zxingCleaner?.(); this.zxingCleaner = null;

    this.facingMode = facingMode;

    // Verify we're in a secure context before even asking
    if (!window.isSecureContext) {
      throw new Error('Camera requires HTTPS. The page is not in a secure context.');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('getUserMedia is not available in this browser.');
    }

    // Attempt ideal constraints first; if overconstrained, retry minimal
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width:  { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
    } catch (e) {
      // If OverconstrainedError, retry with just facingMode
      if (e instanceof Error && (e.name === 'OverconstrainedError' || e.name === 'ConstraintNotSatisfiedError')) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingMode } },
          audio: false,
        });
      } else {
        throw e;
      }
    }

    this.stream       = stream;
    videoEl.srcObject = stream;

    // iOS Safari PWA requires these attributes to be set programmatically
    videoEl.setAttribute('playsinline', 'true');
    videoEl.setAttribute('autoplay', 'true');
    videoEl.setAttribute('muted', 'true');
    videoEl.muted    = true;
    videoEl.autoplay = true;

    // Play may fail if the element is not yet visible; retry on loadedmetadata
    try {
      await videoEl.play();
    } catch {
      // Some browsers require waiting for metadata before play()
      await new Promise<void>((resolve, reject) => {
        const onMeta = () => {
          videoEl.removeEventListener('loadedmetadata', onMeta);
          videoEl.play().then(resolve).catch(reject);
        };
        videoEl.addEventListener('loadedmetadata', onMeta);
        // Timeout safety: if metadata never fires, reject after 5s
        setTimeout(() => reject(new Error('Video metadata timeout')), 5000);
      });
    }

    // Signal the UI that camera is live — do this BEFORE starting the decoder
    // so the video element is visible and sized when the decoder first reads it.
    opts.onStart?.();

    // Start decoder (camera stays open regardless of decoder outcome)
    if ('BarcodeDetector' in window) {
      const BD       = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
      const supported = await BD.getSupportedFormats().catch(() => NATIVE_FORMATS);
      const formats   = NATIVE_FORMATS.filter(f => supported.includes(f));
      const detector  = new BD({ formats: formats.length ? formats : NATIVE_FORMATS });
      this.startNativeLoop(videoEl, detector, opts);
    } else {
      // ZXing: fire and forget — camera is already live; decoder starts in background
      this.startZxingLoop(videoEl, opts);
    }
  }

  // Camera switch without resetting scan entries
  async switchCamera(videoEl: HTMLVideoElement, opts: ScannerCallbacks): Promise<void> {
    const newFacing: 'environment' | 'user' =
      this.facingMode === 'environment' ? 'user' : 'environment';
    this.stop();   // cancel RAF + ZXing + stop stream before restarting
    await this.start(videoEl, opts, newFacing);
  }

  getFacingMode(): 'environment' | 'user' { return this.facingMode; }

  private startNativeLoop(
    videoEl:  HTMLVideoElement,
    detector: { detect(s: HTMLVideoElement): Promise<BarcodeDetectorResult[]> },
    opts:     ScannerCallbacks,
  ) {
    const tick = async () => {
      if (!this.paused && videoEl.readyState >= 2) {
        try {
          const results = await detector.detect(videoEl);
          for (const r of results) {
            if (this.acceptScan(r.rawValue)) {
              opts.onScan(r.rawValue, r.format.toUpperCase().replace(/-/g, '_'));
            }
          }
        } catch { /* non-fatal: frame decode error */ }
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private async startZxingLoop(videoEl: HTMLVideoElement, opts: ScannerCallbacks) {
    try {
      const { BrowserMultiFormatReader } = await import('@zxing/browser');
      const reader   = new BrowserMultiFormatReader();
      const controls = await reader.decodeFromVideoElement(videoEl, (result, _err) => {
        if (result && !this.paused) {
          const raw = result.getText();
          const fmt = result.getBarcodeFormat().toString().replace(/-/g, '_').toUpperCase();
          if (this.acceptScan(raw)) opts.onScan(raw, fmt);
        }
        // NotFoundException and other non-fatal decode errors are silently ignored
      });
      this.zxingCleaner = () => { try { controls?.stop(); } catch { /* ignore */ } };
    } catch {
      opts.onError?.('Barcode decoder unavailable. Use manual entry or USB scanner instead.');
    }
  }

  private acceptScan(raw: string): boolean {
    const now = Date.now();
    if (raw === this.lastRaw && now - this.lastAt < this.COOLDOWN_MS) return false;
    this.lastRaw = raw;
    this.lastAt  = now;
    return true;
  }

  pause()  { this.paused = true; }
  resume() { this.paused = false; }

  private stopStream() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
  }

  stop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.zxingCleaner?.();
    this.zxingCleaner = null;
    this.stopStream();
  }

  async toggleTorch(): Promise<boolean> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return false;
    const caps = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
    if (!caps.torch) return false;
    const settings = track.getSettings() as MediaTrackSettings & { torch?: boolean };
    const newVal   = !settings.torch;
    await track.applyConstraints({
      advanced: [{ torch: newVal } as MediaTrackConstraintSet],
    }).catch(() => {});
    return newVal;
  }

  hasTorch(): boolean {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return false;
    const caps = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
    return !!caps.torch;
  }
}

// ── USB / hardware scanner ────────────────────────────────────────────────────
// USB barcode scanners type characters very fast (< 50ms between keys)
// and emit Enter at the end. We capture this keystroke pattern and treat
// it as a scan rather than manual keyboard input.

export interface UsbScannerOptions {
  onScan:    (raw: string) => void;
  threshold?: number;  // ms between keystrokes — below this = scanner, above = human
}

export class UsbScanner {
  private buffer     = '';
  private lastKeyAt  = 0;
  private readonly threshold: number;
  private readonly handler:   (e: KeyboardEvent) => void;
  private readonly target:    HTMLElement;

  constructor(target: HTMLElement, opts: UsbScannerOptions) {
    this.threshold = opts.threshold ?? 50;
    this.target    = target;
    this.handler   = (e: KeyboardEvent) => {
      const now = Date.now();

      if (e.key === 'Enter' || e.key === 'Tab') {
        const raw = this.buffer.trim();
        if (raw.length >= 3) opts.onScan(raw);
        this.buffer    = '';
        this.lastKeyAt = 0;
        e.preventDefault();
        return;
      }

      // Gap too large → human is typing; discard accumulated buffer
      if (this.lastKeyAt !== 0 && now - this.lastKeyAt > this.threshold * 4) {
        this.buffer = '';
      }

      if (e.key.length === 1) this.buffer += e.key;
      this.lastKeyAt = now;
    };
  }

  attach() { this.target.addEventListener('keydown', this.handler, true); }
  detach() { this.target.removeEventListener('keydown', this.handler, true); }
}
