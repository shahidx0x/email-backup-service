import { Body, Controller, Get, Injectable, Module, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsEnum, IsMongoId, IsOptional, IsString, MinLength } from 'class-validator';
import { Model, Types } from 'mongoose';
import * as argon2 from 'argon2';
import { RefreshToken, RefreshTokenSchema, User, UserSchema } from '@email-backup/database';
import { USER_ROLES, type UserRole } from '@email-backup/domain';
import { Roles } from './common';

class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(12) password!: string;
  @IsEnum(USER_ROLES) role!: UserRole;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsMongoId({ each: true }) permittedMailboxIds?: string[];
}

class UpdateUserDto {
  @IsOptional() @IsEnum(USER_ROLES) role?: UserRole;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsMongoId({ each: true }) permittedMailboxIds?: string[];
  @IsOptional() @IsString() @MinLength(12) password?: string;
}

@Injectable()
class UsersService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(RefreshToken.name) private readonly refreshTokens: Model<RefreshToken>,
  ) {}

  private safe(user: User) {
    return {
      _id: user._id,
      email: user.email,
      role: user.role,
      active: user.active,
      mfaEnabled: user.mfaEnabled,
      permittedMailboxIds: user.permittedMailboxIds,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  async list() {
    return (await this.users.find({}).sort({ createdAt: -1 }).exec()).map((user) => this.safe(user));
  }

  async create(dto: CreateUserDto) {
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 3, parallelism: 1 });
    const user = await this.users.create({
      email: dto.email.toLowerCase(),
      passwordHash,
      role: dto.role,
      active: true,
      permittedMailboxIds: (dto.permittedMailboxIds ?? []).map((id) => new Types.ObjectId(id)),
    });
    return this.safe(user);
  }

  async update(id: string, dto: UpdateUserDto) {
    const update: Record<string, unknown> = {};
    if (dto.role !== undefined) update.role = dto.role;
    if (dto.active !== undefined) update.active = dto.active;
    if (dto.permittedMailboxIds !== undefined) update.permittedMailboxIds = dto.permittedMailboxIds.map((mailboxId) => new Types.ObjectId(mailboxId));
    if (dto.password) update.passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 3, parallelism: 1 });
    const user = await this.users.findByIdAndUpdate(id, update, { new: true, runValidators: true }).exec();
    if (!user) throw new NotFoundException('User not found');
    if (dto.password || dto.active === false) await this.refreshTokens.updateMany({ userId: user._id, revokedAt: { $exists: false } }, { revokedAt: new Date() });
    return this.safe(user);
  }

  async revokeSessions(id: string) {
    if (!await this.users.exists({ _id: id })) throw new NotFoundException('User not found');
    const result = await this.refreshTokens.updateMany({ userId: id, revokedAt: { $exists: false } }, { revokedAt: new Date() });
    return { revokedSessions: result.modifiedCount };
  }
}

@Controller('api/users')
@Roles('super_admin')
class UsersController {
  constructor(private readonly service: UsersService) {}
  @Get() list() { return this.service.list(); }
  @Post() create(@Body() dto: CreateUserDto) { return this.service.create(dto); }
  @Patch(':userId') update(@Param('userId') id: string, @Body() dto: UpdateUserDto) { return this.service.update(id, dto); }
  @Post(':userId/revoke-sessions') revoke(@Param('userId') id: string) { return this.service.revokeSessions(id); }
}

@Module({
  imports: [MongooseModule.forFeature([{ name: User.name, schema: UserSchema }, { name: RefreshToken.name, schema: RefreshTokenSchema }])],
  providers: [UsersService],
  controllers: [UsersController],
})
export class UsersModule {}
