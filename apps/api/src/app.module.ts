import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { parseConfig, buildMongoUri, type AppConfig } from '@email-backup/config';
import { createLoggerConfig } from '@email-backup/logging';
import { ApiExceptionFilter, JwtAuthGuard, RolesGuard } from './common';
import { AuthModule } from './auth';
import { UsersModule } from './users';
import { AuditModule } from './audit';
import { InfrastructureModule } from './infrastructure';
import { MailboxesModule } from './mailboxes';
import { FoldersModule } from './folders';
import { MessagesModule } from './messages';
import { JobsModule } from './jobs';
import { TransfersModule } from './transfers';

@Module({
 imports:[
  ConfigModule.forRoot({isGlobal:true,cache:true,validate:(value)=>parseConfig(value)}),
  LoggerModule.forRootAsync({inject:[ConfigService],useFactory:(c:ConfigService<AppConfig,true>)=>createLoggerConfig(c.get('LOG_LEVEL',{infer:true}))}),
  MongooseModule.forRootAsync({inject:[ConfigService],useFactory:(c:ConfigService<AppConfig,true>)=>({uri:buildMongoUri(parseConfig(process.env)),autoIndex:c.get('NODE_ENV',{infer:true})!=='production',serverSelectionTimeoutMS:10_000})}),
  ThrottlerModule.forRoot([{ttl:60_000,limit:120}]),
  AuthModule,UsersModule,AuditModule,InfrastructureModule,MailboxesModule,FoldersModule,MessagesModule,JobsModule,TransfersModule,
 ],
 providers:[{provide:APP_GUARD,useClass:JwtAuthGuard},{provide:APP_GUARD,useClass:RolesGuard},{provide:APP_FILTER,useClass:ApiExceptionFilter}],
})
export class AppModule{}
