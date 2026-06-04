import type { FastMCP } from 'fastmcp';
import { register as listMessages } from './listMessages.js';
import { register as getMessage } from './getMessage.js';
import { register as getAttachment } from './getAttachment.js';
import { register as importCsvAttachmentToSpreadsheet } from './importCsvAttachmentToSpreadsheet.js';
import { register as sendEmail } from './sendEmail.js';
import { register as trashMessage } from './trashMessage.js';
import { register as modifyMessageLabels } from './modifyMessageLabels.js';
import { register as listLabels } from './listLabels.js';
import { register as createDraft } from './createDraft.js';
import { register as listDrafts } from './listDrafts.js';
import { register as getDraft } from './getDraft.js';
import { register as updateDraft } from './updateDraft.js';
import { register as sendDraft } from './sendDraft.js';
import { register as deleteDraft } from './deleteDraft.js';
import { register as triageInbox } from './triageInbox.js';
import { destructiveDisabled } from '../destructiveGuard.js';

export function registerGmailTools(server: FastMCP) {
  listMessages(server);
  getMessage(server);
  getAttachment(server);
  importCsvAttachmentToSpreadsheet(server);
  sendEmail(server);
  if (!destructiveDisabled()) trashMessage(server);
  modifyMessageLabels(server);
  listLabels(server);
  createDraft(server);
  listDrafts(server);
  getDraft(server);
  updateDraft(server);
  sendDraft(server);
  if (!destructiveDisabled()) deleteDraft(server);
  triageInbox(server);
}
