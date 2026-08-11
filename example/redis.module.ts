import {
  Global,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import Redis from 'ioredis';
import { CREDIT_REDIS_CLIENT } from '../src';

export const REDIS_URL = 'REDIS_URL';

@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(CREDIT_REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_URL,
      useValue: process.env.REDIS_URL ?? 'redis://localhost:6379',
    },
    {
      provide: CREDIT_REDIS_CLIENT,
      inject: [REDIS_URL],
      useFactory: async (url: string): Promise<Redis> => {
        const redis = new Redis(url, {
          maxRetriesPerRequest: 2,
        });

        await redis.ping();
        // Make a fresh demo usable while preserving any existing balance.
        await redis.set('credit:balance:user_123', '100', 'NX');
        return redis;
      },
    },
    RedisShutdown,
  ],
  exports: [CREDIT_REDIS_CLIENT],
})
export class RedisModule {}
