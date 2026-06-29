import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { GridFSBucket } from 'mongodb';
import { Model, Types, type Connection } from 'mongoose';
import type { AppConfig } from '@email-backup/config';
import { BinaryObject, MessageLocation, StoredAttachment, StoredMessage } from '@email-backup/database';
import { ImapClientService } from '@email-backup/imap';
import { sanitizeFilename } from '@email-backup/shared';

interface AddressValue { name?: string; address?: string }
interface AddressContainer { value?: AddressValue[] }
export interface PersistMessageInput {
  mailboxId: Types.ObjectId; folderId: Types.ObjectId; uidValidity: string; imapUid: string;
  flags: string[]; keywords: string[]; modSeq?: string; internalDate?: Date; raw: Buffer;
}
export interface PersistMessageResult { messageId: Types.ObjectId; created: boolean; attachmentCount: number; rawSizeBytes: number }

const digest = (content: Buffer): string => createHash('sha256').update(content).digest('hex');
function addresses(value: AddressContainer | AddressContainer[] | undefined): Array<{ name?: string; address: string }> {
  const containers = Array.isArray(value) ? value : value ? [value] : [];
  return containers.flatMap((container) => (container.value ?? []).flatMap((item) => {
    const address = item.address?.trim().toLowerCase();
    return address ? [{ ...(item.name ? { name: item.name } : {}), address }] : [];
  }));
}
function headersToRecord(headers: Map<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...headers.entries()].map(([key, value]) => [key, value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : value]));
}

