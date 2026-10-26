import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';
import logoSvg from '../assets/logo.svg?raw';

export interface GenerateQrPdfParams {
  restaurantName: string;
  slug: string;
  baseUrl: string;
  includeMaster: boolean;
  /**
   * Migration 045: the table QRs to print. `label` is what the standee says
   * ("5"), `code` is what the QR carries (`?t=<code>`) — the table's number is
   * never in the URL any more, so a QR cannot be guessed or invented.
   */
  tables: { label: string; code: string }[];
}

interface QrItem {
  id: string;
  label: string;
  url: string;
}

// ============================================================================
// A4 LAYOUT CONSTANTS (All units in mm)
// ============================================================================
const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;

// Margins and Gaps
const MARGIN_X = 12;
const MARGIN_Y = 16;
const GAP_X = 10;
const GAP_Y = 15;

// Grid Configuration: 2 Columns x 2 Rows = 4 Standee Cards per Page
const COLS = 2;
const ROWS = 2;
const ITEMS_PER_PAGE = COLS * ROWS; // 4

// Card Dimensions (88mm x 125mm)
const CARD_WIDTH = (PAGE_WIDTH - 2 * MARGIN_X - (COLS - 1) * GAP_X) / COLS; // 88mm
const CARD_HEIGHT = (PAGE_HEIGHT - 2 * MARGIN_Y - (ROWS - 1) * GAP_Y) / ROWS; // 125mm

// Scaled QR Code Dimension for vertical visual balance
const QR_SIZE = 54; // 54mm x 54mm

// Center Logo Overlay (brand mark at the heart of every QR code)
const LOGO_SIZE_RATIO = 0.15; // Logo diameter as a fraction of QR_SIZE (8.1mm on the 54mm QR)
const LOGO_CIRCLE_PAD = 1; // White halo radius beyond the logo edge (mm)
const LOGO_BORDER_W = 0.3; // Orange ring thickness (mm)

// Brand Color Palette
const COLOR_HEADER_BG = '#0F172A'; // Deep Slate
const COLOR_BRAND_ORANGE = '#EA580C'; // RasoiQR Orange
const COLOR_DARK_TEXT = '#0F172A'; // Dark text
const COLOR_CARD_BG = '#FFFFFF';
const COLOR_BORDER = '#CBD5E1'; // Slate 300

/**
 * Rasterizes the RasoiQR brand mark (src/assets/logo.svg — the same chef-hat
 * glyph the navbar renders via IconLogo) into a circular PNG data URL so it can
 * be overlaid at the exact center of every QR code. Returns null if the logo
 * cannot be prepared, letting the PDF generate without it.
 *
 * The asset lives under src/assets (not public/) because Vite inlines `?raw`
 * imports at build time and warns when a public/ file is imported from JS —
 * files in public/ are meant to be fetched by URL, never bundled.
 */
