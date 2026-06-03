import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getGmailClient } from '../../clients.js';
import { decodeBase64UrlToBuffer } from './helpers.js';

type AttachmentReturnFormat = 'base64' | 'text';

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

export function register(server: FastMCP) {
  server.addTool({
    name: 'getAttachment',
    description:
      'Fetches the bytes for a Gmail message attachment by messageId and attachmentId. Use getMessage first to discover attachment IDs; returns base64 for arbitrary files or UTF-8 text for CSV/text attachments.',
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

      try {
        const response = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: args.messageId,
          id: args.attachmentId,
        });

        const encodedData = response.data.data;
        if (encodedData === undefined || encodedData === null) {
          throw new UserError('Gmail attachment response did not include any data.');
        }

        const declaredSize = response.data.size ?? undefined;
        if (args.maxBytes && declaredSize && declaredSize > args.maxBytes) {
          throw new UserError(
            `Gmail attachment is ${declaredSize} bytes, which exceeds maxBytes (${args.maxBytes}).`
          );
        }

        const buffer = decodeBase64UrlToBuffer(encodedData);
        if (args.maxBytes && buffer.length > args.maxBytes) {
          throw new UserError(
            `Gmail attachment is ${buffer.length} bytes, which exceeds maxBytes (${args.maxBytes}).`
          );
        }

        return stringifyAttachmentResult(
          {
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
