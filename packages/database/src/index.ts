import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import type { MailboxStatus, UserRole } from '@email-backup/domain';

export type UserDocument = HydratedDocument<User>;
@Schema({ timestamps: true, collection: 'users' })
export class User {
  _id!: Types.ObjectId;
  @Prop({ required: true, unique: true, lowercase: true, trim: true, index: true }) email!: string;
  @Prop({ required: true, select: false }) passwordHash!: string;
  @Prop({ required: true, enum: ['super_admin','admin','auditor','viewer'], default: 'viewer' }) role!: UserRole;
  @Prop({ default: true }) active!: boolean;
  @Prop({ default: false }) mfaEnabled!: boolean;
  @Prop({ select: false }) mfaSecret?: string;
  @Prop({ type: [MongooseSchema.Types.ObjectId], default: [] }) permittedMailboxIds!: Types.ObjectId[];
  createdAt!: Date; updatedAt!: Date;
}
export const UserSchema = SchemaFactory.createForClass(User);

export type RefreshTokenDocument = HydratedDocument<RefreshToken>;
@Schema({ timestamps: true, collection: 'refreshTokens' })
export class RefreshToken {
  _id!: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) userId!: Types.ObjectId;
  @Prop({ required: true, unique: true, index: true }) tokenId!: string;
  @Prop({ required: true, select: false }) tokenHash!: string;
  @Prop({ required: true, index: { expireAfterSeconds: 0 } }) expiresAt!: Date;
  @Prop() revokedAt?: Date;
  @Prop() replacedByTokenId?: string;
  @Prop() userAgent?: string;
  @Prop() ipAddress?: string;
  createdAt!: Date; updatedAt!: Date;
}
export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);

@Schema({ _id: false })
export class EncryptedCredentialSubdocument {
  @Prop({ required: true, select: false }) ciphertext!: string;
  @Prop({ required: true, select: false }) initializationVector!: string;
  @Prop({ required: true, select: false }) authenticationTag!: string;
  @Prop({ required: true, select: false }) keyVersion!: number;
}
export const EncryptedCredentialSchema = SchemaFactory.createForClass(EncryptedCredentialSubdocument);

export type MailboxDocument = HydratedDocument<Mailbox>;
@Schema({ timestamps: true, collection: 'mailboxes' })
export class Mailbox {
  _id!: Types.ObjectId;
  @Prop({ required: true, trim: true }) displayName!: string;
  @Prop({ required: true, trim: true }) emailAddress!: string;
  @Prop({ required: true, lowercase: true, trim: true }) normalizedEmailAddress!: string;
  @Prop({ required: true, default: 'custom' }) provider!: string;
  @Prop({ required: true }) imapHost!: string;
  @Prop({ required: true, min: 1, max: 65535 }) imapPort!: number;
  @Prop({ required: true, default: true }) tlsEnabled!: boolean;
  @Prop({ required: true, default: true }) tlsRejectUnauthorized!: boolean;
  @Prop() tlsServername?: string;
  @Prop({ required: true }) username!: string;
  @Prop({ type: EncryptedCredentialSchema, required: true, select: false }) encryptedCredential!: EncryptedCredentialSubdocument;
  @Prop({ default: true }) syncEnabled!: boolean;
  @Prop({ required: true, default: 'pending', index: true }) status!: MailboxStatus;
  @Prop() detectedSentFolder?: string;
  @Prop() sentFolderOverride?: string;
  @Prop({ default: 300, min: 60 }) pollingIntervalSeconds!: number;
  @Prop({ default: 2, min: 1, max: 10 }) maximumConnections!: number;
  @Prop({ min: 0 }) retentionDays?: number;
  @Prop({ default: false }) initialSyncCompleted!: boolean;
  @Prop() initialSyncStartedAt?: Date;
  @Prop() initialSyncCompletedAt?: Date;
  @Prop() lastConnectionAt?: Date;
  @Prop() lastSuccessfulSyncAt?: Date;
  @Prop() lastReconciliationAt?: Date;
  @Prop() lastErrorCode?: string;
  @Prop() lastErrorMessage?: string;
  @Prop() lastErrorAt?: Date;
  @Prop({ default: 0 }) totalFolders!: number;
  @Prop({ default: 0 }) totalMessages!: number;
  @Prop({ default: 0 }) totalAttachments!: number;
  @Prop({ default: 0 }) totalStorageBytes!: number;
  createdAt!: Date; updatedAt!: Date;
}
export const MailboxSchema = SchemaFactory.createForClass(Mailbox);
MailboxSchema.index({ imapHost: 1, username: 1, normalizedEmailAddress: 1 }, { unique: true });

