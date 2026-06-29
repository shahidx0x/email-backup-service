import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsMongoId,
  IsOptional,
  IsString,
} from 'class-validator';
import type { FastifyReply } from 'fastify';
import { Model, Types } from 'mongoose';
import type { AppConfig } from '@email-backup/config';
import {
  ExportJob,
  ExportJobSchema,
  RestoreJob,
  RestoreJobSchema,
} from '@email-backup/database';
import type { QueueRegistry } from '@email-backup/queue';
import { CurrentUser, Roles, canAccessMailbox, type AuthenticatedUser } from './common';
import { InfrastructureModule, QUEUES } from './infrastructure';
import { Inject } from '@nestjs/common';

const EXPORT_FORMATS = ['eml', 'mbox', 'zip', 'json', 'csv'] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

class ExportFiltersDto {
  @IsOptional() @IsString() sender?: string;
  @IsOptional() @IsString() recipient?: string;
  @IsOptional() @IsString() subject?: string;
  @IsOptional() @IsString() dateFrom?: string;
  @IsOptional() @IsString() dateTo?: string;
  @IsOptional() @IsBoolean() hasAttachments?: boolean;
  @IsOptional() @IsBoolean() sourceDeleted?: boolean;
  @IsOptional() @IsString() search?: string;
}

class CreateExportDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsMongoId({ each: true }) mailboxIds!: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsMongoId({ each: true }) folderIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(10_000) @IsMongoId({ each: true }) messageIds?: string[];
  @IsEnum(EXPORT_FORMATS) format!: ExportFormat;
  @IsOptional() @IsBoolean() includeAttachments = true;
  @IsOptional() @IsBoolean() includeMetadata = true;
  @IsOptional() filters?: ExportFiltersDto;
}

class CreateRestoreDto {
  @IsMongoId() mailboxId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10_000) @IsMongoId({ each: true }) messageIds!: string[];
  @IsOptional() @IsString() targetFolder?: string;
}

function serializeJob<T extends { toObject?: () => Record<string, unknown> }>(job: T): Record<string, unknown> {
  const value = job.toObject ? job.toObject() : job as Record<string, unknown>;
  delete value.outputReference;
  return value;
}

