import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileDown,
  Loader2,
  Power,
  QrCode as QrCodeIcon,
  RotateCw,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Card, Button, Alert } from "../../../components/ui";
import { generateQrPdf } from "../../../services/qrPdfService";
import { getMyTables, rotateTableCode, setTableActive } from "../../../services/restaurantService";
import type { RestaurantTable } from "../../../config/supabase";

interface QRCodeManagerProps {
  slug: string;
  restaurantName: string;
  /**
   * Migration 044/045: the owner's declared table count. It is no longer the
   * source of the QR list (that is `restaurant_tables`) — it is the signal that
   * the list changed, because the profile form above is the only thing that
   * creates or deactivates tables.
   */
  tableCount: number | null;
}

interface Notice {
  type: "success" | "error";
  message: string;
}

// Rasterised size for the standalone image download — the QR is vector, so it
// stays crisp at any scale.
const PNG_EXPORT_PX = 1024;

const MAX_DOTS = 12; // above this the counter alone is clearer

// This section always previews the master menu QR as slide 0 and exposes no
// master toggle, so every PDF includes it. Named so the generateQrPdf contract
// stays explicit if a toggle is ever added.
const INCLUDE_MASTER = true;

/** Rasterises a rendered QR svg into a white-backed PNG data URL. */
const svgToPngDataUrl = (svg: SVGSVGElement, px: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const svgData = new XMLSerializer().serializeToString(svg);
    const img = new Image();

    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = px;
      canvas.height = px;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas is not supported in this browser"));
        return;
      }
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, px, px);
      ctx.drawImage(img, 0, 0, px, px);
      resolve(canvas.toDataURL("image/png"));
    };

    img.onerror = () => reject(new Error("Could not render the QR code image"));
    img.src = `data:image/svg+xml;base64,${btoa(svgData)}`;
  });

