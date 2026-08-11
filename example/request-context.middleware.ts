import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

interface DemoRequest {
  user?: { id: string };
  requestId?: string;
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: DemoRequest, _response: unknown, next: () => void): void {
    request.user = { id: 'user_123' };
    request.requestId = randomUUID();
    next();
  }
}
