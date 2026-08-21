import { Global, Module } from '@nestjs/common';
import { CreditEnvironment, CreditModule } from '../../../src';
import { RedisModule } from '../../redis.module';

interface ServiceRequest {
  service?: {
    businessId?: string;
    tenantId?: string;
    environment?: CreditEnvironment;
  };
  requestId?: string;
}

@Global()
@Module({
  imports: [
    RedisModule,
    CreditModule.forRootAsync({
      imports: [RedisModule],
      useFactory: () => ({
        keyPrefix: 'credit-multi',
        redisHashTag: 'credit-multi',
        requestContextResolver: (unknownRequest: unknown) => {
          const request = unknownRequest as ServiceRequest;
          return {
            subject: {
              tenantId: request.service?.tenantId,
              appType: 'BUSINESS',
              appId: request.service?.businessId ?? '',
            },
            requestId: request.requestId,
            environment: request.service?.environment as CreditEnvironment,
          };
        },
      }),
    }),
  ],
  exports: [CreditModule],
})
export class BillingModule {}
