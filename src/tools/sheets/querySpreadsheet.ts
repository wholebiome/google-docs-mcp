import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getAuthClient } from '../../clients.js';
import * as SheetsHelpers from '../../googleSheetsApiHelpers.js';

type GvizColumn = {
  id?: string;
  label?: string;
  type?: string;
  pattern?: string;
};

type GvizCell = {
  v?: unknown;
  f?: string;
};

type GvizRow = {
  c?: Array<GvizCell | null>;
};

type GvizResponse = {
  status?: string;
  errors?: Array<{ reason?: string; message?: string; detailed_message?: string }>;
  warnings?: Array<{ reason?: string; message?: string; detailed_message?: string }>;
  table?: {
    cols?: GvizColumn[];
    rows?: GvizRow[];
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Buffer.isBuffer(value);
}

function objectErrorMessage(responseData: Record<string, unknown>) {
  const error = responseData.error;

  if (typeof error === 'string') return error;
  if (isRecord(error)) {
    const message = error.message;
    const status = error.status;
    if (typeof message === 'string') return message;
    if (typeof status === 'string') return status;
  }

  return undefined;
}

export function parseGvizJson(responseData: unknown): GvizResponse {
  if (isRecord(responseData)) {
    const errorMessage = objectErrorMessage(responseData);
    if (errorMessage) {
      throw new UserError(`Spreadsheet query failed: ${errorMessage}`);
    }

    if ('table' in responseData || 'status' in responseData || 'errors' in responseData) {
      return responseData as GvizResponse;
    }

    throw new UserError(
      `Query returned an unsupported object response from Google Sheets: ${Object.keys(responseData)
        .slice(0, 5)
        .join(', ')}.`
    );
  }

  if (responseData === null || responseData === undefined) {
    throw new UserError('Query returned an empty response from Google Sheets.');
  }

  const responseText = Buffer.isBuffer(responseData) ? responseData.toString('utf8') : responseData;

  if (typeof responseText !== 'string') {
    throw new UserError(
      `Query returned an unsupported response type from Google Sheets: ${typeof responseText}.`
    );
  }

  const trimmed = responseText.trim().replace(/^\/\*O_o\*\/\s*/, '');
  const prefix = 'google.visualization.Query.setResponse(';

  if (!trimmed) {
    throw new UserError('Query returned an empty response from Google Sheets.');
  }

  if (trimmed.startsWith(prefix) && trimmed.endsWith(');')) {
    return JSON.parse(trimmed.slice(prefix.length, -2)) as GvizResponse;
  }

  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    return parseGvizJson(parsed);
  }

  throw new UserError('Query returned an unexpected response format from Google Sheets.');
}

function columnKey(column: GvizColumn, index: number, usedKeys: Set<string>): string {
  const baseKey = column.label || column.id || `column_${index + 1}`;
  let key = baseKey;
  let suffix = 2;

  while (usedKeys.has(key)) {
    key = `${baseKey}_${suffix}`;
    suffix += 1;
  }

  usedKeys.add(key);
  return key;
}

export function normalizeGvizResponse(response: GvizResponse) {
  if (response.status === 'error') {
    const message =
      response.errors
        ?.map((error) => error.detailed_message || error.message || error.reason)
        .filter(Boolean)
        .join('; ') || 'Unknown query error';
    throw new UserError(`Spreadsheet query failed: ${message}`);
  }

  if (!response.table) {
    throw new UserError('Spreadsheet query response did not include a result table.');
  }

  const usedKeys = new Set<string>();
  const columns = response.table.cols || [];
  const objectKeys = columns.map((column, index) => columnKey(column, index, usedKeys));

  const rows = (response.table.rows || []).map((row) => {
    const values = columns.map((_, index) => row.c?.[index]?.v ?? null);
    const formattedValues = columns.map((_, index) => row.c?.[index]?.f ?? null);
    const object = Object.fromEntries(objectKeys.map((key, index) => [key, values[index]]));

    return { values, formattedValues, object };
  });

  return {
    columns: columns.map((column, index) => ({
      id: column.id || '',
      label: column.label || '',
      type: column.type || '',
      pattern: column.pattern,
      key: objectKeys[index],
    })),
    rows,
    warnings:
      response.warnings?.map((warning) => ({
        reason: warning.reason,
        message: warning.message || warning.detailed_message,
      })) || [],
  };
}

