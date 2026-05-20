import { describe, expect, it, vi } from 'vitest';
import {
  buildQueryUrl,
  formatSpreadsheetQueryResult,
  normalizeGvizResponse,
  parseGvizJson,
  runSpreadsheetQuery,
  spreadsheetQueryFailureMessage,
  stringifyToolResult,
} from './querySpreadsheet.js';

describe('buildQueryUrl', () => {
  it('encodes the query and range parameters', () => {
    const url = new URL(
      buildQueryUrl({
        spreadsheetId: 'spreadsheet-id',
        query: "select A, sum(B) where C = 'Done' group by A",
        range: 'Tasks!A1:C100',
        headers: 1,
      })
    );

    expect(url.pathname).toBe('/spreadsheets/d/spreadsheet-id/gviz/tq');
    expect(url.searchParams.get('tqx')).toBe('out:json');
    expect(url.searchParams.get('tq')).toBe("select A, sum(B) where C = 'Done' group by A");
    expect(url.searchParams.get('sheet')).toBe('Tasks');
    expect(url.searchParams.get('range')).toBe('A1:C100');
    expect(url.searchParams.get('headers')).toBe('1');
  });

  it('keeps explicit sheetName when range also contains a sheet name', () => {
    const url = new URL(
      buildQueryUrl({
        spreadsheetId: 'spreadsheet-id',
        query: 'select A',
        sheetName: 'Explicit',
        range: 'Ignored!A1:A10',
      })
    );

    expect(url.searchParams.get('sheet')).toBe('Explicit');
    expect(url.searchParams.get('range')).toBe('A1:A10');
  });
});

describe('normalizeGvizResponse', () => {
  it('returns columns and rows as arrays plus keyed objects', () => {
    const result = normalizeGvizResponse({
      status: 'ok',
      table: {
        cols: [
          { id: 'A', label: 'Name', type: 'string' },
          { id: 'B', label: 'Total', type: 'number' },
        ],
        rows: [{ c: [{ v: 'Ada' }, { v: 42, f: '42.00' }] }, { c: [{ v: 'Grace' }, { v: 31 }] }],
      },
    });

    expect(result.columns).toEqual([
      { id: 'A', label: 'Name', type: 'string', pattern: undefined, key: 'Name' },
      { id: 'B', label: 'Total', type: 'number', pattern: undefined, key: 'Total' },
    ]);
    expect(result.rows).toEqual([
      { values: ['Ada', 42], formattedValues: [null, '42.00'], object: { Name: 'Ada', Total: 42 } },
      {
        values: ['Grace', 31],
        formattedValues: [null, null],
        object: { Name: 'Grace', Total: 31 },
      },
    ]);
  });

  it('deduplicates object keys from duplicate labels', () => {
    const result = normalizeGvizResponse({
      status: 'ok',
      table: {
        cols: [
          { id: 'A', label: 'Value', type: 'number' },
          { id: 'B', label: 'Value', type: 'number' },
        ],
        rows: [{ c: [{ v: 1 }, { v: 2 }] }],
      },
    });

    expect(result.columns.map((column) => column.key)).toEqual(['Value', 'Value_2']);
    expect(result.rows[0].object).toEqual({ Value: 1, Value_2: 2 });
  });

  it('can format normalized query results as compact values', () => {
    const result = normalizeGvizResponse({
      status: 'ok',
      table: {
        cols: [
          { id: 'A', label: 'Name', type: 'string' },
          { id: 'count-A', label: 'count ', type: 'number' },
        ],
        rows: [{ c: [{ v: 'Ada' }, { v: 42 }] }],
      },
    });

    expect(formatSpreadsheetQueryResult(result, 'values')).toEqual({
      values: [
        ['Name', 'count '],
        ['Ada', 42],
      ],
    });
  });
});

describe('parseGvizJson', () => {
  it('parses JSONP responses with the Sheets anti-XSSI prefix', () => {
    expect(
      parseGvizJson(
        '/*O_o*/\ngoogle.visualization.Query.setResponse({"status":"ok","table":{"cols":[],"rows":[]}});'
      )
    ).toEqual({ status: 'ok', table: { cols: [], rows: [] } });
  });

  it('accepts already-parsed response objects from the Google client', () => {
    const response = { status: 'ok', table: { cols: [], rows: [] } };

    expect(parseGvizJson(response)).toBe(response);
  });

  it('parses buffer response bodies', () => {
    expect(parseGvizJson(Buffer.from('{"status":"ok","table":{"cols":[],"rows":[]}}'))).toEqual({
      status: 'ok',
      table: { cols: [], rows: [] },
    });
  });

  it('throws a UserError for empty responses instead of calling trim', () => {
    expect(() => parseGvizJson(undefined)).toThrow('Query returned an empty response');
  });

  it('throws Google API error object messages instead of treating them as empty results', () => {
    expect(() => parseGvizJson({ error: { message: 'Invalid Credentials' } })).toThrow(
      'Spreadsheet query failed: Invalid Credentials'
    );
  });

  it('rejects unsupported object responses instead of treating them as empty results', () => {
    expect(() => parseGvizJson({ html: '<p>Sign in</p>' })).toThrow('unsupported object response');
  });
});

describe('runSpreadsheetQuery', () => {
  it('authenticates through the Google auth client instead of adding access_token to the URL', async () => {
    const request = vi.fn().mockResolvedValue({
      data: '{"status":"ok","table":{"cols":[],"rows":[]}}',
    });

    await runSpreadsheetQuery({ request } as any, {
      spreadsheetId: 'spreadsheet-id',
      sheetName: 'Tasks',
      query: 'select A',
    });

    const requestArgs = request.mock.calls[0][0];
    const url = new URL(requestArgs.url);
    expect(url.searchParams.has('access_token')).toBe(false);
    expect(requestArgs).toMatchObject({
      method: 'GET',
      responseType: 'text',
    });
  });
});

describe('spreadsheetQueryFailureMessage', () => {
  it('summarizes Google sign-in HTML without echoing the whole page', () => {
    const message = spreadsheetQueryFailureMessage({
      response: { data: '<!DOCTYPE html><div class="login">Sign in</div>' },
    });

    expect(message).toContain('HTML sign-in page');
    expect(message).not.toContain('<!DOCTYPE html>');
  });
});

describe('stringifyToolResult', () => {
  it('can emit compact JSON for latency-sensitive MCP responses', () => {
    expect(stringifyToolResult({ values: [['A'], ['x']] }, false)).toBe('{"values":[["A"],["x"]]}');
  });
});

describe('normalizeGvizResponse error handling', () => {
  it('throws when a successful-looking response has no table payload', () => {
    expect(() => normalizeGvizResponse({ status: 'ok' })).toThrow(
      'Spreadsheet query response did not include a result table'
    );
  });
});
