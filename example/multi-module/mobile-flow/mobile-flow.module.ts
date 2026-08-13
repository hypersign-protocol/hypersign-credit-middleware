import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { MobileFlowController } from './mobile-flow.controller';
import { MobileFlowValidationMiddleware } from './mobile-flow-validation.middleware';

@Module({
  controllers: [MobileFlowController],
  providers: [MobileFlowValidationMiddleware],
})
export class MobileFlowModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Root middleware has already authenticated and reserved credits.
    consumer.apply(MobileFlowValidationMiddleware).forRoutes(MobileFlowController);
  }
}
