import { Body, Controller, Get, Injectable, Module, OnModuleInit, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { IsEmail, IsOptional, IsString, Length, MinLength } from 'class-validator';
import { Model } from 'mongoose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '@email-backup/config';
import { RefreshToken, RefreshTokenSchema, User, UserSchema, type UserDocument } from '@email-backup/database';
import { CurrentUser, Public, type AuthenticatedUser } from './common';

class LoginDto { @IsEmail() email!: string; @IsString() @MinLength(8) password!: string; @IsOptional() @IsString() @Length(6, 8) mfaCode?: string; }
class MfaCodeDto { @IsString() @Length(6, 8) code!: string; }

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(@InjectModel(User.name) private readonly users: Model<User>, @InjectModel(RefreshToken.name) private readonly refreshTokens: Model<RefreshToken>, private readonly jwt: JwtService, private readonly config: ConfigService<AppConfig, true>) {}
  async onModuleInit(): Promise<void> {
    const email = this.config.get('ADMIN_INITIAL_EMAIL', { infer: true }).toLowerCase();
    if (await this.users.exists({ email })) return;
    const passwordHash = await argon2.hash(this.config.get('ADMIN_INITIAL_PASSWORD', { infer: true }), { type: argon2.argon2id, memoryCost: 19456, timeCost: 3, parallelism: 1 });
    await this.users.create({ email, passwordHash, role: 'super_admin', active: true, permittedMailboxIds: [] });
  }
  private accessPayload(user: UserDocument): AuthenticatedUser { return { sub: user._id.toString(), email: user.email, role: user.role, permittedMailboxIds: user.permittedMailboxIds.map(String) }; }
  private async issue(user: UserDocument, request: FastifyRequest, reply: FastifyReply): Promise<{ accessToken: string; expiresIn: number }> {
    const tokenId = randomUUID();
    const refreshToken = await this.jwt.signAsync({ sub: user._id.toString(), jti: tokenId, type: 'refresh' }, { secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }), expiresIn: this.config.get('JWT_REFRESH_TTL_SECONDS', { infer: true }) });
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + this.config.get('JWT_REFRESH_TTL_SECONDS', { infer: true }) * 1000);
    await this.refreshTokens.create({ userId: user._id, tokenId, tokenHash, expiresAt, userAgent: request.headers['user-agent'], ipAddress: request.ip });
    const secure = this.config.get('NODE_ENV', { infer: true }) !== 'development';
    const csrf = randomBytes(24).toString('base64url');
    reply.setCookie('refresh_token', refreshToken, { path: '/api/auth', httpOnly: true, secure, sameSite: 'strict', maxAge: this.config.get('JWT_REFRESH_TTL_SECONDS', { infer: true }) });
    reply.setCookie('csrf_token', csrf, { path: '/', httpOnly: false, secure, sameSite: 'strict', maxAge: this.config.get('JWT_REFRESH_TTL_SECONDS', { infer: true }) });
    const accessToken = await this.jwt.signAsync(this.accessPayload(user), { secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }), expiresIn: this.config.get('JWT_ACCESS_TTL_SECONDS', { infer: true }) });
    return { accessToken, expiresIn: this.config.get('JWT_ACCESS_TTL_SECONDS', { infer: true }) };
  }
  async login(dto: LoginDto, request: FastifyRequest, reply: FastifyReply) {
    const user = await this.users.findOne({ email: dto.email.toLowerCase(), active: true }).select('+passwordHash +mfaSecret').exec() as UserDocument | null;
    const passwordValid = user ? await argon2.verify(user.passwordHash, dto.password).catch(() => false) : false;
    const mfaValid = user?.mfaEnabled ? Boolean(user.mfaSecret && dto.mfaCode && authenticator.check(dto.mfaCode, user.mfaSecret)) : true;
    if (!user || !passwordValid || !mfaValid) throw new UnauthorizedException('Invalid credentials');
    return this.issue(user, request, reply);
  }
  private validateCsrf(request: FastifyRequest): void {
    const header = String(request.headers['x-csrf-token'] ?? '');
    const cookie = String(request.cookies.csrf_token ?? '');
    if (!header || !cookie || header.length !== cookie.length || !timingSafeEqual(Buffer.from(header), Buffer.from(cookie))) throw new UnauthorizedException('Invalid request');
  }
  async refresh(request: FastifyRequest, reply: FastifyReply) {
    this.validateCsrf(request);
    const raw = request.cookies.refresh_token;
    if (!raw) throw new UnauthorizedException('Invalid session');
    let payload: { sub: string; jti: string; type: string };
    try { payload = await this.jwt.verifyAsync(raw, { secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }) }); } catch { throw new UnauthorizedException('Invalid session'); }
    const stored = await this.refreshTokens.findOne({ tokenId: payload.jti, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } }).select('+tokenHash').exec();
    if (!stored || stored.tokenHash !== createHash('sha256').update(raw).digest('hex')) throw new UnauthorizedException('Invalid session');
    const user = await this.users.findOne({ _id: payload.sub, active: true }).exec() as UserDocument | null;
    if (!user) throw new UnauthorizedException('Invalid session');
    stored.revokedAt = new Date(); await stored.save();
    return this.issue(user, request, reply);
  }
  async logout(request: FastifyRequest, reply: FastifyReply): Promise<{ success: true }> {
    this.validateCsrf(request);
    const raw = request.cookies.refresh_token;
    if (raw) {
      try { const payload = await this.jwt.verifyAsync<{ jti: string }>(raw, { secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }) }); await this.refreshTokens.updateOne({ tokenId: payload.jti }, { revokedAt: new Date() }); } catch { /* token is already invalid */ }
    }
    reply.clearCookie('refresh_token', { path: '/api/auth' }); reply.clearCookie('csrf_token', { path: '/' });
    return { success: true };
  }
  async setupMfa(user: AuthenticatedUser) {
    const secret = authenticator.generateSecret();
    await this.users.updateOne({ _id: user.sub }, { mfaSecret: secret, mfaEnabled: false });
    return { secret, otpauthUrl: authenticator.keyuri(user.email, 'Email Backup Platform', secret) };
  }
  async verifyMfa(user: AuthenticatedUser, code: string) {
    const record = await this.users.findById(user.sub).select('+mfaSecret').exec();
    if (!record?.mfaSecret || !authenticator.check(code, record.mfaSecret)) throw new UnauthorizedException('Invalid verification code');
    record.mfaEnabled = true;
    await record.save();
    await this.refreshTokens.updateMany({ userId: record._id, revokedAt: { $exists: false } }, { revokedAt: new Date() });
    return { verified: true, mfaEnabled: true };
  }
}

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Public() @Post('login') login(@Body() dto: LoginDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) { return this.auth.login(dto, req, reply); }
  @Public() @Post('refresh') refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) { return this.auth.refresh(req, reply); }
  @Public() @Post('logout') logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) { return this.auth.logout(req, reply); }
  @Get('me') me(@CurrentUser() user: AuthenticatedUser) { return user; }
  @Post('mfa/setup') setupMfa(@CurrentUser() user: AuthenticatedUser) { return this.auth.setupMfa(user); }
  @Post('mfa/verify') verifyMfa(@CurrentUser() user: AuthenticatedUser, @Body() dto: MfaCodeDto) { return this.auth.verifyMfa(user, dto.code); }
}

@Module({ imports: [JwtModule.register({}), MongooseModule.forFeature([{ name: User.name, schema: UserSchema }, { name: RefreshToken.name, schema: RefreshTokenSchema }])], controllers: [AuthController], providers: [AuthService], exports: [JwtModule] })
export class AuthModule {}
