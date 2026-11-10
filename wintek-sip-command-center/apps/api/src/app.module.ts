import { Module, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { JwtAuthGuard, PermissionsGuard } from './common/auth/guards';
import { DatabaseModule } from './common/db/database.module';
import { AllExceptionsFilter } from './common/http/exception.filter';
import { LOG_REDACT_PATHS } from './common/http/redact';
import { RedisModule } from './common/redis/redis.module';
import { config } from './config';
import { AdminModule } from './modules/admin/admin.module';
import { AssignmentsModule } from './modules/assignments/assignments.module';
import { AtmsModule } from './modules/atms/atms.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CallsModule } from './modules/calls/calls.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { OperatorsModule } from './modules/operators/operators.module';
import { QueueModule } from './modules/queue/queue.module';
import { EventBusModule, RealtimeModule } from './modules/realtime/realtime.module';
import { ShiftsModule } from './modules/shifts/shifts.module';
import { SystemModule } from './modules/system/system.module';

@Module({
  imports: [
    LoggerModule.forRoot({
      forRoutes: [{ path: '{*path}', method: RequestMethod.ALL }],
      pinoHttp: {
        level: config().LOG_LEVEL,
        redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
        genReqId: (req: any) => req.correlationId ?? randomUUID(),
        customProps: (req: any) => ({ correlationId: req.correlationId, node: config().NODE_ID }),
        autoLogging: { ignore: (req) => req.url === '/metrics' || req.url?.startsWith('/api/v1/system/live') === true },
        transport: config().NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
      },
    }),
    JwtModule.register({ global: true, secret: config().JWT_SECRET, signOptions: { algorithm: 'HS256', issuer: 'wintek-sip-cc' }, verifyOptions: { issuer: 'wintek-sip-cc' } }),
    ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 600 }], skipIf: () => config().NODE_ENV === 'test' }),
    DatabaseModule,
    RedisModule,
    EventBusModule,
    AuditModule,
    AuthModule,
    AtmsModule,
    OperatorsModule,
    AssignmentsModule,
    ShiftsModule,
    QueueModule,
    CallsModule,
    DashboardModule,
    AdminModule,
    RealtimeModule,
    SystemModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
