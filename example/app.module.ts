import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CreditBoundaryMiddleware, CreditModule } from '../src';
import {
  CHEAP_CREDIT_POLICY,
  ExampleCreditEventHandler,
  exampleBalanceProvider,
} from './credit-demo.config';
import { ExampleDemoController } from './demo.controller';
import { EarlyReturnMiddleware } from './early-return.middleware';
import { RedisModule } from './redis.module';
import { RequestContextMiddleware } from './request-context.middleware';

@Module({
  imports: [
    RedisModule,
    CreditModule.forRoot({
      leaseMs: 10_000, // Short only so orphan recovery is easy to demonstrate
      retentionMs: 60 * 60 * 1_000,
      criticalBalance: 20,
      balanceProvider: exampleBalanceProvider,
      eventHandler: new ExampleCreditEventHandler(),
      requestContextResolver: (request: unknown) => {
        const value = request as {
          creditSubject?: {
            accountId: string;
            accountType: string;
            serviceId: string;
            creditType: string;
          };
          requestId?: string;
        };
        return {
          subject: value.creditSubject ?? { accountId: '' },
          requestId: value.requestId,
        };
      },

      // Middleware cannot read controller decorator metadata. Reuse the same
      // policy constant here so amount/mode/operation cannot drift.
      earlyPolicies: [{
        method: 'POST',
        path: '/demo/cheap',
        ...CHEAP_CREDIT_POLICY,
      }],
    }),
  ],
  controllers: [ExampleDemoController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        RequestContextMiddleware,    // 1. Authenticate/resolve account first
        CreditBoundaryMiddleware,    // 2. Atomically reserve paid routes
        EarlyReturnMiddleware,       // 3. May terminate; boundary refunds
      )
      .forRoutes('*');
  }
}
