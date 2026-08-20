import * as XLSX from 'xlsx';

const MAX_SHEETS = 50;
const MAX_ROWS = 20000;
const MAX_COLUMNS = 500;
const MAX_CELL_CHARS = 20000;

function cellValue(cell) {
  if (!cell) return '';
  return String(cell.w ?? cell.v ?? '').slice(0, MAX_CELL_CHARS);
}

self.onmessage = (event) => {
  try {
    const workbook = XLSX.read(event.data, { type: 'array', cellDates: true, cellFormula: false });
    const sheets = workbook.SheetNames.slice(0, MAX_SHEETS).map((name) => {
      const sheet = workbook.Sheets[name];
      const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
      const rowCount = Math.min(Math.max(0, range.e.r - range.s.r + 1), MAX_ROWS);
      const columnCount = Math.min(Math.max(0, range.e.c - range.s.c + 1), MAX_COLUMNS);
      const rows = Array.from({ length: rowCount }, (_, rowOffset) => Array.from({ length: columnCount }, (_, columnOffset) => {
        const address = XLSX.utils.encode_cell({ r: range.s.r + rowOffset, c: range.s.c + columnOffset });
        return cellValue(sheet[address]);
      }));
      return { name, rows, rowCount, columnCount };
    });
    self.postMessage({ ok: true, sheets });
  } catch (error) {
    self.postMessage({ ok: false, error: error?.message || String(error) });
  }
};
