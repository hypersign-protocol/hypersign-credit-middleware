import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import {
  AnyCreditEvent,
  CREDIT_EVENT_NAMES,
  CreditBullMqJob,
  CreditBullMqWorker,
  CreditLifecycleEventEnvelope,
} from '../../src';
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
      const idempotencyKey = this.validate(job);
      const { existing } = this.store.append(job, idempotencyKey);
      if (existing) return;

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
        case CREDIT_EVENT_NAMES.PLAN_EXPIRED:
          this.logger.log(`Recharge plan expired: ${JSON.stringify(job.data)}`);
          break;
        case CREDIT_EVENT_NAMES.CREDIT_GRANTED:
          this.logger.log(`Credit granted: ${JSON.stringify(job.data)}`);
          break;
        case CREDIT_EVENT_NAMES.CRITICAL_BALANCE:
          this.logger.log(`Critical balance reached: ${JSON.stringify(job.data)}`);
          break;
        case CREDIT_EVENT_NAMES.CREDIT_OBSERVED:
          this.logger.log(`Development usage observed: ${JSON.stringify(job.data)}`);
          break;
        case CREDIT_EVENT_NAMES.COMMAND_REJECTED:
          this.logger.error(`Credit command rejected: ${JSON.stringify(job.data)}`);
          break;
      }
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  private validate(job: CreditBullMqJob): string {
    if (job.name === CREDIT_EVENT_NAMES.COMMAND_REJECTED) {
      const rejection = job.data as Record<string, unknown> | undefined;
      if (
        !rejection ||
        rejection.schemaVersion !== 3 ||
        rejection.serviceType !== 'CAVACH_API' ||
        typeof rejection.commandId !== 'string' ||
        typeof rejection.reason !== 'string'
      ) {
        throw new Error('Invalid credit command rejection');
      }
      return `command-rejected:${rejection.commandId}`;
    }

    const expectedType = EVENT_TYPES[job.name];
    if (!expectedType) throw new Error(`Unsupported lifecycle job ${job.name}`);

    const envelope = job.data as CreditLifecycleEventEnvelope | undefined;
    const event = envelope?.event as Partial<AnyCreditEvent> | undefined;
    if (
      !envelope ||
      envelope.schemaVersion !== 3 ||
      envelope.serviceType !== 'CAVACH_API' ||
      typeof envelope.catalogVersion !== 'string' ||
      !envelope.catalogVersion ||
      typeof envelope.eventId !== 'string' ||
      !envelope.eventId ||
      !event ||
      event.type !== expectedType ||
      typeof event.appId !== 'string' ||
      !event.appId
    ) {
      throw new Error(`Invalid ${job.name} lifecycle envelope`);
    }
    return envelope.eventId;
  }
}

const EVENT_TYPES: Record<string, AnyCreditEvent['type']> = {
  [CREDIT_EVENT_NAMES.RESERVED]: 'RESERVED',
  [CREDIT_EVENT_NAMES.COMMITTED]: 'COMMITTED',
  [CREDIT_EVENT_NAMES.ROLLED_BACK]: 'ROLLED_BACK',
  [CREDIT_EVENT_NAMES.EXPIRED]: 'EXPIRED',
  [CREDIT_EVENT_NAMES.PLAN_EXPIRED]: 'PLAN_EXPIRED',
  [CREDIT_EVENT_NAMES.CREDIT_GRANTED]: 'CREDIT_GRANTED',
  [CREDIT_EVENT_NAMES.CRITICAL_BALANCE]: 'CRITICAL_BALANCE',
  [CREDIT_EVENT_NAMES.CREDIT_OBSERVED]: 'CREDIT_OBSERVED',
};
