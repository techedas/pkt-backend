import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import type { Response } from 'express';
import { AppError } from './errors';

export type SheetRow = Record<string, string>;

/** Canonical header key: "Option A" -> "optiona", "Product Code" -> "productcode". */
export const headerKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((t) => t.text).join('');
    if ('text' in value) return String(value.text);
    if ('result' in value) return value.result === undefined ? '' : String(value.result);
  }
  return String(value);
}

/**
 * Parse an uploaded CSV or XLSX file into rows keyed by canonical header.
 * Only the first worksheet of an Excel workbook is read.
 */
export async function parseSpreadsheet(file: Express.Multer.File, maxRows = 5000): Promise<SheetRow[]> {
  const name = file.originalname.toLowerCase();
  let rows: SheetRow[];

  if (name.endsWith('.csv') || file.mimetype === 'text/csv') {
    const text = file.buffer.toString('utf8').replace(/^﻿/, '');
    const records = parse(text, { columns: (h: string[]) => h.map(headerKey), skip_empty_lines: true, trim: true, relax_column_count: true }) as SheetRow[];
    rows = records;
  } else if (name.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    } catch {
      throw AppError.badRequest('The Excel file could not be read.', 'INVALID_FILE');
    }
    const ws = wb.worksheets[0];
    if (!ws) throw AppError.badRequest('The Excel file has no worksheets.', 'INVALID_FILE');
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = headerKey(cellToString(cell.value));
    });
    rows = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const record: SheetRow = {};
      let hasValue = false;
      headers.forEach((h, col) => {
        if (!h) return;
        const v = cellToString(row.getCell(col).value).trim();
        if (v) hasValue = true;
        record[h] = v;
      });
      if (hasValue) rows.push(record);
    });
  } else {
    throw AppError.badRequest('Only .csv and .xlsx files are supported.', 'INVALID_FILE_TYPE');
  }

  if (!rows.length) throw AppError.badRequest('The file contains no data rows.', 'EMPTY_FILE');
  if (rows.length > maxRows) throw AppError.badRequest(`A maximum of ${maxRows} rows can be uploaded at once.`, 'TOO_MANY_ROWS');
  return rows;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | Date | null | undefined;
}

/**
 * Report exporter abstraction. CSV is implemented; an Excel exporter can be
 * added by implementing this interface and registering it in `exporters`.
 */
export interface ReportExporter {
  readonly contentType: string;
  readonly extension: string;
  render<T>(columns: ExportColumn<T>[], rows: T[]): Promise<Buffer>;
}

const formatValue = (v: unknown) => (v instanceof Date ? v.toISOString() : v ?? '');

class CsvExporter implements ReportExporter {
  readonly contentType = 'text/csv; charset=utf-8';
  readonly extension = 'csv';

  async render<T>(columns: ExportColumn<T>[], rows: T[]) {
    const data = rows.map((r) => columns.map((c) => formatValue(c.value(r))));
    // Excel detects UTF-8 reliably only with a BOM.
    return Buffer.from('﻿' + stringify([columns.map((c) => c.header), ...data]), 'utf8');
  }
}

export const exporters: Record<string, ReportExporter> = { csv: new CsvExporter() };

export async function sendExport<T>(res: Response, format: string, filename: string, columns: ExportColumn<T>[], rows: T[]) {
  const exporter = exporters[format];
  if (!exporter) throw AppError.badRequest(`Unsupported export format: ${format}`, 'UNSUPPORTED_FORMAT');
  const buffer = await exporter.render(columns, rows);
  const safeName = filename.replace(/[^A-Za-z0-9_.-]/g, '_');
  res.setHeader('Content-Type', exporter.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${exporter.extension}"`);
  res.send(buffer);
}

export function csvTemplate(headers: string[], sampleRows: string[][]) {
  return Buffer.from('﻿' + stringify([headers, ...sampleRows]), 'utf8');
}