function applyRangeDefaults(range: string | undefined, sheetName: string | undefined) {
  if (!range) return { range, sheetName };

  const parsed = SheetsHelpers.parseRange(range);
  return {
    range: parsed.a1Range,
    sheetName: sheetName || parsed.sheetName || undefined,
  };
}

export function buildQueryUrl(args: {
  spreadsheetId: string;
  query: string;
  sheetName?: string;
  gid?: number;
  range?: string;
  headers?: number;
}) {
  const { range, sheetName } = applyRangeDefaults(args.range, args.sheetName);
  const url = new URL(`https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/gviz/tq`);

  url.searchParams.set('tqx', 'out:json');
  url.searchParams.set('tq', args.query);

  if (sheetName) url.searchParams.set('sheet', sheetName);
  if (args.gid !== undefined) url.searchParams.set('gid', String(args.gid));
  if (range) url.searchParams.set('range', range);
  if (args.headers !== undefined) url.searchParams.set('headers', String(args.headers));

  return url.toString();
}

export type SpreadsheetQueryArgs = {
  spreadsheetId: string;
  query: string;
  sheetName?: string;
  gid?: number;
  range?: string;
  headers?: number;
};

export async function addAccessToken(url: string, auth: Awaited<ReturnType<typeof getAuthClient>>) {
  const tokenResponse = await auth.getAccessToken();
  const accessToken = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;

  if (!accessToken) {
    throw new UserError('Google auth client did not provide an access token for the query.');
  }

  const authenticatedUrl = new URL(url);
  authenticatedUrl.searchParams.set('access_token', accessToken);
  return authenticatedUrl.toString();
}

export async function runSpreadsheetQuery(
  auth: Awaited<ReturnType<typeof getAuthClient>>,
  args: SpreadsheetQueryArgs
) {
  const response = await auth.request<string>({
    url: await addAccessToken(buildQueryUrl(args), auth),
    method: 'GET',
    responseType: 'text',
  });
  return normalizeGvizResponse(parseGvizJson(response.data));
}

export function register(server: FastMCP) {
  server.addTool({
    name: 'querySpreadsheet',
    description:
      'Runs a Google Visualization API Query Language query against a spreadsheet and returns the result without writing formulas or modifying the sheet. Use column letters in queries (e.g., "select A, sum(B) where C = \'Done\' group by A").',
    parameters: z
      .object({
        spreadsheetId: z
          .string()
          .describe(
            'The spreadsheet ID — the long string between /d/ and /edit in a Google Sheets URL.'
          ),
        query: z
          .string()
          .min(1)
          .describe(
            'Google Visualization API Query Language query, such as "select A, B where C > 10 order by B desc limit 20". Use spreadsheet column letters, not header labels.'
          ),
        sheetName: z
          .string()
          .optional()
          .describe(
            'Optional sheet/tab name to query. Can also be provided in range as Sheet1!A1:C.'
          ),
        gid: z
          .number()
          .int()
          .optional()
          .describe('Optional numeric sheet gid. Use this instead of sheetName if preferred.'),
        range: z
          .string()
          .optional()
          .describe(
            'Optional A1 range to query, such as "A1:D100" or "Sheet1!A1:D100". If omitted, queries the selected sheet.'
          ),
        headers: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Optional number of header rows. Use 0 when the range has no header row.'),
      })
      .refine((args) => !(args.sheetName && args.gid !== undefined), {
        message: 'Provide either sheetName or gid, not both.',
        path: ['gid'],
      }),
    execute: async (args, { log }) => {
      const auth = await getAuthClient();
      log.info(`Querying spreadsheet ${args.spreadsheetId}`);

      try {
        return JSON.stringify(await runSpreadsheetQuery(auth, args), null, 2);
      } catch (error: any) {
        log.error(`Error querying spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
        if (error instanceof UserError) throw error;
        if (error.code === 404) {
          throw new UserError(`Spreadsheet not found (ID: ${args.spreadsheetId}). Check the ID.`);
        }
        if (error.code === 403) {
          throw new UserError(
            `Permission denied for spreadsheet (ID: ${args.spreadsheetId}). Ensure you have read access.`
          );
        }
        throw new UserError(`Failed to query spreadsheet: ${error.message || 'Unknown error'}`);
      }
    },
  });
}
