import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE_NAMES, type QueueName } from '@email-backup/domain';

export const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 10_000 },
  removeOnFail: false,
};

export function createRedisConnection(host: string, port: number, password: string): IORedis {
  return new IORedis({ host, port, password, maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
}

export class QueueRegistry {
  readonly connection: IORedis;
  readonly queues: ReadonlyMap<QueueName, Queue>;
  constructor(host: string, port: number, password: string) {
    this.connection = createRedisConnection(host, port, password);
    this.queues = new Map(QUEUE_NAMES.map((name) => [name, new Queue(name, { connection: this.connection, defaultJobOptions })]));
  }
  get(name: QueueName): Queue { const queue = this.queues.get(name); if (!queue) throw new Error(`Unknown queue ${name}`); return queue; }
  async close(): Promise<void> { await Promise.all([...this.queues.values()].map((q) => q.close())); await this.connection.quit(); }
}
