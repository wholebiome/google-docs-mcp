import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getAuthClient } from '../../clients.js';
import { runSpreadsheetQuery, spreadsheetQueryFailureMessage } from './querySpreadsheet.js';

const queryParameters = z
  .object({
    id: z
      .string()
      .min(1)
      .optional()
      .describe('Optional caller-defined ID included with this query result.'),
    query: z
      .string()
      .min(1)
      .describe(
        'Google Visualization API Query Language query, such as "select A, B where C > 10". Use spreadsheet column letters, not header labels.'
      ),
    sheetName: z
      .string()
      .optional()
      .describe('Optional sheet/tab name to query. Defaults to the top-level sheetName.'),
    gid: z
      .number()
      .int()
      .optional()
      .describe('Optional numeric sheet gid. Defaults to the top-level gid.'),
    range: z
      .string()
      .optional()
      .describe('Optional A1 range to query, such as "A1:D100" or "Sheet1!A1:D100".'),
    headers: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Optional number of header rows. Defaults to the top-level headers.'),
  })
  .refine((args) => !(args.sheetName && args.gid !== undefined), {
    message: 'Provide either sheetName or gid, not both.',
    path: ['gid'],
  });

export function register(server: FastMCP) {
  server.addTool({
    name: 'batchQuerySpreadsheet',
    description:
      'Runs multiple Google Visualization API Query Language queries against the same spreadsheet in one MCP call and returns each normalized result. This is useful for dashboards that need several grouped aggregations without reading or writing sheet data.',
    parameters: z
      .object({
        spreadsheetId: z
          .string()
          .describe(
            'The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'
          ),
        sheetName: z
          .string()
          .optional()
          .describe('Default sheet/tab name for all queries unless a query overrides it.'),
        gid: z
          .number()
          .int()
          .optional()
          .describe('Default numeric sheet gid for all queries unless a query overrides it.'),
        range: z
          .string()
          .optional()
          .describe('Default A1 range for all queries unless a query overrides it.'),
        headers: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Default number of header rows for all queries unless a query overrides it.'),
        queries: z
          .array(queryParameters)
          .min(1)
          .max(25)
          .describe('Queries to run. Results preserve this input order.'),
      })
      .refine((args) => !(args.sheetName && args.gid !== undefined), {
        message: 'Provide either sheetName or gid, not both.',
        path: ['gid'],
      }),
    execute: async (args, { log }) => {
      const auth = await getAuthClient();
      log.info(`Batch querying spreadsheet ${args.spreadsheetId}: ${args.queries.length} queries`);

      try {
        const results = await Promise.all(
          args.queries.map(async (query, index) => {
            const result = await runSpreadsheetQuery(auth, {
              spreadsheetId: args.spreadsheetId,
              query: query.query,
              sheetName: query.sheetName ?? args.sheetName,
              gid: query.gid ?? args.gid,
              range: query.range ?? args.range,
              headers: query.headers ?? args.headers,
            });

            return {
              id: query.id ?? String(index + 1),
              query: query.query,
              ...result,
            };
          })
        );

        return JSON.stringify({ spreadsheetId: args.spreadsheetId, results }, null, 2);
      } catch (error: any) {
        log.error(
          `Error batch querying spreadsheet ${args.spreadsheetId}: ${error.message || error}`
        );
        if (error instanceof UserError) throw error;
        if (error.code === 404) {
          throw new UserError(`Spreadsheet not found (ID: ${args.spreadsheetId}). Check the ID.`);
        }
        if (error.code === 403) {
          throw new UserError(
            `Permission denied for spreadsheet (ID: ${args.spreadsheetId}). Ensure you have read access.`
          );
        }
        throw new UserError(
          `Failed to batch query spreadsheet: ${spreadsheetQueryFailureMessage(error)}`
        );
      }
    },
  });
}
