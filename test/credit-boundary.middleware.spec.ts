import { EventEmitter } from 'node:events';
import { ConflictException } from '@nestjs/common';
import {
  CREDIT_BOUNDARY_STATE,
  CreditBoundaryMiddleware,
} from '../src/credit-boundary.middleware';
import { DEFAULT_CREDIT_OPTIONS } from '../src/credit.constants';

describe('CreditBoundaryMiddleware', () => {
  const credits = { reserve: jest.fn(), rollback: jest.fn() };
  const middleware = new CreditBoundaryMiddleware(credits as any, {
    ...DEFAULT_CREDIT_OPTIONS,
    earlyPolicies: [{
      method: 'POST', path: '/paid/:id', amount: 10,
      settlementMode: 'IMMEDIATE', operation: 'PAID',
    }],
  });

  beforeEach(() => {
    jest.clearAllMocks();
    credits.reserve.mockResolvedValue({
      reservationId: 'res_1', remainingBalance: 90,
      leaseToken: 'lease_1', scopeId: 'scope_1', subject: { accountId: 'user_123' },
      expiresAt: Date.now() + 60_000, existing: false,
      autoRecover: true,
      settlementMode: 'IMMEDIATE',
    });
    credits.rollback.mockResolvedValue(true);
  });

  it('rolls back if later middleware ends before the interceptor', async () => {
    const request: any = {
      method: 'POST', originalUrl: '/paid/123',
      user: { id: 'user_123' }, requestId: 'req_1',
    };
    const response = new EventEmitter();
    await middleware.use(request, response as any, jest.fn());
    response.emit('finish');
    await Promise.resolve();
    expect(credits.rollback).toHaveBeenCalledWith(
      'res_1', 'response_ended_before_credit_interceptor',
    );
  });

  it('leaves a reservation claimed by the interceptor alone', async () => {
    const request: any = {
      method: 'POST', originalUrl: '/paid/123',
      user: { id: 'user_123' }, requestId: 'req_1',
    };
    const response = new EventEmitter();
    await middleware.use(request, response as any, jest.fn());
    request[CREDIT_BOUNDARY_STATE].claimedByInterceptor = true;
    response.emit('finish');
    await Promise.resolve();
    expect(credits.rollback).not.toHaveBeenCalled();
  });

  it('rejects a duplicate request before later middleware executes', async () => {
    credits.reserve.mockResolvedValue({
      reservationId: 'res_existing', remainingBalance: 90,
      leaseToken: 'lease_existing', scopeId: 'scope_1',
      subject: { accountId: 'user_123' },
      expiresAt: Date.now() + 60_000, autoRecover: true,
      existing: true, settlementMode: 'IMMEDIATE',
    });
    const next = jest.fn();

    await expect(middleware.use({
      method: 'POST', originalUrl: '/paid/123',
      user: { id: 'user_123' }, requestId: 'req_1',
    } as any, new EventEmitter() as any, next))
      .rejects.toBeInstanceOf(ConflictException);

    expect(next).not.toHaveBeenCalled();
    expect(credits.rollback).not.toHaveBeenCalled();
  });
});
