import { ConflictException, Injectable, NestMiddleware } from '@nestjs/common';

interface DemoRequest {
  headers: Record<string, string | string[] | undefined>;
}

/** Simulates KYC feature middleware that can reject before guards/interceptors. */
@Injectable()
export class MobileFlowValidationMiddleware implements NestMiddleware {
  use(request: DemoRequest, _response: unknown, next: () => void): void {
    if (request.headers['x-reject-mobile-flow'] === 'true') {
      throw new ConflictException('Mobile flow validation rejected the request');
    }
    next();
  }
}