export type MailFolderDocument = HydratedDocument<MailFolder>;
@Schema({ timestamps: true, collection: 'folders' })
export class MailFolder {
  _id!: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) mailboxId!: Types.ObjectId;
  @Prop({ required: true }) name!: string;
  @Prop({ required: true }) path!: string;
  @Prop() encodedPath?: string;
  @Prop() delimiter?: string;
  @Prop() specialUse?: string;
  @Prop({ default: true }) selectable!: boolean;
  @Prop() subscribed?: boolean;
  @Prop() uidValidity?: string;
  @Prop() uidNext?: string;
  @Prop() highestModSeq?: string;
  @Prop() highestProcessedUid?: string;
  @Prop({ default: false }) initialSyncCompleted!: boolean;
  @Prop() lastSyncAt?: Date;
  @Prop() lastReconciliationAt?: Date;
  @Prop({ enum: ['pending','syncing','active','paused','reconciliation_required','error'], default: 'pending' }) status!: string;
  createdAt!: Date; updatedAt!: Date;
}
export const MailFolderSchema = SchemaFactory.createForClass(MailFolder);
MailFolderSchema.index({ mailboxId: 1, path: 1 }, { unique: true });

@Schema({ _id: false })
export class EmailAddressSubdocument {
  @Prop() name?: string;
  @Prop({ required: true, lowercase: true }) address!: string;
}
export const EmailAddressSchema = SchemaFactory.createForClass(EmailAddressSubdocument);

export type StoredMessageDocument = HydratedDocument<StoredMessage>;
@Schema({ timestamps: true, collection: 'messages' })
export class StoredMessage {
  _id!: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) mailboxId!: Types.ObjectId;
  @Prop() internetMessageId?: string;
  @Prop() providerMessageIdentifier?: string;
  @Prop() subject?: string;
  @Prop() normalizedSubject?: string;
  @Prop({ type: [EmailAddressSchema], default: [] }) from!: EmailAddressSubdocument[];
  @Prop({ type: EmailAddressSchema }) sender?: EmailAddressSubdocument;
  @Prop({ type: [EmailAddressSchema], default: [] }) replyTo!: EmailAddressSubdocument[];
  @Prop({ type: [EmailAddressSchema], default: [] }) to!: EmailAddressSubdocument[];
  @Prop({ type: [EmailAddressSchema], default: [] }) cc!: EmailAddressSubdocument[];
  @Prop({ type: [EmailAddressSchema], default: [] }) bcc!: EmailAddressSubdocument[];
  @Prop() inReplyTo?: string;
  @Prop({ type: [String], default: [] }) references!: string[];
  @Prop() sentAt?: Date;
  @Prop() receivedAt?: Date;
  @Prop() internalDate?: Date;
  @Prop() textBody?: string;
  @Prop() htmlBody?: string;
  @Prop() bodyPreview?: string;
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) headers!: Record<string, unknown>;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) rawGridFsId!: Types.ObjectId;
  @Prop({ required: true }) rawSha256!: string;
  @Prop({ required: true }) rawSizeBytes!: number;
  @Prop() contentType?: string;
  @Prop() charset?: string;
  @Prop() importance?: string;
  @Prop({ default: false }) hasAttachments!: boolean;
  @Prop({ default: 0 }) attachmentCount!: number;
  @Prop({ required: true, default: Date.now }) firstSeenAt!: Date;
  @Prop({ required: true, default: Date.now }) lastSeenAt!: Date;
  @Prop() sourceDeletedAt?: Date;
  @Prop({ enum: ['pending','complete','partial','failed','corrupted'], default: 'pending' }) backupStatus!: string;
  @Prop({ enum: ['pending','complete','partial','failed'], default: 'pending' }) parseStatus!: string;
  @Prop() parseErrorCode?: string;
  @Prop() parseErrorMessage?: string;
  createdAt!: Date; updatedAt!: Date;
}
export const StoredMessageSchema = SchemaFactory.createForClass(StoredMessage);
StoredMessageSchema.index({ mailboxId: 1, receivedAt: -1 });
StoredMessageSchema.index({ mailboxId: 1, sentAt: -1 });
StoredMessageSchema.index({ mailboxId: 1, internetMessageId: 1 });
StoredMessageSchema.index({ mailboxId: 1, rawSha256: 1 });
StoredMessageSchema.index({ mailboxId: 1, sourceDeletedAt: 1 });
StoredMessageSchema.index({ mailboxId: 1, subject: 1 });
StoredMessageSchema.index({ mailboxId: 1, 'from.address': 1 });
StoredMessageSchema.index({ mailboxId: 1, 'to.address': 1 });
StoredMessageSchema.index({ subject: 'text', textBody: 'text', bodyPreview: 'text' });

