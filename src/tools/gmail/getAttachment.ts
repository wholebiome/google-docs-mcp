import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import type { gmail_v1 } from 'googleapis';
import { getGmailClient } from '../../clients.js';
import { createDownloadToken } from '../../downloadProxy.js';
import { requestClients } from '../../remoteWrapper.js';
import { decodeBase64UrlToBuffer } from './helpers.js';

type AttachmentReturnFormat = 'base64' | 'text';
type AttachmentReturnAs = 'url' | 'content';
const isRemote = process.env.MCP_TRANSPORT === 'httpStream';

const MIME_EXTENSION_HINTS: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'text/csv': '.csv',
  'text/plain': '.txt',
  'application/json': '.json',
};

export function formatAttachmentContent(buffer: Buffer, returnFormat: AttachmentReturnFormat) {
  if (returnFormat === 'text') {
    return {
      encoding: 'utf8' as const,
      data: buffer.toString('utf-8'),
    };
  }

  return {
    encoding: 'base64' as const,
    data: buffer.toString('base64'),
  };
}

export function stringifyAttachmentResult(result: unknown, pretty: boolean | undefined) {
  return JSON.stringify(result, null, pretty === false ? 0 : 2);
}

export function safeAttachmentFileName(name?: string | null, mimeType?: string | null): string {
  const cleaned = (name || 'gmail-attachment').replace(/[\\/\x00-\x1f\x7f]/g, '_').trim();
  const safeName = cleaned || 'gmail-attachment';
  if (safeName.includes('.')) return safeName;

  const extension = mimeType ? MIME_EXTENSION_HINTS[mimeType] : undefined;
  return extension ? `${safeName}${extension}` : safeName;
}

export function buildAttachmentContentResult(args: {
  messageId: string;
  attachmentId: string;
  filename?: string | null;
  mimeType?: string | null;
  buffer: Buffer;
  declaredSize?: number;
  returnFormat: AttachmentReturnFormat;
}) {
  const mimeType = args.mimeType ?? 'application/octet-stream';
  const suggestedFilename = safeAttachmentFileName(args.filename, mimeType);
  const content = formatAttachmentContent(args.buffer, args.returnFormat);
  const isBase64 = content.encoding === 'base64';

  return {
    resultMode: 'content',
    messageId: args.messageId,
    attachmentId: args.attachmentId,
    filename: args.filename ?? null,
    suggestedFilename,
    mimeType,
    size: args.declaredSize ?? args.buffer.length,
    decodedSize: args.buffer.length,
    encoding: content.encoding,
    dataField: isBase64 ? 'dataBase64' : 'dataText',
    ...(isBase64 ? { dataBase64: content.data } : { dataText: content.data }),
    agentInstructions: isBase64
      ? [
          'The attachment bytes are already fetched in the top-level dataBase64 field.',
          `Decode dataBase64 as base64 and write the bytes to ${suggestedFilename}.`,
          'Do not search for content.data; this response intentionally avoids a nested content wrapper.',
        ]
      : [
          'The attachment text is already fetched in the top-level dataText field.',
          `Write dataText as UTF-8 text to ${suggestedFilename}.`,
          'Do not search for content.data; this response intentionally avoids a nested content wrapper.',
        ],
  };
}

export async function fetchGmailAttachmentBuffer(
  gmail: gmail_v1.Gmail,
  messageId: string,
  attachmentId: string,
  maxBytes?: number
) {
  const response = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });

  const encodedData = response.data.data;
  if (encodedData === undefined || encodedData === null) {
    throw new UserError('Gmail attachment response did not include any data.');
  }

  const declaredSize = response.data.size ?? undefined;
  if (maxBytes && declaredSize && declaredSize > maxBytes) {
    throw new UserError(
      `Gmail attachment is ${declaredSize} bytes, which exceeds maxBytes (${maxBytes}).`
    );
  }

  const buffer = decodeBase64UrlToBuffer(encodedData);
  if (maxBytes && buffer.length > maxBytes) {
    throw new UserError(
      `Gmail attachment is ${buffer.length} bytes, which exceeds maxBytes (${maxBytes}).`
    );
  }

  return { buffer, declaredSize };
}

