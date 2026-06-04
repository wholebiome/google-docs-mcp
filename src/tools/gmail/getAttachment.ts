import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import type { gmail_v1 } from 'googleapis';
import { getGmailClient } from '../../clients.js';
import { createDownloadToken } from '../../downloadProxy.js';
import { requestClients } from '../../remoteWrapper.js';
import { decodeBase64UrlToBuffer } from './helpers.js';

type AttachmentReturnFormat = 'base64' | 'text';
type AttachmentReturnAs = 'resource' | 'url' | 'content';
const isRemote = process.env.MCP_TRANSPORT === 'httpStream';
const MAX_RESOURCE_BYTES = 25 * 1024 * 1024;

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

function safeAttachmentFileName(name?: string | null): string {
  const cleaned = (name || 'gmail-attachment').replace(/[\\/\0\r\n\t]/g, '_').trim();
  return cleaned || 'gmail-attachment';
}

export function attachmentResourceResult(args: {
  messageId: string;
  attachmentId: string;
  filename?: string | null;
  mimeType?: string | null;
  buffer: Buffer;
  declaredSize?: number;
}) {
  const fileName = safeAttachmentFileName(args.filename);
  const mimeType = args.mimeType ?? 'application/octet-stream';

  return {
    content: [
      {
        type: 'resource' as const,
        resource: {
          uri: `gmail:///${encodeURIComponent(args.messageId)}/${encodeURIComponent(args.attachmentId)}/${encodeURIComponent(fileName)}`,
          blob: args.buffer.toString('base64'),
          mimeType,
        },
      },
      {
        type: 'text' as const,
        text: JSON.stringify({
          resultMode: 'resource',
          messageId: args.messageId,
          attachmentId: args.attachmentId,
          filename: fileName,
          mimeType,
          size: args.declaredSize ?? args.buffer.length,
          decodedSize: args.buffer.length,
        }),
      },
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
      'Fetches a Gmail message attachment by messageId and attachmentId. Use getMessage first to discover attachment IDs. In remote mode it returns an MCP resource by default so PDF/image/binary attachments are delivered as file-like content instead of a user-facing URL or JSON base64.',
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
        .enum(['resource', 'url', 'content'])
        .optional()
        .describe(
          'Remote mode default is "resource" so attachments are delivered as MCP resource content. Stdio mode default is "content". Use "url" only when the caller can fetch links itself; use "content" only for small text/base64 responses.'
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
      const returnAs: AttachmentReturnAs = args.returnAs ?? (isRemote ? 'resource' : 'content');

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
            fileName: args.filename ?? 'gmail-attachment',
            mimeType: args.mimeType ?? 'application/octet-stream',
            maxBytes: args.maxBytes,
          });

          return stringifyAttachmentResult(
            {
              downloadUrl: `${process.env.BASE_URL}/download/${token}`,
              expiresInSeconds: 300,
              messageId: args.messageId,
              attachmentId: args.attachmentId,
              filename: args.filename ?? null,
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

        if (returnAs === 'resource') {
          if (buffer.length > MAX_RESOURCE_BYTES) {
            throw new UserError(
              `Attachment is too large for MCP resource transfer (${(buffer.length / 1024 / 1024).toFixed(1)}MB, limit ${(MAX_RESOURCE_BYTES / 1024 / 1024).toFixed(0)}MB). For CSV files use importCsvAttachmentToSpreadsheet; otherwise request returnAs="url" from a client that can fetch URLs.`
            );
          }

          return attachmentResourceResult({
            messageId: args.messageId,
            attachmentId: args.attachmentId,
            filename: args.filename,
            mimeType: args.mimeType,
            buffer,
            declaredSize,
          });
        }

        return stringifyAttachmentResult(
          {
            resultMode: 'content',
            messageId: args.messageId,
            attachmentId: args.attachmentId,
            filename: args.filename ?? null,
            mimeType: args.mimeType ?? null,
            size: declaredSize ?? buffer.length,
            decodedSize: buffer.length,
            content: formatAttachmentContent(buffer, args.returnFormat),
          },
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
