import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import { CreditCost } from '../src/credit.decorator';
import { CreditInterceptor } from '../src/credit.interceptor';
import { CreditService, InsufficientCreditsException } from '../src/credit.service';

class TestController {
  @CreditCost(20)
  endpoint() {}
}

const context = {
  getHandler: () => TestController.prototype.endpoint,
  getClass: () => TestController,
  switchToHttp: () => ({
    getRequest: () => ({ user: { id: 'user_123' }, requestId: 'req_123' }),
  }),
} as unknown as ExecutionContext;

describe('CreditInterceptor', () => {
  const service = {
    reserve: jest.fn(),
    commit: jest.fn(),
    rollback: jest.fn(),
  } as unknown as jest.Mocked<CreditService>;
  const interceptor = new CreditInterceptor(new Reflector(), service);

  beforeEach(() => jest.clearAllMocks());

  it('commits after a successful controller response', async () => {
    service.reserve.mockResolvedValue({
      reservationId: 'res_1', remainingBalance: 80, expiresAt: Date.now() + 60_000,
      existing: false,
    });
    service.commit.mockResolvedValue(true);
    const next = { handle: jest.fn(() => of({ success: true })) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(context, next)))
      .resolves.toEqual({ success: true });
    expect(service.reserve).toHaveBeenCalledWith({
      accountId: 'user_123', requestId: 'req_123', serviceId: 'endpoint', amount: 20,
    });
    expect(service.commit).toHaveBeenCalledWith('res_1');
    expect(service.rollback).not.toHaveBeenCalled();
  });

  it('rolls back and preserves the original controller error', async () => {
    const controllerError = new Error('Demo failure');
    service.reserve.mockResolvedValue({
      reservationId: 'res_1', remainingBalance: 80, expiresAt: Date.now() + 60_000,
      existing: false,
    });
    service.rollback.mockResolvedValue(true);
    const next = {
      handle: jest.fn(() => throwError(() => controllerError)),
    } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(context, next)))
      .rejects.toBe(controllerError);
    expect(service.rollback).toHaveBeenCalledWith('res_1');
    expect(service.commit).not.toHaveBeenCalled();
  });

  it('does not execute the controller when reserve fails', async () => {
    service.reserve.mockRejectedValue(new InsufficientCreditsException());
    const next = { handle: jest.fn(() => of('never')) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(context, next)))
      .rejects.toBeInstanceOf(InsufficientCreditsException);
    expect(next.handle).not.toHaveBeenCalled();
  });
});
