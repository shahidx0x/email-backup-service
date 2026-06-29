import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Injectable, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { AppConfig } from '@email-backup/config';
import { parseConfig } from '@email-backup/config';
import { PlatformMetrics } from '@email-backup/metrics';
import { QueueRegistry } from '@email-backup/queue';
import type { QueueName } from '@email-backup/domain';

@Injectable()
class SchedulerRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly instanceId=randomUUID();
  private readonly queues:QueueRegistry;
  private readonly metrics=new PlatformMetrics();
  private server?:Server;private renew?:NodeJS.Timeout;private heartbeat?:NodeJS.Timeout;private leader=false;
  constructor(private readonly config:ConfigService<AppConfig,true>){this.queues=new QueueRegistry(config.get('REDIS_HOST',{infer:true}),config.get('REDIS_PORT',{infer:true}),config.get('REDIS_PASSWORD',{infer:true}));}
  async onApplicationBootstrap(){await this.tryBecomeLeader();this.renew=setInterval(()=>void this.tryBecomeLeader(),20_000);this.heartbeat=setInterval(()=>this.metrics.schedulerHeartbeat.set(Date.now()/1000),10_000);this.metrics.schedulerHeartbeat.set(Date.now()/1000);this.server=createServer(async(req,res)=>{if(req.url==='/metrics'){res.writeHead(200,{'content-type':this.metrics.contentType()});res.end(await this.metrics.metrics());return;}res.writeHead(this.leader?200:503,{'content-type':'application/json'});res.end(JSON.stringify({status:this.leader?'ok':'standby',leader:this.leader,instanceId:this.instanceId}));});this.server.listen(this.config.get('SCHEDULER_HEALTH_PORT',{infer:true}),'0.0.0.0');}
  private async tryBecomeLeader(){const key='email-backup:scheduler:leader';if(this.leader){const current=await this.queues.connection.get(key);if(current===this.instanceId){await this.queues.connection.pexpire(key,60_000);return;}this.leader=false;}const acquired=await this.queues.connection.set(key,this.instanceId,'PX',60_000,'NX');if(acquired==='OK'){this.leader=true;await this.registerSchedules();}}
  private async registerSchedules(){const schedules:[string,string,string,string][]=[
    ['folder-discovery','global-folder-discovery',this.config.get('FOLDER_DISCOVERY_CRON',{infer:true}),'folder-discovery'],
    ['reconciliation','global-reconciliation',this.config.get('RECONCILIATION_CRON',{infer:true}),'reconciliation'],
    ['integrity-check','integrity-sample',this.config.get('INTEGRITY_SAMPLE_CRON',{infer:true}),'sample'],
    ['integrity-check','integrity-full',this.config.get('FULL_INTEGRITY_CRON',{infer:true}),'full'],
    ['cleanup','export-cleanup',this.config.get('EXPORT_CLEANUP_CRON',{infer:true}),'exports'],
    ['statistics','statistics-refresh',this.config.get('STATISTICS_REFRESH_CRON',{infer:true}),'statistics'],
    ['mailbox-connect','connectivity-check',this.config.get('CONNECTIVITY_CHECK_CRON',{infer:true}),'connectivity'],
    ['cleanup','stale-lock-cleanup',this.config.get('STALE_LOCK_CLEANUP_CRON',{infer:true}),'locks'],
  ];
  for(const[queueName,id,pattern,name]of schedules){await this.queues.get(queueName as QueueName).upsertJobScheduler(id,{pattern},{name,data:{scope:'global'},opts:{removeOnComplete:1000,removeOnFail:false}});}}
  async onApplicationShutdown(){if(this.renew)clearInterval(this.renew);if(this.heartbeat)clearInterval(this.heartbeat);if(this.leader){const key='email-backup:scheduler:leader';const current=await this.queues.connection.get(key);if(current===this.instanceId)await this.queues.connection.del(key);}await this.queues.close();if(this.server)await new Promise<void>((resolve,reject)=>this.server!.close(e=>e?reject(e):resolve()));}
}
@Module({imports:[ConfigModule.forRoot({isGlobal:true,cache:true,validate:v=>parseConfig(v)})],providers:[SchedulerRuntime]})class SchedulerModule{}
async function bootstrap(){const app=await NestFactory.createApplicationContext(SchedulerModule,{logger:['error','warn','log']});app.enableShutdownHooks();}
void bootstrap();
