import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { ImapFlow } from 'imapflow';
import { Model, Types } from 'mongoose';
import type { AppConfig } from '@email-backup/config';
import { MailFolder, Mailbox, MessageLocation, StoredMessage } from '@email-backup/database';
import type { QueueRegistry } from '@email-backup/queue';
import { StorageService } from './storage.service';

interface MailboxStateSnapshot { uidValidity?: bigint | number | string; uidNext?: number; highestModseq?: bigint | number | string }
interface FetchedMessageSnapshot { source?: Buffer | Uint8Array; internalDate?: Date; flags?: Set<string>; modseq?: bigint | number | string }
interface MailboxEventRecord { mailboxId: Types.ObjectId; code: string; message?: string; details?: Record<string, unknown> }
export interface SyncEngineResult { processed: number; created: number }

@Injectable()
export class SyncEngine {
  constructor(
    @InjectModel(Mailbox.name) private readonly mailboxes: Model<Mailbox>,
    @InjectModel(MailFolder.name) private readonly folders: Model<MailFolder>,
    @InjectModel(MessageLocation.name) private readonly locations: Model<MessageLocation>,
    @InjectModel(StoredMessage.name) private readonly messages: Model<StoredMessage>,
    @InjectModel('SyncEvent') private readonly events: Model<MailboxEventRecord>,
    @InjectModel('SyncError') private readonly errors: Model<MailboxEventRecord>,
    private readonly storage: StorageService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private async acquire(folderId: string, queues: QueueRegistry): Promise<{ key: string; token: string }> {
    const key = `email-backup:folder-lock:${folderId}`;
    const token = randomUUID();
    const result = await queues.connection.set(key, token, 'PX', 3_600_000, 'NX');
    if (result !== 'OK') throw new Error('Folder synchronization is already running');
    return { key, token };
  }

  private async release(lock: { key: string; token: string }, queues: QueueRegistry): Promise<void> {
    const current = await queues.connection.get(lock.key).catch(() => null);
    if (current === lock.token) await queues.connection.del(lock.key).catch(() => undefined);
  }

  async run(client: ImapFlow, mailboxId: string, folderId: string, queues: QueueRegistry): Promise<SyncEngineResult> {
    const distributedLock = await this.acquire(folderId, queues);
    try {
      const mailbox = await this.mailboxes.findById(mailboxId).exec();
      const folder = await this.folders.findOne({ _id: folderId, mailboxId }).exec();
      if (!mailbox || !folder || !folder.selectable || !mailbox.syncEnabled || folder.status === 'paused') return { processed: 0, created: 0 };
      await this.folders.updateOne({ _id: folder._id }, { status: 'syncing' });
      await this.mailboxes.updateOne({ _id: mailbox._id }, { status: mailbox.initialSyncCompleted ? 'active' : 'initial_sync', $setOnInsert: { initialSyncStartedAt: new Date() } });
      let processed = 0;
      let created = 0;
      const lock = await client.getMailboxLock(folder.path, { readOnly: true });
      try {
        const state = client.mailbox as unknown as MailboxStateSnapshot | false;
        if (!state) throw new Error('Unable to read folder state');
        const uidValidity = String(state.uidValidity ?? '0');
        if (folder.uidValidity && folder.uidValidity !== uidValidity) {
          await this.locations.updateMany({ folderId: folder._id, removedFromSourceAt: { $exists: false } }, { removedFromSourceAt: new Date() });
          await this.events.create({ mailboxId: mailbox._id, code: 'UIDVALIDITY_CHANGED', message: `UIDVALIDITY changed for ${folder.path}`,
            details: { folderId, oldUidValidity: folder.uidValidity, newUidValidity: uidValidity } });
          folder.highestProcessedUid = undefined;
          folder.status = 'reconciliation_required';
        }
        folder.uidValidity = uidValidity;
        folder.uidNext = state.uidNext === undefined ? undefined : String(state.uidNext);
        folder.highestModSeq = state.highestModseq === undefined ? undefined : String(state.highestModseq);
        const startUid = Math.max(1, Number(folder.highestProcessedUid ?? '0') + 1);
        const found = await client.search({ uid: `${startUid}:*` }, { uid: true });
        const uids = Array.isArray(found) ? found : [];
        const batchSize = this.config.get('SYNC_BATCH_SIZE', { infer: true });
        for (let offset = 0; offset < uids.length; offset += batchSize) {
          const batch = uids.slice(offset, offset + batchSize);
          for (const uid of batch) {
            const fetched = await client.fetchOne(uid, { source: true, internalDate: true, flags: true, size: true }, { uid: true }) as unknown as FetchedMessageSnapshot | false;
            if (!fetched || !fetched.source) {
              await this.errors.create({ mailboxId: mailbox._id, code: 'MESSAGE_REMOVED_DURING_FETCH', message: `UID ${uid} disappeared`, details: { folderId } });
              folder.highestProcessedUid = String(uid);
              await folder.save();
              continue;
            }
            const raw = Buffer.isBuffer(fetched.source) ? fetched.source : Buffer.from(fetched.source);
            const flags = [...(fetched.flags ?? new Set<string>())];
            const result = await this.storage.persistMessage({ mailboxId: mailbox._id, folderId: folder._id, uidValidity, imapUid: String(uid),
              flags, keywords: flags.filter((flag) => !flag.startsWith('\\')), modSeq: fetched.modseq === undefined ? undefined : String(fetched.modseq),
              internalDate: fetched.internalDate, raw });
            processed += 1;
            if (result.created) created += 1;
            folder.highestProcessedUid = String(uid);
            folder.lastSyncAt = new Date();
            await folder.save();
          }
        }
        folder.initialSyncCompleted = true;
        folder.status = 'active';
        folder.lastSyncAt = new Date();
        await folder.save();
      } finally { lock.release(); }
      const pending = await this.folders.countDocuments({ mailboxId: mailbox._id, selectable: true, initialSyncCompleted: false });
      await this.mailboxes.updateOne({ _id: mailbox._id }, { status: 'active', initialSyncCompleted: pending === 0,
        ...(pending === 0 ? { initialSyncCompletedAt: new Date() } : {}), lastSuccessfulSyncAt: new Date(),
        $unset: { lastErrorCode: 1, lastErrorMessage: 1, lastErrorAt: 1 } });
      return { processed, created };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Folder synchronization failed';
      await this.folders.updateOne({ _id: folderId }, { status: 'error' });
      await this.mailboxes.updateOne({ _id: mailboxId }, { status: 'error', lastErrorCode: 'FOLDER_SYNC_FAILED', lastErrorMessage: message.slice(0, 1000), lastErrorAt: new Date() });
      if (Types.ObjectId.isValid(mailboxId)) await this.errors.create({ mailboxId: new Types.ObjectId(mailboxId), code: 'FOLDER_SYNC_FAILED', message: message.slice(0, 1000), details: { folderId } });
      throw error;
    } finally { await this.release(distributedLock, queues); }
  }

  async markSourceDeletions(client: ImapFlow, mailboxId: string, folderId: string): Promise<number> {
    const folder = await this.folders.findOne({ _id: folderId, mailboxId }).exec();
    if (!folder?.uidValidity) return 0;
    const lock = await client.getMailboxLock(folder.path, { readOnly: true });
    try {
      const current = await client.search({ all: true }, { uid: true });
      const currentSet = new Set((Array.isArray(current) ? current : []).map(String));
      const locations = await this.locations.find({ folderId: folder._id, uidValidity: folder.uidValidity, removedFromSourceAt: { $exists: false } }).exec();
      let removed = 0;
      for (const location of locations) {
        if (currentSet.has(location.imapUid)) continue;
        location.removedFromSourceAt = new Date();
        await location.save();
        removed += 1;
        const active = await this.locations.exists({ messageId: location.messageId, removedFromSourceAt: { $exists: false } });
        if (!active) await this.messages.updateOne({ _id: location.messageId }, { sourceDeletedAt: new Date() });
      }
      folder.lastReconciliationAt = new Date();
      await folder.save();
      return removed;
    } finally { lock.release(); }
  }
}
