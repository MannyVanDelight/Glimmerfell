// PDF of the current configuration, made entirely in the browser: snapshot of the view,
// the list of items with their finishes and indicative prices, and a link + QR code that
// reopen exactly this configuration.

import type { Config, SummaryLine } from './types';
import { amount } from './ui';

const GOLD: [number, number, number] = [197, 160, 89], INK: [number, number, number] = [14, 14, 15];
const MUTED: [number, number, number] = [138, 138, 143], BODY: [number, number, number] = [74, 74, 78], HAIR: [number, number, number] = [226, 226, 226];

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

async function pngData(src: string, size: number): Promise<string> {
    const img = await loadImage(src);
    const cv = document.createElement('canvas'); cv.width = cv.height = size;
    cv.getContext('2d')!.drawImage(img, 0, 0, size, size);
    return cv.toDataURL('image/png');
}

export async function makePdf(cfg: Config, lines: SummaryLine[], image: string, imageAspect: number, shareUrl: string, save = true,
    cta?: { label: string; text: string }, code?: string | null): Promise<string | void> {
    // loaded on first use, so the PDF library is not part of the first page load
    const [{ jsPDF }, qrMod] = await Promise.all([import('jspdf'), import('qrcode-generator')]);
    const qrcode = (qrMod as any).default ?? qrMod;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, H = 297, M = 16;
    let y = M;

    // header
    try { doc.addImage(await pngData('./brand/logo.png', 256), 'PNG', M, y - 2, 11, 11); } catch { /* logo is optional */ }
    doc.setFont('times', 'normal'); doc.setFontSize(15); doc.setTextColor(...INK);
    doc.text('GLIMMERFELL', M + 14, y + 5.6, { charSpace: 1.3 });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
    const date = new Date().toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' });
    doc.text(date, W - M, y + 2, { align: 'right' });
    doc.text('glimmerfell.com', W - M, y + 6.5, { align: 'right' });
    y += 15;
    doc.setDrawColor(...GOLD); doc.setLineWidth(0.4); doc.line(M, y, W - M, y);
    y += 10;

    doc.setFont('times', 'normal'); doc.setFontSize(22); doc.setTextColor(...INK);
    doc.text('Your configuration', M, y);
    y += 6;

    // image
    const iw = W - 2 * M, ih = iw / imageAspect;
    doc.addImage(image, 'JPEG', M, y, iw, ih, undefined, 'FAST');
    y += ih + 8;

    // table
    const colP = W - M, row = (h = 7) => { y += h; };
    const head = () => {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED);
        doc.text('ITEM', M, y, { charSpace: 0.4 }); doc.text('FINISH', M + 62, y, { charSpace: 0.4 });
        doc.text('INDICATIVE PRICE', colP, y, { align: 'right' });
        y += 2.2; doc.setDrawColor(...HAIR); doc.setLineWidth(0.2); doc.line(M, y, W - M, y);
    };
    head();
    let total = 0;
    for (const l of lines) {
        const fin = doc.splitTextToSize(l.finishes.join(', ') || '–', 84) as string[];
        const h = 5.1 + (fin.length - 1) * 3.6;      // compact rows: a full room fits on one page
        if (y + h > H - 66) { doc.addPage(); y = M + 4; head(); }
        row(4.0);
        doc.setFont('times', 'normal'); doc.setFontSize(10.5); doc.setTextColor(...INK);
        doc.text(l.name, M, y);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.6); doc.setTextColor(...BODY);
        doc.text(fin, M + 62, y);
        doc.text(l.price ? amount(l.price, cfg.currency) : '–', colP, y, { align: 'right' });
        y += h - 4.0;
        doc.setDrawColor(...HAIR); doc.line(M, y, W - M, y);
        total += l.price;
    }
    row(8);
    doc.setFont('times', 'normal'); doc.setFontSize(13); doc.setTextColor(...INK);
    doc.text('Indicative total', M, y);
    doc.setTextColor(...GOLD);
    doc.text(amount(total, cfg.currency), colP, y, { align: 'right' });
    row(5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.2); doc.setTextColor(...MUTED);
    doc.text('Prices are indicative placeholders, not a quote.', M, y);

    // link + QR (+ the primary call to action), kept together at the foot of the last page
    const foot = cta ? 49 : 43;
    if (y > H - foot - 7) { doc.addPage(); }
    const qy = H - foot;
    doc.setDrawColor(...GOLD); doc.setLineWidth(0.4); doc.line(M, qy - 6, W - M, qy - 6);
    const qr = qrcode(0, 'L'); qr.addData(shareUrl); qr.make();
    const n = qr.getModuleCount(), qs = 26, cell = qs / n;
    doc.setFillColor(...INK);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) doc.rect(M + c * cell, qy + r * cell, cell + 0.02, cell + 0.02, 'F');
    const tx = M + qs + 8;
    doc.setFont('times', 'normal'); doc.setFontSize(13); doc.setTextColor(...INK);
    doc.text('Open this configuration again', tx, qy + 4.5);
    if (code) {
        // the configuration code, right-aligned on the heading line: short enough to read out in store
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED);
        doc.text('QUOTE THIS CODE IN STORE', W - M, qy, { align: 'right', charSpace: 0.3 });
        doc.setFont('courier', 'bold'); doc.setFontSize(12); doc.setTextColor(...INK);
        doc.text(code, W - M, qy + 5, { align: 'right' });
    }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.4); doc.setTextColor(...BODY);
    doc.text('Scan the code or use the link. It reopens the room exactly as you left it,', tx, qy + 10);
    doc.text('ready to change or to send on.', tx, qy + 14);
    doc.setFontSize(7); doc.setTextColor(...GOLD);
    const linkLines = doc.splitTextToSize(shareUrl, W - M - tx) as string[];
    doc.text(linkLines.slice(0, 4), tx, qy + 19.5);
    doc.link(tx, qy + 16.5, W - M - tx, 4 * 3.2, { url: shareUrl });

    if (cta) {
        const cy = qy + qs + 8;
        doc.setFont('times', 'normal'); doc.setFontSize(11); doc.setTextColor(...INK);
        doc.text(cta.label, M, cy);
        const lw = doc.getTextWidth(cta.label);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.4); doc.setTextColor(...GOLD);
        if (cta.text) doc.text('·  ' + cta.text, M + lw + 3, cy);
    }

    if (!save) return doc.output('datauristring');       // used by tests
    doc.save('glimmerfell-configuration.pdf');
}
