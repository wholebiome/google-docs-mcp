import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import { getGmailClient, getSheetsClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';
import { fetchGmailAttachmentBuffer, stringifyAttachmentResult } from './getAttachment.js';

type SheetValue = string | number | boolean | null;

export function parseCsvRows(
  csvText: string,
  opts: { delimiter?: string; skipRows?: number; maxRows?: number } = {}
): SheetValue[][] {
  const rows = parse(csvText, {
    bom: true,
    columns: false,
    delimiter: opts.delimiter ?? ',',
    relax_column_count: true,
    skip_empty_lines: false,
  }) as SheetValue[][];

  const start = opts.skipRows ?? 0;
  const end = opts.maxRows ? start + opts.maxRows : undefined;
  return rows.slice(start, end);
}

export function chunkRows<T>(rows: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    chunks.push(rows.slice(i, i + chunkSize));
  }
  return chunks;
}

function quoteSheetName(sheetName: string): string {
  if (/^[A-Za-z0-9_]+$/.test(sheetName)) return sheetName;
  return `'${sheetName.replace(/'/g, "''")}'`;
}

export function parseChunkStartRange(range: string): {
  sheetName: string | null;
  startCell: string;
} {
  if (range.startsWith("'")) {
    let sheetName = '';
    for (let i = 1; i < range.length; i += 1) {
      const char = range[i];
      if (char === "'") {
        if (range[i + 1] === "'") {
          sheetName += "'";
          i += 1;
          continue;
        }
        if (range[i + 1] !== '!') {
          throw new UserError(
            `Invalid quoted A1 range: ${range}. Expected a sheet-name separator after the closing quote.`
          );
        }
        return {
          sheetName,
          startCell: range.slice(i + 2).split(':')[0],
        };
      }
      sheetName += char;
    }

    throw new UserError(`Invalid quoted A1 range: ${range}. Missing closing quote.`);
  }

  const separator = range.indexOf('!');
  const a1Range = separator === -1 ? range : range.slice(separator + 1);
  return {
    sheetName: separator === -1 ? null : range.slice(0, separator),
    startCell: a1Range.split(':')[0],
  };
}

export function chunkStartRange(range: string, rowOffset: number): string {
  const { sheetName, startCell } = parseChunkStartRange(range);
  const { row, col } = SheetsHelpers.a1ToRowCol(startCell);
  const cell = SheetsHelpers.rowColToA1(row + rowOffset, col);
  return sheetName ? `${quoteSheetName(sheetName)}!${cell}` : cell;
}

