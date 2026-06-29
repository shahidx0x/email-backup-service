import { Controller, Get, Header, Inject, Injectable, Module, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type { AppConfig } from '@email-backup/config';
import { PlatformMetrics } from '@email-backup/metrics';
import { QueueRegistry } from '@email-backup/queue';
import { Public } from './common';

export const METRICS = Symbol('METRICS');
export const QUEUES = Symbol('QUEUES');

@Injectable()
export class InfrastructureLifecycle implements OnApplicationShutdown {
  constructor(@Inject(QUEUES) private readonly queues: QueueRegistry) {}
  async onApplicationShutdown(): Promise<void> { await this.queues.close(); }
}

@Controller()
export class InfrastructureController {
  constructor(@InjectConnection() private readonly mongo: Connection, @Inject(QUEUES) private readonly queues: QueueRegistry, @Inject(METRICS) private readonly metrics: PlatformMetrics) {}
  @Public() @Get('health') health() { return { status: 'ok', service: 'api', timestamp: new Date().toISOString() }; }
  @Public() @Get('ready') async ready() {
    const mongoReady = this.mongo.readyState === 1;
    let redisReady = false;
    try { redisReady = (await this.queues.connection.ping()) === 'PONG'; } catch { redisReady = false; }
    this.metrics.mongodbStatus.set(mongoReady ? 1 : 0); this.metrics.redisStatus.set(redisReady ? 1 : 0);
    if (!mongoReady || !redisReady) throw new ServiceUnavailableException({ code: 'NOT_READY', message: 'Dependencies are not ready', mongodb: mongoReady, redis: redisReady });
    return { status: 'ready', mongodb: true, redis: true };
  }
  @Public() @Get('metrics') @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8') metricsText() { return this.metrics.metrics(); }
}

@Module({
  controllers: [InfrastructureController],
  providers: [
    { provide: METRICS, useFactory: () => new PlatformMetrics() },
    { provide: QUEUES, inject: [ConfigService], useFactory: (c: ConfigService<AppConfig, true>) => new QueueRegistry(c.get('REDIS_HOST', { infer: true }), c.get('REDIS_PORT', { infer: true }), c.get('REDIS_PASSWORD', { infer: true })) },
    InfrastructureLifecycle,
  ],
  exports: [METRICS, QUEUES],
})
export class InfrastructureModule {}
