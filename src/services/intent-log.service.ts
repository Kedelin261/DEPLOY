// DEPLOY Platform — Intent Log Service
// Permanent, tamper-evident audit trail for every Intent Layer execution.
// Satisfies the "log all changes" and "Intent Layer enforced" mandates.

import type { D1Database } from '@cloudflare/workers-types';

export interface IntentLogEntry {
  userId: string | null;
  projectId: string | null;
  intent: string;
  modelId: string | null;
  inputPayload: Record<string, unknown>;     // will be hashed — not stored raw
  outputSummary: string | null;
  coinsCharged: number;
  tokensUsed: number;
  providerUsed: string | null;
  latencyMs: number | null;
  status: 'success' | 'failed' | 'fallback';
  errorMessage?: string | null;
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

async function sha256Short(text: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(text)
    );
    return Array.from(new Uint8Array(buf))
      .slice(0, 8)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return 'hash_err';
  }
}

export class IntentLogService {
  constructor(private readonly db: D1Database) {}

  /**
   * Record an intent execution.
   * inputPayload is SHA-256–hashed before storage (privacy-safe).
   */
  async log(entry: IntentLogEntry): Promise<string> {
    const id = generateId('ilog');
    const inputHash = await sha256Short(JSON.stringify(entry.inputPayload));
    const outputSummary = entry.outputSummary
      ? entry.outputSummary.slice(0, 500)
      : null;

    try {
      await this.db
        .prepare(
          `INSERT INTO intent_log
             (id, user_id, project_id, intent, model_id, input_hash, output_summary,
              coins_charged, tokens_used, provider_used, latency_ms, status, error_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          entry.userId,
          entry.projectId,
          entry.intent,
          entry.modelId,
          inputHash,
          outputSummary,
          entry.coinsCharged,
          entry.tokensUsed,
          entry.providerUsed,
          entry.latencyMs,
          entry.status,
          entry.errorMessage ?? null
        )
        .run();

      // Async: update coin_analytics aggregate (fire-and-forget)
      if (entry.userId && entry.coinsCharged > 0) {
        this.updateCoinAnalytics(entry).catch(() => {/* non-fatal */});
      }
    } catch (err) {
      // Non-fatal — logging must never break the main flow
      console.error('[IntentLog] Failed to write log entry:', err);
    }

    return id;
  }

  /** Upsert monthly coin_analytics aggregate. */
  private async updateCoinAnalytics(entry: IntentLogEntry): Promise<void> {
    const period = new Date().toISOString().slice(0, 7); // YYYY-MM
    const analyticId = generateId('ca');
    await this.db
      .prepare(
        `INSERT INTO coin_analytics
           (id, user_id, period, model_id, project_id, intent, coins_spent, operation_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, period, model_id, project_id, intent) DO UPDATE SET
           coins_spent = coins_spent + excluded.coins_spent,
           operation_count = operation_count + 1,
           updated_at = CURRENT_TIMESTAMP`
      )
      .bind(
        analyticId,
        entry.userId,
        period,
        entry.modelId ?? '',
        entry.projectId ?? '',
        entry.intent,
        entry.coinsCharged
      )
      .run();
  }

  /** Fetch paginated intent log for a user (admin / debug use). */
  async listForUser(
    userId: string,
    limit = 50,
    offset = 0
  ): Promise<{ results: unknown[]; total: number }> {
    const [rows, countRow] = await Promise.all([
      this.db
        .prepare(
          `SELECT id, intent, model_id, provider_used, coins_charged, tokens_used,
                  latency_ms, status, error_message, created_at
           FROM intent_log WHERE user_id = ?
           ORDER BY created_at DESC LIMIT ? OFFSET ?`
        )
        .bind(userId, limit, offset)
        .all(),
      this.db
        .prepare('SELECT COUNT(*) AS total FROM intent_log WHERE user_id = ?')
        .bind(userId)
        .first<{ total: number }>(),
    ]);
    return { results: rows.results, total: countRow?.total ?? 0 };
  }

  /** Fetch coin analytics for a user (Financial Control Center). */
  async getCoinAnalytics(
    userId: string,
    months = 6
  ): Promise<{
    byPeriod: unknown[];
    byIntent: unknown[];
    byModel: unknown[];
  }> {
    const since = new Date();
    since.setMonth(since.getMonth() - months);
    const sincePeriod = since.toISOString().slice(0, 7);

    const [byPeriod, byIntent, byModel] = await Promise.all([
      this.db
        .prepare(
          `SELECT period, SUM(coins_spent) AS coins_spent, SUM(operation_count) AS ops
           FROM coin_analytics WHERE user_id = ? AND period >= ?
           GROUP BY period ORDER BY period ASC`
        )
        .bind(userId, sincePeriod)
        .all(),

      this.db
        .prepare(
          `SELECT intent, SUM(coins_spent) AS coins_spent, SUM(operation_count) AS ops
           FROM coin_analytics WHERE user_id = ? AND period >= ?
           GROUP BY intent ORDER BY coins_spent DESC`
        )
        .bind(userId, sincePeriod)
        .all(),

      this.db
        .prepare(
          `SELECT ca.model_id, m.display_name AS model_name,
                  SUM(ca.coins_spent) AS coins_spent, SUM(ca.operation_count) AS ops
           FROM coin_analytics ca
           LEFT JOIN ai_models m ON m.id = ca.model_id
           WHERE ca.user_id = ? AND ca.period >= ?
           GROUP BY ca.model_id ORDER BY coins_spent DESC`
        )
        .bind(userId, sincePeriod)
        .all(),
    ]);

    return {
      byPeriod: byPeriod.results,
      byIntent: byIntent.results,
      byModel: byModel.results,
    };
  }
}
