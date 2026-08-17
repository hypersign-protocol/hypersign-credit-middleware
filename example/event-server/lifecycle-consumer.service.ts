import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { CREDIT_EVENT_NAMES, CreditBullMqWorker } from '../../src';
import { ExampleBullMqProvider } from '../bullmq.module';
import { CreditEventStore } from './event-store.service';

@Injectable()
export class CreditLifecycleConsumer
implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CreditLifecycleConsumer.name);
  private worker?: CreditBullMqWorker;

  constructor(
    private readonly bullMq: ExampleBullMqProvider,
    private readonly store: CreditEventStore,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.worker = await this.bullMq.createWorker('credit.lifecycle', async (job) => {
      this.store.append(job);
      switch (job.name) {
        case CREDIT_EVENT_NAMES.RESERVED:
          this.logger.log(`Credit reserved: ${JSON.stringify(job.data)}`);
          break;
        case CREDIT_EVENT_NAMES.COMMITTED:
          this.logger.warn(`Credit committed: ${JSON.stringify(job.data)}`);
          break;
        case CREDIT_EVENT_NAMES.ROLLED_BACK:
          this.logger.log(`Credit rolled back: ${JSON.stringify(job.data)}`);
          break;
        case CREDIT_EVENT_NAMES.EXPIRED:
          this.logger.log(`Credit expired: ${JSON.stringify(job.data)}`);
          break;
        case CREDIT_EVENT_NAMES.CREDIT_GRANTED:
          this.logger.log(`Credit granted: ${JSON.stringify(job.data)}`);
          break;
        case CREDIT_EVENT_NAMES.CRITICAL_BALANCE:
          this.logger.log(`Critical balance reached: ${JSON.stringify(job.data)}`);
          break;
        case CREDIT_EVENT_NAMES.BALANCE_INITIALIZED:
          this.logger.log(`Balance initialized: ${JSON.stringify(job.data)}`);
          break;
      }
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
