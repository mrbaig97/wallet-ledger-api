import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type QueryResultRow } from 'pg';
import { ApiError } from './http';
import { balanceSql, creditSql, debitSql } from './queries';

interface BalanceRow extends QueryResultRow {
  balance: string;
}

interface DebitRow extends QueryResultRow {
  balance: string | null;
  wallet_exists: boolean;
}

function unknownWallet() {
  return new ApiError(404, 'user_not_found', 'Wallet does not exist.');
}

function walletResponse(userId: string, balance: string) {
  // pg returns bigint as a string. Preserve exact values on the JSON wire.
  const json = JSON as JSON & { rawJSON(value: string): unknown };
  return { user_id: userId, balance: json.rawJSON(balance) };
}

@Injectable()
export class WalletService implements OnApplicationShutdown {
  private readonly logger = new Logger(WalletService.name);
  private readonly pool = new Pool({ max: 24 });
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor() {
    this.pool.on('error', (error: NodeJS.ErrnoException) => {
      this.logger.error('Idle database connection failed (' + (error.code ?? 'unknown') + ').');
    });
  }

  async balance(userId: string) {
    const result = await this.pool.query<BalanceRow>({
      name: 'wallet-balance', text: balanceSql, values: [userId],
    });
    if (!result.rows[0]) throw unknownWallet();
    return walletResponse(userId, result.rows[0].balance);
  }

  async credit(userId: string, amount: number) {
    const result = await this.write<BalanceRow>(userId, amount, 'wallet-credit', creditSql);
    return walletResponse(userId, result.balance);
  }

  async debit(userId: string, amount: number) {
    const result = await this.write<DebitRow>(userId, amount, 'wallet-debit', debitSql);
    if (!result.wallet_exists) throw unknownWallet();
    if (result.balance === null) {
      throw new ApiError(409, 'insufficient_funds', 'Wallet has insufficient funds.');
    }
    return walletResponse(userId, result.balance);
  }

  private async write<Row extends QueryResultRow>(userId: string, amount: number, name: string, text: string) {
    // Queue by user before acquiring a connection so a hot wallet cannot occupy
    // every pool slot on this instance. PostgreSQL enforces cross-instance safety.
    const previous = this.pendingWrites.get(userId);
    const operation = (async () => {
      await previous;
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await this.pool.query<Row>({ name, text, values: [userId, amount] });
          return result.rows[0];
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== '40P01' && code !== '40001') throw error;
          if (attempt === 5) {
            throw new ApiError(503, 'temporarily_unavailable', 'Please retry the operation.');
          }
          await delay(Math.random() * 5 * (2 ** attempt));
        }
      }
    })();
    const tail = operation.then(() => undefined, () => undefined);
    this.pendingWrites.set(userId, tail);
    try {
      return await operation;
    } finally {
      if (this.pendingWrites.get(userId) === tail) this.pendingWrites.delete(userId);
    }
  }

  async onApplicationShutdown() {
    await this.pool.end();
  }
}
