// Core module, service, and decorator
export * from './credit.decorator';
export * from './credit-boundary.middleware';
export * from './credit.constants';
export * from './credit-recovery.service';
export * from './credit.interceptor';
export * from './credit-keyspace';
export * from './credit.module';
export * from './credit.service';
export * from './credit.types';

// Event system — implement CreditModuleEventHandler to receive lifecycle events
export * from './events/credit.events';
export * from './events/credit.event-handler';
// Note: CreditEventDispatcher is intentionally NOT exported (internal detail)