@Injectable()
export class StorageService {
  private readonly parser = new ImapClientService();
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(StoredMessage.name) private readonly messages: Model<StoredMessage>,
    @InjectModel(MessageLocation.name) private readonly locations: Model<MessageLocation>,
    @InjectModel(StoredAttachment.name) private readonly attachments: Model<StoredAttachment>,
    @InjectModel(BinaryObject.name) private readonly binaries: Model<BinaryObject>,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}
  private bucket(): GridFSBucket {
    if (!this.connection.db) throw new Error('MongoDB is not connected');
    return new GridFSBucket(this.connection.db, { bucketName: 'emailBinaries' });
  }
  private async putBinary(mailboxId: Types.ObjectId, kind: 'raw_message' | 'attachment' | 'export', content: Buffer, hash: string, filename: string): Promise<Types.ObjectId> {
    const existing = await this.binaries.findOne({ mailboxId, sha256: hash, kind }).exec();
    if (existing) {
      await this.binaries.updateOne({ _id: existing._id }, { $inc: { referenceCount: 1 } });
      return existing.gridFsFileId;
    }
    const gridFsFileId = new Types.ObjectId();
    await pipeline(Readable.from(content), this.bucket().openUploadStreamWithId(gridFsFileId, filename, { metadata: { mailboxId, kind, sha256: hash } }));
    try {
      await this.binaries.create({ mailboxId, sha256: hash, sizeBytes: content.length, gridFsFileId, kind, referenceCount: 1, integrityStatus: 'healthy' });
      return gridFsFileId;
    } catch (error) {
      await this.bucket().delete(gridFsFileId).catch(() => undefined);
      const raced = await this.binaries.findOneAndUpdate({ mailboxId, sha256: hash, kind }, { $inc: { referenceCount: 1 } }, { new: true }).exec();
      if (!raced) throw error;
      return raced.gridFsFileId;
    }
  }
  async persistMessage(input: PersistMessageInput): Promise<PersistMessageResult> {
    const maxMessageSize = this.config.get('MAX_MESSAGE_SIZE_BYTES', { infer: true });
    if (input.raw.length > maxMessageSize) throw new Error(`Message exceeds ${maxMessageSize} bytes`);
    const rawHash = digest(input.raw);
    let message = await this.messages.findOne({ mailboxId: input.mailboxId, rawSha256: rawHash }).exec();
    let created = false;
    if (!message) {
      const rawGridFsId = await this.putBinary(input.mailboxId, 'raw_message', input.raw, rawHash, `${rawHash}.eml`);
      try {
        const parsed = await this.parser.parse(input.raw);
        const textBody = parsed.text ?? undefined;
        const htmlBody = typeof parsed.html === 'string' ? parsed.html : undefined;
        const preview = (textBody ?? htmlBody?.replace(/<[^>]*>/g, ' ') ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
        const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
        message = await this.messages.create({
          mailboxId: input.mailboxId, internetMessageId: parsed.messageId, subject: parsed.subject,
          normalizedSubject: parsed.subject?.trim().toLowerCase(), from: addresses(parsed.from as AddressContainer | undefined),
          sender: addresses(parsed.sender as AddressContainer | undefined)[0], replyTo: addresses(parsed.replyTo as AddressContainer | undefined),
          to: addresses(parsed.to as AddressContainer | AddressContainer[] | undefined), cc: addresses(parsed.cc as AddressContainer | AddressContainer[] | undefined),
          bcc: addresses(parsed.bcc as AddressContainer | AddressContainer[] | undefined), inReplyTo: parsed.inReplyTo, references,
          sentAt: parsed.date, receivedAt: input.internalDate ?? parsed.date, internalDate: input.internalDate,
          textBody, htmlBody, bodyPreview: preview, headers: headersToRecord(parsed.headers as Map<string, unknown>),
          rawGridFsId, rawSha256: rawHash, rawSizeBytes: input.raw.length, hasAttachments: parsed.attachments.length > 0,
          attachmentCount: parsed.attachments.length, firstSeenAt: new Date(), lastSeenAt: new Date(), backupStatus: 'complete', parseStatus: 'complete',
        });
        created = true;
        const maxAttachmentSize = this.config.get('MAX_ATTACHMENT_SIZE_BYTES', { infer: true });
        for (let index = 0; index < parsed.attachments.length; index += 1) {
          const attachment = parsed.attachments[index];
          if (!attachment || attachment.content.length > maxAttachmentSize) continue;
          const hash = digest(attachment.content);
          const safeName = sanitizeFilename(attachment.filename || `attachment-${index + 1}`);
          const gridFsFileId = await this.putBinary(input.mailboxId, 'attachment', attachment.content, hash, safeName);
          await this.attachments.create({ mailboxId: input.mailboxId, messageId: message._id, filename: attachment.filename,
            sanitizedFilename: safeName, contentType: attachment.contentType, contentDisposition: attachment.contentDisposition,
            contentId: attachment.cid, sizeBytes: attachment.content.length, sha256: hash, gridFsFileId,
            isInline: attachment.contentDisposition === 'inline' || Boolean(attachment.cid) });
        }
      } catch (error) {
        message = await this.messages.create({ mailboxId: input.mailboxId, from: [], replyTo: [], to: [], cc: [], bcc: [], references: [],
          internalDate: input.internalDate, receivedAt: input.internalDate, headers: {}, rawGridFsId, rawSha256: rawHash,
          rawSizeBytes: input.raw.length, hasAttachments: false, attachmentCount: 0, firstSeenAt: new Date(), lastSeenAt: new Date(),
          backupStatus: 'complete', parseStatus: 'failed', parseErrorCode: 'MIME_PARSE_FAILED',
          parseErrorMessage: error instanceof Error ? error.message.slice(0, 1000) : 'Unable to parse MIME message' });
        created = true;
      }
    } else await this.messages.updateOne({ _id: message._id }, { lastSeenAt: new Date(), $unset: { sourceDeletedAt: 1 } });
    await this.locations.updateOne(
      { mailboxId: input.mailboxId, folderId: input.folderId, uidValidity: input.uidValidity, imapUid: input.imapUid },
      { $set: { messageId: message._id, flags: input.flags, keywords: input.keywords, modSeq: input.modSeq, lastSeenAt: new Date() },
        $setOnInsert: { mailboxId: input.mailboxId, folderId: input.folderId, uidValidity: input.uidValidity, imapUid: input.imapUid, firstSeenAt: new Date() },
        $unset: { removedFromSourceAt: 1 } }, { upsert: true });
    return { messageId: message._id, created, attachmentCount: message.attachmentCount, rawSizeBytes: message.rawSizeBytes };
  }
  async downloadBuffer(id: Types.ObjectId): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.bucket().openDownloadStream(id)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  async hashGridFsFile(id: Types.ObjectId): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of this.bucket().openDownloadStream(id)) hash.update(chunk);
    return hash.digest('hex');
  }
  openDownloadStream(id: Types.ObjectId) { return this.bucket().openDownloadStream(id); }
}
