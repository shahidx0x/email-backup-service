#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="${1:-.}"
cd "$ROOT"

mkdir -p 'apps/api'
cat > 'apps/api/package.json' <<'__P_2_0__'
{
  "name": "@email-backup/api",
  "version": "0.1.0",
  "private": true,
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/main.ts",
    "start": "node dist/main.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@email-backup/config": "workspace:*",
    "@email-backup/database": "workspace:*",
    "@email-backup/domain": "workspace:*",
    "@email-backup/encryption": "workspace:*",
    "@email-backup/imap": "workspace:*",
    "@email-backup/logging": "workspace:*",
    "@email-backup/metrics": "workspace:*",
    "@email-backup/queue": "workspace:*",
    "@email-backup/shared": "workspace:*",
    "@fastify/cookie": "^11.0.2",
    "@fastify/helmet": "^13.0.2",
    "@nestjs/common": "^11.1.27",
    "@nestjs/config": "^4.0.2",
    "@nestjs/core": "^11.1.27",
    "@nestjs/jwt": "^11.0.2",
    "@nestjs/mongoose": "^11.0.4",
    "@nestjs/platform-fastify": "^11.1.27",
    "@nestjs/swagger": "^11.4.4",
    "@nestjs/throttler": "^6.5.0",
    "argon2": "^0.44.0",
    "class-transformer": "^0.5.1",
    "class-validator": "^0.14.2",
    "mongoose": "^8.18.0",
    "nestjs-pino": "^4.6.1",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2",
    "fastify": "^5.6.2"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "tsx": "^4.20.6",
    "typescript": "^5.9.3"
  }
}
__P_2_0__

mkdir -p 'apps/api/src'
cat > 'apps/api/src/app.module.ts' <<'__P_2_1__'
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
import { InfrastructureModule } from './infrastructure';
import { MailboxesModule } from './mailboxes';
import { MessagesModule } from './messages';
import { JobsModule } from './jobs';

@Module({
 imports:[
  ConfigModule.forRoot({isGlobal:true,cache:true,validate:(value)=>parseConfig(value)}),
  LoggerModule.forRootAsync({inject:[ConfigService],useFactory:(c:ConfigService<AppConfig,true>)=>createLoggerConfig(c.get('LOG_LEVEL',{infer:true}))}),
  MongooseModule.forRootAsync({inject:[ConfigService],useFactory:(c:ConfigService<AppConfig,true>)=>({uri:buildMongoUri(parseConfig(process.env)),autoIndex:c.get('NODE_ENV',{infer:true})!=='production',serverSelectionTimeoutMS:10_000})}),
  ThrottlerModule.forRoot([{ttl:60_000,limit:120}]),
  AuthModule,InfrastructureModule,MailboxesModule,MessagesModule,JobsModule,
 ],
 providers:[{provide:APP_GUARD,useClass:JwtAuthGuard},{provide:APP_GUARD,useClass:RolesGuard},{provide:APP_FILTER,useClass:ApiExceptionFilter}],
})
export class AppModule{}
__P_2_1__

echo 'Materialized chunk 02.'
