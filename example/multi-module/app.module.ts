import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CreditBoundaryMiddleware } from '../../src';
import { BillingModule } from './billing/billing.module';
import { ServiceContextMiddleware } from './common/service-context.middleware';
import { MobileFlowModule } from './mobile-flow/mobile-flow.module';
import { OperationsModule } from './operations/operations.module';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [BillingModule, MobileFlowModule, ReportsModule, OperationsModule],
  providers: [ServiceContextMiddleware],
})
export class MultiModuleAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        ServiceContextMiddleware, // 1. verify token and attach request.service
        CreditBoundaryMiddleware, // 2. reserve configured early routes
      )
      .forRoutes('*');
  }
}
