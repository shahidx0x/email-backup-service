import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { once } from 'node:events';
import archiver from 'archiver';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { ImapFlow } from 'imapflow';
import { Model, Types } from 'mongoose';
import type { AppConfig } from '@email-backup/config';
import { AuditLog, ExportJob, MessageLocation, RestoreJob, StoredAttachment, StoredMessage } from '@email-backup/database';
import { protectCsvValue, sanitizeFilename } from '@email-backup/shared';
import { StorageService } from './storage.service';

function csv(value: unknown): string {
  const protectedValue = protectCsvValue(value).replaceAll('"', '""');
  return `"${protectedValue}"`;
}
function mboxEscape(raw: Buffer): Buffer {
  const text = raw.toString('binary').replace(/^From /gm, '>From ');
  return Buffer.from(text, 'binary');
}
async function writeChunk(stream: NodeJS.WritableStream, value: string | Buffer): Promise<void> {
  if (!stream.write(value)) await once(stream, 'drain');
}

@Injectable()
export class TransferEngine {
  constructor(
    @InjectModel(ExportJob.name) private readonly exports: Model<ExportJob>,
    @InjectModel(RestoreJob.name) private readonly restores: Model<RestoreJob>,
    @InjectModel(StoredMessage.name) private readonly messages: Model<StoredMessage>,
    @InjectModel(MessageLocation.name) private readonly locations: Model<MessageLocation>,
    @InjectModel(StoredAttachment.name) private readonly attachments: Model<StoredAttachment>,
    @InjectModel(AuditLog.name) private readonly audits: Model<AuditLog>,
    private readonly storage: StorageService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private async messageFilter(job: ExportJob): Promise<Record<string, unknown>> {
    const filter: Record<string, unknown> = { mailboxId: { $in: job.mailboxIds } };
    if (job.messageIds?.length) filter._id = { $in: job.messageIds };
    if (job.folderIds?.length) {
      const ids = await this.locations.distinct('messageId', { mailboxId: { $in: job.mailboxIds }, folderId: { $in: job.folderIds } });
      filter._id = { $in: job.messageIds?.length ? ids.filter((id) => job.messageIds?.some((selected) => selected.equals(id))) : ids };
    }
    const query = job.filters ?? {};
    if (typeof query.sender === 'string') filter['from.address'] = query.sender.toLowerCase();
    if (typeof query.recipient === 'string') filter['to.address'] = query.recipient.toLowerCase();
    if (typeof query.subject === 'string') filter.subject = { $regex: query.subject, $options: 'i' };
    if (typeof query.hasAttachments === 'boolean') filter.hasAttachments = query.hasAttachments;
    if (typeof query.sourceDeleted === 'boolean') filter.sourceDeletedAt = query.sourceDeleted ? { $exists: true } : { $exists: false };
    if (typeof query.search === 'string') filter.$text = { $search: query.search };
    if (query.dateFrom || query.dateTo) {
      const range: Record<string, Date> = {};
      if (typeof query.dateFrom === 'string') range.$gte = new Date(query.dateFrom);
      if (typeof query.dateTo === 'string') range.$lte = new Date(query.dateTo);
      filter.receivedAt = range;
    }
    return filter;
  }

  async runExport(exportJobId: string): Promise<{ outputFilename: string; outputSizeBytes: number }> {
    const job = await this.exports.findById(exportJobId).exec();
    if (!job) throw new Error('Export job not found');
    const filter = await this.messageFilter(job);
    const totalMessages = await this.messages.countDocuments(filter);
    if (job.format === 'eml' && totalMessages !== 1) throw new Error('EML export requires exactly one message');
    const extension = job.format === 'zip' ? 'zip' : job.format;
    const outputFilename = sanitizeFilename(`email-export-${job._id}.${extension}`);
    const directory = this.config.get('EXPORT_DIRECTORY', { infer: true });
    await mkdir(directory, { recursive: true });
    const outputPath = join(directory, outputFilename);
    const temporaryPath = `${outputPath}.partial`;
    await rm(temporaryPath, { force: true });
    job.status = 'running'; job.startedAt = new Date();
    job.progress = { totalMessages, processedMessages: 0, processedBytes: 0, percentage: 0 };
    await job.save();
    try {
      if (job.format === 'zip') await this.writeZip(job, filter, temporaryPath, totalMessages);
      else await this.writeFlat(job, filter, temporaryPath, totalMessages);
      await import('node:fs/promises').then((fs) => fs.rename(temporaryPath, outputPath));
      const file = await stat(outputPath);
      if (file.size > this.config.get('MAX_EXPORT_SIZE_BYTES', { infer: true })) throw new Error('Export exceeded maximum size');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(outputPath)) hash.update(chunk);
      job.status = 'completed'; job.completedAt = new Date(); job.outputReference = outputPath; job.outputFilename = basename(outputPath);
      job.outputSizeBytes = file.size; job.sha256 = hash.digest('hex');
      job.expiresAt = new Date(Date.now() + this.config.get('EXPORT_EXPIRATION_HOURS', { infer: true }) * 3_600_000);
      await job.save();
      await this.audits.create({ actorUserId: job.requestedBy, action: 'EXPORT_COMPLETED', resourceType: 'exportJob', resourceId: String(job._id), details: { mailboxIds: job.mailboxIds.map(String), format: job.format, messages: totalMessages } });
      return { outputFilename: job.outputFilename, outputSizeBytes: file.size };
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      job.status = job.status === 'cancelled' ? 'cancelled' : 'failed';
      job.errorCode = 'EXPORT_FAILED'; job.errorMessage = error instanceof Error ? error.message.slice(0, 1000) : 'Export failed';
      await job.save();
      throw error;
    }
  }

