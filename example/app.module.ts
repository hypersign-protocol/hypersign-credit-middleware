import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { CreditModule } from "../src";
import { ExampleDemoController } from "./demo.controller";
import { RedisModule } from "./redis.module";
import { RequestContextMiddleware } from "./request-context.middleware";
import { ScheduleModule } from "@nestjs/schedule";

@Module({
  imports: [
    RedisModule,
    CreditModule.forRoot({
      leaseMs: 10_000,
      retentionMs: 60 * 60 * 1_000,
    }),
    ScheduleModule.forRoot(),
  ],
  controllers: [ExampleDemoController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes("*");
  }
}
