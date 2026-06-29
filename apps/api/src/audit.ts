import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditLog, AuditLogSchema } from '@email-backup/database';
import { CurrentUser, Roles, canAccessMailbox, type AuthenticatedUser } from './common';

@Injectable()
class AuditService {
  constructor(@InjectModel(AuditLog.name) private readonly audits: Model<AuditLog>) {}

  async list(user: AuthenticatedUser, query: Record<string, string | undefined>) {
    const page = Math.max(1, Number(query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 50)));
    const filter: Record<string, unknown> = {};
    if (query.action) filter.action = query.action;
    if (query.mailboxId) {
      if (!canAccessMailbox(user, query.mailboxId)) return { items: [], page, limit, total: 0 };
      filter.mailboxId = new Types.ObjectId(query.mailboxId);
    } else if (!['super_admin', 'admin'].includes(user.role)) {
      filter.$or = [
        { mailboxId: { $in: user.permittedMailboxIds.map((id) => new Types.ObjectId(id)) } },
        { actorUserId: new Types.ObjectId(user.sub) },
      ];
    }
    if (query.dateFrom || query.dateTo) {
      const range: Record<string, Date> = {};
      if (query.dateFrom) range.$gte = new Date(query.dateFrom);
      if (query.dateTo) range.$lte = new Date(query.dateTo);
      filter.createdAt = range;
    }
    const [items, total] = await Promise.all([
      this.audits.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.audits.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }
}

@Controller('api/audit-logs')
@Roles('super_admin', 'admin', 'auditor')
class AuditController {
  constructor(private readonly service: AuditService) {}
  @Get() list(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string | undefined>) { return this.service.list(user, query); }
}

@Module({
  imports: [MongooseModule.forFeature([{ name: AuditLog.name, schema: AuditLogSchema }])],
  providers: [AuditService],
  controllers: [AuditController],
})
export class AuditModule {}
