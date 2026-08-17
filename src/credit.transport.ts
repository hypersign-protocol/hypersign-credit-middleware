import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CreditCatalogService } from './credit.catalog';
import { CreditService } from './credit.service';
import p1 from 'process';
import {
  CREDIT_OPTIONS,
  CREDIT_REDIS_CLIENT,
  CreditBullMqJob,
  CreditCommandEnvelope,
  CreditEventStreamClient,
  CreditRedisClient,
  CreditSubject,
  ResolvedCreditOptions,
} from './credit.types';
import { from } from 'rxjs';

export interface CreditLifecycleEventEnvelope {
  eventId: string;
  schemaVersion: 1;
  catalogVersion: string;
  serviceId: string;
  event: Record<string, unknown>;
}

const JOB_NAMES: Record<string, string> = {
  RESERVED: 'credit.reserved',
  COMMITTED: 'credit.committed',
  ROLLED_BACK: 'credit.rolled-back',
  EXPIRED: 'credit.expired',
  CREDIT_GRANTED: 'credit.granted',
  CRITICAL_BALANCE: 'credit.critical-balance',
  BALANCE_INITIALIZED: 'credit.balance-initialized',
};

/** Relays the transactional Redis Stream outbox to the supplied BullMQ queues. */
@Injectable()
export class CreditEventRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CreditEventRelay.name);
  private running = false;
  private loop?: Promise<void>;
  private readonly consumer = `${process.pid}-${randomUUID()}`;

  constructor(
    @Inject(CREDIT_REDIS_CLIENT) private readonly operationRedis: CreditRedisClient,
    @Inject(CREDIT_OPTIONS) private readonly options: ResolvedCreditOptions,
    private readonly catalog: CreditCatalogService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const config = this.options.bullMq;
    if (!config) return;
    if ((config.streamClient as unknown) === (this.operationRedis as unknown)) {
      throw new TypeError(
        'bullMq.streamClient must be a dedicated Redis connection; blocking reads ' +
        'cannot share the credit operation connection',
      );
    }
    await this.createGroup(config.streamClient, config.consumerGroup);
    const claimed = await config.streamClient.xautoclaim(
      this.options.eventStreamKey,
      config.consumerGroup,
      this.consumer,
      config.pendingIdleMs,
      '0-0',
      'COUNT',
      config.batchSize,
    );
    await this.publishEntries(this.claimedEntries(claimed));
    this.running = true;
    this.loop = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    const config = this.options.bullMq!;
    const stream = this.options.eventStreamKey;
    while (this.running) {
      try {
        const claimed = await config.streamClient.xautoclaim(
          stream,
          config.consumerGroup,
          this.consumer,
          config.pendingIdleMs,
          '0-0',
          'COUNT',
          config.batchSize,
        );
        await this.publishEntries(this.claimedEntries(claimed));
        if (!this.running) break;
        const response = await config.streamClient.xreadgroup(
          'GROUP',
          config.consumerGroup,
          this.consumer,
          'COUNT',
          config.batchSize,
          'BLOCK',
          config.blockMs,
          'STREAMS',
          stream,
          '>',
        );
        await this.publishEntries(this.readEntries(response));
      } catch (error) {
        if (!this.running) break;
        if (this.isMissingConsumerGroup(error)) {
          try {
            await this.createGroup(config.streamClient, config.consumerGroup);
            this.logger.warn(
              `Recreated missing Redis Stream consumer group ${config.consumerGroup}`,
            );
          } catch (recoveryError) {
            const recoveryMessage = recoveryError instanceof Error
              ? recoveryError.message
              : String(recoveryError);
            this.logger.error(
              `Credit event relay consumer-group recovery failed: ${recoveryMessage}`,
            );
          }
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Credit event relay pass failed: ${message}`);
        // the process will be restarted by the BullMQ lifecycle consumer if the relay is not running
        // restart 
        await new Promise((resolve) => setTimeout( () => p1.exit(1), 5_000));
        
        
      }
    }
  }

  private async publishEntries(entries: StreamEntry[]): Promise<void> {
    const config = this.options.bullMq!;
    for (const [eventId, values] of entries) {
      const fields = pairs(values);
      const streamServiceId = fields.serviceId;
      if (!streamServiceId) {
        this.logger.error(
          `Credit stream event ${eventId} has no serviceId; leaving it pending`,
        );
        continue;
      }
      if (streamServiceId !== this.catalog.serviceId) {
        await config.streamClient.xack(
          this.options.eventStreamKey,
          config.consumerGroup,
          eventId,
        );
        continue;
      }
      const jobName = JOB_NAMES[fields.event];
      if (!jobName) {
        this.logger.error(`Unknown credit stream event ${fields.event}; leaving ${eventId} pending`);
        continue;
      }
      const envelope: CreditLifecycleEventEnvelope = {
        eventId,
        schemaVersion: 1,
        catalogVersion: this.catalog.version,
        serviceId: this.catalog.serviceId,
        event: normalizeEvent(fields),
      };
      for (const queueName of config.lifecycleQueueNames) {
        await config.provider.add(queueName, jobName, envelope, {
          jobId: `${this.catalog.serviceId}-${eventId}`,
        });
      }
      await config.streamClient.xack(
        this.options.eventStreamKey,
        config.consumerGroup,
        eventId,
      );
    }
  }

  private async createGroup(client: CreditEventStreamClient, group: string): Promise<void> {
    try {
      await client.xgroup('CREATE', this.options.eventStreamKey, group, '0', 'MKSTREAM');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('BUSYGROUP')) throw error;
    }
  }

  private isMissingConsumerGroup(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('NOGROUP');
  }

  private claimedEntries(value: unknown): StreamEntry[] {
    if (!Array.isArray(value) || !Array.isArray(value[1])) return [];
    return value[1] as StreamEntry[];
  }

  private readEntries(value: unknown): StreamEntry[] {
    if (!Array.isArray(value)) return [];
    const result: StreamEntry[] = [];
    for (const stream of value as Array<[string, StreamEntry[]]>) {
      if (Array.isArray(stream?.[1])) result.push(...stream[1]);
    }
    return result;
  }
}

/** Consumes trusted service-specific credit commands from the supplied BullMQ provider. */
@Injectable()
export class CreditCommandWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CreditCommandWorker.name);
  private worker?: { close(): Promise<void> };

  constructor(
    @Inject(CREDIT_OPTIONS) private readonly options: ResolvedCreditOptions,
    private readonly catalog: CreditCatalogService,
    private readonly credits: CreditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const config = this.options.bullMq;
    if (!config?.commandQueueName) return;
    this.worker = await config.provider.createWorker(
      config.commandQueueName,
      (job) => this.process(job),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: CreditBullMqJob): Promise<unknown> {
    let command: CreditCommandEnvelope | undefined;
    try {
      command = this.command(job);
      switch (job.name) {
        case 'credit.grant.requested':
          return this.credits.grant({
            subject: this.subject(command.payload.subject),
            amount: positiveInteger(command.payload.amount, 'payload.amount'),
            referenceId: requiredString(
              command.payload.referenceId ?? command.commandId,
              'payload.referenceId',
            ),
            reason: optionalString(command.payload.reason),
          });
        case 'credit.reserve.requested':
          return this.credits.reserve({
            subject: this.subject(command.payload.subject),
            requestId: optionalString(command.payload.requestId) ?? command.commandId,
            amount: positiveInteger(command.payload.amount, 'payload.amount'),
            operation: requiredString(command.payload.operation, 'payload.operation'),
            settlementMode: deferredSettlement(command.payload.settlementMode),
            autoRecover: command.payload.autoRecover !== false,
          });
        case 'credit.commit.requested':
          return this.settle(
            requiredString(command.payload.reservationId, 'payload.reservationId'),
            'COMMIT',
          );
        case 'credit.rollback.requested':
          return this.settle(
            requiredString(command.payload.reservationId, 'payload.reservationId'),
            'ROLLBACK',
            optionalString(command.payload.reason) ?? 'external_command',
          );
        default:
          throw new TypeError(`Unsupported credit command ${job.name}`);
      }
    } catch (error) {
      await this.publishRejection(command ?? {
        commandId: typeof job.id === 'string' && job.id ? job.id : randomUUID(),
        schemaVersion: 1,
        serviceId: this.catalog.serviceId,
        payload: {},
      }, job.name, error);
      throw error;
    }
  }

  private command(job: CreditBullMqJob): CreditCommandEnvelope {
    const value = job.data as Partial<CreditCommandEnvelope> | undefined;
    if (!value || value.schemaVersion !== 1 || !value.payload) {
      throw new TypeError('Invalid credit command envelope');
    }
    const commandId = requiredString(value.commandId ?? job.id, 'commandId');
    if (value.serviceId !== this.catalog.serviceId) {
      throw new TypeError(
        `Command serviceId ${String(value.serviceId)} does not match ${this.catalog.serviceId}`,
      );
    }
    return { ...value, commandId } as CreditCommandEnvelope;
  }

  private subject(value: unknown): CreditSubject {
    if (!value || typeof value !== 'object') throw new TypeError('payload.subject is required');
    const subject = value as Partial<CreditSubject>;
    if (subject.serviceId && subject.serviceId !== this.catalog.serviceId) {
      throw new TypeError('Command subject serviceId does not match installed catalog');
    }
    return {
      accountId: requiredString(subject.accountId, 'payload.subject.accountId'),
      tenantId: optionalString(subject.tenantId),
      accountType: optionalString(subject.accountType),
      serviceId: this.catalog.serviceId,
      creditType: requiredString(subject.creditType, 'payload.subject.creditType'),
    };
  }

  private async settle(
    reservationId: string,
    action: 'COMMIT' | 'ROLLBACK',
    reason?: string,
  ): Promise<{ reservationId: string; outcome: string }> {
    const before = await this.credits.getReservation(reservationId);
    if (!before) return { reservationId, outcome: 'NOT_FOUND' };
    const applied = action === 'COMMIT'
      ? await this.credits.commit(reservationId)
      : await this.credits.rollback(reservationId, reason);
    if (applied) return { reservationId, outcome: 'APPLIED' };
    const after = await this.credits.getReservation(reservationId);
    return { reservationId, outcome: after?.status ?? 'NOT_FOUND' };
  }

  private async publishRejection(
    command: CreditCommandEnvelope,
    commandName: string,
    error: unknown,
  ): Promise<void> {
    const config = this.options.bullMq!;
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.error(`Rejected credit command ${command.commandId}: ${reason}`);
    for (const queueName of config.lifecycleQueueNames) {
      await config.provider.add(queueName, 'credit.command-rejected', {
        schemaVersion: 1,
        serviceId: this.catalog.serviceId,
        commandId: command.commandId,
        commandName,
        reason,
        timestamp: Date.now(),
      }, { jobId: `${this.catalog.serviceId}-${command.commandId}-rejected` });
    }
  }
}

type StreamEntry = [string, string[]];

function pairs(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    result[values[index]] = values[index + 1];
  }
  return result;
}

function normalizeEvent(fields: Record<string, string>): Record<string, unknown> {
  const numeric = new Set([
    'timestamp', 'amount', 'balanceAfter', 'balance', 'threshold', 'expiresAt',
  ]);
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (numeric.has(name)) result[name] = Number(value);
    else if (name === 'autoRecover') result[name] = value === '1';
    else if (value !== '') result[name] = value;
  }
  result.type = fields.event;
  delete result.event;
  result.subject = {
    accountId: fields.accountId,
    ...(fields.tenantId ? { tenantId: fields.tenantId } : {}),
    ...(fields.accountType ? { accountType: fields.accountType } : {}),
    ...(fields.serviceId ? { serviceId: fields.serviceId } : {}),
    ...(fields.creditType ? { creditType: fields.creditType } : {}),
  };
  return result;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function deferredSettlement(value: unknown): 'DEFERRED' {
  if (value !== undefined && value !== 'DEFERRED') {
    throw new TypeError('Command reservations support only DEFERRED settlement');
  }
  return 'DEFERRED';
}
