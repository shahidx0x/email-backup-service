import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Worker, type Job } from 'bullmq';
import { Model, type Connection } from 'mongoose';
import { buildMongoUri, parseConfig, type AppConfig } from '@email-backup/config';
import { AuditLog, AuditLogSchema, BinaryObject, BinaryObjectSchema, ExportJob, ExportJobSchema, Mailbox, MailboxSchema, MessageLocation, MessageLocationSchema, RestoreJob, RestoreJobSchema, StoredAttachment, StoredAttachmentSchema, StoredMessage, StoredMessageSchema } from '@email-backup/database';
import { CredentialCipher } from '@email-backup/encryption';
import { ImapClientService } from '@email-backup/imap';
import { createRedisConnection } from '@email-backup/queue';
import { StorageService } from './storage.service';
import { TransferEngine } from './transfer-engine';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: (value) => parseConfig(value) }),
    MongooseModule.forRootAsync({ useFactory: () => ({ uri: buildMongoUri(parseConfig(process.env)), autoIndex: false }) }),
    MongooseModule.forFeature([
      { name: Mailbox.name, schema: MailboxSchema },
      { name: StoredMessage.name, schema: StoredMessageSchema },
      { name: MessageLocation.name, schema: MessageLocationSchema },
      { name: StoredAttachment.name, schema: StoredAttachmentSchema },
      { name: BinaryObject.name, schema: BinaryObjectSchema },
      { name: ExportJob.name, schema: ExportJobSchema },
      { name: RestoreJob.name, schema: RestoreJobSchema },
      { name: AuditLog.name, schema: AuditLogSchema },
    ]),
  ],
  providers: [StorageService, TransferEngine],
})
class RestoreWorkerModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(RestoreWorkerModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  const config = app.get(ConfigService<AppConfig, true>);
  const mongo = app.get<Connection>(getConnectionToken());
  const mailboxes = app.get<Model<Mailbox>>(getModelToken(Mailbox.name));
  const restores = app.get<Model<RestoreJob>>(getModelToken(RestoreJob.name));
  const engine = app.get(TransferEngine);
  const imap = new ImapClientService();
  const cipher = new CredentialCipher(new Map([[1, Buffer.from(config.get('CREDENTIAL_ENCRYPTION_KEY', { infer: true }), 'base64')]]), 1);
  const connection = createRedisConnection(config.get('REDIS_HOST', { infer: true }), config.get('REDIS_PORT', { infer: true }), config.get('REDIS_PASSWORD', { infer: true }));
  const worker = new Worker('restore', async (job: Job) => {
    const restoreJobId = String((job.data as { restoreJobId?: string }).restoreJobId ?? '');
    if (!restoreJobId) throw new Error('Restore job ID is required');
    const restore = await restores.findById(restoreJobId).lean();
    if (!restore) throw new Error('Restore job not found');
    const mailboxId = String(restore.mailboxId);
    const mailbox = await mailboxes.findById(mailboxId).select('+encryptedCredential').exec();
    if (!mailbox) throw new Error('Mailbox not found');
    const password = cipher.decrypt(mailbox.encryptedCredential, `mailbox:${mailboxId}`);
    const client = imap.createClient({ host: mailbox.imapHost, port: mailbox.imapPort, secure: mailbox.tlsEnabled, servername: mailbox.tlsServername, rejectUnauthorized: mailbox.tlsRejectUnauthorized, username: mailbox.username, password, connectionTimeoutMs: config.get('IMAP_CONNECTION_TIMEOUT_SECONDS', { infer: true }) * 1000 });
    try { await client.connect(); return await engine.runRestore(client, restoreJobId); }
    finally { if (client.usable) await client.logout().catch(() => undefined); }
  }, { connection, concurrency: Math.max(1, Number(process.env.RESTORE_WORKER_CONCURRENCY ?? 1)), lockDuration: 900_000, maxStalledCount: 2 });
  const port = Number(process.env.RESTORE_WORKER_HEALTH_PORT ?? 3006);
  let server: Server | undefined = createServer(async (_request, response) => {
    const redis = await connection.ping().catch(() => null);
    const healthy = mongo.readyState === 1 && redis === 'PONG';
    response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: healthy ? 'ok' : 'unhealthy', mongodb: mongo.readyState === 1, redis: redis === 'PONG' }));
  });
  server.listen(port, '0.0.0.0');
  const shutdown = async () => { await worker.close(); await connection.quit(); if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; await app.close(); };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
void bootstrap();
