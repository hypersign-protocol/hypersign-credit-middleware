import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CreditBoundaryMiddleware, CreditModule } from '../src';
import {
  CREDIT_BULLMQ_PROVIDER,
  ExampleBullMqModule,
  ExampleBullMqProvider,
} from './bullmq.module';
import { ExampleDemoController } from './demo.controller';
import { EarlyReturnMiddleware } from './early-return.middleware';
import { CREDIT_EVENT_STREAM_REDIS, RedisModule } from './redis.module';
import Redis from 'ioredis';
import { RequestContextMiddleware } from './request-context.middleware';

@Module({
  imports: [
    RedisModule,
    ExampleBullMqModule,
    CreditModule.forRootAsync({
      imports: [RedisModule, ExampleBullMqModule],
      inject: [CREDIT_BULLMQ_PROVIDER, CREDIT_EVENT_STREAM_REDIS],
      useFactory: (bullMq: ExampleBullMqProvider, streamClient: Redis) => ({
        keyPrefix: 'credit-example',
        redisHashTag: 'credit-example',
        leaseMs: 10_000, // Short only so orphan recovery is easy to demonstrate
        retentionMs: 60 * 60 * 1_000,
        criticalBalance: 20,
        bullMq: { provider: bullMq, streamClient },
        requestContextResolver: (request: unknown) => {
          const value = request as {
            creditSubject?: {
              appId: string;
              appType: string;
              creditType: string;
            };
            requestId?: string;
          };
          return {
            subject: value.creditSubject ?? { appId: '' },
            requestId: value.requestId,
          };
        },
      }),
    }),
  ],
  controllers: [ExampleDemoController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        RequestContextMiddleware,    // 1. Authenticate/resolve account first
        CreditBoundaryMiddleware,    // 2. Reserve catalog routes with boundary=true
        EarlyReturnMiddleware,       // 3. May terminate; boundary refunds
      )
      .forRoutes('*');
  }
}
