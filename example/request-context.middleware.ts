import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CreditEnvironment } from '../src';
import { EXAMPLE_SUBJECT } from './credit-demo.config';

interface DemoRequest {
  creditSubject?: typeof EXAMPLE_SUBJECT;
  creditEnvironment?: CreditEnvironment;
  requestId?: string;
  headers?: Record<string, string | string[] | undefined>;
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: DemoRequest, _response: unknown, next: () => void): void {
    // Demo only. A production app must derive this from verified auth context.
    request.creditSubject = EXAMPLE_SUBJECT;
    const environmentHeader = request.headers?.['x-service-environment'];
    const rawEnvironment = Array.isArray(environmentHeader)
      ? environmentHeader[0]
      : environmentHeader;
    const environment = rawEnvironment?.trim().toUpperCase();
    if (environment !== 'PROD' && environment !== 'DEV') {
      throw new UnauthorizedException(
        'x-service-environment must be PROD or DEV',
      );
    }
    request.creditEnvironment = environment;
    const header = request.headers?.['x-request-id'];
    request.requestId = typeof header === 'string' ? header : randomUUID();
    next();
  }
}
