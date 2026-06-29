import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import type { ImapFlow } from 'imapflow';
import { Model, type Connection } from 'mongoose';
import { buildMongoUri, parseConfig, type AppConfig } from '@email-backup/config';
import { Mailbox, MailboxSchema } from '@email-backup/database';
import { CredentialCipher } from '@email-backup/encryption';
import { ImapClientService } from '@email-backup/imap';
import { QueueRegistry } from '@email-backup/queue';

interface Session { client: ImapFlow; restart?: NodeJS.Timeout }

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: (value) => parseConfig(value) }),
    MongooseModule.forRootAsync({ useFactory: () => ({ uri: buildMongoUri(parseConfig(process.env)), autoIndex: false }) }),
    MongooseModule.forFeature([{ name: Mailbox.name, schema: MailboxSchema }]),
  ],
})
class MailboxWatcherModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(MailboxWatcherModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  const config = app.get(ConfigService<AppConfig, true>);
  if (!config.get('IMAP_IDLE_ENABLED', { infer: true })) return;
  const mongo = app.get<Connection>(getConnectionToken());
  const mailboxes = app.get<Model<Mailbox>>(getModelToken(Mailbox.name));
  const cipher = new CredentialCipher(new Map([[1, Buffer.from(config.get('CREDENTIAL_ENCRYPTION_KEY', { infer: true }), 'base64')]]), 1);
  const imap = new ImapClientService();
  const queues = new QueueRegistry(config.get('REDIS_HOST', { infer: true }), config.get('REDIS_PORT', { infer: true }), config.get('REDIS_PASSWORD', { infer: true }));
  const sessions = new Map<string, Session>();
  let stopping = false;

  const stopSession = async (mailboxId: string): Promise<void> => {
    const session = sessions.get(mailboxId);
    if (!session) return;
    sessions.delete(mailboxId);
    if (session.restart) clearTimeout(session.restart);
    if (session.client.usable) await session.client.logout().catch(() => undefined);
  };

  const startSession = async (mailboxId: string): Promise<void> => {
    if (stopping || sessions.has(mailboxId)) return;
    const mailbox = await mailboxes.findById(mailboxId).select('+encryptedCredential').exec();
    if (!mailbox || !mailbox.syncEnabled || ['paused', 'disabled'].includes(mailbox.status)) return;
    const password = cipher.decrypt(mailbox.encryptedCredential, `mailbox:${mailboxId}`);
    const client = imap.createClient({
      host: mailbox.imapHost,
      port: mailbox.imapPort,
      secure: mailbox.tlsEnabled,
      servername: mailbox.tlsServername,
      rejectUnauthorized: mailbox.tlsRejectUnauthorized,
      username: mailbox.username,
      password,
      connectionTimeoutMs: config.get('IMAP_CONNECTION_TIMEOUT_SECONDS', { infer: true }) * 1000,
    });
    sessions.set(mailboxId, { client });
    const trigger = async () => {
      const bucket = Math.floor(Date.now() / 30_000);
      await queues.get('incremental-sync').add('incremental-sync', { mailboxId, scope: 'idle' }, { jobId: `idle:${mailboxId}:${bucket}` }).catch(() => undefined);
    };
    const reconnect = () => {
      if (stopping) return;
      void stopSession(mailboxId).finally(() => setTimeout(() => void startSession(mailboxId), 5_000 + Math.floor(Math.random() * 10_000)));
    };
    client.on('exists', () => void trigger());
    client.on('close', reconnect);
    client.on('error', reconnect);
    try {
      await client.connect();
      await client.mailboxOpen('INBOX', { readOnly: true });
      await mailboxes.updateOne({ _id: mailbox._id }, { status: 'active', lastConnectionAt: new Date() });
      const restart = setTimeout(() => void stopSession(mailboxId).finally(() => startSession(mailboxId)), 25 * 60_000);
      sessions.set(mailboxId, { client, restart });
    } catch (error) {
      await mailboxes.updateOne({ _id: mailbox._id }, { status: 'connection_failed', lastErrorCode: 'IMAP_IDLE_FAILED', lastErrorMessage: error instanceof Error ? error.message.slice(0, 1000) : 'IMAP IDLE failed', lastErrorAt: new Date() });
      reconnect();
    }
  };

  const refresh = async (): Promise<void> => {
    const maximum = config.get('IMAP_MAX_GLOBAL_CONNECTIONS', { infer: true });
    const active = await mailboxes.find({ syncEnabled: true, status: { $nin: ['paused', 'disabled'] } }).select('_id').limit(maximum).lean();
    const allowed = new Set(active.map((mailbox) => String(mailbox._id)));
    await Promise.all([...sessions.keys()].filter((id) => !allowed.has(id)).map(stopSession));
    for (const mailbox of active) await startSession(String(mailbox._id));
  };

  await refresh();
  const refreshTimer = setInterval(() => void refresh(), 60_000);
  let server: Server | undefined = createServer((_request, response) => {
    const healthy = mongo.readyState === 1 && !stopping;
    response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: healthy ? 'ok' : 'unhealthy', activeSessions: sessions.size }));
  });
  server.listen(Number(process.env.IDLE_WORKER_HEALTH_PORT ?? 3007), '0.0.0.0');
  const shutdown = async () => {
    stopping = true;
    clearInterval(refreshTimer);
    await Promise.all([...sessions.keys()].map(stopSession));
    await queues.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await app.close();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
void bootstrap();
