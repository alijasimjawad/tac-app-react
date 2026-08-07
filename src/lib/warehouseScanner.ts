// ── Warehouse Scanner Abstraction ─────────────────────────────────────────────
//
// Architecture:
//  1. parseScan()   — stateless parser registry (manufacturer profiles pluggable)
//  2. CameraScanner — class that owns the MediaStream + decode loop lifecycle
//  3. UsbScanner    — hooks into rapid-keystroke input for USB barcode scanners
//
// BarcodeDetector (Chrome/Android native) is preferred.
// @zxing/browser   is the universal fallback (iOS Safari, Firefox, desktop).

// ── Parsed scan result ────────────────────────────────────────────────────────

export interface ParsedScan {
  rawValue: string;
  symbology: string;         // 'CODE_128' | 'DATA_MATRIX' | 'QR_CODE' | etc.
  serialNumber: string | null;
  partNumber: string | null;
  itemType: string | null;
  rawFields: string[];
  parsingProfile: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

// ── Parser profile interface ──────────────────────────────────────────────────

interface ParserProfile {
  name: string;
  canParse: (raw: string) => boolean;
  parse: (raw: string) => Omit<ParsedScan, 'rawValue' | 'symbology'>;
}

// ── GS1 DataMatrix field parser ───────────────────────────────────────────────

function parseGS1(fields: string[]): Omit<ParsedScan, 'rawValue' | 'symbology'> {
  let partNumber: string | null = null;
  let serialNumber: string | null = null;

  for (const f of fields) {
    // AI (01) = GTIN/product code
    const m01 = f.match(/^\(?01\)?([\dX]{8,14})$/i);
    if (m01) { partNumber = m01[1]; continue; }

    // AI (21) = serial number
    const m21 = f.match(/^\(?21\)?(.{1,20})$/i);
    if (m21) { serialNumber = m21[1].trim().toUpperCase(); continue; }

    // AI (10) = lot/batch — ignore for now
  }

  return {
    serialNumber,
    partNumber,
    itemType: null,
    rawFields: fields,
    parsingProfile: 'gs1',
    confidence: serialNumber ? 'HIGH' : 'MEDIUM',
  };
}

// ── Generic parser (registered last — always matches) ────────────────────────

const genericParser: ParserProfile = {
  name: 'generic',
  canParse: () => true,
  parse: (raw: string) => {
    const clean = raw.trim();
    const upper = clean.toUpperCase();

    // GS1 DataMatrix: ASCII GS (0x1D) or RS (0x1E) separators
    const gsFields = clean.split(/[\x1d\x1e\x04]/).filter(Boolean);
    if (gsFields.length > 1) return parseGS1(gsFields);

    // Parenthesised GS1: "(01)12345678(21)SN001"
    const aiFields = clean.match(/\(\d{2}\)[^(]+/g);
    if (aiFields && aiFields.length > 1) return parseGS1(aiFields);

    // Semicolon-delimited (some label encodings): TYPE;PN;SN
    const scFields = clean.split(';').filter(Boolean);
    if (scFields.length === 3) {
      return {
        itemType:      scFields[0].trim().toUpperCase() || null,
        partNumber:    scFields[1].trim() || null,
        serialNumber:  scFields[2].trim().toUpperCase() || null,
        rawFields:     scFields,
        parsingProfile: 'generic-semicolon',
        confidence: 'MEDIUM',
      };
    }
    if (scFields.length === 2) {
      // Could be PN;SN or itemType;SN — treat second field as SN
      return {
        itemType:     null,
        partNumber:   scFields[0].trim() || null,
        serialNumber: scFields[1].trim().toUpperCase() || null,
        rawFields:    scFields,
        parsingProfile: 'generic-semicolon-2',
        confidence: 'LOW',
      };
    }

    // Pure serial number (alphanumeric, 6–30 chars)
    if (/^[A-Z0-9\-\/\.]{6,30}$/i.test(clean)) {
      return {
        serialNumber:  upper,
        partNumber:    null,
        itemType:      null,
        rawFields:     [clean],
        parsingProfile: 'generic-sn-only',
        confidence: 'LOW',
      };
    }

    // Unrecognized — keep raw, ask user to resolve
    return {
      serialNumber:  null,
      partNumber:    null,
      itemType:      null,
      rawFields:     [clean],
      parsingProfile: 'generic-unknown',
      confidence: 'LOW',
    };
  },
};

// ── Parser registry (manufacturer profiles inserted here in Phase 2) ──────────

const PARSERS: ParserProfile[] = [
  // Nokia, Huawei, Ericsson profiles will be added here
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
    serialNumber: null, partNumber: null, itemType: null,
    rawFields: [raw], parsingProfile: 'none', confidence: 'LOW',
  };
}

// ── Camera permission check ───────────────────────────────────────────────────

export type CameraPermission = 'granted' | 'denied' | 'unsupported' | 'unknown';

export async function checkCameraPermission(): Promise<CameraPermission> {
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  if (navigator.permissions) {
    try {
      const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
      if (status.state === 'granted') return 'granted';
      if (status.state === 'denied')  return 'denied';
    } catch {
      // Some browsers don't support querying 'camera' — fall through to probe
    }
  }
  return 'unknown';
}

// ── BarcodeDetector type shim ─────────────────────────────────────────────────
// Not yet in lib.dom.d.ts for all TypeScript versions.

interface BarcodeDetectorResult {
  rawValue: string;
  format: string;
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

// ── CameraScanner class ───────────────────────────────────────────────────────

export interface ScannerCallbacks {
  onScan: (raw: string, symbology: string) => void;
  onError?: (msg: string) => void;
  onStart?: () => void;
}

export class CameraScanner {
  private stream: MediaStream | null = null;
  private rafId: number | null = null;
  private zxingCleaner: (() => void) | null = null;
  private paused = false;
  private lastRaw = '';
  private lastAt = 0;
  private readonly COOLDOWN_MS = 1500;