export type MessageLocationDocument = HydratedDocument<MessageLocation>;
@Schema({ timestamps: true, collection: 'messageLocations' })
export class MessageLocation {
  _id!: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) mailboxId!: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) messageId!: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) folderId!: Types.ObjectId;
  @Prop({ required: true }) imapUid!: string;
  @Prop({ required: true }) uidValidity!: string;
  @Prop({ type: [String], default: [] }) flags!: string[];
  @Prop({ type: [String], default: [] }) keywords!: string[];
  @Prop() modSeq?: string;
  @Prop({ default: Date.now }) firstSeenAt!: Date;
  @Prop({ default: Date.now }) lastSeenAt!: Date;
  @Prop() removedFromSourceAt?: Date;
  createdAt!: Date; updatedAt!: Date;
}
export const MessageLocationSchema = SchemaFactory.createForClass(MessageLocation);
MessageLocationSchema.index({ mailboxId: 1, folderId: 1, uidValidity: 1, imapUid: 1 }, { unique: true });

export type StoredAttachmentDocument = HydratedDocument<StoredAttachment>;
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'attachments' })
export class StoredAttachment {
  _id!: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) mailboxId!: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) messageId!: Types.ObjectId;
  @Prop() filename?: string;
  @Prop({ required: true }) sanitizedFilename!: string;
  @Prop() contentType?: string;
  @Prop() contentDisposition?: string;
  @Prop() contentId?: string;
  @Prop({ required: true }) sizeBytes!: number;
  @Prop({ required: true }) sha256!: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) gridFsFileId!: Types.ObjectId;
  @Prop({ default: false }) isInline!: boolean;
  createdAt!: Date;
}
export const StoredAttachmentSchema = SchemaFactory.createForClass(StoredAttachment);

export type BinaryObjectDocument = HydratedDocument<BinaryObject>;
@Schema({ timestamps: true, collection: 'binaryObjects' })
export class BinaryObject {
  _id!: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) mailboxId!: Types.ObjectId;
  @Prop({ required: true, index: true }) sha256!: string;
  @Prop({ required: true }) sizeBytes!: number;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) gridFsFileId!: Types.ObjectId;
  @Prop({ enum: ['raw_message','attachment','export'], required: true }) kind!: string;
  @Prop({ default: 1 }) referenceCount!: number;
  @Prop({ enum: ['healthy','corrupted','missing'], default: 'healthy' }) integrityStatus!: string;
  createdAt!: Date; updatedAt!: Date;
}
export const BinaryObjectSchema = SchemaFactory.createForClass(BinaryObject);
BinaryObjectSchema.index({ mailboxId: 1, sha256: 1, kind: 1 }, { unique: true });

function createMailboxEventSchema(collection: string) {
  const schema = new MongooseSchema({
    mailboxId: { type: MongooseSchema.Types.ObjectId, required: true, index: true },
    code: { type: String, required: true }, message: { type: String }, details: { type: MongooseSchema.Types.Mixed },
  }, { timestamps: true, collection });
  return schema;
}
export const SyncEventSchema = createMailboxEventSchema('syncEvents');
export const SyncErrorSchema = createMailboxEventSchema('syncErrors');
export const IntegrityReportSchema = createMailboxEventSchema('integrityReports');

export type AuditLogDocument = HydratedDocument<AuditLog>;
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'auditLogs' })
export class AuditLog {
  _id!: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, index: true }) mailboxId?: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, index: true }) actorUserId?: Types.ObjectId;
  @Prop({ required: true, index: true }) action!: string;
  @Prop() resourceType?: string;
  @Prop() resourceId?: string;
  @Prop() ipAddress?: string;
  @Prop() userAgent?: string;
  @Prop({ type: MongooseSchema.Types.Mixed }) details?: Record<string, unknown>;
  @Prop({ required: true, default: Date.now, index: true }) createdAt!: Date;
}
export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);

