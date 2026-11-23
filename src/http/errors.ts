import type { FastifyError, FastifyInstance } from 'fastify';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const body = (code: string, message: string, details: Record<string, unknown> = {}) => ({ error: { code, message, details } });

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send(body(err.code, err.message, err.details));
    const status = (err as FastifyError).statusCode;
    if (status !== undefined && status >= 400 && status <= 499) return reply.code(status).send(body('INVALID_REQUEST', err.message));
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(body('INTERNAL', 'Internal error'));
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(body('NOT_FOUND', 'Route not found. Contract 7.0.0 has only reads: see docs/contract/README.md')));
}
