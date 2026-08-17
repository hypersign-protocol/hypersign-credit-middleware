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
export const CREDIT_EVENT_STREAM_REDIS = Symbol('CREDIT_EVENT_STREAM_REDIS');

@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(CREDIT_REDIS_CLIENT) private readonly redis: Redis,
    @Inject(CREDIT_EVENT_STREAM_REDIS) private readonly streamRedis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
    await this.streamRedis.quit();
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
        return redis;
      },
    },
    {
      provide: CREDIT_EVENT_STREAM_REDIS,
      inject: [REDIS_URL],
      useFactory: async (url: string): Promise<Redis> => {
        const redis = new Redis(url, { maxRetriesPerRequest: null });
        await redis.ping();
        return redis;
      },
    },
    RedisShutdown,
  ],
  exports: [CREDIT_REDIS_CLIENT, CREDIT_EVENT_STREAM_REDIS, REDIS_URL],
})
export class RedisModule {}