export type ExportJobDocument = HydratedDocument<ExportJob>;
@Schema({ timestamps: true, collection: 'exportJobs' })
export class ExportJob {
  _id!: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) requestedBy!: Types.ObjectId;
  @Prop({ type: [MongooseSchema.Types.ObjectId], required: true }) mailboxIds!: Types.ObjectId[];
  @Prop({ type: [MongooseSchema.Types.ObjectId] }) folderIds?: Types.ObjectId[];
  @Prop({ type: [MongooseSchema.Types.ObjectId] }) messageIds?: Types.ObjectId[];
  @Prop({ type: MongooseSchema.Types.Mixed }) filters?: Record<string, unknown>;
  @Prop({ enum: ['eml','mbox','zip','json','csv'], required: true }) format!: string;
  @Prop({ default: true }) includeAttachments!: boolean;
  @Prop({ default: true }) includeMetadata!: boolean;
  @Prop({ enum: ['queued','running','completed','failed','cancelled','expired'], default: 'queued', index: true }) status!: string;
  @Prop({ type: MongooseSchema.Types.Mixed, default: { totalMessages: 0, processedMessages: 0, processedBytes: 0, percentage: 0 } }) progress!: Record<string, number>;
  @Prop({ enum: ['temporary_volume','gridfs','object_storage'], default: 'temporary_volume' }) outputStorageType!: string;
  @Prop() outputReference?: string;
  @Prop() outputFilename?: string;
  @Prop() outputSizeBytes?: number;
  @Prop() sha256?: string;
  @Prop({ index: { expireAfterSeconds: 0 } }) expiresAt?: Date;
  @Prop() errorCode?: string;
  @Prop() errorMessage?: string;
  @Prop() startedAt?: Date;
  @Prop() completedAt?: Date;
  createdAt!: Date; updatedAt!: Date;
}
export const ExportJobSchema = SchemaFactory.createForClass(ExportJob);

export type RestoreJobDocument = HydratedDocument<RestoreJob>;
@Schema({ timestamps: true, collection: 'restoreJobs' })
export class RestoreJob {
  _id!: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) requestedBy!: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true }) mailboxId!: Types.ObjectId;
  @Prop({ type: [MongooseSchema.Types.ObjectId], required: true }) messageIds!: Types.ObjectId[];
  @Prop({ required: true }) targetFolder!: string;
  @Prop({ enum: ['queued','running','completed','failed','cancelled'], default: 'queued', index: true }) status!: string;
  @Prop({ type: MongooseSchema.Types.Mixed, default: { totalMessages: 0, processedMessages: 0, percentage: 0 } }) progress!: Record<string, number>;
  @Prop() errorCode?: string;
  @Prop() errorMessage?: string;
  @Prop() startedAt?: Date;
  @Prop() completedAt?: Date;
  createdAt!: Date; updatedAt!: Date;
}
export const RestoreJobSchema = SchemaFactory.createForClass(RestoreJob);

export const SystemSettingSchema = new MongooseSchema({ key: { type: String, required: true, unique: true }, value: MongooseSchema.Types.Mixed }, { timestamps: true, collection: 'systemSettings' });

export const DATABASE_MODELS = [
  { name: User.name, schema: UserSchema }, { name: RefreshToken.name, schema: RefreshTokenSchema },
  { name: Mailbox.name, schema: MailboxSchema }, { name: MailFolder.name, schema: MailFolderSchema },
  { name: StoredMessage.name, schema: StoredMessageSchema }, { name: MessageLocation.name, schema: MessageLocationSchema },
  { name: StoredAttachment.name, schema: StoredAttachmentSchema }, { name: BinaryObject.name, schema: BinaryObjectSchema },
  { name: 'SyncEvent', schema: SyncEventSchema }, { name: 'SyncError', schema: SyncErrorSchema },
  { name: 'IntegrityReport', schema: IntegrityReportSchema }, { name: AuditLog.name, schema: AuditLogSchema },
  { name: ExportJob.name, schema: ExportJobSchema }, { name: RestoreJob.name, schema: RestoreJobSchema },
  { name: 'SystemSetting', schema: SystemSettingSchema },
] as const;
