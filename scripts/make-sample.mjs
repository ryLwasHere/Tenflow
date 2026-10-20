// Splits the combined sample workbook into the two upload files the app expects
// (Fingerprint + HRIS). Output goes to sample-data/ (git-ignored: it contains employee data).
import ExcelJS from 'exceljs';
import { mkdirSync } from 'node:fs';

const src = process.argv[2] ?? 'Anonymized Data.xlsx';
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(src);
mkdirSync('sample-data', { recursive: true });
for (const [sheet, out] of [['Data Fingeprint', 'sample-data/fingerprint.xlsx'], ['Data HRIS Talenta', 'sample-data/hris.xlsx']]) {
  const keep = wb.getWorksheet(sheet);
  if (!keep) throw new Error(`Sheet "${sheet}" tidak ditemukan di ${src}`);
  for (const ws of [...wb.worksheets]) if (ws !== keep) wb.removeWorksheet(ws.id);
  // formulas point at sheets we just removed: freeze them to their cached values
  keep.eachRow((row) => row.eachCell((c) => { const v = c.value; if (v && typeof v === 'object' && !(v instanceof Date) && ('formula' in v || 'sharedFormula' in v)) c.value = v.result ?? null; }));
  await wb.xlsx.writeFile(out);
  console.log('wrote', out);
  await wb.xlsx.readFile(src); // reload: sheets were removed in place
}
