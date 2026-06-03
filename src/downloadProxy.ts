import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { stream } from 'hono/streaming';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import type { FastMCP } from 'fastmcp';

interface PendingDriveDownload {
  kind?: 'drive';
  fileId: string;
  accessToken: string;
  exportMime?: string;
  fileName: string;
  mimeType: string;
  isWorkspace: boolean;
  expiresAt: number;
}

interface PendingGmailAttachmentDownload {
  kind: 'gmailAttachment';
  messageId: string;
  attachmentId: string;
  accessToken: string;
  fileName: string;
  mimeType: string;
  maxBytes?: number;
  expiresAt: number;
}

type PendingDownload = PendingDriveDownload | PendingGmailAttachmentDownload;
type DownloadTokenInput =
  | Omit<PendingDriveDownload, 'expiresAt'>
  | Omit<PendingGmailAttachmentDownload, 'expiresAt'>;

const pending = new Map<string, PendingDownload>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
}, 60_000).unref();

export function createDownloadToken(opts: DownloadTokenInput): string {
  const token = crypto.randomUUID();
  pending.set(token, { ...opts, expiresAt: Date.now() + 5 * 60 * 1000 });
  return token;
}

export function registerDownloadRoute(server: FastMCP): void {
  const app = server.getApp();
  app.get('/download/:token', async (c) => {
    const token = c.req.param('token');
    const entry = pending.get(token);
    if (!entry || entry.expiresAt < Date.now()) {
      return c.text('Download link expired or invalid.', 410);
    }
    pending.delete(token);

    const auth = new OAuth2Client();
    auth.setCredentials({ access_token: entry.accessToken });

    c.header(
      'Content-Disposition',
      `attachment; filename="${entry.fileName.replace(/"/g, '\\"')}"`
    );

    if (entry.kind === 'gmailAttachment') {
      c.header('Content-Type', entry.mimeType);
      const gmail = google.gmail({ version: 'v1', auth });
      const res = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: entry.messageId,
        id: entry.attachmentId,
      });
      const buffer = Buffer.from(res.data.data ?? '', 'base64url');
      if (entry.maxBytes && buffer.length > entry.maxBytes) {
        return c.text(
          `Attachment is ${buffer.length} bytes, which exceeds maxBytes (${entry.maxBytes}).`,
          413
        );
      }
      c.header('Content-Length', String(buffer.length));
      const webStream = Readable.toWeb(Readable.from(buffer)) as ReadableStream;
      return stream(c, async (s) => {
        await s.pipe(webStream);
      });
    }

    const drive = google.drive({ version: 'v3', auth });

    if (entry.isWorkspace && entry.exportMime) {
      c.header('Content-Type', entry.exportMime);
      const res = await drive.files.export(
        { fileId: entry.fileId, mimeType: entry.exportMime },
        { responseType: 'stream' }
      );
      const webStream = Readable.toWeb(res.data as Readable) as ReadableStream;
      return stream(c, async (s) => {
        await s.pipe(webStream);
      });
    } else {
      c.header('Content-Type', entry.mimeType);
      const res = await drive.files.get(
        { fileId: entry.fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );
      const webStream = Readable.toWeb(res.data as Readable) as ReadableStream;
      return stream(c, async (s) => {
        await s.pipe(webStream);
      });
    }
  });
}
