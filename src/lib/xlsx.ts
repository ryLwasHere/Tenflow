import type { CellValue } from 'exceljs';

export type Cell = string | number | Date | null;
export type Row = Record<string, Cell>;

// exceljs is large: load it only when a file is actually read or written.
async function lib() {
  const m: any = await import('exceljs');
  return (m.Workbook ? m : m.default) as typeof import('exceljs');
}

export const normHeader = (s: unknown) => String(s ?? '').toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim();

export function cellValue(v: CellValue | undefined): Cell {
  if (v == null) return null;
  if (v instanceof Date || typeof v === 'number') return v;
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'boolean') return String(v);
  if ('result' in v) return cellValue(v.result as CellValue); // formula: use the cached result
  if ('richText' in v) return cellValue(v.richText.map((r) => r.text).join(''));
  if ('text' in v) return cellValue(v.text as string); // hyperlink
  return null; // error cells (#N/A …) are treated as empty
}

export interface Table { sheet: string; headerRow: number; rows: { n: number; cells: Row }[] }
export interface ReadResult { table?: Table; missing: string[]; sheets: string[] }

/**
 * Finds the sheet + header row (within the first 20 rows) that contains every required column,
 * then reads the required/optional columns by header name. Ignores anything else on the sheet
 * (title rows, pivot areas), so exports with decorative headers still load.
 */
export async function readTable(buf: ArrayBuffer, required: string[], optional: string[] = []): Promise<ReadResult> {
  const X = await lib();
  const wb = new X.Workbook();
  await wb.xlsx.load(buf);
  const want = [...required, ...optional].map(normHeader);
  let bestMissing = required.slice();
  for (const ws of wb.worksheets) {
    const limit = Math.min(20, ws.rowCount);
    for (let r = 1; r <= limit; r++) {
      const col = new Map<string, number>();
      ws.getRow(r).eachCell((c, i) => { const h = normHeader(cellValue(c.value)); if (want.includes(h) && !col.has(h)) col.set(h, i); });
      const missing = required.filter((h) => !col.has(normHeader(h)));
      if (missing.length < bestMissing.length) bestMissing = missing;
      if (missing.length) continue;
      const rows: Table['rows'] = [];
      for (let n = r + 1; n <= ws.rowCount; n++) {
        const row = ws.getRow(n);
        const cells: Row = {};
        let any = false;
        for (const [h, i] of col) { const v = cellValue(row.getCell(i).value); cells[h] = v; if (v != null) any = true; }
        if (any) rows.push({ n, cells });
      }
      return { table: { sheet: ws.name, headerRow: r, rows }, missing: [], sheets: wb.worksheets.map((w) => w.name) };
    }
  }
  return { missing: bestMissing, sheets: wb.worksheets.map((w) => w.name) };
}

/** Reads whole sheets as canonical 2-D arrays (used by the dashboard + checksum). */
export async function readSheets(buf: ArrayBuffer): Promise<Record<string, unknown[][]>> {
  const X = await lib();
  const wb = new X.Workbook();
  await wb.xlsx.load(buf);
  const out: Record<string, unknown[][]> = {};
  for (const ws of wb.worksheets) {
    const rows: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals: unknown[] = [];
      for (let i = 1; i <= ws.columnCount; i++) vals.push(canon(cellValue(row.getCell(i).value)));
      rows.push(vals);
    });
    out[ws.name] = rows;
  }
  return out;
}

export const canon = (v: unknown): string | number =>
  v == null ? '' : v instanceof Date ? new Date(Math.round(+v / 1000) * 1000).toISOString() : typeof v === 'number' ? v : String(v);

export type CellIn = string | number | null | Date | { formula: string; result: string | number };
export interface SheetSpec { name: string; rows: CellIn[][]; widths?: number[]; fmts?: Record<number, string> }

export async function writeXlsx(sheets: SheetSpec[]): Promise<ArrayBuffer> {
  const X = await lib();
  const wb = new X.Workbook();
  wb.creator = 'Tenflow';
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    s.rows.forEach((r) => ws.addRow(r as never[]));
    ws.getRow(1).font = { bold: true };
    s.widths?.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    for (const [c, f] of Object.entries(s.fmts ?? {})) for (let r = 2; r <= s.rows.length; r++) ws.getRow(r).getCell(+c + 1).numFmt = f;
  }
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
