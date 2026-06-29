import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import type { AppConfig } from '@email-backup/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
 const adapter=new FastifyAdapter({logger:false,trustProxy:true,bodyLimit:10*1024*1024});
 const app=await NestFactory.create<NestFastifyApplication>(AppModule,adapter,{bufferLogs:true});
 const config=app.get<ConfigService<AppConfig,true>>(ConfigService);
 await app.register(cookie);
 await app.register(helmet,{contentSecurityPolicy:false});
 app.enableCors({origin:config.get('CORS_ORIGINS',{infer:true}).split(',').map(v=>v.trim()),credentials:true,methods:['GET','POST','PATCH','DELETE','OPTIONS']});
 app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true,transformOptions:{enableImplicitConversion:true}}));
 app.enableShutdownHooks();
 if(config.get('NODE_ENV',{infer:true})!=='production'&&(config.get('SWAGGER_ENABLED',{infer:true})||config.get('OPENAPI_JSON_ENABLED',{infer:true}))){
  const doc=SwaggerModule.createDocument(app,new DocumentBuilder().setTitle('Email Backup Platform API').setVersion('0.1.0').addBearerAuth().build());
  if(config.get('SWAGGER_ENABLED',{infer:true}))SwaggerModule.setup(config.get('SWAGGER_PATH',{infer:true}),app,doc,{swaggerOptions:{persistAuthorization:false}});
  if(config.get('OPENAPI_JSON_ENABLED',{infer:true}))adapter.getInstance().get(`/${config.get('OPENAPI_JSON_PATH',{infer:true})}`,async(_req,reply)=>reply.send(doc));
 }
 await app.listen({port:config.get('API_PORT',{infer:true}),host:'0.0.0.0'});
}
void bootstrap();
