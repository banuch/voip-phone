import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { isUniqueViolation } from '../db/database.service';

/**
 * Uniform error body: { code, message, details?, correlationId }.
 * Unknown errors become 500 without leaking internals; unique violations
 * that escaped domain handling become 409.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const correlationId = (req as any).correlationId ?? null;
    if (err instanceof HttpException) {
      const status = err.getStatus();
      const body = err.getResponse();
      const obj = typeof body === 'string' ? { message: body } : (body as Record<string, unknown>);
      const code = (obj.code as string) ?? (status === 400 ? 'VALIDATION_FAILED' : status === 429 ? 'RATE_LIMITED' : `HTTP_${status}`);
      const message = Array.isArray(obj.message) ? 'Validation failed' : (obj.message as string) ?? err.message;
      const details = Array.isArray(obj.message) ? { errors: obj.message } : obj.details;
      res.status(status).json({ code, message, ...(details ? { details } : {}), ...(obj.missing ? { missing: obj.missing } : {}), correlationId });
      return;
    }
    if (isUniqueViolation(err)) {
      res.status(409).json({ code: 'CONFLICT', message: 'Conflicts with an existing record', correlationId });
      return;
    }
    this.log.error({ err, correlationId }, 'unhandled error');
    res.status(500).json({ code: 'INTERNAL', message: 'Internal server error', correlationId });
  }
}
