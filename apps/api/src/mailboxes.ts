import { Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { Model, Types } from 'mongoose';
import type { AppConfig } from '@email-backup/config';
import { Mailbox, MailboxSchema, MailFolder, MailFolderSchema } from '@email-backup/database';
import { CredentialCipher } from '@email-backup/encryption';
import { ImapClientService } from '@email-backup/imap';
import type { QueueRegistry } from '@email-backup/queue';
import { CurrentUser, Roles, canAccessMailbox, type AuthenticatedUser } from './common';
import { InfrastructureModule, QUEUES } from './infrastructure';
import { Inject } from '@nestjs/common';

class CreateMailboxDto {
  @IsString() @MinLength(1) displayName!: string;
  @IsEmail() emailAddress!: string;
  @IsString() provider = 'Hostinger';
  @IsString() imapHost = 'imap.hostinger.com';
  @IsInt() @Min(1) @Max(65535) imapPort = 993;
  @IsBoolean() tlsEnabled = true;
  @IsBoolean() tlsRejectUnauthorized = true;
  @IsOptional() @IsString() tlsServername?: string;
  @IsString() username!: string;
  @IsString() @MinLength(1) password!: string;
  @IsOptional() @IsInt() @Min(60) pollingIntervalSeconds?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10) maximumConnections?: number;
  @IsOptional() @IsString() sentFolderOverride?: string;
}
class UpdateMailboxDto {
  @IsOptional() @IsString() displayName?: string; @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() imapHost?: string; @IsOptional() @IsInt() @Min(1) @Max(65535) imapPort?: number;
  @IsOptional() @IsBoolean() tlsEnabled?: boolean; @IsOptional() @IsBoolean() tlsRejectUnauthorized?: boolean;
  @IsOptional() @IsString() tlsServername?: string; @IsOptional() @IsString() username?: string;
  @IsOptional() @IsString() password?: string; @IsOptional() @IsBoolean() syncEnabled?: boolean;
  @IsOptional() @IsInt() @Min(60) pollingIntervalSeconds?: number; @IsOptional() @IsInt() @Min(1) @Max(10) maximumConnections?: number;
  @IsOptional() @IsString() sentFolderOverride?: string;
}
class TestConnectionDto extends CreateMailboxDto {}

