import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

interface ServiceRequest {
  headers: Record<string, string | string[] | undefined>;
  service?: { businessId: string; tenantId: string };
  requestId?: string;
}

/**
 * Demo replacement for authentication. A production service must verify its
 * token/session here before trusting and attaching the billing account.
 */
@Injectable()
export class ServiceContextMiddleware implements NestMiddleware {
  use(request: ServiceRequest, _response: unknown, next: () => void): void {
    const accountHeader = request.headers['x-business-id'];
    const accountId = Array.isArray(accountHeader) ? accountHeader[0] : accountHeader;
    if (!accountId) {
      throw new UnauthorizedException('x-business-id is required');
    }

    const requestIdHeader = request.headers['x-request-id'];
    request.requestId =
      (Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader) ??
      randomUUID();
    request.service = { businessId: accountId, tenantId: 'tenant_1' };
    next();
  }
}
