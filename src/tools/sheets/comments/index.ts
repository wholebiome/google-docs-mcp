import type { FastMCP } from 'fastmcp';

import { register as listSheetsComments } from './listSheetsComments.js';
import { register as getSheetsComment } from './getSheetsComment.js';
import { register as replyToSheetsComment } from './replyToSheetsComment.js';
import { register as resolveSheetsComment } from './resolveSheetsComment.js';
import { register as deleteSheetsComment } from './deleteSheetsComment.js';
import { destructiveDisabled } from '../../destructiveGuard.js';

export function registerSheetsCommentTools(server: FastMCP) {
  listSheetsComments(server);
  getSheetsComment(server);
  replyToSheetsComment(server);
  resolveSheetsComment(server);
  if (!destructiveDisabled()) deleteSheetsComment(server);
}