export function register(server: FastMCP) {
  server.addTool({
    name: 'importCsvAttachmentToSpreadsheet',
    description:
      'Fetches a CSV Gmail attachment and writes it directly into Google Sheets without returning the CSV content to the model. Use this for large CSV attachments that would exceed context limits if returned as base64 or text.',
    parameters: z.object({
      messageId: z.string().describe('The Gmail message ID that owns the CSV attachment.'),
      attachmentId: z
        .string()
        .describe('The Gmail attachment ID from getMessage attachments[].attachmentId.'),
      spreadsheetId: z
        .string()
        .describe(
          'The destination spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'
        ),
      range: z
        .string()
        .describe(
          'Destination A1 range or starting cell, such as "Sheet1!A1". Append mode appends after existing data in this range; overwrite mode writes chunks starting at this cell.'
        ),
      writeMode: z
        .enum(['append', 'overwrite'])
        .optional()
        .default('append')
        .describe(
          '"append" adds rows after existing data. "overwrite" writes from range/start cell and can optionally clear a range first.'
        ),
      clearRangeBeforeWrite: z
        .string()
        .optional()
        .describe(
          'Optional A1 range to clear before writing. Useful with writeMode="overwrite" to remove stale rows.'
        ),
      delimiter: z
        .string()
        .length(1)
        .optional()
        .default(',')
        .describe('Single-character CSV delimiter. Defaults to comma.'),
      skipRows: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe('Number of parsed CSV rows to skip before writing. Defaults to 0.'),
      maxRows: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional maximum number of parsed CSV rows to write.'),
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Optional safety limit. If the decoded attachment exceeds this many bytes, fail.'
        ),
      chunkSize: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .default(1000)
        .describe('Rows to write per Sheets API request. Defaults to 1000.'),
      valueInputOption: z
        .enum(['RAW', 'USER_ENTERED'])
        .optional()
        .default('RAW')
        .describe(
          'How Sheets should interpret values. RAW preserves CSV strings; USER_ENTERED lets Sheets parse numbers/dates/formulas.'
        ),
      pretty: z
        .boolean()
        .optional()
        .default(true)
        .describe('Pretty-print JSON output. Set false for smaller responses.'),
    }),
    execute: async (args, { log }) => {
      const gmail = await getGmailClient();
      const sheets = await getSheetsClient();
      log.info(
        `Importing Gmail CSV attachment ${args.attachmentId} from message ${args.messageId} to spreadsheet ${args.spreadsheetId}`
      );

      try {
        const { buffer, declaredSize } = await fetchGmailAttachmentBuffer(
          gmail,
          args.messageId,
          args.attachmentId,
          args.maxBytes
        );
        const rows = parseCsvRows(buffer.toString('utf-8'), {
          delimiter: args.delimiter,
          skipRows: args.skipRows,
          maxRows: args.maxRows,
        });

        if (args.clearRangeBeforeWrite) {
          await SheetsHelpers.clearRange(sheets, args.spreadsheetId, args.clearRangeBeforeWrite);
        }

        const chunks = chunkRows(rows, args.chunkSize);
        const updatedRanges: string[] = [];
        let rowsWritten = 0;
        let cellsWritten = 0;

        for (const [index, chunk] of chunks.entries()) {
          if (chunk.length === 0) continue;
          if (args.writeMode === 'overwrite') {
            const chunkRange = chunkStartRange(args.range, rowsWritten);
            const response = await SheetsHelpers.writeRange(
              sheets,
              args.spreadsheetId,
              chunkRange,
              chunk,
              args.valueInputOption
            );
            if (response.updatedRange) updatedRanges.push(response.updatedRange);
            cellsWritten +=
              response.updatedCells ?? chunk.reduce((sum, row) => sum + row.length, 0);
          } else {
            const response = await SheetsHelpers.appendValues(
              sheets,
              args.spreadsheetId,
              args.range,
              chunk,
              args.valueInputOption
            );
            if (response.updates?.updatedRange) updatedRanges.push(response.updates.updatedRange);
            cellsWritten +=
              response.updates?.updatedCells ?? chunk.reduce((sum, row) => sum + row.length, 0);
          }
          rowsWritten += chunk.length;
          log.info(`Imported CSV chunk ${index + 1}/${chunks.length} (${chunk.length} rows)`);
        }

        return stringifyAttachmentResult(
          {
            messageId: args.messageId,
            attachmentId: args.attachmentId,
            spreadsheetId: args.spreadsheetId,
            range: args.range,
            writeMode: args.writeMode,
            attachmentSize: declaredSize ?? buffer.length,
            decodedSize: buffer.length,
            rowsParsed: rows.length,
            rowsWritten,
            cellsWritten,
            chunksWritten: chunks.length,
            updatedRanges: {
              first: updatedRanges[0] ?? null,
              last: updatedRanges[updatedRanges.length - 1] ?? null,
              count: updatedRanges.length,
            },
          },
          args.pretty
        );
      } catch (error: any) {
        if (error instanceof UserError) throw error;
        log.error(`Error importing Gmail CSV attachment: ${error.message || error}`);
        if (error.code === 404) {
          throw new UserError(
            'Gmail attachment or destination spreadsheet not found. Verify IDs and access.'
          );
        }
        if (error.code === 403) {
          throw new UserError(
            'Permission denied. Confirm Gmail and Sheets scopes were granted and the spreadsheet is writable.'
          );
        }
        throw new UserError(
          `Failed to import Gmail CSV attachment: ${error.message || 'Unknown error'}`
        );
      }
    },
  });
}
