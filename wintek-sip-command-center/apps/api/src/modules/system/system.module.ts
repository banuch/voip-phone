import { Controller, Get, Header, Inject, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { collectDefaultMetrics, register } from 'prom-client';
import { Permission } from '@wintek/shared';
import { Public, RequirePermissions } from '../../common/auth/decorators';
import { DatabaseService } from '../../common/db/database.service';
import { RedisService } from '../../common/redis/redis.service';
import { config } from '../../config';
import { AtmsModule } from '../atms/atms.module';
import { CallsModule } from '../calls/calls.module';
import { SIP_DRIVER, type SipDriver } from '../calls/sip/sip-driver';
import { OperatorsModule } from '../operators/operators.module';
import { QueueModule } from '../queue/queue.module';
import { EventsGateway } from '../realtime/events.gateway';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkersService } from './workers.service';

collectDefaultMetrics({ prefix: 'wintek_' });

type ComponentStatus = 'up' | 'degraded' | 'down';

@ApiTags('system')
@Controller()
export class SystemController {
  private readonly started = Date.now();

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly workers: WorkersService,
    private readonly gateway: EventsGateway,
    @Inject(SIP_DRIVER) private readonly driver: SipDriver,
  ) {}

  /** Liveness/readiness for load balancers: 200 only when the database answers. */
  @Public()
  @SkipThrottle()
  @Get('system/live')
  @ApiOperation({ summary: 'Readiness probe (no details)' })
  async live() {
    await this.db.ping();
    return { status: 'ok' };
  }

  @Get('system/health')
  @ApiBearerAuth()
  @RequirePermissions(Permission.SYSTEM_READ)
  @ApiOperation({ summary: 'Component health: database, Redis, media node, WebSocket, background jobs' })
  async health() {
    const timed = async <T>(fn: () => Promise<T>) => {
      try {
        return { ok: true as const, value: await fn() };
      } catch (e: any) {
        return { ok: false as const, error: e.message as string };
      }
    };
    const [db, redis, media] = await Promise.all([timed(() => this.db.ping()), timed(() => this.redis.ping()), this.driver.health()]);
    const components: { name: string; status: ComponentStatus; detail: string; latencyMs: number | null }[] = [
      { name: 'database', status: db.ok ? 'up' : 'down', detail: db.ok ? 'PostgreSQL' : db.error, latencyMs: db.ok ? db.value : null },
      {
        name: 'redis',
        status: !this.redis.enabled ? 'degraded' : redis.ok ? 'up' : 'down',
        detail: !this.redis.enabled ? 'disabled (single node mode)' : redis.ok ? 'Redis' : redis.error,
        latencyMs: redis.ok ? (redis.value ?? null) : null,
      },
      { name: `media:${media.node}`, status: media.connected ? 'up' : 'down', detail: media.detail, latencyMs: media.latencyMs },
      { name: 'websocket', status: 'up', detail: `${this.gateway.connectionCount} connection(s) on this node`, latencyMs: null },
    ];
    const jobs = [...this.workers.status.values()];
    const failingJobs = jobs.filter((j) => j.lastError);
    if (failingJobs.length) components.push({ name: 'workers', status: 'degraded', detail: failingJobs.map((j) => `${j.name}: ${j.lastError}`).join('; '), latencyMs: null });
    const overall: ComponentStatus = components.some((c) => c.status === 'down' && (c.name === 'database' || c.name.startsWith('media')))
      ? 'down'
      : components.some((c) => c.status !== 'up')
        ? 'degraded'
        : 'up';
    return {
      status: overall,
      node: config().NODE_ID,
      version: process.env.npm_package_version ?? '1.1.0',
      sipDriver: this.driver.name,
      uptimeSec: Math.round((Date.now() - this.started) / 1000),
      components,
      jobs,
      checkedAt: new Date().toISOString(),
    };
  }

  /** Prometheus scrape endpoint. Block it at the reverse proxy; scrape over the internal network. */
  @Public()
  @SkipThrottle()
  @Get('metrics')
  @ApiExcludeEndpoint()
  @Header('Content-Type', register.contentType)
  metrics() {
    return register.metrics();
  }
}

@Module({
  imports: [CallsModule, OperatorsModule, AtmsModule, QueueModule, RealtimeModule],
  providers: [WorkersService],
  controllers: [SystemController],
})
export class SystemModule {}
