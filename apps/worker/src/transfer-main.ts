import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { Worker, type Job } from 'bullmq';
import { buildMongoUri, parseConfig, type AppConfig } from '@email-backup/config';
import { AuditLog, AuditLogSchema, BinaryObject, BinaryObjectSchema, ExportJob, ExportJobSchema, MessageLocation, MessageLocationSchema, RestoreJob, RestoreJobSchema, StoredAttachment, StoredAttachmentSchema, StoredMessage, StoredMessageSchema } from '@email-backup/database';
import { createRedisConnection } from '@email-backup/queue';
import { StorageService } from './storage.service';
import { TransferEngine } from './transfer-engine';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: (value) => parseConfig(value) }),
    MongooseModule.forRootAsync({ useFactory: () => ({ uri: buildMongoUri(parseConfig(process.env)), autoIndex: false }) }),
    MongooseModule.forFeature([
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
class TransferWorkerModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(TransferWorkerModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  const config = app.get(ConfigService<AppConfig, true>);
  const engine = app.get(TransferEngine);
  const connection = createRedisConnection(config.get('REDIS_HOST', { infer: true }), config.get('REDIS_PORT', { infer: true }), config.get('REDIS_PASSWORD', { infer: true }));
  const worker = new Worker('export', async (job: Job) => {
    const exportJobId = String((job.data as { exportJobId?: string }).exportJobId ?? '');
    if (!exportJobId) throw new Error('Export job ID is required');
    return engine.runExport(exportJobId);
  }, { connection, concurrency: Math.max(1, Number(process.env.EXPORT_WORKER_CONCURRENCY ?? 2)), lockDuration: 900_000, maxStalledCount: 2 });
  const shutdown = async () => { await worker.close(); await connection.quit(); await app.close(); };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
void bootstrap();
