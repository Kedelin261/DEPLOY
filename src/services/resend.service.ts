// DEPLOY Platform - Resend Email Service
// Handles all transactional emails via Resend API.
// API key is server-side only — never exposed to clients.

import type { Bindings } from '../types';

export class ResendService {
  private apiKey: string;
  private from: string;

  constructor(private env: Bindings) {
    this.apiKey = env.RESEND_API_KEY;
    this.from = env.FROM_EMAIL
      ? `${env.FROM_NAME || 'DEPLOY Platform'} <${env.FROM_EMAIL}>`
      : 'DEPLOY Platform <noreply@deployapp.io>';
  }

  // ── Core send method ───────────────────────────────────────────────────────

  private async send(opts: {
    to: string | string[];
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
  }): Promise<{ id: string }> {
    if (!this.apiKey || this.apiKey === 're_placeholder') {
      console.warn('[ResendService] API key not configured — skipping email send');
      return { id: 'skipped' };
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: Array.isArray(opts.to) ? opts.to : [opts.to],
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        reply_to: opts.replyTo,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[ResendService] Send error:', err);
      throw new Error(`Email send failed: ${res.status}`);
    }

    return await res.json() as { id: string };
  }

  // ── Email templates ────────────────────────────────────────────────────────

  /** Welcome email sent after successful signup */
  async sendWelcome(opts: { to: string; name: string; coins: number }): Promise<void> {
    const appUrl = this.env.APP_URL || 'https://deploy-app.pages.dev';
    await this.send({
      to: opts.to,
      subject: '🚀 Welcome to DEPLOY — Your AI Dev Platform',
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px">
    <div style="text-align:center;margin-bottom:32px">
      <div style="font-size:32px;font-weight:900;background:linear-gradient(135deg,#6366f1,#8b5cf6,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-1px">DEPLOY</div>
    </div>
    <div style="background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px">
      <h1 style="color:#f8fafc;font-size:24px;margin:0 0 16px">Welcome, ${escapeHtml(opts.name)}! 👋</h1>
      <p style="color:#94a3b8;font-size:16px;line-height:1.6;margin:0 0 24px">
        You're now part of DEPLOY — the AI-powered platform that turns your app idea into a production-ready blueprint in minutes.
      </p>
      <div style="background:#0f172a;border:1px solid #6366f1;border-radius:12px;padding:20px;margin:0 0 24px;text-align:center">
        <div style="color:#6366f1;font-size:14px;font-weight:600;margin-bottom:8px">YOUR STARTING BALANCE</div>
        <div style="color:#f8fafc;font-size:48px;font-weight:900">${opts.coins}</div>
        <div style="color:#94a3b8;font-size:14px">coins ready to spend</div>
      </div>
      <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 28px">
        Use your coins to get AI assistance on your prompt builder, generate full build specs, and kick off your first deployment.
      </p>
      <div style="text-align:center">
        <a href="${appUrl}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:16px">
          Start Building →
        </a>
      </div>
    </div>
    <p style="color:#475569;font-size:12px;text-align:center;margin-top:24px">
      You received this email because you signed up for DEPLOY. 
      <a href="${appUrl}" style="color:#6366f1">Manage preferences</a>
    </p>
  </div>
</body>
</html>`,
      text: `Welcome to DEPLOY, ${opts.name}!\n\nYou have ${opts.coins} coins to get started.\n\nStart building: ${appUrl}`,
    });
  }

  /** Password reset email */
  async sendPasswordReset(opts: {
    to: string;
    name: string;
    resetToken: string;
  }): Promise<void> {
    const appUrl = this.env.APP_URL || 'https://deploy-app.pages.dev';
    const resetUrl = `${appUrl}/reset-password?token=${opts.resetToken}`;

    await this.send({
      to: opts.to,
      subject: 'Reset your DEPLOY password',
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px">
    <div style="text-align:center;margin-bottom:32px">
      <div style="font-size:32px;font-weight:900;background:linear-gradient(135deg,#6366f1,#8b5cf6,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent">DEPLOY</div>
    </div>
    <div style="background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px">
      <h1 style="color:#f8fafc;font-size:22px;margin:0 0 16px">Password Reset Request</h1>
      <p style="color:#94a3b8;font-size:16px;line-height:1.6;margin:0 0 8px">Hi ${escapeHtml(opts.name)},</p>
      <p style="color:#94a3b8;font-size:16px;line-height:1.6;margin:0 0 24px">
        We received a request to reset your DEPLOY password. Click the button below to set a new one. This link expires in <strong style="color:#f8fafc">1 hour</strong>.
      </p>
      <div style="text-align:center;margin:0 0 24px">
        <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:16px">
          Reset Password →
        </a>
      </div>
      <p style="color:#64748b;font-size:13px;text-align:center;margin:0">
        If you didn't request this, ignore this email — your account is safe.
      </p>
      <div style="margin-top:20px;padding:12px;background:#0f172a;border-radius:8px;word-break:break-all">
        <p style="color:#64748b;font-size:11px;margin:0 0 4px">Or copy this link:</p>
        <p style="color:#6366f1;font-size:12px;margin:0">${resetUrl}</p>
      </div>
    </div>
  </div>
</body>
</html>`,
      text: `Hi ${opts.name},\n\nReset your DEPLOY password: ${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, ignore this email.`,
    });
  }

