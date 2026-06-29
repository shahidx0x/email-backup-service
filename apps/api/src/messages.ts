import { Controller, Get, Injectable, Module, NotFoundException, Param, Query, Res } from '@nestjs/common';
import { InjectConnection, InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Model, Types, type Connection } from 'mongoose';
import type { FastifyReply } from 'fastify';
import { GridFSBucket } from 'mongodb';
import { StoredAttachment, StoredAttachmentSchema, StoredMessage, StoredMessageSchema } from '@email-backup/database';
import { CurrentUser, canAccessMailbox, type AuthenticatedUser } from './common';

@Injectable()
class MessagesService {
  constructor(@InjectModel(StoredMessage.name) private readonly messages:Model<StoredMessage>,@InjectModel(StoredAttachment.name) private readonly attachments:Model<StoredAttachment>,@InjectConnection() private readonly connection:Connection){}
  async list(query:Record<string,string|undefined>,user:AuthenticatedUser){
    const page=Math.max(1,Number(query.page??1));const limit=Math.min(100,Math.max(1,Number(query.limit??25)));
    const filter:Record<string,unknown>={}; const requested=(query.mailboxIds??'').split(',').filter(Boolean); const allowed=['super_admin','admin'].includes(user.role)?requested:requested.filter(id=>user.permittedMailboxIds.includes(id));
    if(allowed.length)filter.mailboxId={$in:allowed.map(id=>new Types.ObjectId(id))};else if(!['super_admin','admin'].includes(user.role))filter.mailboxId={$in:user.permittedMailboxIds.map(id=>new Types.ObjectId(id))};
    if(query.sender)filter['from.address']=query.sender.toLowerCase();if(query.recipient)filter['to.address']=query.recipient.toLowerCase();if(query.subject)filter.subject={$regex:query.subject,$options:'i'};if(query.hasAttachments)filter.hasAttachments=query.hasAttachments==='true';if(query.sourceDeleted)filter.sourceDeletedAt=query.sourceDeleted==='true'?{$exists:true}:{$exists:false};if(query.search)filter.$text={$search:query.search};
    const [items,total]=await Promise.all([this.messages.find(filter).sort({receivedAt:-1,_id:-1}).skip((page-1)*limit).limit(limit).lean(),this.messages.countDocuments(filter)]);return{items,page,limit,total};
  }
  async get(id:string,user:AuthenticatedUser){const item=await this.messages.findById(id).lean();if(!item||!canAccessMailbox(user,String(item.mailboxId)))throw new NotFoundException('Message not found');return item;}
  async streamRaw(id:string,user:AuthenticatedUser,reply:FastifyReply){const item=await this.get(id,user);reply.header('Content-Type','message/rfc822');reply.header('Content-Disposition',`attachment; filename="message-${id}.eml"`);const bucket=new GridFSBucket(this.connection.db!,{bucketName:'emailBinaries'});return reply.send(bucket.openDownloadStream(item.rawGridFsId));}
  async listAttachments(id:string,user:AuthenticatedUser){await this.get(id,user);return this.attachments.find({messageId:id}).select('-gridFsFileId').lean();}
  async streamAttachment(id:string,user:AuthenticatedUser,reply:FastifyReply){const item=await this.attachments.findById(id).lean();if(!item||!canAccessMailbox(user,String(item.mailboxId)))throw new NotFoundException('Attachment not found');reply.header('Content-Type',item.contentType??'application/octet-stream');reply.header('Content-Disposition',`attachment; filename="${item.sanitizedFilename}"`);const bucket=new GridFSBucket(this.connection.db!,{bucketName:'emailBinaries'});return reply.send(bucket.openDownloadStream(item.gridFsFileId));}
}
@Controller('api/messages')
class MessagesController {constructor(private readonly service:MessagesService){}@Get()list(@Query()q:Record<string,string|undefined>,@CurrentUser()u:AuthenticatedUser){return this.service.list(q,u)}@Get(':messageId')get(@Param('messageId')id:string,@CurrentUser()u:AuthenticatedUser){return this.service.get(id,u)}@Get(':messageId/raw')raw(@Param('messageId')id:string,@CurrentUser()u:AuthenticatedUser,@Res()r:FastifyReply){return this.service.streamRaw(id,u,r)}@Get(':messageId/attachments')attachments(@Param('messageId')id:string,@CurrentUser()u:AuthenticatedUser){return this.service.listAttachments(id,u)}}
@Controller('api/attachments')
class AttachmentsController {constructor(private readonly service:MessagesService){}@Get(':attachmentId/download')download(@Param('attachmentId')id:string,@CurrentUser()u:AuthenticatedUser,@Res()r:FastifyReply){return this.service.streamAttachment(id,u,r)}}
@Module({imports:[MongooseModule.forFeature([{name:StoredMessage.name,schema:StoredMessageSchema},{name:StoredAttachment.name,schema:StoredAttachmentSchema}])],providers:[MessagesService],controllers:[MessagesController,AttachmentsController]})export class MessagesModule{}
