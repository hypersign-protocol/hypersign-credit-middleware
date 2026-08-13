import { Global, Module } from '@nestjs/common';
import { CreditModule } from '../../../src';
import { RedisModule } from '../../redis.module';
import { EARLY_CREDIT_POLICIES } from './credit-policies';
import {
  MultiCreditEventHandler,
  multiBalanceProvider,
} from './multi-balance.provider';

interface ServiceRequest {
  service?: { businessId?: string; tenantId?: string };
  requestId?: string;
}

/**
 * Infrastructure module imported exactly once by the root application module.
 * Feature modules do not call CreditModule.forRoot() again.
 */
@Global()
@Module({
  imports: [
    RedisModule,
    CreditModule.forRoot({
      leaseMs: 30_000,
      criticalBalance: 20,
      balanceProvider: multiBalanceProvider,
      eventHandler: new MultiCreditEventHandler(),
      earlyPolicies: EARLY_CREDIT_POLICIES,
      requestContextResolver: (unknownRequest: unknown) => {
        const request = unknownRequest as ServiceRequest;
        return {
          subject: {
            tenantId: request.service?.tenantId,
            accountType: 'BUSINESS',
            accountId: request.service?.businessId ?? '',
            serviceId: 'kyc',
            creditType: 'API_CREDIT',
          },
          requestId: request.requestId,
        };
      },
    }),
  ],
  exports: [CreditModule],
})
export class BillingModule {}
