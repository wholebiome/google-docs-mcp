import { describe, expect, it } from 'vitest';
import { decodeBase64UrlToBuffer } from './helpers.js';
import {
  buildAttachmentContentResult,
  formatAttachmentContent,
  stringifyAttachmentResult,
} from './getAttachment.js';

describe('Gmail attachment content helpers', () => {
  it('decodes Gmail base64url data into bytes', () => {
    const csv = 'sku,qty\nGF-001,3\n';
    const encoded = Buffer.from(csv, 'utf-8').toString('base64url');

    expect(decodeBase64UrlToBuffer(encoded).toString('utf-8')).toBe(csv);
  });

  it('formats arbitrary bytes as standard base64 by default', () => {
    const content = formatAttachmentContent(Buffer.from([0xfb, 0xff, 0xee]), 'base64');

    expect(content).toEqual({
      encoding: 'base64',
      data: '+//u',
    });
  });

  it('formats CSV/text attachments as UTF-8 text when requested', () => {
    const content = formatAttachmentContent(Buffer.from('sku,qty\nGF-001,3\n'), 'text');

    expect(content).toEqual({
      encoding: 'utf8',
      data: 'sku,qty\nGF-001,3\n',
    });
  });

  it('can compact JSON output for large attachment responses', () => {
    expect(stringifyAttachmentResult({ content: { data: 'abc' } }, false)).toBe(
      '{"content":{"data":"abc"}}'
    );
  });

  it('formats binary attachments with direct top-level base64 data', () => {
    const result = buildAttachmentContentResult({
      messageId: 'm1',
      attachmentId: 'a1',
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-test'),
      returnFormat: 'base64',
    });

    expect(result).toMatchObject({
      resultMode: 'content',
      suggestedFilename: 'invoice.pdf',
      mimeType: 'application/pdf',
      encoding: 'base64',
      dataField: 'dataBase64',
      dataBase64: Buffer.from('%PDF-test').toString('base64'),
    });
    expect(result).not.toHaveProperty('content');
    expect(result.agentInstructions.join(' ')).toContain('dataBase64');
    expect(result.agentInstructions.join(' ')).toContain('Do not search for content.data');
  });

  it('adds a MIME-derived extension when the filename has none', () => {
    const result = buildAttachmentContentResult({
      messageId: 'm1',
      attachmentId: 'a1',
      filename: 'dashboard-snapshot',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-test'),
      returnFormat: 'base64',
    });

    expect(result.suggestedFilename).toBe('dashboard-snapshot.pdf');
  });
});
