import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import { Injectable, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { InjectConnection, InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Worker, type Job } from 'bullmq';
import { Model, Types, type Connection } from 'mongoose';
import type { AppConfig } from '@email-backup/config';
import { buildMongoUri, parseConfig } from '@email-backup/config';
import { Mailbox, MailboxSchema, MailFolder, MailFolderSchema } from '@email-backup/database';
import { QUEUE_NAMES, type QueueName } from '@email-backup/domain';
import { CredentialCipher } from '@email-backup/encryption';
import { detectSentFolder, ImapClientService } from '@email-backup/imap';
import { PlatformMetrics } from '@email-backup/metrics';
import { QueueRegistry, createRedisConnection } from '@email-backup/queue';

interface MailboxJobData { mailboxId: string; }

@Injectable()
class WorkerRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly workers: Worker[] = [];
  private readonly metrics = new PlatformMetrics();
  private readonly queues: QueueRegistry;
  private readonly cipher: CredentialCipher;
  private readonly imap = new ImapClientService();
  private server?: Server;
  private heartbeat?: NodeJS.Timeout;
  private stopping = false;
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    @InjectModel(Mailbox.name) private readonly mailboxes: Model<Mailbox>,
    @InjectModel(MailFolder.name) private readonly folders: Model<MailFolder>,
    @InjectConnection() private readonly mongo: Connection,
  ) {
    this.queues = new QueueRegistry(config.get('REDIS_HOST',{infer:true}),config.get('REDIS_PORT',{infer:true}),config.get('REDIS_PASSWORD',{infer:true}));
    this.cipher = new CredentialCipher(new Map([[1,Buffer.from(config.get('CREDENTIAL_ENCRYPTION_KEY',{infer:true}),'base64')]]),1);
  }
  async onApplicationBootstrap(): Promise<void> {
    const connection=createRedisConnection(this.config.get('REDIS_HOST',{infer:true}),this.config.get('REDIS_PORT',{infer:true}),this.config.get('REDIS_PASSWORD',{infer:true}));
    const concurrency=Math.max(1,Number(process.env.WORKER_CONCURRENCY??5));
    const handlers:Partial<Record<QueueName,(job:Job)=>Promise<unknown>>>={
      'mailbox-connect':(job)=>this.routeMailboxJob('mailbox-connect',job,(data)=>this.connectMailbox(data)),
      'folder-discovery':(job)=>this.routeMailboxJob('folder-discovery',job,(data)=>this.discoverFolders(data)),
      'reconciliation':(job)=>this.routeMailboxJob('reconciliation',job,(data)=>this.reconcile(data)),
      'statistics':()=>this.refreshStatistics(),
      'cleanup':()=>this.cleanup(),
    };
    for(const name of QUEUE_NAMES){const handler=handlers[name];if(!handler)continue;this.workers.push(new Worker(name,handler,{connection,concurrency}));}
    this.heartbeat=setInterval(()=>this.metrics.workerHeartbeat.set(Date.now()/1000),10_000);this.metrics.workerHeartbeat.set(Date.now()/1000);
    this.server=createServer(async(req,res)=>{if(req.url==='/metrics'){res.writeHead(200,{'content-type':this.metrics.contentType()});res.end(await this.metrics.metrics());return;}const redis=await this.queues.connection.ping().catch(()=>null);const healthy=this.mongo.readyState===1&&redis==='PONG'&&!this.stopping;res.writeHead(healthy?200:503,{'content-type':'application/json'});res.end(JSON.stringify({status:healthy?'ok':'unhealthy',mongodb:this.mongo.readyState===1,redis:redis==='PONG'}));});
    this.server.listen(this.config.get('WORKER_HEALTH_PORT',{infer:true}),'0.0.0.0');
  }

  private async routeMailboxJob(queueName:'mailbox-connect'|'folder-discovery'|'reconciliation',job:Job,handler:(data:MailboxJobData)=>Promise<unknown>):Promise<unknown>{
    const data=job.data as Partial<MailboxJobData> & {scope?:string};
    if(data.mailboxId)return handler({mailboxId:data.mailboxId});
    const mailboxes=await this.mailboxes.find({syncEnabled:true,status:{$nin:['disabled','paused']}}).select('_id').lean();
    const bucket=Math.floor(Date.now()/60_000);
    await Promise.all(mailboxes.map((mailbox)=>this.queues.get(queueName).add(queueName,{mailboxId:String(mailbox._id)},{jobId:`${queueName}:${mailbox._id}:${bucket}`})));
    return{fannedOut:mailboxes.length};
  }
  private async credentials(mailboxId:string){const mailbox=await this.mailboxes.findById(mailboxId).select('+encryptedCredential').exec();if(!mailbox)throw new Error('Mailbox not found');const password=this.cipher.decrypt(mailbox.encryptedCredential,`mailbox:${mailboxId}`);return{mailbox,password,config:{host:mailbox.imapHost,port:mailbox.imapPort,secure:mailbox.tlsEnabled,servername:mailbox.tlsServername,rejectUnauthorized:mailbox.tlsRejectUnauthorized,username:mailbox.username,password,connectionTimeoutMs:this.config.get('IMAP_CONNECTION_TIMEOUT_SECONDS',{infer:true})*1000}};}
  private async connectMailbox(data:MailboxJobData){const{mailbox,config}=await this.credentials(data.mailboxId);try{await this.mailboxes.updateOne({_id:mailbox._id},{status:'connecting'});await this.imap.testConnection(config);await this.mailboxes.updateOne({_id:mailbox._id},{status:'active',lastConnectionAt:new Date(),$unset:{lastErrorCode:1,lastErrorMessage:1,lastErrorAt:1}});await this.queues.get('folder-discovery').add('discover',{mailboxId:data.mailboxId},{jobId:`discover:${data.mailboxId}:${Date.now()}`});return{connected:true};}catch(error){await this.mailboxes.updateOne({_id:mailbox._id},{status:'connection_failed',lastErrorCode:'IMAP_CONNECTION_FAILED',lastErrorMessage:error instanceof Error?error.message:'Connection failed',lastErrorAt:new Date()});throw error;}}
  private async discoverFolders(data:MailboxJobData){const{mailbox,config}=await this.credentials(data.mailboxId);const discovered=await this.imap.listFolders(config);for(const folder of discovered){await this.folders.updateOne({mailboxId:mailbox._id,path:folder.path},{$set:{name:folder.name,path:folder.path,delimiter:folder.delimiter,specialUse:folder.specialUse,selectable:folder.selectable,subscribed:folder.subscribed,status:'active'},$setOnInsert:{mailboxId:mailbox._id,initialSyncCompleted:false}},{upsert:true});}const sent=detectSentFolder(discovered,mailbox.sentFolderOverride);await this.mailboxes.updateOne({_id:mailbox._id},{detectedSentFolder:sent,totalFolders:discovered.length,lastSuccessfulSyncAt:new Date()});return{folders:discovered.length,sentFolder:sent};}
  private async reconcile(data:MailboxJobData){await this.discoverFolders(data);await this.mailboxes.updateOne({_id:data.mailboxId},{lastReconciliationAt:new Date()});return{reconciled:true};}
  private async refreshStatistics(){const ids=await this.mailboxes.find({}).select('_id').lean();for(const m of ids){const totalFolders=await this.folders.countDocuments({mailboxId:m._id});await this.mailboxes.updateOne({_id:m._id},{totalFolders});}return{mailboxes:ids.length};}
  private async cleanup(){const before=new Date(Date.now()-24*60*60*1000);for(const q of this.queues.queues.values())await q.clean(86_400_000,1000,'completed');return{cleanedBefore:before.toISOString()};}
  async onApplicationShutdown():Promise<void>{this.stopping=true;if(this.heartbeat)clearInterval(this.heartbeat);await Promise.all(this.workers.map(w=>w.close()));await this.queues.close();if(this.server)await new Promise<void>((resolve,reject)=>this.server!.close(e=>e?reject(e):resolve()));}
}

@Module({imports:[ConfigModule.forRoot({isGlobal:true,cache:true,validate:v=>parseConfig(v)}),MongooseModule.forRootAsync({useFactory:()=>({uri:buildMongoUri(parseConfig(process.env)),autoIndex:false,serverSelectionTimeoutMS:10_000})}),MongooseModule.forFeature([{name:Mailbox.name,schema:MailboxSchema},{name:MailFolder.name,schema:MailFolderSchema}])],providers:[WorkerRuntime]})class WorkerModule{}
async function bootstrap(){const app=await NestFactory.createApplicationContext(WorkerModule,{logger:['error','warn','log']});app.enableShutdownHooks();}
void bootstrap();
