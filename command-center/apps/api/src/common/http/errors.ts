import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';

/** Domain error with a stable machine-readable code for the dashboard. */
export class DomainError extends HttpException {
  constructor(status: HttpStatus, code: string, message: string, details?: Record<string, unknown>) {
    super({ code, message, ...(details ? { details } : {}) }, status);
  }
}

export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new ConflictException({ code, message, ...(details ? { details } : {}) });

export const notFound = (what: string) => new DomainError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`);
