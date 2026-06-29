import type { ImapFlow } from 'imapflow';
import type { MailFolder, Mailbox } from '@email-backup/database';
import type { StorageService } from './storage.service';

export interface SyncEngineContext {
  client: ImapFlow;
  mailbox: Mailbox;
  folder: MailFolder;
  storage: StorageService;
}

export interface SyncEngineResult {
  processed: number;
  created: number;
}
