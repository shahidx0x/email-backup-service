import { SetMetadata, createParamDecorator, ExecutionContext, CanActivate, Injectable, UnauthorizedException, ForbiddenException, ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '@email-backup/config';
import type { UserRole } from '@email-backup/domain';
import { createRequestId, type ApiErrorResponse } from '@email-backup/shared';

export interface AuthenticatedUser { sub: string; email: string; role: UserRole; permittedMailboxIds: string[]; }
declare module 'fastify' { interface FastifyRequest { user?: AuthenticatedUser; } }

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<FastifyRequest>().user);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService, private readonly config: ConfigService<AppConfig, true>) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException('Authentication required');
    try {
      request.user = await this.jwt.verifyAsync<AuthenticatedUser>(auth.slice(7), { secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }) });
      return true;
    } catch { throw new UnauthorizedException('Authentication required'); }
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!roles?.length) return true;
    const user = context.switchToHttp().getRequest<FastifyRequest>().user;
    if (!user || !roles.includes(user.role)) throw new ForbiddenException('Insufficient permissions');
    return true;
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : undefined;
    const object = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
    const messageValue = object.message ?? (status === 500 ? 'Internal server error' : String(raw ?? 'Request failed'));
    const message = Array.isArray(messageValue) ? messageValue.join('; ') : String(messageValue);
    const response: ApiErrorResponse = {
      statusCode: status,
      code: typeof object.code === 'string' ? object.code : status === 500 ? 'INTERNAL_ERROR' : `HTTP_${status}`,
      message,
      requestId: String(request.id ?? request.headers['x-request-id'] ?? createRequestId()),
      timestamp: new Date().toISOString(),
      path: request.url,
    };
    void reply.status(status).send(response);
  }
}

export function canAccessMailbox(user: AuthenticatedUser, mailboxId: string): boolean {
  return user.role === 'super_admin' || user.role === 'admin' || user.permittedMailboxIds.includes(mailboxId);
}
