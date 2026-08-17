import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CREDIT_EVENT_NAMES } from '../../src';
import { ExampleBullMqProvider } from '../bullmq.module';
import { CreditEventStore } from './event-store.service';

interface GrantCreditRequest {
  serviceId?: unknown;
  tenantId?: unknown;
  appId?: unknown;
  appType?: unknown;
  creditType?: unknown;
  amount?: unknown;
  referenceId?: unknown;
  reason?: unknown;
}

@Controller()
export class CreditEventsController {
  constructor(
    private readonly bullMq: ExampleBullMqProvider,
    private readonly store: CreditEventStore,
  ) {}

  @Get('credit-events')
  events(@Query('limit') rawLimit?: string) {
    const parsed = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 250) {
      throw new BadRequestException('limit must be an integer from 1 to 250');
    }
    return this.store.recent(parsed);
  }

  @Post('credit-commands/grant')
  async grant(@Body() body: GrantCreditRequest) {
    const serviceId = requiredString(body.serviceId, 'serviceId');
    const appId = requiredString(body.appId, 'appId');
    const creditType = requiredString(body.creditType, 'creditType');
    const referenceId = requiredString(body.referenceId, 'referenceId');
    const amount = positiveInteger(body.amount, 'amount');
    const tenantId = optionalString(body.tenantId);
    const appType = optionalString(body.appType);
    const commandId = randomUUID();
    const queue = `credit.commands.${serviceId}`;
    await this.bullMq.add(queue, CREDIT_EVENT_NAMES.GRANT_REQUESTED, {
      schemaVersion: 1,
      commandId,
      serviceId,
      source: 'example-credit-event-server',
      requestedAt: new Date().toISOString(),
      payload: {
        subject: {
          appId,
          creditType,
          ...(tenantId ? { tenantId } : {}),
          ...(appType ? { appType } : {}),
        },
        amount,
        referenceId,
        reason: optionalString(body.reason) ?? 'demo_credit_grant',
      },
    }, { jobId: commandId });

    return { queued: true, commandId, queue, referenceId };
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new BadRequestException(`${field} must be a positive safe integer`);
  }
  return Number(value);
}
