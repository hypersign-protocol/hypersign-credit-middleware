import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { CreditCatalogService } from '../src/credit.catalog';
import { CREDIT_BOUNDARY_STATE } from '../src/credit-boundary.middleware';
import {
  CREDIT_REQUEST_STATE,
  CreditInterceptor,
} from '../src/credit.interceptor';
import { CreditPolicyExecutor } from '../src/credit-policy.executor';
import { CreditService, InsufficientCreditsException } from '../src/credit.service';
import { DEFAULT_CREDIT_OPTIONS } from '../src/credit.constants';

const options = {
  ...DEFAULT_CREDIT_OPTIONS,
  catalog: {
    serviceId: 'test-service',
    version: '1',
    routes: [
      {
        method: 'POST', path: '/api/jobs',
        charges: [{ id: 'api', creditType: 'API_CREDIT', amount: 20 }],
      },
      {
        method: 'POST', path: '/api/blockchain',
        charges: [
          { id: 'api', creditType: 'API_CREDIT', amount: 5 },
          {
            id: 'txn', creditType: 'BLOCKCHAIN_CREDIT', amount: 25,
            settlementMode: 'DEFERRED' as const, autoRecover: false,
          },
        ],
      },
      { method: 'GET', path: '/api/free', charges: [] },
    ],
  },
};

const subject = { accountId: 'user_123', serviceId: 'test-service' };
const reservation = (id: string, mode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE') => ({
  charge: {
    id: id.includes('deferred') ? 'txn' : 'api',
    creditType: id.includes('deferred') ? 'BLOCKCHAIN_CREDIT' : 'API_CREDIT',
    amount: id.includes('deferred') ? 25 : 20,
    settlementMode: mode,
    autoRecover: mode === 'IMMEDIATE',
  },
  reservation: {
    reservationId: id,
    leaseToken: 'lease',
    scopeId: 'scope',
    remainingBalance: 80,
    expiresAt: Date.now() + 60_000,
    autoRecover: mode === 'IMMEDIATE',
    existing: false,
    settlementMode: mode,
    subject,
  },
});

const httpContext = (request: Record<PropertyKey, unknown>): ExecutionContext => ({
  getType: () => 'http',
  switchToHttp: () => ({ getRequest: () => request }),
} as unknown as ExecutionContext);

describe('catalog-driven CreditInterceptor', () => {
  const credits = { commit: jest.fn() } as unknown as jest.Mocked<CreditService>;
  const executor = {
    reserve: jest.fn(),
    claim: jest.fn(),
    rollbackAll: jest.fn(),
  } as unknown as jest.Mocked<CreditPolicyExecutor>;
  const configured = {
    ...options,
    requestContextResolver: () => ({ subject, requestId: 'request_1' }),
  };
  const catalog = new CreditCatalogService(configured);
  const interceptor = new CreditInterceptor(catalog, executor, credits, configured);

  beforeEach(() => {
    jest.clearAllMocks();
    credits.commit.mockResolvedValue(true);
    executor.rollbackAll.mockResolvedValue();
  });

  it('reserves from the catalog and commits an immediate charge', async () => {
    const request: Record<PropertyKey, unknown> = {
      method: 'POST', originalUrl: '/api/jobs?trace=1',
    };
    executor.reserve.mockResolvedValue([reservation('res_1')]);

    await expect(lastValueFrom(interceptor.intercept(
      httpContext(request),
      { handle: () => of({ ok: true }) } as CallHandler,
    ))).resolves.toEqual({ ok: true });

    expect(executor.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/jobs', operation: 'POST /api/jobs' }),
      { subject, requestId: 'request_1' },
    );
    expect(credits.commit).toHaveBeenCalledWith('res_1');
    expect(request[CREDIT_REQUEST_STATE]).toBeDefined();
  });

  it('runs an explicitly free catalog route without resolving credit context', async () => {
    await expect(lastValueFrom(interceptor.intercept(
      httpContext({ method: 'GET', originalUrl: '/api/free' }),
      { handle: () => of('free') } as CallHandler,
    ))).resolves.toBe('free');
    expect(executor.reserve).not.toHaveBeenCalled();
  });

  it('rejects a runtime route that is absent from the catalog', () => {
    expect(() => interceptor.intercept(
      httpContext({ method: 'POST', originalUrl: '/api/unknown' }),
      { handle: () => of('never') } as CallHandler,
    )).toThrow('Credit catalog mismatch');
  });

  it('commits immediate charges and leaves deferred charges reserved', async () => {
    executor.reserve.mockResolvedValue([
      reservation('res_api'),
      reservation('res_deferred', 'DEFERRED'),
    ]);

    await lastValueFrom(interceptor.intercept(
      httpContext({ method: 'POST', originalUrl: '/api/blockchain' }),
      { handle: () => of('accepted') } as CallHandler,
    ));

    expect(credits.commit).toHaveBeenCalledTimes(1);
    expect(credits.commit).toHaveBeenCalledWith('res_api');
  });

  it('does not execute the controller and preserves a reserve failure', async () => {
    executor.reserve.mockRejectedValue(new InsufficientCreditsException());
    const next = { handle: jest.fn(() => of('never')) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(
      httpContext({ method: 'POST', originalUrl: '/api/jobs' }),
      next,
    ))).rejects.toBeInstanceOf(InsufficientCreditsException);
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('rolls back every reservation when the controller fails', async () => {
    const applied = [reservation('res_1')];
    const failure = new Error('controller failed');
    executor.reserve.mockResolvedValue(applied);

    await expect(lastValueFrom(interceptor.intercept(
      httpContext({ method: 'POST', originalUrl: '/api/jobs' }),
      { handle: () => throwError(() => failure) } as CallHandler,
    ))).rejects.toBe(failure);
    expect(executor.rollbackAll).toHaveBeenCalledWith(applied, 'controller failed');
  });

  it('claims catalog reservations made by the early boundary', async () => {
    const applied = [reservation('res_boundary')];
    const route = catalog.find('POST', '/api/jobs')!;
    const boundary = {
      route,
      reservations: applied,
      claimedByInterceptor: false,
      finalized: false,
    };
    executor.claim.mockResolvedValue(applied);
    const request = {
      method: 'POST', originalUrl: '/api/jobs',
      [CREDIT_BOUNDARY_STATE]: boundary,
    };

    await lastValueFrom(interceptor.intercept(
      httpContext(request),
      { handle: () => of('ok') } as CallHandler,
    ));

    expect(executor.reserve).not.toHaveBeenCalled();
    expect(executor.claim).toHaveBeenCalled();
    expect(boundary.claimedByInterceptor).toBe(true);
    expect(boundary.finalized).toBe(true);
  });
});