  private async updateProgress(job: ExportJob, total: number, processed: number, bytes: number): Promise<void> {
    const fresh = await this.exports.findById(job._id).select('status').lean();
    if (fresh?.status === 'cancelled') { job.status = 'cancelled'; throw new Error('Export cancelled'); }
    job.progress = { totalMessages: total, processedMessages: processed, processedBytes: bytes, percentage: total ? Math.floor(processed * 100 / total) : 100 };
    await job.save();
  }

  private async writeFlat(job: ExportJob, filter: Record<string, unknown>, path: string, total: number): Promise<void> {
    const output = createWriteStream(path, { flags: 'wx' });
    let processed = 0; let bytes = 0; let first = true;
    if (job.format === 'json') await writeChunk(output, '[\n');
    if (job.format === 'csv') await writeChunk(output, 'mailboxId,messageId,subject,from,to,receivedAt,hasAttachments,sourceDeleted\n');
    try {
      for await (const message of this.messages.find(filter).sort({ receivedAt: 1, _id: 1 }).cursor()) {
        if (job.format === 'eml') {
          const raw = await this.storage.downloadBuffer(message.rawGridFsId); await writeChunk(output, raw); bytes += raw.length;
        } else if (job.format === 'mbox') {
          const raw = mboxEscape(await this.storage.downloadBuffer(message.rawGridFsId));
          const envelope = `From MAILER-DAEMON ${(message.internalDate ?? message.receivedAt ?? new Date()).toUTCString()}\n`;
          await writeChunk(output, envelope); await writeChunk(output, raw); await writeChunk(output, '\n\n'); bytes += Buffer.byteLength(envelope) + raw.length + 2;
        } else if (job.format === 'json') {
          const data = message.toObject() as Record<string, unknown>; delete data.rawGridFsId; delete data.htmlBody;
          const line = `${first ? '' : ',\n'}${JSON.stringify(data)}`; first = false; await writeChunk(output, line); bytes += Buffer.byteLength(line);
        } else if (job.format === 'csv') {
          const from = message.from.map((item) => item.address).join(';'); const to = message.to.map((item) => item.address).join(';');
          const line = [message.mailboxId, message._id, message.subject, from, to, message.receivedAt?.toISOString(), message.hasAttachments, Boolean(message.sourceDeletedAt)].map(csv).join(',') + '\n';
          await writeChunk(output, line); bytes += Buffer.byteLength(line);
        }
        processed += 1; await this.updateProgress(job, total, processed, bytes);
      }
      if (job.format === 'json') await writeChunk(output, '\n]\n');
      output.end(); await once(output, 'close');
    } catch (error) { output.destroy(); throw error; }
  }

