import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

interface Ctx {
  correlationId: string;
}
const als = new AsyncLocalStorage<Ctx>();

export const correlationId = () => als.getStore()?.correlationId ?? null;

const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Accepts an inbound X-Correlation-Id (if well-formed) or creates one, and echoes it. */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction) {
  const inbound = req.header('x-correlation-id');
  const id = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
  (req as any).correlationId = id;
  res.setHeader('X-Correlation-Id', id);
  als.run({ correlationId: id }, next);
}

export const runWithCorrelation = <T>(id: string, fn: () => T) => als.run({ correlationId: id }, fn);