@Injectable()
class TransfersService {
  constructor(
    @InjectModel(ExportJob.name) private readonly exports: Model<ExportJob>,
    @InjectModel(RestoreJob.name) private readonly restores: Model<RestoreJob>,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private assertMailboxAccess(user: AuthenticatedUser, mailboxIds: readonly string[]): void {
    for (const mailboxId of mailboxIds) {
      if (!Types.ObjectId.isValid(mailboxId) || !canAccessMailbox(user, mailboxId)) {
        throw new NotFoundException('Mailbox not found');
      }
    }
  }

  async createExport(dto: CreateExportDto, user: AuthenticatedUser): Promise<Record<string, unknown>> {
    this.assertMailboxAccess(user, dto.mailboxIds);
    if (dto.format === 'eml' && dto.messageIds?.length !== 1) {
      throw new BadRequestException('EML export requires exactly one message');
    }
    const job = await this.exports.create({
      requestedBy: new Types.ObjectId(user.sub),
      mailboxIds: dto.mailboxIds.map((id) => new Types.ObjectId(id)),
      folderIds: dto.folderIds?.map((id) => new Types.ObjectId(id)),
      messageIds: dto.messageIds?.map((id) => new Types.ObjectId(id)),
      filters: dto.filters,
      format: dto.format,
      includeAttachments: dto.includeAttachments,
      includeMetadata: dto.includeMetadata,
      status: 'queued',
      outputStorageType: 'temporary_volume',
    });
    await this.queues.get('export').add('export', { exportJobId: String(job._id) }, { jobId: `export:${job._id}` });
    return serializeJob(job);
  }

  async listExports(user: AuthenticatedUser, status?: string): Promise<Record<string, unknown>[]> {
    const query: Record<string, unknown> = {};
    if (user.role !== 'super_admin' && user.role !== 'admin') query.requestedBy = new Types.ObjectId(user.sub);
    if (status) query.status = status;
    return (await this.exports.find(query).sort({ createdAt: -1 }).limit(200).exec()).map(serializeJob);
  }

  async getExport(id: string, user: AuthenticatedUser, includeReference = false): Promise<ExportJob> {
    const job = await this.exports.findById(id).exec();
    if (!job) throw new NotFoundException('Export job not found');
    if (user.role !== 'super_admin' && user.role !== 'admin' && String(job.requestedBy) !== user.sub) {
      throw new NotFoundException('Export job not found');
    }
    this.assertMailboxAccess(user, job.mailboxIds.map(String));
    if (!includeReference) return job;
    return job;
  }

  async downloadExport(id: string, user: AuthenticatedUser, reply: FastifyReply): Promise<FastifyReply> {
    const job = await this.getExport(id, user, true);
    if (job.status !== 'completed' || !job.outputReference || !job.outputFilename) {
      throw new BadRequestException('Export is not available');
    }
    const root = resolve(this.config.get('EXPORT_DIRECTORY', { infer: true }));
    const target = resolve(job.outputReference);
    const rel = relative(root, target);
    if (!isAbsolute(target) || rel.startsWith('..') || isAbsolute(rel)) throw new BadRequestException('Invalid export path');
    const file = await stat(target).catch(() => null);
    if (!file?.isFile()) throw new NotFoundException('Export file not found');
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', String(file.size));
    reply.header('Content-Disposition', `attachment; filename="${job.outputFilename.replace(/[\r\n"]/g, '_')}"`);
    return reply.send(createReadStream(target));
  }

  async cancelExport(id: string, user: AuthenticatedUser): Promise<Record<string, unknown>> {
    const job = await this.getExport(id, user);
    if (!['queued', 'running'].includes(job.status)) throw new BadRequestException('Export cannot be cancelled');
    job.status = 'cancelled';
    await job.save();
    const queueJob = await this.queues.get('export').getJob(`export:${id}`);
    if (queueJob) await queueJob.remove().catch(() => undefined);
    return serializeJob(job);
  }

  async retryExport(id: string, user: AuthenticatedUser): Promise<Record<string, unknown>> {
    const job = await this.getExport(id, user);
    if (!['failed', 'cancelled', 'expired'].includes(job.status)) throw new BadRequestException('Export cannot be retried');
    job.status = 'queued';
    job.errorCode = undefined;
    job.errorMessage = undefined;
    job.progress = { totalMessages: 0, processedMessages: 0, processedBytes: 0, percentage: 0 };
    await job.save();
    await this.queues.get('export').add('export', { exportJobId: id }, { jobId: `export:${id}:${Date.now()}` });
    return serializeJob(job);
  }

  async deleteExport(id: string, user: AuthenticatedUser): Promise<{ deleted: true }> {
    const job = await this.getExport(id, user, true);
    if (job.outputReference) await rm(job.outputReference, { force: true }).catch(() => undefined);
    await job.deleteOne();
    return { deleted: true };
  }

  async createRestore(dto: CreateRestoreDto, user: AuthenticatedUser): Promise<Record<string, unknown>> {
    this.assertMailboxAccess(user, [dto.mailboxId]);
    const job = await this.restores.create({
      requestedBy: new Types.ObjectId(user.sub),
      mailboxId: new Types.ObjectId(dto.mailboxId),
      messageIds: dto.messageIds.map((id) => new Types.ObjectId(id)),
      targetFolder: dto.targetFolder?.trim() || this.config.get('DEFAULT_RESTORE_FOLDER' as keyof AppConfig, { infer: true }) || 'Recovered Email Backup',
      status: 'queued',
      progress: { totalMessages: dto.messageIds.length, processedMessages: 0, percentage: 0 },
    });
    await this.queues.get('restore').add('restore', { restoreJobId: String(job._id) }, { jobId: `restore:${job._id}` });
    return serializeJob(job);
  }

  async listRestores(user: AuthenticatedUser): Promise<Record<string, unknown>[]> {
    const query: Record<string, unknown> = user.role === 'super_admin' || user.role === 'admin' ? {} : { requestedBy: new Types.ObjectId(user.sub) };
    return (await this.restores.find(query).sort({ createdAt: -1 }).limit(200).exec()).map(serializeJob);
  }

  async getRestore(id: string, user: AuthenticatedUser): Promise<RestoreJob> {
    const job = await this.restores.findById(id).exec();
    if (!job || !canAccessMailbox(user, String(job.mailboxId))) throw new NotFoundException('Restore job not found');
    if (user.role !== 'super_admin' && user.role !== 'admin' && String(job.requestedBy) !== user.sub) throw new NotFoundException('Restore job not found');
    return job;
  }

  async cancelRestore(id: string, user: AuthenticatedUser): Promise<Record<string, unknown>> {
    const job = await this.getRestore(id, user);
    if (!['queued', 'running'].includes(job.status)) throw new BadRequestException('Restore cannot be cancelled');
    job.status = 'cancelled';
    await job.save();
    const queueJob = await this.queues.get('restore').getJob(`restore:${id}`);
    if (queueJob) await queueJob.remove().catch(() => undefined);
    return serializeJob(job);
  }

  async retryRestore(id: string, user: AuthenticatedUser): Promise<Record<string, unknown>> {
    const job = await this.getRestore(id, user);
    if (!['failed', 'cancelled'].includes(job.status)) throw new BadRequestException('Restore cannot be retried');
    job.status = 'queued';
    job.errorCode = undefined;
    job.errorMessage = undefined;
    job.progress = { totalMessages: job.messageIds.length, processedMessages: 0, percentage: 0 };
    await job.save();
    await this.queues.get('restore').add('restore', { restoreJobId: id }, { jobId: `restore:${id}:${Date.now()}` });
    return serializeJob(job);
  }
}

@Controller('api/exports')
@Roles('super_admin', 'admin', 'auditor')
class ExportsController {
  constructor(private readonly service: TransfersService) {}
  @Post() create(@Body() dto: CreateExportDto, @CurrentUser() user: AuthenticatedUser) { return this.service.createExport(dto, user); }
  @Get() list(@CurrentUser() user: AuthenticatedUser, @Query('status') status?: string) { return this.service.listExports(user, status); }
  @Get(':exportJobId') async get(@Param('exportJobId') id: string, @CurrentUser() user: AuthenticatedUser) { return serializeJob(await this.service.getExport(id, user)); }
  @Get(':exportJobId/download') download(@Param('exportJobId') id: string, @CurrentUser() user: AuthenticatedUser, @Res() reply: FastifyReply) { return this.service.downloadExport(id, user, reply); }
  @Post(':exportJobId/cancel') cancel(@Param('exportJobId') id: string, @CurrentUser() user: AuthenticatedUser) { return this.service.cancelExport(id, user); }
  @Post(':exportJobId/retry') retry(@Param('exportJobId') id: string, @CurrentUser() user: AuthenticatedUser) { return this.service.retryExport(id, user); }
  @Delete(':exportJobId') delete(@Param('exportJobId') id: string, @CurrentUser() user: AuthenticatedUser) { return this.service.deleteExport(id, user); }
}

@Controller('api/restores')
@Roles('super_admin', 'admin')
class RestoresController {
  constructor(private readonly service: TransfersService) {}
  @Post() create(@Body() dto: CreateRestoreDto, @CurrentUser() user: AuthenticatedUser) { return this.service.createRestore(dto, user); }
  @Get() list(@CurrentUser() user: AuthenticatedUser) { return this.service.listRestores(user); }
  @Get(':restoreJobId') async get(@Param('restoreJobId') id: string, @CurrentUser() user: AuthenticatedUser) { return serializeJob(await this.service.getRestore(id, user)); }
  @Post(':restoreJobId/cancel') cancel(@Param('restoreJobId') id: string, @CurrentUser() user: AuthenticatedUser) { return this.service.cancelRestore(id, user); }
  @Post(':restoreJobId/retry') retry(@Param('restoreJobId') id: string, @CurrentUser() user: AuthenticatedUser) { return this.service.retryRestore(id, user); }
}

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ExportJob.name, schema: ExportJobSchema },
      { name: RestoreJob.name, schema: RestoreJobSchema },
    ]),
    InfrastructureModule,
  ],
  providers: [TransfersService],
  controllers: [ExportsController, RestoresController],
})
export class TransfersModule {}
