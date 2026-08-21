import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import {
  CreditBoundaryMiddleware,
  CreditEnvironment,
  CreditModule,
} from '../src';
import { ExampleDemoController } from './demo.controller';
import { EarlyReturnMiddleware } from './early-return.middleware';
import { RedisModule } from './redis.module';
import { CreditRecoveryScheduler } from './recovery.scheduler';
import { RequestContextMiddleware } from './request-context.middleware';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    RedisModule,
    CreditModule.forRootAsync({
      imports: [RedisModule],
      useFactory: () => ({
        keyPrefix: 'credit-example',
        redisHashTag: 'credit-example',
        requestContextResolver: (request: unknown) => {
          const value = request as {
            creditSubject?: {
              appId: string;
              appType: string;
              creditType: string;
            };
            requestId?: string;
            creditEnvironment?: CreditEnvironment;
          };
          return {
            subject: value.creditSubject ?? { appId: '' },
            requestId: value.requestId,
            environment: value.creditEnvironment as CreditEnvironment,
          };
        },
      }),
    }),
  ],
  controllers: [ExampleDemoController],
  providers: [CreditRecoveryScheduler],
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
