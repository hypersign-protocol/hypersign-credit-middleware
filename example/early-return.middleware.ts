import { Injectable, NestMiddleware } from '@nestjs/common';

interface DemoRequest {
  headers?: Record<string, string | string[] | undefined>;
}

interface DemoResponse {
  status(code: number): DemoResponse;
  json(body: unknown): void;
}

/** Simulates application middleware that terminates after credit reservation. */
@Injectable()
export class EarlyReturnMiddleware implements NestMiddleware {
  use(request: DemoRequest, response: DemoResponse, next: () => void): void {
    if (request.headers?.['x-demo-stop-before-controller'] === 'true') {
      response.status(409).json({
        message: 'Stopped by demo middleware before the controller',
      });
      return;
    }
    next();
  }
}
