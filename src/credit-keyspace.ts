import { CreditSubject, ResolvedCreditOptions } from './credit.types';

/** Deterministic, delimiter-safe Redis keys for a scoped credit wallet. */
export class CreditKeyspace {
  constructor(private readonly options: ResolvedCreditOptions) {}

  subject(input: CreditSubject): CreditSubject {
    const clean = (value?: string) => value?.trim() || undefined;
    const subject: CreditSubject = {
      accountId: clean(input.accountId) ?? '',
      tenantId: clean(input.tenantId),
      accountType: clean(input.accountType),
      serviceId: clean(input.serviceId),
      creditType: clean(input.creditType),
    };
    if (!subject.accountId) throw new TypeError('subject.accountId is required');
    return subject;
  }

  scopeId(input: CreditSubject): string {
    const subject = this.subject(input);
    const dimension = (value?: string): string =>
      value === undefined ? '0' : `1:${encodeURIComponent(value)}`;
    return [
      ['tenant', subject.tenantId],
      ['accountType', subject.accountType],
      ['account', subject.accountId],
      ['service', subject.serviceId],
      ['creditType', subject.creditType],
    ].map(([name, value]) => `${name}=${dimension(value)}`).join('|');
  }

  balance(subject: CreditSubject): string { return `${this.base()}:balance:${this.scopeId(subject)}`; }
  request(subject: CreditSubject, requestId: string): string {
    return `${this.base()}:request:${this.scopeId(subject)}:${encodeURIComponent(requestId)}`;
  }
  reservation(id: string): string { return `${this.base()}:reservation:${encodeURIComponent(id)}`; }
  grant(subject: CreditSubject, referenceId: string): string {
    return `${this.base()}:grant:${this.scopeId(subject)}:${encodeURIComponent(referenceId)}`;
  }
  initializationLock(subject: CreditSubject): string {
    return `${this.base()}:initialize:${this.scopeId(subject)}`;
  }
  expirations(): string { return `${this.base()}:reservation:expirations`; }
  eventStream(): string { return this.options.eventStreamKey; }

  private base(): string {
    return `${this.options.keyPrefix}:{${this.options.redisHashTag}}`;
  }
}
