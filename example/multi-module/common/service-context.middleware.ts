import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CreditEnvironment } from '../../../src';

interface ServiceRequest {
  headers: Record<string, string | string[] | undefined>;
  service?: {
    businessId: string;
    tenantId: string;
    environment: CreditEnvironment;
  };
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
    const appId = Array.isArray(accountHeader) ? accountHeader[0] : accountHeader;
    if (!appId) {
      throw new UnauthorizedException('x-business-id is required');
    }
    const environmentHeader = request.headers['x-service-environment'];
    const rawEnvironment = Array.isArray(environmentHeader)
      ? environmentHeader[0]
      : environmentHeader;
    const environment = rawEnvironment?.trim().toUpperCase();
    if (environment !== 'PROD' && environment !== 'DEV') {
      throw new UnauthorizedException(
        'x-service-environment must be PROD or DEV',
      );
    }

    const requestIdHeader = request.headers['x-request-id'];
    request.requestId =
      (Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader) ??
      randomUUID();
    request.service = {
      businessId: appId,
      tenantId: 'tenant_1',
      environment,
    };
    next();
  }
}
