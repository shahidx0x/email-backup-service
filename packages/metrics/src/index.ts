import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
export class PlatformMetrics {
  readonly registry = new Registry();
  readonly httpRequests = new Counter({ name: 'http_requests_total', help: 'HTTP requests', labelNames: ['method','path','status'], registers: [this.registry] });
  readonly workerHeartbeat = new Gauge({ name: 'worker_heartbeat_timestamp', help: 'Unix timestamp of the latest worker heartbeat', registers: [this.registry] });
  readonly schedulerHeartbeat = new Gauge({ name: 'scheduler_heartbeat_timestamp', help: 'Unix timestamp of the latest scheduler heartbeat', registers: [this.registry] });
  readonly mongodbStatus = new Gauge({ name: 'mongodb_connection_status', help: 'MongoDB connection status', registers: [this.registry] });
  readonly redisStatus = new Gauge({ name: 'redis_connection_status', help: 'Redis connection status', registers: [this.registry] });
  readonly queueWaiting = new Gauge({ name: 'queue_waiting_jobs', help: 'Waiting jobs', labelNames: ['queue'], registers: [this.registry] });
  readonly queueActive = new Gauge({ name: 'queue_active_jobs', help: 'Active jobs', labelNames: ['queue'], registers: [this.registry] });
  readonly queueFailed = new Gauge({ name: 'queue_failed_jobs', help: 'Failed jobs', labelNames: ['queue'], registers: [this.registry] });
  constructor(prefix = '') { collectDefaultMetrics({ register: this.registry, prefix }); }
  contentType(): string { return this.registry.contentType; }
  metrics(): Promise<string> { return this.registry.metrics(); }
}