const QRCodeManager: React.FC<QRCodeManagerProps> = ({
  slug,
  restaurantName,
  tableCount,
}) => {
  const [rows, setRows] = useState<RestaurantTable[]>([]);
  const [rowsError, setRowsError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);

  // Migration 045: the tables are server rows now (`restaurant_tables`), each
  // with its own random code. This card only ever displays them — creating and
  // deactivating happens through the declared count in the profile form above,
  // and the code itself is only ever written by the owner RPCs.
  const loadRows = useCallback(async () => {
    try {
      setRows(await getMyTables());
      setRowsError("");
    } catch (e) {
      setRowsError(e instanceof Error ? e.message : "Could not load your tables.");
    }
  }, []);

  useEffect(() => {
    void loadRows();
  }, [loadRows, tableCount]);

  // Only an active table can receive an order, so only those get a QR here — a
  // standee for a stopped table could never place one.
  const activeTables = useMemo(() => rows.filter((row) => row.is_active), [rows]);

  /**
   * A numeric table is "above the declared count" when the profile number is
   * lower — the count-sync deactivates those rows instead of deleting them, so
   * that raising the number again revives the SAME code and an already-printed
   * standee needs no reprint. Those rows get no Resume button: the owner's lever
   * is the number in the profile, and a table outside it should not accept
   * orders. Non-numeric labels (a future custom table) have no count to compare.
   */
  const isAboveDeclaredCount = (row: RestaurantTable): boolean =>
    tableCount !== null && /^\d+$/.test(row.label) && Number(row.label) > tableCount;

  // Slide 0 is always the master menu QR, then one slide per active table. The
  // URL carries the table's CODE, never its number: that is what makes a table
  // impossible to invent and revocable one at a time.
  const slides = useMemo(() => {
    const base = window.location.origin;
    return [
      {
        id: "master",
        label: "Master Menu QR",
        fileName: `${slug}-master.png`,
        url: `${base}/menu/${slug}`,
      },
      ...activeTables.map((table) => ({
        id: `table-${table.label}`,
        label: `Table ${table.label}`,
        fileName: `${slug}-table-${table.label}.png`,
        url: `${base}/menu/${slug}?t=${table.code}`,
      })),
    ];
  }, [slug, activeTables]);

  /** Give one table a fresh code — the old printed standee stops working. */
  const handleRotate = async (row: RestaurantTable) => {
    const confirmed = window.confirm(
      `Give Table ${row.label} a new QR code?\n\nThe QR on that table stops working straight away — print and place the new one. No other table is affected.`
    );
    if (!confirmed) return;

    setBusyId(row.id);
    setNotice(null);
    try {
      await rotateTableCode(row.id);
      await loadRows();
      setNotice({
        type: "success",
        message: `Table ${row.label} has a new code. Download its QR again — the old standee no longer works.`,
      });
    } catch (e) {
      setNotice({
        type: "error",
        message: e instanceof Error ? e.message : "Could not change this table's code.",
      });
    } finally {
      setBusyId(null);
    }
  };

  /** Stop a table from ordering (broken standee, table removed) without deleting it. */
  const handleToggleActive = async (row: RestaurantTable) => {
    const next = !row.is_active;
    if (!next) {
      const confirmed = window.confirm(
        `Stop Table ${row.label} from ordering?\n\nIts QR stops working until you resume it. The table keeps its code, so resuming needs no reprint.`
      );
      if (!confirmed) return;
    }

    setBusyId(row.id);
    setNotice(null);
    try {
      await setTableActive(row.id, next);
      await loadRows();
      setNotice({
        type: "success",
        message: `Table ${row.label} is now ${next ? "active" : "stopped"}.`,
      });
    } catch (e) {
      setNotice({
        type: "error",
        message: e instanceof Error ? e.message : "Could not update this table.",
      });
    } finally {
      setBusyId(null);
    }
  };

  const totalSlides = slides.length;
  const current = slides[Math.min(currentIndex, totalSlides - 1)];

  const goTo = useCallback(
    (index: number) =>
      setCurrentIndex(Math.min(Math.max(index, 0), totalSlides - 1)),
    [totalSlides]
  );

  // Arrow-key navigation (ignored while typing in a form field).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setCurrentIndex((index) => Math.max(index - 1, 0));
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setCurrentIndex((index) => Math.min(index + 1, totalSlides - 1));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [totalSlides]);

  const qrElement = (index: number) =>
    document.getElementById(`qr-slide-${index}`) as SVGSVGElement | null;

  const downloadCurrentQr = async () => {
    const svg = qrElement(currentIndex);
    if (!svg) return;
    setNotice(null);
    try {
      const pngDataUrl = await svgToPngDataUrl(svg, PNG_EXPORT_PX);
      const link = document.createElement("a");
      link.download = current.fileName;
      link.href = pngDataUrl;
      link.click();
    } catch (e) {
      console.error("[QR] Could not download the QR image", e);
      setNotice({
        type: "error",
        message: e instanceof Error ? e.message : "Could not download this QR code",
      });
    }
  };

  const downloadAllAsPdf = async () => {
    // The master QR is always included and this button is already gated on
    // tables.length, so this guard only mirrors the service's own contract.
    if (!INCLUDE_MASTER && activeTables.length === 0) {
      setNotice({
        type: "error",
        message: "Please generate at least one QR code first",
      });
      return;
    }

    setPdfLoading(true);
    setNotice(null);

    try {
      await generateQrPdf({
        restaurantName,
        slug,
        baseUrl: window.location.origin,
        includeMaster: INCLUDE_MASTER,
        tables: activeTables.map((table) => ({ label: table.label, code: table.code })),
      });
      setNotice({
        type: "success",
        message: `PDF downloaded — ${activeTables.length + (INCLUDE_MASTER ? 1 : 0)} QR codes ready to print.`,
      });
    } catch (e) {
      console.error("[QR] Could not generate the QR PDF", e);
      setNotice({
        type: "error",
        message: "Could not generate the PDF. Please try again.",
      });
    } finally {
      setPdfLoading(false);
    }
  };

  const arrowClass =
    "flex h-11 w-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full border border-border bg-white text-text-secondary transition-colors hover:border-accent hover:text-accent focus:outline-none focus:ring-2 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-text-secondary";

  return (
    <Card>
      {/* Section header */}
      <div className="flex items-start space-x-2 mb-6">
        <QrCodeIcon className="w-6 h-6 text-accent" />
        <div>
          <h3 className="text-xl font-bold text-text">QR Codes</h3>
          <p className="text-text-secondary text-sm">
            Preview, print and download a QR for your counter — and one for every table
          </p>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-8">
        {/* Left column — carousel */}
        <div className="flex flex-col items-center gap-4">
          <div className="flex w-full items-center justify-center gap-2 sm:gap-4">
            <button
              type="button"
              aria-label="Previous QR code"
              className={arrowClass}
              disabled={currentIndex === 0}
              onClick={() => goTo(currentIndex - 1)}
            >
              <ChevronLeft className="w-6 h-6" />
            </button>

            {/* flex-1 + min-w-0 lets the preview shrink on narrow phones instead of pushing the arrows out */}
            <div className="min-w-0 flex-1 max-w-[284px] rounded-lg border border-border bg-white p-3 shadow-md sm:p-4">
              <div className="relative mx-auto aspect-square w-full max-w-[250px]">
                {slides.map((slide, index) => (
                  <div
                    key={slide.id}
                    className={index === currentIndex ? "block h-full w-full" : "hidden"}
                  >
                    <QRCodeSVG
                      id={`qr-slide-${index}`}
                      value={slide.url}
                      size={250}
                      level="M"
                      includeMargin
                      title={slide.label}
                      className="h-full w-full"
                    />
                  </div>
                ))}
              </div>
            </div>

            <button
              type="button"
              aria-label="Next QR code"
              className={arrowClass}
              disabled={currentIndex === totalSlides - 1}
              onClick={() => goTo(currentIndex + 1)}
            >
              <ChevronRight className="w-6 h-6" />
            </button>
          </div>

          <div className="text-center">
            <p className="font-semibold text-text">{current.label}</p>
            <p className="text-xs text-text-secondary mt-0.5">
              {currentIndex + 1} / {totalSlides}
            </p>
          </div>

          {totalSlides <= MAX_DOTS && (
            <div className="flex items-center gap-1.5">
              {slides.map((slide, index) => (
                <button
                  key={slide.id}
                  type="button"
                  aria-label={`Show ${slide.label}`}
                  onClick={() => goTo(index)}
                  className={`h-1.5 rounded-full transition-all ${
                    index === currentIndex
                      ? "w-4 bg-accent"
                      : "w-1.5 bg-border hover:bg-text-secondary"
                  }`}
                />
              ))}
            </div>
          )}

          <div className="w-full max-w-xs space-y-3">
            <Button
              fullWidth
              icon={<Download className="w-5 h-5" />}
              onClick={downloadCurrentQr}
            >
              Download This QR
            </Button>
            <Button
              variant="outline"
              fullWidth
              disabled={activeTables.length === 0 || pdfLoading}
              onClick={downloadAllAsPdf}
            >
              {pdfLoading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <FileDown className="w-5 h-5 mr-2" />
                  Download All as PDF
                </>
              )}
            </Button>

            {notice && (
              <Alert
                type={notice.type}
                message={notice.message}
                onClose={() => setNotice(null)}
              />
            )}
          </div>
        </div>

        {/* Right column — details & controls */}
        <div className="space-y-4">
          <div>
            <label className="label mb-2">Restaurant Name</label>
            <div className="p-3 bg-bg-subtle rounded-lg text-text font-medium">
              {restaurantName}
            </div>
          </div>

          <div>
            <label className="label mb-2">Menu URL</label>
            <div className="p-3 bg-bg-subtle rounded-lg break-all text-text-secondary text-sm">
              {current.url}
            </div>
            <a
              href={current.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center space-x-1 text-accent hover:text-accent-secondary mt-2 text-sm"
            >
              <ExternalLink className="w-4 h-4" />
              <span>Open menu page</span>
            </a>
          </div>

          {rows.length === 0 ? (
            <Alert
              type="info"
              message="Set how many tables you have in Restaurant profile above. Each table gets its own QR, and a dine-in order only goes through when the customer scans one of them — until then the Master QR takes takeaway orders only."
            />
          ) : (
            <div>
              <label className="label mb-2">Your tables</label>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {rows.map((row) => (
                  <li key={row.id} className="flex items-center gap-2 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
                      Table {row.label}
                      {!row.is_active && !isAboveDeclaredCount(row) && (
                        <span className="ml-2 text-xs font-semibold text-text-secondary">stopped</span>
                      )}
                      {isAboveDeclaredCount(row) && (
                        <span className="ml-2 text-xs font-semibold text-text-secondary">
                          above your table count
                        </span>
                      )}
                    </span>
                    {isAboveDeclaredCount(row) && (
                      <span className="text-xs text-text-secondary">
                        Raise the number in the profile to use it — its code is kept
                      </span>
                    )}
                    {!isAboveDeclaredCount(row) && (
                      <>
                    <button
                      type="button"
                      onClick={() => void handleRotate(row)}
                      disabled={busyId === row.id}
                      title="Give this table a new QR code"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-semibold text-text-secondary transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
                    >
                      {busyId === row.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RotateCw className="h-3.5 w-3.5" />
                      )}
                      New code
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleToggleActive(row)}
                      disabled={busyId === row.id}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-semibold text-text-secondary transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
                    >
                      <Power className="h-3.5 w-3.5" />
                      {row.is_active ? "Stop" : "Resume"}
                    </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-text-secondary">
                {activeTables.length} active · from the number in Restaurant profile.
                <span className="font-semibold"> New code</span> invalidates that one table's
                printed QR and leaves every other standee working.
              </p>
              {rowsError && <p className="mt-2 text-xs text-error">{rowsError}</p>}
            </div>
          )}

          <div className="bg-accent/10 border border-accent/20 rounded-lg p-4">
            <h4 className="font-semibold text-text mb-2">How to use:</h4>
            <ol className="space-y-2 text-text-secondary text-sm">
              <li>1. Set your number of tables in Restaurant profile above</li>
              <li>2. Every table gets its own QR — guests who scan it order from their table</li>
              <li>3. Use ◀ ▶ to preview, then download one QR or all as a PDF</li>
              <li>4. Print and place one on each table; the Master QR goes on the counter for takeaway</li>
              <li>5. If a standee is lost or abused, use New code for that table only</li>
            </ol>
          </div>
        </div>
      </div>
    </Card>
  );
};

export default QRCodeManager;