async function loadCircularLogoPng(): Promise<string | null> {
  try {
    // Pin the intrinsic size so every browser rasterizes the SVG identically
    const sizedSvg = logoSvg.replace('<svg ', '<svg width="256" height="256" ');
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sizedSvg)}`;

    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Logo image failed to load'));
      img.src = src;
    });

    const px = 256;
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Center-crop to a square first (viewBox is already 24x24, so this is a
    // no-op for the current asset but keeps non-square sources safe) ...
    const side = Math.min(img.width, img.height);
    const sx = (img.width - side) / 2;
    const sy = (img.height - side) / 2;

    // ... then clip to a circle before drawing
    ctx.beginPath();
    ctx.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, sx, sy, side, side, 0, 0, px, px);

    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/**
 * Generates and downloads a print-ready A4 PDF containing table QR standees.
 */
export async function generateQrPdf({
  restaurantName,
  slug,
  baseUrl,
  includeMaster,
  tables,
}: GenerateQrPdfParams): Promise<void> {
  if (!includeMaster && tables.length === 0) {
    throw new Error('Please select at least one QR code (Master or Table).');
  }

  const cleanBaseUrl = baseUrl.replace(/\/+$/, '');

  // 1. Build list of QR items
  const items: QrItem[] = [];

  if (includeMaster) {
    items.push({
      id: 'master',
      label: 'MASTER MENU',
      url: `${cleanBaseUrl}/menu/${slug}`,
    });
  }

  for (const table of tables) {
    // Numbers keep the old zero-padded caption ("TABLE 05"); a custom label is
    // printed as it is.
    const tableNum = /^\d+$/.test(table.label) ? table.label.padStart(2, '0') : table.label;
    items.push({
      id: `table-${table.label}`,
      label: `TABLE ${tableNum}`,
      url: `${cleanBaseUrl}/menu/${slug}?t=${table.code}`,
    });
  }

  // 2. Generate QR Data URLs (Tight margin for exact framing)
  const qrDataUrls = await Promise.all(
    items.map((item) =>
      QRCode.toDataURL(item.url, {
        width: 700, // High DPI rendering
        margin: 1,
        errorCorrectionLevel: 'H', // 30% damage recovery — required for the center logo
        color: {
          dark: '#000000',
          light: '#FFFFFF',
        },
      })
    )
  );

  // 3. Prepare circular brand logo for the QR centers (null → skip overlay)
  const logoDataUrl = await loadCircularLogoPng();

  // 4. Initialize jsPDF
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const totalPages = Math.ceil(items.length / ITEMS_PER_PAGE);

  // 5. Render cards onto PDF pages
  items.forEach((item, index) => {
    const pageIndex = Math.floor(index / ITEMS_PER_PAGE);
    const pageItemIndex = index % ITEMS_PER_PAGE;

    if (index > 0 && pageItemIndex === 0) {
      doc.addPage();
    }

    const col = pageItemIndex % COLS;
    const row = Math.floor(pageItemIndex / COLS);

    const cardX = MARGIN_X + col * (CARD_WIDTH + GAP_X);
    const cardY = MARGIN_Y + row * (CARD_HEIGHT + GAP_Y);

    // ------------------------------------------------------------------------
    // A. CUTTING GUIDELINE (Dashed Outer Box)
    // ------------------------------------------------------------------------
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.3);
    doc.setLineDashPattern([2, 2], 0);
    doc.rect(cardX, cardY, CARD_WIDTH, CARD_HEIGHT);
    doc.setLineDashPattern([0], 0); // Explicit reset

    // ------------------------------------------------------------------------
    // B. CARD INNER CONTAINER
    // ------------------------------------------------------------------------
    const padding = 2;
    const innerX = cardX + padding;
    const innerY = cardY + padding;
    const innerW = CARD_WIDTH - padding * 2; // 84mm
    const innerH = CARD_HEIGHT - padding * 2; // 121mm

    // White Card Background Fill
    doc.setFillColor(COLOR_CARD_BG);
    doc.roundedRect(innerX, innerY, innerW, innerH, 4, 4, 'F');

    // ------------------------------------------------------------------------
    // C. DARK HEADER BAND
    // ------------------------------------------------------------------------
    const headerH = 18;
    doc.setFillColor(COLOR_HEADER_BG);
    doc.roundedRect(innerX, innerY, innerW, headerH, 4, 4, 'F');
    doc.rect(innerX, innerY + headerH - 4, innerW, 4, 'F'); // Square bottom corners

    // Card Outer Border Stroke (Drawn on top to keep corners intact)
    doc.setDrawColor(COLOR_BORDER);
    doc.setLineWidth(0.4);
    doc.roundedRect(innerX, innerY, innerW, innerH, 4, 4, 'D');

    // Restaurant Name Text (Auto-scaling & truncation)
    let formattedName = restaurantName.toUpperCase();
    let fontScale = 11.5;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(fontScale);
    const maxTextWidth = innerW - 8;

    while (doc.getTextWidth(formattedName) > maxTextWidth && fontScale > 6.5) {
      fontScale -= 0.5;
      doc.setFontSize(fontScale);
    }

    if (doc.getTextWidth(formattedName) > maxTextWidth) {
      while (doc.getTextWidth(formattedName + '...') > maxTextWidth && formattedName.length > 0) {
        formattedName = formattedName.slice(0, -1);
      }
      formattedName += '...';
    }

    doc.setTextColor(255, 255, 255);
    doc.text(formattedName, innerX + innerW / 2, innerY + 11, {
      align: 'center',
    });

    // ------------------------------------------------------------------------
    // D. TABLE / MASTER BADGE (Pill Design)
    // ------------------------------------------------------------------------
    const badgeW = 46;
    const badgeH = 8.5;
    const badgeX = innerX + (innerW - badgeW) / 2;
    const badgeY = innerY + headerH + 5; // 23mm from top

    doc.setFillColor(COLOR_BRAND_ORANGE);
    doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 4.25, 4.25, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(255, 255, 255);
    doc.text(item.label, innerX + innerW / 2, badgeY + 5.7, {
      align: 'center',
    });

    // ------------------------------------------------------------------------
    // E. 54mm x 54mm QR CODE & FRAME
    // ------------------------------------------------------------------------
    const qrX = innerX + (innerW - QR_SIZE) / 2;
    const qrY = badgeY + badgeH + 5; // 36.5mm from top

    // QR Border Box Frame
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.3);
    doc.roundedRect(qrX - 2, qrY - 2, QR_SIZE + 4, QR_SIZE + 4, 3, 3, 'FD');

    // QR Image
    doc.addImage(qrDataUrls[index], 'PNG', qrX, qrY, QR_SIZE, QR_SIZE);

    // QR Center Logo: white disc + orange ring + circular brand mark
    if (logoDataUrl) {
      const logoD = QR_SIZE * LOGO_SIZE_RATIO;
      const logoCx = qrX + QR_SIZE / 2;
      const logoCy = qrY + QR_SIZE / 2;
      const haloR = logoD / 2 + LOGO_CIRCLE_PAD;

      // White disc behind the logo
      doc.setFillColor(255, 255, 255);
      doc.circle(logoCx, logoCy, haloR, 'F');

      // Thin orange ring around the disc
      doc.setDrawColor(COLOR_BRAND_ORANGE);
      doc.setLineWidth(LOGO_BORDER_W);
      doc.circle(logoCx, logoCy, haloR, 'S');

      // Circular logo, dead center
      doc.addImage(logoDataUrl, 'PNG', logoCx - logoD / 2, logoCy - logoD / 2, logoD, logoD);
    }

    // ------------------------------------------------------------------------
    // F. CTA TEXT
    // ------------------------------------------------------------------------
    const ctaY = qrY + QR_SIZE + 7.5; // ~98mm from top
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(COLOR_DARK_TEXT);
    doc.text('SCAN TO VIEW MENU & ORDER', innerX + innerW / 2, ctaY, {
      align: 'center',
    });

    // ------------------------------------------------------------------------
    // G. 3-STEP CAMERA GUIDE (numbered discs + labels)
    // ------------------------------------------------------------------------
    const guideY = ctaY + 4; // ~102mm from top
    const guideW = 74;
    const guideH = 9;
    const guideX = innerX + (innerW - guideW) / 2;

    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(guideX, guideY, guideW, guideH, 2.5, 2.5, 'FD');

    const steps: Array<[string, string]> = [
      ['1', 'CAMERA'],
      ['2', 'SCAN'],
      ['3', 'ORDER'],
    ];
    const discD = 3.32; // numbered disc diameter
    const discGap = 1.42; // disc edge to label

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    const stepWidths = steps.map(
      ([, label]) => discD + discGap + doc.getTextWidth(label)
    );
    const stepGap =
      (guideW * 0.78 - stepWidths.reduce((sum, w) => sum + w, 0)) /
      (steps.length - 1);
    const rowW =
      stepWidths.reduce((sum, w) => sum + w, 0) + stepGap * (steps.length - 1);
    const stepMidY = guideY + guideH / 2;
    let stepX = guideX + (guideW - rowW) / 2;

    steps.forEach(([number, label], stepIndex) => {
      // Dark numbered disc
      doc.setFillColor(COLOR_HEADER_BG);
      doc.circle(stepX + discD / 2, stepMidY, discD / 2, 'F');
      doc.setFontSize(6.3);
      doc.setTextColor(255, 255, 255);
      doc.text(number, stepX + discD / 2, stepMidY + 0.71, { align: 'center' });

      // Step label
      doc.setFontSize(7.5);
      doc.setTextColor(COLOR_DARK_TEXT);
      doc.text(label, stepX + discD + discGap, stepMidY + 0.95);

      stepX += stepWidths[stepIndex] + stepGap;
    });

    // ------------------------------------------------------------------------
    // H. FOOTER BRANDING ("Powered by RasoiQR")
    // ------------------------------------------------------------------------
    const footerY = guideY + guideH + 6.5; // ~117.5mm (near bottom of 121mm card)
    const text1 = 'Powered by ';
    const text2 = 'RasoiQR';

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    const w1 = doc.getTextWidth(text1);
    doc.setFont('helvetica', 'bold');
    const w2 = doc.getTextWidth(text2);
    const totalW = w1 + w2;

    const startX = innerX + (innerW - totalW) / 2;

    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text(text1, startX, footerY);

    doc.setFont('helvetica', 'bold');
    doc.setTextColor(234, 88, 12);
    doc.text(text2, startX + w1, footerY);

    // ------------------------------------------------------------------------
    // PAGE FOOTER (A4 Bottom Margin)
    // ------------------------------------------------------------------------
    if (pageItemIndex === ITEMS_PER_PAGE - 1 || index === items.length - 1) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(148, 163, 184);
      doc.text(
        `--- Cut along dashed lines   ·   Page ${pageIndex + 1} of ${totalPages}   ·   Powered by RasoiQR ---`,
        PAGE_WIDTH / 2,
        PAGE_HEIGHT - 6,
        { align: 'center' }
      );
    }
  });

  // 6. Download the generated PDF file
  doc.save(`${slug}-table-qrs.pdf`);
}
