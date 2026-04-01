// DEPLOY Platform - Coin Ledger Service

import { generateId } from '../middleware/auth';
import type { Bindings } from '../types';

export class CoinService {
  constructor(private db: D1Database) {}

  async getWallet(userId: string) {
    return this.db.prepare(
      'SELECT * FROM coin_wallets WHERE user_id = ?'
    ).bind(userId).first<{
      id: string; user_id: string; balance: number;
      lifetime_earned: number; lifetime_spent: number;
      last_grant_at: string; next_grant_at: string;
    }>();
  }

  async createWallet(userId: string): Promise<string> {
    const id = generateId('wallet');
    await this.db.prepare(
      'INSERT INTO coin_wallets (id, user_id, balance, lifetime_earned, lifetime_spent) VALUES (?, ?, 0, 0, 0)'
    ).bind(id, userId).run();
    return id;
  }

  async credit(
    userId: string,
    amount: number,
    type: string,
    description: string,
    referenceId?: string,
    referenceType?: string
  ): Promise<{ newBalance: number; entryId: string }> {
    const wallet = await this.getWallet(userId);
    if (!wallet) throw new Error('Wallet not found');

    const newBalance = wallet.balance + amount;
    const entryId = generateId('cle');

    await this.db.batch([
      this.db.prepare(
        'UPDATE coin_wallets SET balance = ?, lifetime_earned = lifetime_earned + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'
      ).bind(newBalance, amount, userId),
      this.db.prepare(
        'INSERT INTO coin_ledger_entries (id, user_id, wallet_id, type, amount, balance_after, description, reference_id, reference_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(entryId, userId, wallet.id, type, amount, newBalance, description, referenceId || null, referenceType || null)
    ]);

    return { newBalance, entryId };
  }

  async debit(
    userId: string,
    amount: number,
    type: string,
    description: string,
    referenceId?: string,
    referenceType?: string
  ): Promise<{ newBalance: number; entryId: string }> {
    const wallet = await this.getWallet(userId);
    if (!wallet) throw new Error('Wallet not found');
    if (wallet.balance < amount) throw new Error('Insufficient coins');

    const newBalance = wallet.balance - amount;
    const entryId = generateId('cle');

    // Atomic conditional debit — prevents race conditions
    const updateResult = await this.db.prepare(
      'UPDATE coin_wallets SET balance = ?, lifetime_spent = lifetime_spent + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND balance >= ?'
    ).bind(newBalance, amount, userId, amount).run();

    if (!updateResult.meta?.changes || updateResult.meta.changes === 0) {
      const fresh = await this.getWallet(userId);
      throw new Error(`Insufficient coins. Balance: ${fresh?.balance ?? 0}, Required: ${amount}`);
    }

    await this.db.prepare(
      'INSERT INTO coin_ledger_entries (id, user_id, wallet_id, type, amount, balance_after, description, reference_id, reference_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(entryId, userId, wallet.id, type, -amount, newBalance, description, referenceId || null, referenceType || null).run();

    return { newBalance, entryId };
  }

  async holdCoins(userId: string, amount: number, referenceId: string, referenceType: string): Promise<string> {
    const wallet = await this.getWallet(userId);
    if (!wallet) throw new Error('Wallet not found');
    if (wallet.balance < amount) throw new Error('Insufficient coins for hold');

    const holdId = generateId('hold');
    const newBalance = wallet.balance - amount;
    const entryId = generateId('cle');

    // Atomic conditional UPDATE — only succeeds if balance hasn't changed since we read it
    // This prevents double-spend under concurrent requests (optimistic locking)
    const updateResult = await this.db.prepare(
      'UPDATE coin_wallets SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND balance >= ?'
    ).bind(newBalance, userId, amount).run();

    if (!updateResult.meta?.changes || updateResult.meta.changes === 0) {
      // Re-read current balance to provide accurate error
      const fresh = await this.getWallet(userId);
      throw new Error(`Insufficient coins for hold. Balance: ${fresh?.balance ?? 0}, Required: ${amount}`);
    }

    // Now record the hold and ledger entry (balance is already deducted)
    await this.db.batch([
      this.db.prepare(
        'INSERT INTO coin_holds (id, user_id, wallet_id, amount, reference_id, reference_type) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(holdId, userId, wallet.id, amount, referenceId, referenceType),
      this.db.prepare(
        'INSERT INTO coin_ledger_entries (id, user_id, wallet_id, type, amount, balance_after, description, reference_id, reference_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(entryId, userId, wallet.id, 'hold', -amount, newBalance, `Hold for ${referenceType}`, referenceId, referenceType)
    ]);

    return holdId;
  }

  async releaseHold(holdId: string, settle = false): Promise<void> {
    const hold = await this.db.prepare(
      'SELECT * FROM coin_holds WHERE id = ? AND status = ?'
    ).bind(holdId, 'active').first<{
      id: string; user_id: string; wallet_id: string;
      amount: number; reference_id: string; reference_type: string;
    }>();

    if (!hold) return;

    const wallet = await this.getWallet(hold.user_id);
    if (!wallet) return;

    const status = settle ? 'settled' : 'released';
    const entryType = settle ? 'spend' : 'release';
    const description = settle ? `Settled ${hold.reference_type} payment` : `Released hold for ${hold.reference_type}`;

    let newBalance = wallet.balance;
    if (!settle) {
      newBalance = wallet.balance + hold.amount;
    }

    const entryId = generateId('cle');

    await this.db.batch([
      this.db.prepare(
        'UPDATE coin_holds SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).bind(status, holdId),
      ...(settle ? [] : [this.db.prepare(
        'UPDATE coin_wallets SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'
      ).bind(newBalance, hold.user_id)]),
      this.db.prepare(
        'INSERT INTO coin_ledger_entries (id, user_id, wallet_id, type, amount, balance_after, description, reference_id, reference_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(entryId, hold.user_id, hold.wallet_id, entryType, settle ? 0 : hold.amount, newBalance, description, hold.reference_id, hold.reference_type)
    ]);
  }

  async getLedger(userId: string, page = 1, perPage = 20) {
    const offset = (page - 1) * perPage;
    const [items, count] = await Promise.all([
      this.db.prepare(
        'SELECT * FROM coin_ledger_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).bind(userId, perPage, offset).all(),
      this.db.prepare(
        'SELECT COUNT(*) as total FROM coin_ledger_entries WHERE user_id = ?'
      ).bind(userId).first<{ total: number }>()
    ]);
    return { items: items.results, total: count?.total || 0 };
  }

  async getActiveHolds(userId: string) {
    return this.db.prepare(
      'SELECT * FROM coin_holds WHERE user_id = ? AND status = ? ORDER BY created_at DESC'
    ).bind(userId, 'active').all();
  }

  async processMonthlyGrant(userId: string, planSlug: string): Promise<number> {
    const plan = await this.db.prepare(
      'SELECT * FROM plans WHERE slug = ?'
    ).bind(planSlug).first<{ monthly_coins: number; max_rollover_coins: number }>();

    if (!plan || plan.monthly_coins === 0) return 0;

    const wallet = await this.getWallet(userId);
    if (!wallet) return 0;

    const now = new Date();
    if (wallet.next_grant_at && new Date(wallet.next_grant_at) > now) return 0;

    // Cap balance at max rollover
    const grantAmount = plan.monthly_coins;
    const nextGrant = new Date(now);
    nextGrant.setMonth(nextGrant.getMonth() + 1);

    await this.credit(userId, grantAmount, 'grant', `Monthly ${planSlug} plan coin grant`);

    await this.db.prepare(
      'UPDATE coin_wallets SET last_grant_at = CURRENT_TIMESTAMP, next_grant_at = ? WHERE user_id = ?'
    ).bind(nextGrant.toISOString(), userId).run();

    return grantAmount;
  }
}