export function register(server: FastMCP) {
  server.addTool({
    name: 'getAttachment',
    description:
      'Fetches a Gmail message attachment by messageId and attachmentId. Use getMessage first to discover attachment IDs. Returns attachment bytes as direct top-level dataBase64 by default so agents can decode PDFs/images/binary files in one step. For CSV-to-Sheets workflows, use importCsvAttachmentToSpreadsheet instead of routing CSV content through model context.',
    parameters: z.object({
      messageId: z.string().describe('The Gmail message ID that owns the attachment.'),
      attachmentId: z
        .string()
        .describe('The Gmail attachment ID from getMessage attachments[].attachmentId.'),
      filename: z
        .string()
        .optional()
        .describe('Optional filename from getMessage, echoed back for caller bookkeeping.'),
      mimeType: z
        .string()
        .optional()
        .describe('Optional MIME type from getMessage, echoed back for caller bookkeeping.'),
      returnAs: z
        .enum(['url', 'content'])
        .optional()
        .describe(
          'Default is "content": returns direct top-level dataBase64/dataText for the agent to write locally. Use "url" only in remote mode when the caller can fetch links itself.'
        ),
      returnFormat: z
        .enum(['base64', 'text'])
        .optional()
        .default('base64')
        .describe(
          '"base64" returns arbitrary attachment bytes safely. "text" decodes bytes as UTF-8 for CSV or other text attachments.'
        ),
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Optional safety limit. If the decoded attachment exceeds this many bytes, fail.'
        ),
      pretty: z
        .boolean()
        .optional()
        .default(true)
        .describe('Pretty-print JSON output. Set false for smaller responses.'),
    }),
    execute: async (args, { log }) => {
      const gmail = await getGmailClient();
      log.info(`Getting Gmail attachment ${args.attachmentId} from message ${args.messageId}`);
      const returnAs: AttachmentReturnAs = args.returnAs ?? 'content';

      try {
        if (returnAs === 'url') {
          if (!isRemote) {
            throw new UserError('returnAs="url" is only available in remote httpStream mode.');
          }

          const store = requestClients.getStore();
          if (!store) throw new UserError('Request context missing.');

          const token = createDownloadToken({
            kind: 'gmailAttachment',
            accessToken: store.accessToken,
            messageId: args.messageId,
            attachmentId: args.attachmentId,
            fileName: safeAttachmentFileName(args.filename, args.mimeType),
            mimeType: args.mimeType ?? 'application/octet-stream',
            maxBytes: args.maxBytes,
          });

          return stringifyAttachmentResult(
            {
              downloadUrl: `${process.env.BASE_URL}/download/${token}`,
              expiresInSeconds: 300,
              messageId: args.messageId,
              attachmentId: args.attachmentId,
              filename: safeAttachmentFileName(args.filename, args.mimeType),
              mimeType: args.mimeType ?? null,
            },
            args.pretty
          );
        }

        const { buffer, declaredSize } = await fetchGmailAttachmentBuffer(
          gmail,
          args.messageId,
          args.attachmentId,
          args.maxBytes
        );

        return stringifyAttachmentResult(
          buildAttachmentContentResult({
            messageId: args.messageId,
            attachmentId: args.attachmentId,
            filename: args.filename,
            mimeType: args.mimeType,
            buffer,
            declaredSize,
            returnFormat: args.returnFormat,
          }),
          args.pretty
        );
      } catch (error: any) {
        if (error instanceof UserError) throw error;

        log.error(`Error getting Gmail attachment: ${error.message || error}`);
        if (error.code === 404) {
          throw new UserError(
            'Gmail message or attachment not found. Verify messageId and attachmentId from getMessage.'
          );
        }
        if (error.code === 403) {
          throw new UserError('Permission denied. Confirm the gmail.modify scope was granted.');
        }
        throw new UserError(`Failed to get Gmail attachment: ${error.message || 'Unknown error'}`);
      }
    },
  });
}
