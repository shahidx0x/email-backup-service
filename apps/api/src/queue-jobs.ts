import { Controller, Get, Inject, Injectable, Module, NotFoundException, Param, Post, Query } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUE_NAMES, type QueueName } from '@email-backup/domain';
import type { QueueRegistry } from '@email-backup/queue';
import { Roles } from './common';
import { InfrastructureModule, QUEUES } from './infrastructure';

function safeJob(job: Job) {
  return {
    id: job.id,
    name: job.name,
    queueName: job.queueName,
    data: job.data,
    progress: job.progress,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
    timestamp: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
  };
}

@Injectable()
class QueueJobsService {
  constructor(@Inject(QUEUES) private readonly queues: QueueRegistry) {}

  async list(queueName?: string, state = 'failed') {
    const names = queueName && QUEUE_NAMES.includes(queueName as QueueName) ? [queueName as QueueName] : [...QUEUE_NAMES];
    const items: ReturnType<typeof safeJob>[] = [];
    const counts: Record<string, unknown> = {};
    for (const name of names) {
      const queue = this.queues.get(name);
      counts[name] = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'paused');
      const jobs = await queue.getJobs([state as 'failed' | 'waiting' | 'active' | 'delayed' | 'completed'], 0, 99, false);
      items.push(...jobs.map(safeJob));
    }
    return { counts, items: items.slice(0, 500) };
  }

  async get(queueName: string, jobId: string) {
    if (!QUEUE_NAMES.includes(queueName as QueueName)) throw new NotFoundException('Queue not found');
    const job = await this.queues.get(queueName as QueueName).getJob(jobId);
    if (!job) throw new NotFoundException('Job not found');
    return safeJob(job);
  }

  async retry(queueName: string, jobId: string) {
    if (!QUEUE_NAMES.includes(queueName as QueueName)) throw new NotFoundException('Queue not found');
    const job = await this.queues.get(queueName as QueueName).getJob(jobId);
    if (!job) throw new NotFoundException('Job not found');
    await job.retry();
    return { retried: true, queueName, jobId };
  }
}

@Controller('api/jobs')
@Roles('super_admin', 'admin')
class QueueJobsController {
  constructor(private readonly service: QueueJobsService) {}
  @Get() list(@Query('queue') queue?: string, @Query('state') state?: string) { return this.service.list(queue, state); }
  @Get(':queueName/:jobId') get(@Param('queueName') queue: string, @Param('jobId') id: string) { return this.service.get(queue, id); }
  @Post(':queueName/:jobId/retry') retry(@Param('queueName') queue: string, @Param('jobId') id: string) { return this.service.retry(queue, id); }
}

@Module({ imports: [InfrastructureModule], providers: [QueueJobsService], controllers: [QueueJobsController] })
export class QueueJobsModule {}
