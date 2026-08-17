import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { CreditBullMqWorker } from '../../src';
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


  // RESERVED: 'credit.reserved',
  // COMMITTED: 'credit.committed',
  // ROLLED_BACK: 'credit.rolled-back',
  // EXPIRED: 'credit.expired',
  // CREDIT_GRANTED: 'credit.granted',
  // CRITICAL_BALANCE: 'credit.critical-balance',
  // BALANCE_INITIALIZED: 'credit.balance-initialized',  
  async onApplicationBootstrap(): Promise<void> {
    this.worker = await this.bullMq.createWorker('credit.lifecycle', async (job) => {
      const event = this.store.append(job);
      if(job.name === 'credit.reserved') {
        this.logger.log(`Credit reserved: ${JSON.stringify(job.data)}`);
      }
      if(job.name === 'credit.committed') {
        this.logger.warn(`Credit committed: ${JSON.stringify(job.data)}`);
      }
      if(job.name === 'credit.rolled-back') {
        this.logger.log(`Credit rolled back: ${JSON.stringify(job.data)}`);
      }
      if(job.name === 'credit.expired') {
        this.logger.log(`Credit expired: ${JSON.stringify(job.data)}`);
      }
      if(job.name === 'credit.granted') {
        this.logger.log(`Credit granted: ${JSON.stringify(job.data)}`);
      }
      if(job.name === 'credit.critical-balance') {
        this.logger.log(`Critical balance reached: ${JSON.stringify(job.data)}`);
      }
      if(job.name === 'credit.balance-initialized') {
        this.logger.log(`Balance initialized: ${JSON.stringify(job.data)}`);
      }
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
