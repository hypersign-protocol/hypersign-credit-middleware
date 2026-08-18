import { Controller, Get, Param, Post, Req } from "@nestjs/common";
import {
  CreditRecoveryService,
  CreditService,
  getCreditRequestState,
} from "../src";
import {
  BLOCKCHAIN_TRANSACTION_SUBJECT,
  EXAMPLE_ACCOUNT_ID,
  EXAMPLE_COST,
  EXAMPLE_SUBJECT,
} from "./credit-demo.config";

interface DemoRequest {
  requestId: string;
}

@Controller("demo")
export class ExampleDemoController {
  constructor(
    private readonly credits: CreditService,
    private readonly recovery: CreditRecoveryService,
  ) {}

  /** Explicitly declared as free in the service catalog. */
  @Get("free")
  free() {
    return {
      success: true,
      message: "This endpoint does not reserve credits",
      cost: 0,
    };
  }

  /** Read the current balance without spending credits. */
  @Get("balance")
  async balance() {
    return {
      appId: EXAMPLE_ACCOUNT_ID,
      balances: {
        API_CREDIT: await this.credits.getBalance(EXAMPLE_SUBJECT),
        BLOCKCHAIN_TXN_CREDIT: await this.credits.getBalance(
          BLOCKCHAIN_TRANSACTION_SUBJECT,
        ),
      },
    };
  }

  /** Inspect the durable state retained after commit, rollback, or expiry. */
  @Get("reservations/:reservationId")
  async reservation(@Param("reservationId") reservationId: string) {
    return (
      (await this.credits.getReservation(reservationId)) ?? { found: false }
    );
  }

  /** Create an intentionally abandoned reservation for recovery experiments. */
  @Post("orphan")
  async orphan(@Req() request: DemoRequest) {
    return this.credits.reserve({
      subject: EXAMPLE_SUBJECT,
      requestId: request.requestId,
      amount: 15,
    });
  }

  /** Programmatic/deferred: caller settles this reservation later. */
  @Post("deferred")
  async deferred(@Req() request: DemoRequest) {
    return this.credits.reserve({
      subject: EXAMPLE_SUBJECT,
      requestId: `${request.requestId}:deferred`,
      operation: "DEFERRED_DEMO",
      amount: 25,
      settlementMode: "DEFERRED",
    });
  }

  /**
   * One business operation with two independent credit lifecycles:
   * The catalog creates two independent reservations before this handler:
   * 5 API_CREDIT is committed automatically and 25 BLOCKCHAIN_TXN_CREDIT
   * remains deferred for an external command to settle.
   */
  @Post("blockchain-operation")
  async blockchainOperation(@Req() req: any) {
    const state = getCreditRequestState(req);
    const reservationId = state?.reservations.find(
      ({ charge }) => charge.settlementMode === "DEFERRED",
    )?.reservation.reservationId;

    return {
      reservationId,
    };
  }

  @Post("deferred/:reservationId/commit")
  commitDeferred(@Param("reservationId") id: string) {
    return this.credits.commit(id);
  }

  @Post("deferred/:reservationId/rollback")
  rollbackDeferred(@Param("reservationId") id: string) {
    return this.credits.rollback(id, "deferred_operation_failed");
  }

  @Get("plans")
  async plans() {
    return this.credits.getPlans(EXAMPLE_SUBJECT);
  }

  /** Manually run one recovery pass (production should use an external worker). */
  @Post("recover")
  async recover() {
    return { recovered: await this.recovery.runOnce() };
  }

  /** Successful low-cost request: 100 becomes 90. */
  @Post("cheap")
  async cheap() {
    return {
      success: true,
      cost: EXAMPLE_COST.CHEAP,
      balanceDuringController: await this.credits.getBalance(EXAMPLE_SUBJECT),
    };
  }

  /** Successful high-cost request, useful for concurrency experiments. */
  @Post("expensive")
  async expensive() {
    return {
      success: true,
      cost: EXAMPLE_COST.EXPENSIVE,
      balanceDuringController: await this.credits.getBalance(EXAMPLE_SUBJECT),
    };
  }

  /** Reserves 20, throws, and should have all 20 rolled back. */
  @Post("fail")
  fail(): never {
    throw new Error("Intentional demo failure");
  }
}
