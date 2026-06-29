import { Body, Controller, Get, Injectable, Module, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { Model } from 'mongoose';
import { MailFolder, MailFolderSchema } from '@email-backup/database';
import type { QueueRegistry } from '@email-backup/queue';
import { CurrentUser, Roles, canAccessMailbox, type AuthenticatedUser } from './common';
import { InfrastructureModule, QUEUES } from './infrastructure';
import { Inject } from '@nestjs/common';

class UpdateFolderDto {
  @IsOptional() @IsIn(['active', 'paused']) status?: 'active' | 'paused';
  @IsOptional() @IsBoolean() subscribed?: boolean;
}

@Injectable()
class FoldersService {
  constructor(
    @InjectModel(MailFolder.name) private readonly folders: Model<MailFolder>,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
  ) {}

  async list(mailboxId: string, user: AuthenticatedUser) {
    if (!canAccessMailbox(user, mailboxId)) throw new NotFoundException('Mailbox not found');
    return this.folders.find({ mailboxId }).sort({ path: 1 }).lean();
  }

  async get(folderId: string, user: AuthenticatedUser) {
    const folder = await this.folders.findById(folderId).lean();
    if (!folder || !canAccessMailbox(user, String(folder.mailboxId))) throw new NotFoundException('Folder not found');
    return folder;
  }

  async update(folderId: string, dto: UpdateFolderDto, user: AuthenticatedUser) {
    const existing = await this.get(folderId, user);
    const folder = await this.folders.findByIdAndUpdate(folderId, dto, { new: true, runValidators: true }).lean();
    if (!folder) throw new NotFoundException('Folder not found');
    return { ...folder, mailboxId: existing.mailboxId };
  }

  async synchronize(folderId: string, user: AuthenticatedUser) {
    const folder = await this.get(folderId, user);
    const queue = folder.initialSyncCompleted ? 'incremental-sync' : 'initial-sync';
    await this.queues.get(queue).add(queue, { mailboxId: String(folder.mailboxId), folderId }, { jobId: `${queue}:${folderId}:${Date.now()}` });
    return { queued: true, queue };
  }
}

@Controller('api/mailboxes/:mailboxId/folders')
class MailboxFoldersController {
  constructor(private readonly service: FoldersService) {}
  @Get() list(@Param('mailboxId') mailboxId: string, @CurrentUser() user: AuthenticatedUser) { return this.service.list(mailboxId, user); }
}

@Controller('api/folders')
class FoldersController {
  constructor(private readonly service: FoldersService) {}
  @Get(':folderId') get(@Param('folderId') folderId: string, @CurrentUser() user: AuthenticatedUser) { return this.service.get(folderId, user); }
  @Patch(':folderId') @Roles('super_admin', 'admin') update(@Param('folderId') folderId: string, @Body() dto: UpdateFolderDto, @CurrentUser() user: AuthenticatedUser) { return this.service.update(folderId, dto, user); }
  @Post(':folderId/sync') @Roles('super_admin', 'admin') sync(@Param('folderId') folderId: string, @CurrentUser() user: AuthenticatedUser) { return this.service.synchronize(folderId, user); }
}

@Module({
  imports: [MongooseModule.forFeature([{ name: MailFolder.name, schema: MailFolderSchema }]), InfrastructureModule],
  providers: [FoldersService],
  controllers: [MailboxFoldersController, FoldersController],
})
export class FoldersModule {}
