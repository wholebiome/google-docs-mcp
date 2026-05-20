import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getAuthClient } from '../../clients.js';
import {
  formatSpreadsheetQueryResult,
  type NormalizedGvizResponse,
  runSpreadsheetQuery,
  spreadsheetQueryFailureMessage,
  stringifyToolResult,
} from './querySpreadsheet.js';

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

async function mapWithConcurrency<T, U>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<U>
) {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    })
  );

  return results;
}

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
        responseFormat: z
          .enum(['rich', 'values'])
          .optional()
          .describe(
            'Output shape for each result. "rich" preserves the default columns/rows/object response. "values" returns compact 2D values arrays with header rows.'
          ),
        includeQuery: z
          .boolean()
          .optional()
          .describe('Include each original query string in the response. Defaults to true.'),
        pretty: z
          .boolean()
          .optional()
          .describe('Pretty-print JSON output. Defaults to true; set false for smaller responses.'),
        maxConcurrency: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe(
            'Maximum number of Google Visualization requests to run at once. Defaults to 3 to avoid transient Google sign-in/rate-limit responses.'
          ),
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
      const responseFormat = args.responseFormat ?? 'rich';
      const includeQuery = args.includeQuery ?? true;
      const pretty = args.pretty ?? true;
      const maxConcurrency = args.maxConcurrency ?? 3;

      try {
        const results = await mapWithConcurrency(
          args.queries,
          maxConcurrency,
          async (query, index) => {
            const queryArgs = {
              spreadsheetId: args.spreadsheetId,
              query: query.query,
              sheetName: query.sheetName ?? args.sheetName,
              gid: query.gid ?? args.gid,
              range: query.range ?? args.range,
              headers: query.headers ?? args.headers,
            };
            let result: NormalizedGvizResponse;
            try {
              result = await runSpreadsheetQuery(auth, queryArgs);
            } catch (error: any) {
              if (spreadsheetQueryFailureMessage(error).includes('HTML sign-in page')) {
                result = await runSpreadsheetQuery(auth, queryArgs);
              } else {
                throw error;
              }
            }

            return {
              id: query.id ?? String(index + 1),
              ...(includeQuery ? { query: query.query } : {}),
              ...formatSpreadsheetQueryResult(result, responseFormat),
            };
          }
        );

        return stringifyToolResult({ spreadsheetId: args.spreadsheetId, results }, pretty);
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
