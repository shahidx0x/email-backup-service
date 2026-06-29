import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Worker, type Job } from 'bullmq';
import { Model, type Connection } from 'mongoose';
import { buildMongoUri, parseConfig, type AppConfig } from '@email-backup/config';
import { BinaryObject, BinaryObjectSchema, Mailbox, MailboxSchema, MailFolder, MailFolderSchema, MessageLocation, MessageLocationSchema, StoredAttachment, StoredAttachmentSchema, StoredMessage, StoredMessageSchema, SyncErrorSchema, SyncEventSchema } from '@email-backup/database';
import { CredentialCipher } from '@email-backup/encryption';
import { ImapClientService } from '@email-backup/imap';
import { QueueRegistry, createRedisConnection } from '@email-backup/queue';
import { StorageService } from './storage.service';
import { SyncEngine } from './sync-engine';

interface Data { mailboxId?: string; folderId?: string; scope?: string }

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: (value) => parseConfig(value) }),
    MongooseModule.forRootAsync({ useFactory: () => ({ uri: buildMongoUri(parseConfig(process.env)), autoIndex: false }) }),
    MongooseModule.forFeature([
      { name: Mailbox.name, schema: MailboxSchema }, { name: MailFolder.name, schema: MailFolderSchema },
      { name: StoredMessage.name, schema: StoredMessageSchema }, { name: MessageLocation.name, schema: MessageLocationSchema },
      { name: StoredAttachment.name, schema: StoredAttachmentSchema }, { name: BinaryObject.name, schema: BinaryObjectSchema },
      { name: 'SyncEvent', schema: SyncEventSchema }, { name: 'SyncError', schema: SyncErrorSchema },
    ]),
  ],
  providers: [StorageService, SyncEngine],
})
class MessageWorkerModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(MessageWorkerModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  const config = app.get(ConfigService<AppConfig, true>);
  const mailboxes = app.get<Model<Mailbox>>(getModelToken(Mailbox.name));
  const folders = app.get<Model<MailFolder>>(getModelToken(MailFolder.name));
  const mongo = app.get<Connection>(getConnectionToken());
  const sync = app.get(SyncEngine);
  const imap = new ImapClientService();
  const cipher = new CredentialCipher(new Map([[1, Buffer.from(config.get('CREDENTIAL_ENCRYPTION_KEY', { infer: true }), 'base64')]]), 1);
  const queues = new QueueRegistry(config.get('REDIS_HOST', { infer: true }), config.get('REDIS_PORT', { infer: true }), config.get('REDIS_PASSWORD', { infer: true }));
  const connection = createRedisConnection(config.get('REDIS_HOST', { infer: true }), config.get('REDIS_PORT', { infer: true }), config.get('REDIS_PASSWORD', { infer: true }));
  const processJob = async (job: Job): Promise<unknown> => {
    const data = job.data as Data;
    if (!data.folderId) {
      const mailboxFilter = data.mailboxId ? { _id: data.mailboxId, syncEnabled: true } : { syncEnabled: true, status: { $nin: ['paused', 'disabled'] } };
      const allowed = await mailboxes.find(mailboxFilter).select('_id').lean();
      const folderDocs = await folders.find({ mailboxId: { $in: allowed.map((item) => item._id) }, selectable: true, status: { $ne: 'paused' } }).select('_id mailboxId highestProcessedUid').lean();
      await Promise.all(folderDocs.map((folder) => queues.get(job.queueName as 'initial-sync' | 'incremental-sync').add(job.name, { mailboxId: String(folder.mailboxId), folderId: String(folder._id), scope: data.scope }, { jobId: `${job.queueName}:${folder._id}:${data.scope ?? folder.highestProcessedUid ?? Date.now()}` })));
      return { fannedOut: folderDocs.length };
    }
    if (!data.mailboxId) throw new Error('Mailbox ID is required');
    const mailbox = await mailboxes.findById(data.mailboxId).select('+encryptedCredential').exec();
    if (!mailbox) throw new Error('Mailbox not found');
    const password = cipher.decrypt(mailbox.encryptedCredential, `mailbox:${data.mailboxId}`);
    const client = imap.createClient({ host: mailbox.imapHost, port: mailbox.imapPort, secure: mailbox.tlsEnabled, servername: mailbox.tlsServername, rejectUnauthorized: mailbox.tlsRejectUnauthorized, username: mailbox.username, password, connectionTimeoutMs: config.get('IMAP_CONNECTION_TIMEOUT_SECONDS', { infer: true }) * 1000 });
    try {
      await client.connect();
      const result = await sync.run(client, data.mailboxId, data.folderId, queues);
      const removed = data.scope === 'reconcile' ? await sync.markSourceDeletions(client, data.mailboxId, data.folderId) : 0;
      return { ...result, removed };
    } finally { if (client.usable) await client.logout().catch(() => undefined); }
  };
  const concurrency = Math.max(1, Number(process.env.MESSAGE_WORKER_CONCURRENCY ?? config.get('SYNC_FOLDER_CONCURRENCY', { infer: true })));
  const workers = ['initial-sync', 'incremental-sync'].map((name) => new Worker(name, processJob, { connection, concurrency, lockDuration: 900_000, maxStalledCount: 2 }));
  let server: Server | undefined;
  const port = Number(process.env.MESSAGE_WORKER_HEALTH_PORT ?? 3005);
  server = createServer((_request, response) => { const healthy = mongo.readyState === 1; response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: healthy ? 'ok' : 'unhealthy' })); });
  server.listen(port, '0.0.0.0');
  const shutdown = async () => { await Promise.all(workers.map((worker) => worker.close())); await queues.close(); await connection.quit(); if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); await app.close(); };
  process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown());
}
void bootstrap();
