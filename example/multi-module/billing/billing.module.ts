import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { CreditModule } from '../../../src';
import {
  CREDIT_BULLMQ_PROVIDER,
  ExampleBullMqModule,
  ExampleBullMqProvider,
} from '../../bullmq.module';
import { CREDIT_EVENT_STREAM_REDIS, RedisModule } from '../../redis.module';

interface ServiceRequest {
  service?: { businessId?: string; tenantId?: string };
  requestId?: string;
}

@Global()
@Module({
  imports: [
    RedisModule,
    ExampleBullMqModule,
    CreditModule.forRootAsync({
      imports: [RedisModule, ExampleBullMqModule],
      inject: [CREDIT_BULLMQ_PROVIDER, CREDIT_EVENT_STREAM_REDIS],
      useFactory: (bullMq: ExampleBullMqProvider, streamClient: Redis) => ({
        keyPrefix: 'credit-multi',
        redisHashTag: 'credit-multi',
        leaseMs: 30_000,
        criticalBalance: 20,
        bullMq: { provider: bullMq, streamClient },
        requestContextResolver: (unknownRequest: unknown) => {
          const request = unknownRequest as ServiceRequest;
          return {
            subject: {
              tenantId: request.service?.tenantId,
              appType: 'BUSINESS',
              appId: request.service?.businessId ?? '',
            },
            requestId: request.requestId,
          };
        },
      }),
    }),
  ],
  exports: [CreditModule],
})
export class BillingModule {}