  /** Build request confirmation */
  async sendBuildConfirmation(opts: {
    to: string;
    name: string;
    projectName: string;
    jobId: string;
    coinsSpent: number;
    remainingBalance: number;
  }): Promise<void> {
    const appUrl = this.env.APP_URL || 'https://deploy-app.pages.dev';
    await this.send({
      to: opts.to,
      subject: `🔨 Build started — ${opts.projectName}`,
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px">
    <div style="text-align:center;margin-bottom:32px">
      <div style="font-size:32px;font-weight:900;background:linear-gradient(135deg,#6366f1,#8b5cf6,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent">DEPLOY</div>
    </div>
    <div style="background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="display:inline-block;background:#6366f1;border-radius:50%;width:56px;height:56px;line-height:56px;font-size:24px">🔨</div>
      </div>
      <h1 style="color:#f8fafc;font-size:22px;margin:0 0 8px;text-align:center">Build Request Received</h1>
      <p style="color:#94a3b8;text-align:center;margin:0 0 24px">Your AI is generating the full build spec for <strong style="color:#f8fafc">${escapeHtml(opts.projectName)}</strong></p>
      <div style="background:#0f172a;border-radius:12px;padding:20px;margin:0 0 24px">
        <div style="display:flex;justify-content:space-between;margin-bottom:12px">
          <span style="color:#64748b;font-size:14px">Job ID</span>
          <span style="color:#f8fafc;font-size:14px;font-family:monospace">${opts.jobId}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:12px">
          <span style="color:#64748b;font-size:14px">Coins Spent</span>
          <span style="color:#ef4444;font-size:14px;font-weight:700">-${opts.coinsSpent} coins</span>
        </div>
        <div style="display:flex;justify-content:space-between">
          <span style="color:#64748b;font-size:14px">Remaining Balance</span>
          <span style="color:#22c55e;font-size:14px;font-weight:700">${opts.remainingBalance} coins</span>
        </div>
      </div>
      <div style="text-align:center">
        <a href="${appUrl}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;font-size:15px">
          View Dashboard →
        </a>
      </div>
    </div>
  </div>
</body>
</html>`,
      text: `Build started for ${opts.projectName}.\nJob: ${opts.jobId}\nCoins spent: ${opts.coinsSpent}\nRemaining: ${opts.remainingBalance}\n\n${appUrl}`,
    });
  }

  /** Coin purchase receipt */
  async sendCoinReceipt(opts: {
    to: string;
    name: string;
    packageName: string;
    coinsAdded: number;
    newBalance: number;
    amountPaid: string;
  }): Promise<void> {
    const appUrl = this.env.APP_URL || 'https://deploy-app.pages.dev';
    await this.send({
      to: opts.to,
      subject: `✅ ${opts.coinsAdded} coins added to your DEPLOY vault`,
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px">
    <div style="text-align:center;margin-bottom:32px">
      <div style="font-size:32px;font-weight:900;background:linear-gradient(135deg,#6366f1,#8b5cf6,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent">DEPLOY</div>
    </div>
    <div style="background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px">
      <h1 style="color:#f8fafc;font-size:22px;margin:0 0 8px;text-align:center">Payment Confirmed ✅</h1>
      <p style="color:#94a3b8;text-align:center;margin:0 0 24px">Your coin purchase was successful</p>
      <div style="background:#0f172a;border-radius:12px;padding:20px;margin:0 0 24px">
        <div style="display:flex;justify-content:space-between;margin-bottom:12px">
          <span style="color:#64748b;font-size:14px">Package</span>
          <span style="color:#f8fafc;font-size:14px">${escapeHtml(opts.packageName)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:12px">
          <span style="color:#64748b;font-size:14px">Amount Paid</span>
          <span style="color:#f8fafc;font-size:14px">${escapeHtml(opts.amountPaid)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:12px">
          <span style="color:#64748b;font-size:14px">Coins Added</span>
          <span style="color:#22c55e;font-size:14px;font-weight:700">+${opts.coinsAdded}</span>
        </div>
        <div style="border-top:1px solid #334155;padding-top:12px;display:flex;justify-content:space-between">
          <span style="color:#f8fafc;font-size:14px;font-weight:700">New Balance</span>
          <span style="color:#6366f1;font-size:18px;font-weight:900">${opts.newBalance} coins</span>
        </div>
      </div>
      <div style="text-align:center">
        <a href="${appUrl}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;font-size:15px">
          Start Building →
        </a>
      </div>
    </div>
  </div>
</body>
</html>`,
      text: `${opts.coinsAdded} coins added to your DEPLOY vault.\nNew balance: ${opts.newBalance} coins\nAmount paid: ${opts.amountPaid}\n\n${appUrl}`,
    });
  }
  /** Deployment is now live */
  async sendDeploymentLive(opts: {
    to: string;
    name: string;
    projectName: string;
    deploymentUrl: string;
  }): Promise<void> {
    const appUrl = this.env.APP_URL || 'https://deploy-app.pages.dev';
    await this.send({
      to: opts.to,
      subject: `🚀 Your app is live — ${opts.projectName}`,
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px">
    <div style="text-align:center;margin-bottom:32px">
      <div style="font-size:32px;font-weight:900;background:linear-gradient(135deg,#6366f1,#8b5cf6,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent">DEPLOY</div>
    </div>
    <div style="background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="display:inline-block;background:linear-gradient(135deg,#10b981,#059669);border-radius:50%;width:64px;height:64px;line-height:64px;font-size:28px">🚀</div>
      </div>
      <h1 style="color:#f8fafc;font-size:24px;margin:0 0 8px;text-align:center">Your App is Live!</h1>
      <p style="color:#94a3b8;text-align:center;margin:0 0 24px">Hi ${escapeHtml(opts.name)} — <strong style="color:#f8fafc">${escapeHtml(opts.projectName)}</strong> is now deployed and accessible on the web.</p>
      <div style="background:#0f172a;border:1px solid #10b981;border-radius:12px;padding:20px;margin:0 0 24px;text-align:center">
        <p style="color:#64748b;font-size:12px;margin:0 0 8px;text-transform:uppercase;letter-spacing:1px">Live URL</p>
        <a href="${escapeHtml(opts.deploymentUrl)}" style="color:#10b981;font-size:16px;font-weight:700;text-decoration:none;word-break:break-all">${escapeHtml(opts.deploymentUrl)}</a>
      </div>
      <div style="text-align:center">
        <a href="${escapeHtml(opts.deploymentUrl)}" style="display:inline-block;background:linear-gradient(135deg,#10b981,#059669);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:16px;margin-right:12px">
          Open App →
        </a>
        <a href="${appUrl}" style="display:inline-block;background:transparent;border:1px solid #334155;color:#94a3b8;text-decoration:none;padding:14px 24px;border-radius:10px;font-weight:600;font-size:14px">
          Dashboard
        </a>
      </div>
    </div>
  </div>
</body>
</html>`,
      text: `Your app ${opts.projectName} is now live!\n\nURL: ${opts.deploymentUrl}\n\nDashboard: ${appUrl}`,
    });
  }

  /** Build completed successfully */
  async sendBuildComplete(opts: {
    to: string;
    name: string;
    projectName: string;
    jobId: string;
    readinessScore: number;
    projectId: string;
  }): Promise<void> {
    const appUrl = this.env.APP_URL || 'https://deploy-app.pages.dev';
    const projectUrl = `${appUrl}/#project-${opts.projectId}`;
    await this.send({
      to: opts.to,
      subject: `✅ Build complete — ${opts.projectName} (${opts.readinessScore}% ready)`,
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px">
    <div style="text-align:center;margin-bottom:32px">
      <div style="font-size:32px;font-weight:900;background:linear-gradient(135deg,#6366f1,#8b5cf6,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent">DEPLOY</div>
    </div>
    <div style="background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="display:inline-block;background:linear-gradient(135deg,#6366f1,#4f46e5);border-radius:50%;width:64px;height:64px;line-height:64px;font-size:28px">✅</div>
      </div>
      <h1 style="color:#f8fafc;font-size:22px;margin:0 0 8px;text-align:center">Build Complete!</h1>
      <p style="color:#94a3b8;text-align:center;margin:0 0 24px">The AI has finished generating your app spec for <strong style="color:#f8fafc">${escapeHtml(opts.projectName)}</strong>.</p>
      <div style="background:#0f172a;border-radius:12px;padding:20px;margin:0 0 24px">
        <div style="display:flex;justify-content:space-between;margin-bottom:12px">
          <span style="color:#64748b;font-size:14px">Job ID</span>
          <span style="color:#f8fafc;font-size:13px;font-family:monospace">${opts.jobId}</span>
        </div>
        <div style="display:flex;justify-content:space-between">
          <span style="color:#64748b;font-size:14px">Readiness Score</span>
          <span style="color:#6366f1;font-size:16px;font-weight:900">${opts.readinessScore}%</span>
        </div>
        <div style="margin-top:12px;background:#0d1224;border-radius:8px;overflow:hidden">
          <div style="background:linear-gradient(90deg,#6366f1,#06b6d4);height:6px;width:${opts.readinessScore}%;transition:width 0.5s"></div>
        </div>
      </div>
      <div style="text-align:center">
        <a href="${projectUrl}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:16px">
          Review Build →
        </a>
      </div>
    </div>
  </div>
</body>
</html>`,
      text: `Build complete for ${opts.projectName}!\nReadiness: ${opts.readinessScore}%\nJob: ${opts.jobId}\n\nReview: ${projectUrl}`,
    });
  }

  /** Low coin balance alert */
  async sendLowCoinAlert(opts: {
    to: string;
    name: string;
    balance: number;
    threshold: number;
  }): Promise<void> {
    const appUrl = this.env.APP_URL || 'https://deploy-app.pages.dev';
    await this.send({
      to: opts.to,
      subject: `⚠️ Low coin balance — only ${opts.balance} coins left`,
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px">
    <div style="text-align:center;margin-bottom:32px">
      <div style="font-size:32px;font-weight:900;background:linear-gradient(135deg,#6366f1,#8b5cf6,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent">DEPLOY</div>
    </div>
    <div style="background:#1e293b;border:1px solid #f59e0b;border-radius:16px;padding:32px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="display:inline-block;background:linear-gradient(135deg,#f59e0b,#d97706);border-radius:50%;width:64px;height:64px;line-height:64px;font-size:28px">⚠️</div>
      </div>
      <h1 style="color:#f8fafc;font-size:22px;margin:0 0 8px;text-align:center">Low Coin Balance</h1>
      <p style="color:#94a3b8;text-align:center;margin:0 0 24px">Hi ${escapeHtml(opts.name)}, your DEPLOY coin balance is running low.</p>
      <div style="background:#0f172a;border:1px solid #f59e0b;border-radius:12px;padding:20px;margin:0 0 24px;text-align:center">
        <div style="color:#f59e0b;font-size:14px;font-weight:600;margin-bottom:8px">CURRENT BALANCE</div>
        <div style="color:#f8fafc;font-size:48px;font-weight:900">${opts.balance}</div>
        <div style="color:#94a3b8;font-size:14px">coins remaining</div>
      </div>
      <p style="color:#94a3b8;font-size:14px;text-align:center;margin:0 0 24px">Top up your vault to keep building without interruption.</p>
      <div style="text-align:center">
        <a href="${appUrl}" style="display:inline-block;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:16px">
          Add Coins Now →
        </a>
      </div>
    </div>
  </div>
</body>
</html>`,
      text: `Low coin balance alert!\nYou have ${opts.balance} coins remaining.\n\nTop up: ${appUrl}`,
    });
  }

  /** Subscription plan change — upgrade, downgrade, or cancellation */
  async sendSubscriptionChange(opts: {
    to: string;
    name: string;
    changeType: 'upgraded' | 'downgraded' | 'cancelled';
    fromPlan: string;
    toPlan: string;
    effectiveDate?: string;
  }): Promise<void> {
    const appUrl = this.env.APP_URL || 'https://deploy-app.pages.dev';
    const emoji = opts.changeType === 'upgraded' ? '🚀' : opts.changeType === 'downgraded' ? '📉' : '😢';
    const colour = opts.changeType === 'upgraded' ? '#10b981' : opts.changeType === 'downgraded' ? '#f59e0b' : '#ef4444';
    const subject = opts.changeType === 'upgraded'
      ? `🚀 Welcome to ${opts.toPlan} — you've upgraded!`
      : opts.changeType === 'downgraded'
      ? `📉 Your plan has changed to ${opts.toPlan}`
      : `Your DEPLOY subscription has been cancelled`;
    const effectiveNote = opts.effectiveDate
      ? `<p style="color:#94a3b8;font-size:14px">Effective: ${opts.effectiveDate}</p>`
      : '';
    await this.send({
      to: opts.to,
      subject,
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px">
    <div style="text-align:center;margin-bottom:32px">
      <div style="font-size:32px;font-weight:900;background:linear-gradient(135deg,#6366f1,#8b5cf6,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent">DEPLOY</div>
    </div>
    <div style="background:#1e293b;border:1px solid ${colour};border-radius:16px;padding:32px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:48px">${emoji}</div>
        <h2 style="color:#f8fafc;font-size:22px;font-weight:700;margin:12px 0 4px">Subscription ${opts.changeType}</h2>
        <p style="color:#94a3b8;font-size:15px;margin:0">Hi ${escapeHtml(opts.name)}</p>
      </div>
      <div style="background:#0f172a;border-radius:12px;padding:20px;margin-bottom:24px;text-align:center">
        <div style="color:#94a3b8;font-size:13px;margin-bottom:8px">Plan change</div>
        <div style="display:flex;align-items:center;justify-content:center;gap:12px;font-size:18px;font-weight:700">
          <span style="color:#64748b;text-transform:capitalize">${escapeHtml(opts.fromPlan)}</span>
          <span style="color:#6366f1">→</span>
          <span style="color:${colour};text-transform:capitalize">${escapeHtml(opts.toPlan)}</span>
        </div>
        ${effectiveNote}
      </div>
      ${opts.changeType === 'cancelled' ? `<p style="color:#94a3b8;font-size:14px;text-align:center">Your account stays active until the end of your current billing period. After that, you'll be moved to the Free plan.</p>` : ''}
      ${opts.changeType !== 'cancelled' ? `<div style="text-align:center"><a href="${appUrl}/vault" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:600;font-size:15px">View Your Plan</a></div>` : ''}
    </div>
    <p style="text-align:center;color:#475569;font-size:12px;margin-top:24px">DEPLOY Platform · <a href="${appUrl}" style="color:#6366f1;text-decoration:none">deployapp.io</a></p>
  </div>
</body>
</html>`,
      text: `Hi ${opts.name}, your DEPLOY subscription has been ${opts.changeType} from ${opts.fromPlan} to ${opts.toPlan}.${opts.effectiveDate ? ' Effective: ' + opts.effectiveDate : ''}`,
    });
  }
}
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