  private async writeZip(job: ExportJob, filter: Record<string, unknown>, path: string, total: number): Promise<void> {
    const output = createWriteStream(path, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(output);
    let processed = 0; let bytes = 0; const checksums: string[] = [];
    for await (const message of this.messages.find(filter).sort({ mailboxId: 1, receivedAt: 1, _id: 1 }).cursor()) {
      const prefix = String(message.mailboxId); const name = `${prefix}/messages/${message._id}.eml`;
      archive.append(this.storage.openDownloadStream(message.rawGridFsId), { name });
      checksums.push(`${message.rawSha256}  ${name}`); bytes += message.rawSizeBytes;
      if (job.includeAttachments) {
        const attachments = await this.attachments.find({ messageId: message._id }).exec();
        for (const attachment of attachments) archive.append(this.storage.openDownloadStream(attachment.gridFsFileId), { name: `${prefix}/attachments/${message._id}/${sanitizeFilename(attachment.sanitizedFilename)}` });
      }
      processed += 1; await this.updateProgress(job, total, processed, bytes);
    }
    archive.append(JSON.stringify({ exportJobId: String(job._id), mailboxIds: job.mailboxIds.map(String), format: job.format, totalMessages: total, createdAt: new Date().toISOString() }, null, 2), { name: 'manifest.json' });
    archive.append(`${checksums.join('\n')}\n`, { name: 'SHA256SUMS.txt' });
    await archive.finalize(); await once(output, 'close');
  }

  async runRestore(client: ImapFlow, restoreJobId: string): Promise<{ restored: number; skipped: number }> {
    const job = await this.restores.findById(restoreJobId).exec();
    if (!job) throw new Error('Restore job not found');
    job.status = 'running'; job.startedAt = new Date(); await job.save();
    let restored = 0; let skipped = 0;
    try {
      const exists = await client.list();
      if (!exists.some((folder) => folder.path === job.targetFolder)) await client.mailboxCreate(job.targetFolder);
      for (const messageId of job.messageIds) {
        const fresh = await this.restores.findById(job._id).select('status').lean();
        if (fresh?.status === 'cancelled') throw new Error('Restore cancelled');
        const message = await this.messages.findOne({ _id: messageId, mailboxId: job.mailboxId }).exec();
        if (!message) { skipped += 1; continue; }
        const already = await this.audits.exists({ action: 'MESSAGE_RESTORED', resourceId: String(message._id), 'details.mailboxId': String(job.mailboxId), 'details.targetFolder': job.targetFolder });
        if (already) { skipped += 1; continue; }
        const raw = await this.storage.downloadBuffer(message.rawGridFsId);
        await client.append(job.targetFolder, raw, [], message.internalDate ?? message.receivedAt);
        restored += 1;
        await this.audits.create({ mailboxId: job.mailboxId, actorUserId: job.requestedBy, action: 'MESSAGE_RESTORED', resourceType: 'message', resourceId: String(message._id), details: { mailboxId: String(job.mailboxId), targetFolder: job.targetFolder } });
        job.progress = { totalMessages: job.messageIds.length, processedMessages: restored + skipped, percentage: Math.floor((restored + skipped) * 100 / job.messageIds.length) };
        await job.save();
      }
      job.status = 'completed'; job.completedAt = new Date(); await job.save();
      return { restored, skipped };
    } catch (error) {
      job.status = job.status === 'cancelled' ? 'cancelled' : 'failed'; job.errorCode = 'RESTORE_FAILED';
      job.errorMessage = error instanceof Error ? error.message.slice(0, 1000) : 'Restore failed'; await job.save(); throw error;
    }
  }
}
