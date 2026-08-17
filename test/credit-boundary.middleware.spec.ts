import { EventEmitter } from 'node:events';
import { CreditCatalogService } from '../src/credit.catalog';
import {
  CREDIT_BOUNDARY_STATE,
  CreditBoundaryMiddleware,
} from '../src/credit-boundary.middleware';
import { DEFAULT_CREDIT_OPTIONS } from '../src/credit.constants';

describe('catalog-driven CreditBoundaryMiddleware', () => {
  const options = {
    ...DEFAULT_CREDIT_OPTIONS,
    catalog: {
      serviceId: 'test', version: '1', routes: [
        {
          method: 'POST', path: '/paid/:id', boundary: true,
          charges: [{ id: 'api', creditType: 'API_CREDIT', amount: 10 }],
        },
        { method: 'GET', path: '/free', charges: [] },
      ],
    },
    requestContextResolver: () => ({
      subject: { appId: 'user_123', serviceId: 'test' },
      requestId: 'req_1',
    }),
  };
  const catalog = new CreditCatalogService(options);
  const applied = [{
    charge: catalog.find('POST', '/paid/123')!.charges[0],
    reservation: {
      reservationId: 'res_1', remainingBalance: 90, leaseToken: 'lease_1',
      scopeId: 'scope_1', subject: { appId: 'user_123', serviceId: 'test' },
      expiresAt: Date.now() + 60_000, existing: false, autoRecover: true,
      settlementMode: 'IMMEDIATE' as const,
    },
  }];
  const executor = { reserve: jest.fn(), rollbackAll: jest.fn() };
  const middleware = new CreditBoundaryMiddleware(catalog, executor as any, options);

  beforeEach(() => {
    jest.clearAllMocks();
    executor.reserve.mockResolvedValue(applied);
    executor.rollbackAll.mockResolvedValue(undefined);
  });

  it('rolls back if later middleware ends before the interceptor', async () => {
    const request: any = { method: 'POST', originalUrl: '/paid/123' };
    const response = new EventEmitter();
    await middleware.use(request, response as any, jest.fn());
    response.emit('finish');
    await Promise.resolve();
    expect(executor.rollbackAll).toHaveBeenCalledWith(
      applied, 'response_ended_before_credit_interceptor',
    );
  });

  it('leaves reservations claimed by the interceptor alone', async () => {
    const request: any = { method: 'POST', originalUrl: '/paid/123' };
    const response = new EventEmitter();
    await middleware.use(request, response as any, jest.fn());
    request[CREDIT_BOUNDARY_STATE].claimedByInterceptor = true;
    response.emit('finish');
    await Promise.resolve();
    expect(executor.rollbackAll).not.toHaveBeenCalled();
  });

  it('does not reserve routes without boundary=true', async () => {
    const next = jest.fn();
    await middleware.use(
      { method: 'GET', originalUrl: '/free' },
      new EventEmitter() as any,
      next,
    );
    expect(next).toHaveBeenCalled();
    expect(executor.reserve).not.toHaveBeenCalled();
  });
});
