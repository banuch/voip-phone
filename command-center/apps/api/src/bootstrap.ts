import 'reflect-metadata';
import { RequestMethod, ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { correlationMiddleware } from './common/http/request-context';
import { config } from './config';

export async function createApp(opts: { logger?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, logger: opts.logger === false ? false : undefined });
  if (opts.logger !== false) app.useLogger(app.get(Logger));
  const http = app.getHttpAdapter().getInstance();
  http.set('trust proxy', 1); // behind the TLS reverse proxy: req.ip is the client address
  http.disable('x-powered-by');
  app.use(correlationMiddleware);
  app.use(helmet({ contentSecurityPolicy: false })); // API only; the dashboard is served with its own CSP
  app.use(cookieParser());
  app.enableCors({
    origin: config().CORS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: true,
    exposedHeaders: ['X-Correlation-Id'],
  });
  app.setGlobalPrefix('api/v1', { exclude: [{ path: 'metrics', method: RequestMethod.GET }] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();
  return app;
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const doc = new DocumentBuilder()
    .setTitle('Wintek ATM SIP Command Center API')
    .setDescription(
      'Operator-initiated SIP intercom management for ATM fleets. All endpoints except auth/login, auth/refresh, auth/logout and system/live need a Bearer access token; permissions are enforced server-side. Errors use {code, message, details?, correlationId}. Real-time events: WebSocket /ws (see docs/realtime-events.md).',
    )
    .setVersion('1.1.0')
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, doc);
}
