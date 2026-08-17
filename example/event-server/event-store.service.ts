import { Injectable } from '@nestjs/common';
import { CreditBullMqJob } from '../../src';

export interface StoredCreditEvent {
  receivedAt: string;
  jobId?: string;
  name: string;
  data: unknown;
}

/**
 * Demo persistence boundary. Replace this bounded memory store with a
 * TimescaleDB repository without changing the BullMQ consumer.
 */
@Injectable()
export class CreditEventStore {
  private readonly events: StoredCreditEvent[] = [];

  append(job: CreditBullMqJob): StoredCreditEvent {
    const event = {
      receivedAt: new Date().toISOString(),
      jobId: job.id,
      name: job.name,
      data: job.data,
    };
    this.events.unshift(event);
    this.events.splice(1_000);
    return event;
  }

  recent(limit: number): StoredCreditEvent[] {
    return this.events.slice(0, limit);
  }
}