  async start(videoEl: HTMLVideoElement, opts: ScannerCallbacks): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      },
    });

    this.stream = stream;
    videoEl.srcObject = stream;
    videoEl.setAttribute('playsinline', 'true'); // required by iOS Safari
    videoEl.setAttribute('muted', 'true');
    videoEl.muted = true;
    await videoEl.play().catch(() => {}); // Safari may require a user-gesture promise chain

    opts.onStart?.();

    if ('BarcodeDetector' in window) {
      const BD = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
      const supported = await BD.getSupportedFormats().catch(() => NATIVE_FORMATS);
      const formats   = NATIVE_FORMATS.filter(f => supported.includes(f));
      const detector  = new BD({ formats: formats.length ? formats : NATIVE_FORMATS });
      this.startNativeLoop(videoEl, detector, opts);
    } else {
      await this.startZxingLoop(videoEl, opts);
    }
  }

  private startNativeLoop(videoEl: HTMLVideoElement, detector: { detect(s: HTMLVideoElement): Promise<BarcodeDetectorResult[]> }, opts: ScannerCallbacks) {
    const tick = async () => {
      if (!this.paused && videoEl.readyState >= 2) {
        try {
          const results = await detector.detect(videoEl);
          for (const r of results) {
            if (this.acceptScan(r.rawValue)) {
              opts.onScan(r.rawValue, r.format.toUpperCase().replace(/-/g, '_'));
            }
          }
        } catch { /* non-fatal */ }
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private async startZxingLoop(videoEl: HTMLVideoElement, opts: ScannerCallbacks) {
    try {
      const { BrowserMultiFormatReader } = await import('@zxing/browser');
      const reader = new BrowserMultiFormatReader();
      const controls = await reader.decodeFromVideoElement(videoEl, (result, _err) => {
        if (result && !this.paused) {
          const raw = result.getText();
          const fmt = result.getBarcodeFormat().toString().replace(/-/g, '_').toUpperCase();
          if (this.acceptScan(raw)) opts.onScan(raw, fmt);
        }
        // non-fatal decode errors (NotFoundException etc.) are ignored
      });
      this.zxingCleaner = () => { try { controls?.stop(); } catch { /* ignore */ } };
    } catch {
      opts.onError?.('Barcode scanner library failed to load. Use manual entry instead.');
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

  stop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.zxingCleaner?.();
    this.zxingCleaner = null;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
  }

  async toggleTorch(): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return;
    const caps = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
    if (!caps.torch) return;
    const settings = track.getSettings() as MediaTrackSettings & { torch?: boolean };
    await track.applyConstraints({
      advanced: [{ torch: !settings.torch } as MediaTrackConstraintSet],
    }).catch(() => {});
  }

  hasTorch(): boolean {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return false;
    const caps = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
    return !!caps.torch;
  }
}

// ── USB / hardware scanner helper ─────────────────────────────────────────────
// USB barcode scanners behave as keyboard devices: they type characters very
// quickly and then emit an Enter key. We detect this by watching for
// keystroke sequences where consecutive keys arrive within 50ms.

export interface UsbScannerOptions {
  onScan: (raw: string) => void;
  /** ms threshold — keystrokes faster than this are from the scanner, not the user */
  threshold?: number;
}

export class UsbScanner {
  private buffer = '';
  private lastKeyAt = 0;
  private readonly threshold: number;
  private readonly handler: (e: KeyboardEvent) => void;
  private readonly target: HTMLElement;

  constructor(target: HTMLElement, opts: UsbScannerOptions) {
    this.threshold = opts.threshold ?? 50;
    this.target    = target;
    this.handler   = (e: KeyboardEvent) => {
      const now = Date.now();

      if (e.key === 'Enter') {
        const raw = this.buffer.trim();
        if (raw.length >= 3) opts.onScan(raw);
        this.buffer = '';
        this.lastKeyAt = 0;
        e.preventDefault();
        return;
      }

      // Reset buffer if gap is too large (manual typing)
      if (now - this.lastKeyAt > this.threshold * 4 && this.lastKeyAt !== 0) {
        this.buffer = '';
      }

      if (e.key.length === 1) {
        this.buffer += e.key;
      }
      this.lastKeyAt = now;
    };
  }

  attach() { this.target.addEventListener('keydown', this.handler, true); }
  detach() { this.target.removeEventListener('keydown', this.handler, true); }
}
