import { createHash, timingSafeEqual } from 'node:crypto';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { RequestHandler, Response } from 'express';

export class ApiError extends HttpException {
  constructor(status: number, error: string, message: string) {
    super({ error, message }, status);
  }
}

export function invalidRequest(message: string) {
  return new ApiError(400, 'invalid_request', message);
}

export function bearerAuth(token: string): RequestHandler {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expected = digest(token);
  return (request, response, next) => {
    const match = /^Bearer ([^\s,]+)$/i.exec(request.headers.authorization ?? '');
    const valid = timingSafeEqual(digest(match?.[1] ?? ''), expected);
    if (!match || !valid) {
      response.set('WWW-Authenticate', 'Bearer');
      response.status(401).json({ error: 'unauthorized', message: 'A valid bearer token is required.' });
      return;
    }
    next();
  };
}

export function validateUserId(userId: unknown): string {
  if (typeof userId !== 'string' || userId.length < 1 || userId.length > 64 ||
      /[^A-Za-z0-9_-]/.test(userId)) {
    throw invalidRequest('user_id must contain 1 to 64 letters, digits, underscores, or hyphens.');
  }
  return userId;
}

export function parseMutation(body: unknown) {
  if (typeof body !== 'string') throw invalidRequest('Expected a JSON request body.');
  let data: unknown;
  try {
    // JSON.parse otherwise makes 1, 1.0 and 1e0 indistinguishable.
    data = JSON.parse(body, (_key, value: unknown, context?: { source: string }) =>
      typeof value === 'number' && !/^-?[0-9]+$/.test(context?.source ?? '') ? null : value,
    );
  } catch {
    throw invalidRequest('Malformed JSON.');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw invalidRequest('Expected a JSON object.');
  }
  const { user_id, amount } = data as Record<string, unknown>;
  const userId = validateUserId(user_id);
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > 1_000_000_000) {
    throw invalidRequest('amount must be an integer between 1 and 1000000000.');
  }
  return { userId, amount };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof ApiError) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const errors: Record<number, { error: string; message: string }> = {
      400: { error: 'invalid_request', message: 'Invalid request.' },
      404: { error: 'not_found', message: 'Endpoint not found.' },
      500: { error: 'internal_error', message: 'An unexpected error occurred.' },
    };
    const known = errors[status];
    response.status(known ? status : 500).json(known ?? errors[500]);
  }
}
