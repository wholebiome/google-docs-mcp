import { describe, expect, it } from 'vitest';
import { chunkRows, chunkStartRange, parseCsvRows } from './importCsvAttachmentToSpreadsheet.js';

describe('Gmail CSV attachment import helpers', () => {
  it('parses quoted CSV rows without flattening embedded delimiters or newlines', () => {
    const rows = parseCsvRows('sku,notes\nGF-001,"hello, world"\nGF-002,"two\nlines"\n');

    expect(rows).toEqual([
      ['sku', 'notes'],
      ['GF-001', 'hello, world'],
      ['GF-002', 'two\nlines'],
    ]);
  });

  it('supports skipping rows and limiting output rows', () => {
    const rows = parseCsvRows('h1,h2\n1,2\n3,4\n5,6\n', { skipRows: 1, maxRows: 2 });

    expect(rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('chunks rows for batched Sheets writes', () => {
    expect(chunkRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('calculates overwrite chunk start cells from an A1 start range', () => {
    expect(chunkStartRange('Import Sheet!B2', 1000)).toBe("'Import Sheet'!B1002");
  });

  it('preserves apostrophes in quoted sheet names when chunking overwrites', () => {
    expect(chunkStartRange("'Bob''s Sheet'!A1", 10)).toBe("'Bob''s Sheet'!A11");
  });

  it('handles exclamation points inside quoted sheet names when chunking overwrites', () => {
    expect(chunkStartRange("'Q1!Import'!A1", 5)).toBe("'Q1!Import'!A6");
  });
});