@Injectable()
export class MailboxesService {
  private readonly cipher: CredentialCipher;
  private readonly imap = new ImapClientService();
  constructor(@InjectModel(Mailbox.name) private readonly mailboxes: Model<Mailbox>, @InjectModel(MailFolder.name) private readonly folders: Model<MailFolder>, private readonly config: ConfigService<AppConfig, true>, @Inject(QUEUES) private readonly queues: QueueRegistry) {
    this.cipher = new CredentialCipher(new Map([[1, Buffer.from(config.get('CREDENTIAL_ENCRYPTION_KEY', { infer: true }), 'base64')]]), 1);
  }
  private safe<T extends { toObject?: () => Record<string, unknown> }>(doc: T): Record<string, unknown> { const value = doc.toObject ? doc.toObject() : doc as Record<string, unknown>; delete value.encryptedCredential; return value; }
  async create(dto: CreateMailboxDto) {
    const id = new Types.ObjectId();
    const encryptedCredential = this.cipher.encrypt(dto.password, `mailbox:${id.toString()}`);
    const doc = await this.mailboxes.create({ _id: id, displayName: dto.displayName, emailAddress: dto.emailAddress, normalizedEmailAddress: dto.emailAddress.toLowerCase(), provider: dto.provider,
      imapHost: dto.imapHost, imapPort: dto.imapPort, tlsEnabled: dto.tlsEnabled, tlsRejectUnauthorized: dto.tlsRejectUnauthorized, tlsServername: dto.tlsServername,
      username: dto.username, encryptedCredential, pollingIntervalSeconds: dto.pollingIntervalSeconds ?? 300, maximumConnections: dto.maximumConnections ?? 2,
      sentFolderOverride: dto.sentFolderOverride, syncEnabled: true, status: 'pending' });
    return this.safe(doc);
  }
  async list(user: AuthenticatedUser) { const query = ['super_admin','admin'].includes(user.role) ? {} : { _id: { $in: user.permittedMailboxIds } }; return (await this.mailboxes.find(query).sort({ createdAt: -1 }).exec()).map((d) => this.safe(d)); }
  async get(id: string, user: AuthenticatedUser) { if (!canAccessMailbox(user, id)) throw new NotFoundException('Mailbox not found'); const doc=await this.mailboxes.findById(id).exec(); if(!doc) throw new NotFoundException('Mailbox not found'); return this.safe(doc); }
  async update(id: string, dto: UpdateMailboxDto) {
    const update: Record<string, unknown> = { ...dto }; delete update.password;
    if (dto.password) update.encryptedCredential = this.cipher.encrypt(dto.password, `mailbox:${id}`);
    const doc=await this.mailboxes.findByIdAndUpdate(id, update, { new:true, runValidators:true }).exec(); if(!doc) throw new NotFoundException('Mailbox not found'); return this.safe(doc);
  }
  async testUnsaved(dto: TestConnectionDto) { await this.imap.testConnection({ host:dto.imapHost,port:dto.imapPort,secure:dto.tlsEnabled,servername:dto.tlsServername,rejectUnauthorized:dto.tlsRejectUnauthorized,username:dto.username,password:dto.password,connectionTimeoutMs:this.config.get('IMAP_CONNECTION_TIMEOUT_SECONDS',{infer:true})*1000 }); return { success:true }; }
  async testSaved(id: string) {
    const doc=await this.mailboxes.findById(id).select('+encryptedCredential').exec(); if(!doc) throw new NotFoundException('Mailbox not found');
    await this.mailboxes.updateOne({_id:id},{status:'testing'}); const password=this.cipher.decrypt(doc.encryptedCredential,`mailbox:${id}`);
    try { await this.imap.testConnection({host:doc.imapHost,port:doc.imapPort,secure:doc.tlsEnabled,servername:doc.tlsServername,rejectUnauthorized:doc.tlsRejectUnauthorized,username:doc.username,password,connectionTimeoutMs:this.config.get('IMAP_CONNECTION_TIMEOUT_SECONDS',{infer:true})*1000}); await this.mailboxes.updateOne({_id:id},{status:'active',lastConnectionAt:new Date(),$unset:{lastErrorCode:1,lastErrorMessage:1,lastErrorAt:1}}); return {success:true}; }
    catch (error) { await this.mailboxes.updateOne({_id:id},{status:'connection_failed',lastErrorCode:'IMAP_CONNECTION_FAILED',lastErrorMessage:error instanceof Error?error.message:'Connection failed',lastErrorAt:new Date()}); throw error; }
  }
  async enqueue(id:string, action:'start'|'reconcile') { const mailbox=await this.mailboxes.findById(id); if(!mailbox) throw new NotFoundException('Mailbox not found'); const queue=action==='reconcile'?'reconciliation':'mailbox-connect'; await this.queues.get(queue).add(action,{mailboxId:id},{jobId:`${action}:${id}:${Date.now()}`}); if(action==='start') await this.mailboxes.updateOne({_id:id},{syncEnabled:true,status:'connecting'}); return {queued:true}; }
  async setPaused(id:string, paused:boolean){const doc=await this.mailboxes.findByIdAndUpdate(id,{syncEnabled:!paused,status:paused?'paused':'pending'},{new:true});if(!doc)throw new NotFoundException('Mailbox not found');if(!paused)await this.enqueue(id,'start');return this.safe(doc);}
  async stats(id:string){const mailbox=await this.mailboxes.findById(id).lean();if(!mailbox)throw new NotFoundException('Mailbox not found');const folderCount=await this.folders.countDocuments({mailboxId:id});return{mailboxId:id,totalFolders:folderCount,totalMessages:mailbox.totalMessages,totalAttachments:mailbox.totalAttachments,totalStorageBytes:mailbox.totalStorageBytes,status:mailbox.status,lastSuccessfulSyncAt:mailbox.lastSuccessfulSyncAt};}
  async deleteConfiguration(id:string){const doc=await this.mailboxes.findByIdAndDelete(id);if(!doc)throw new NotFoundException('Mailbox not found');return{configurationDeleted:true,backupDataPreserved:true};}
}

@Controller('api/mailboxes') @Roles('super_admin','admin')
export class MailboxesController {
  constructor(private readonly service:MailboxesService){}
  @Post() create(@Body() dto:CreateMailboxDto){return this.service.create(dto)}
  @Get() list(@CurrentUser() user:AuthenticatedUser){return this.service.list(user)}
  @Post('test-connection') test(@Body() dto:TestConnectionDto){return this.service.testUnsaved(dto)}
  @Get(':mailboxId') get(@Param('mailboxId') id:string,@CurrentUser() user:AuthenticatedUser){return this.service.get(id,user)}
  @Patch(':mailboxId') update(@Param('mailboxId') id:string,@Body() dto:UpdateMailboxDto){return this.service.update(id,dto)}
  @Post(':mailboxId/test-connection') testSaved(@Param('mailboxId') id:string){return this.service.testSaved(id)}
  @Post(':mailboxId/start-sync') start(@Param('mailboxId') id:string){return this.service.enqueue(id,'start')}
  @Post(':mailboxId/pause') pause(@Param('mailboxId') id:string){return this.service.setPaused(id,true)}
  @Post(':mailboxId/resume') resume(@Param('mailboxId') id:string){return this.service.setPaused(id,false)}
  @Post(':mailboxId/reconcile') reconcile(@Param('mailboxId') id:string){return this.service.enqueue(id,'reconcile')}
  @Get(':mailboxId/status') status(@Param('mailboxId') id:string,@CurrentUser() user:AuthenticatedUser){return this.service.get(id,user)}
  @Get(':mailboxId/statistics') statistics(@Param('mailboxId') id:string){return this.service.stats(id)}
  @Delete(':mailboxId/configuration') delete(@Param('mailboxId') id:string){return this.service.deleteConfiguration(id)}
}

@Module({imports:[MongooseModule.forFeature([{name:Mailbox.name,schema:MailboxSchema},{name:MailFolder.name,schema:MailFolderSchema}]),InfrastructureModule],controllers:[MailboxesController],providers:[MailboxesService],exports:[MailboxesService]})
export class MailboxesModule{}
