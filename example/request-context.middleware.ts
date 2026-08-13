import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EXAMPLE_SUBJECT } from './credit-demo.config';

interface DemoRequest {
  creditSubject?: typeof EXAMPLE_SUBJECT;
  requestId?: string;
  headers?: Record<string, string | string[] | undefined>;
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: DemoRequest, _response: unknown, next: () => void): void {
    // Demo only. A production app must derive this from verified auth context.
    request.creditSubject = EXAMPLE_SUBJECT;
    const header = request.headers?.['x-request-id'];
    request.requestId = typeof header === 'string' ? header : randomUUID();
    next();
  }
}
