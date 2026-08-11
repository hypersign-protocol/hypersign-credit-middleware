import { DynamicModule, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DEFAULT_CREDIT_OPTIONS } from './credit.constants';
import { CreditRecoveryService } from './credit-recovery.service';
import { CreditInterceptor } from './credit.interceptor';
import { CreditService } from './credit.service';
import { CREDIT_OPTIONS, CreditOptions } from './credit.types';

const providers = [
  CreditService,
  CreditRecoveryService,
  { provide: APP_INTERCEPTOR, useClass: CreditInterceptor },
];

@Module({
  providers: [
    { provide: CREDIT_OPTIONS, useValue: DEFAULT_CREDIT_OPTIONS },
    ...providers,
  ],
  exports: [CreditService, CreditRecoveryService],
})
export class CreditModule {
  static forRoot(options: CreditOptions = {}): DynamicModule {
    return {
      module: CreditModule,
      providers: [{
        provide: CREDIT_OPTIONS,
        useValue: { ...DEFAULT_CREDIT_OPTIONS, ...options },
      }],
    };
  }
}
