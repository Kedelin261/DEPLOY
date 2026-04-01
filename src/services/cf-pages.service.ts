// DEPLOY Platform — Cloudflare Pages Deployment Service
// Handles real CF Pages API calls: project creation, direct uploads, rollback, custom domains.
// ALL calls use the server-side CF_API_TOKEN secret — never exposed to clients.

import type { Bindings } from '../types';

interface CFResponse<T = Record<string, unknown>> {
  success: boolean;
  result: T;
  errors: Array<{ code: number; message: string }>;
}

async function cfRequest<T = Record<string, unknown>>(
  token: string,
  method: string,
  path: string,
  body?: BodyInit,
  contentType?: string
): Promise<T> {
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (contentType) headers['Content-Type'] = contentType;

  const res = await fetch(url, { method, headers, body });
  const json = await res.json() as CFResponse<T>;

  if (!json.success) {
    const msg = json.errors?.[0]?.message || `CF API error ${res.status}`;
    throw new Error(`[CFPages] ${msg}`);
  }
  return json.result;
}

// ─── Helper: encode body as form-data for multipart uploads ──────────────────
function buildFormData(files: Array<{ name: string; content: string; type: string }>): { body: FormData } {
  const form = new FormData();
  for (const f of files) {
    form.append('files', new Blob([f.content], { type: f.type }), f.name);
  }
  return { body: form };
}

export class CFPagesService {
  private token: string;
  private accountId: string;

  constructor(private env: Bindings) {
    this.token = env.CF_API_TOKEN || env.CLOUDFLARE_API_TOKEN || '';
    this.accountId = env.CLOUDFLARE_ACCOUNT_ID || '';
    if (!this.token) throw new Error('CF_API_TOKEN not configured');
    if (!this.accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID not configured');
  }

  // ── Ensure CF Pages project exists ───────────────────────────────────────────
  async ensureProject(projectName: string): Promise<{ name: string; subdomain: string }> {
    try {
      // Try to fetch existing project
      const existing = await cfRequest<{ name: string; subdomain: string }>(
        this.token, 'GET',
        `/accounts/${this.accountId}/pages/projects/${projectName}`
      );
      return existing;
    } catch {
      // Create new project
      const created = await cfRequest<{ name: string; subdomain: string }>(
        this.token, 'POST',
        `/accounts/${this.accountId}/pages/projects`,
        JSON.stringify({ name: projectName, production_branch: 'main' }),
        'application/json'
      );
      return created;
    }
  }

  // ── Deploy generated spec as a static site to CF Pages ───────────────────────
  // Takes the AI-generated spec JSON and wraps it in a minimal HTML/CSS/JS shell.
  async deploySpec(opts: {
    projectName: string;
    specJson: string;
    projectTitle: string;
    deployId: string;
  }): Promise<{ deployment_id: string; url: string; aliases: string[] }> {
    await this.ensureProject(opts.projectName);

    // Build deployable HTML artifact from spec
    const html = this.renderSpecToHTML(opts.projectTitle, opts.specJson);
    const cssContent = this.getDefaultCSS();
    const jsContent = this.getDefaultJS(opts.specJson);

    const form = new FormData();
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    form.append('files', new Blob([cssContent], { type: 'text/css' }), 'styles.css');
    form.append('files', new Blob([jsContent], { type: 'application/javascript' }), 'app.js');
    form.append('files', new Blob([opts.specJson], { type: 'application/json' }), 'spec.json');
    form.append('branch', 'main');
    form.append('commit_message', `Deploy via DEPLOY Platform — job ${opts.deployId}`);

    const result = await cfRequest<{
      id: string;
      url: string;
      aliases: string[];
      short_id: string;
    }>(
      this.token, 'POST',
      `/accounts/${this.accountId}/pages/projects/${opts.projectName}/deployments`,
      form
      // No Content-Type — browser sets multipart boundary automatically
    );

    return {
      deployment_id: result.id,
      url: result.url || `https://${opts.projectName}.pages.dev`,
      aliases: result.aliases || []
    };
  }

  // ── Rollback to a prior deployment ──────────────────────────────────────────
  async rollbackDeployment(projectName: string, deploymentId: string): Promise<void> {
    await cfRequest(
      this.token, 'POST',
      `/accounts/${this.accountId}/pages/projects/${projectName}/deployments/${deploymentId}/retry`
    );
  }

  // ── Add custom domain to a Pages project ─────────────────────────────────────
  async addCustomDomain(projectName: string, domain: string): Promise<{ domain: string; status: string }> {
    const result = await cfRequest<{ name: string; status: string }>(
      this.token, 'POST',
      `/accounts/${this.accountId}/pages/projects/${projectName}/domains`,
      JSON.stringify({ name: domain }),
      'application/json'
    );
    return { domain: result.name, status: result.status };
  }

  // ── Remove custom domain ──────────────────────────────────────────────────────
  async removeCustomDomain(projectName: string, domain: string): Promise<void> {
    await cfRequest(
      this.token, 'DELETE',
      `/accounts/${this.accountId}/pages/projects/${projectName}/domains/${domain}`
    );
  }

  // ── List deployments for a project ───────────────────────────────────────────
  async listDeployments(projectName: string): Promise<Array<{ id: string; url: string; created_on: string; stage: { name: string } }>> {
    return await cfRequest(
      this.token, 'GET',
      `/accounts/${this.accountId}/pages/projects/${projectName}/deployments`
    ) as Array<{ id: string; url: string; created_on: string; stage: { name: string } }>;
  }

  // ── Health check a deployed URL ───────────────────────────────────────────────
  async checkHealth(url: string): Promise<'healthy' | 'degraded' | 'down'> {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (res.status >= 500) return 'degraded';
      if (res.status >= 200 && res.status < 400) return 'healthy';
      return 'degraded';
    } catch {
      return 'down';
    }
  }

  // ── Render spec JSON into a deployable HTML landing page ────────────────────
  private renderSpecToHTML(title: string, specJson: string): string {
    let spec: Record<string, unknown> = {};
    try { spec = JSON.parse(specJson); } catch { /* raw text */ }

    const safeTitle = (title || 'My App').replace(/[<>]/g, '');
    const tagline = this.safeStr(spec.tagline || spec.product_summary || 'Built with DEPLOY Platform');
    const features = this.safeArr(spec.mvp_features || spec.core_features);
    const techStack = this.safeArr(spec.tech_stack || []);
    const audience = this.safeStr(spec.target_audience || '');
    const problem = this.safeStr(spec.problem_statement || '');

    const featuresHTML = features.length
      ? features.map(f => `<li>${this.escHtml(f)}</li>`).join('\n')
      : '<li>See full specification below</li>';

    const stackHTML = techStack.length
      ? techStack.map(t => `<span class="tag">${this.escHtml(t)}</span>`).join(' ')
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<link rel="stylesheet" href="styles.css">
<meta name="description" content="${this.escHtml(tagline)}">
<meta property="og:title" content="${safeTitle}">
<meta property="og:description" content="${this.escHtml(tagline)}">
</head>
<body>
<header class="hero">
  <nav><span class="brand">⚡ Built with DEPLOY</span></nav>
  <div class="hero-content">
    <h1>${safeTitle}</h1>
    <p class="tagline">${this.escHtml(tagline)}</p>
    ${stackHTML ? `<div class="tags">${stackHTML}</div>` : ''}
  </div>
</header>
<main>
  ${audience ? `<section class="section"><h2>Who It's For</h2><p>${this.escHtml(audience)}</p></section>` : ''}
  ${problem ? `<section class="section"><h2>Problem We Solve</h2><p>${this.escHtml(problem)}</p></section>` : ''}
  <section class="section">
    <h2>Core Features</h2>
    <ul class="feature-list">${featuresHTML}</ul>
  </section>
  <section class="section spec-section">
    <h2>Full Specification</h2>
    <div id="spec-viewer"></div>
  </section>
</main>
<footer>
  <p>Generated by <a href="https://deploy-app.pages.dev">DEPLOY Platform</a></p>
</footer>
<script src="app.js"></script>
</body>
</html>`;
  }

  private getDefaultCSS(): string {
    return `*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;line-height:1.6}
.hero{background:linear-gradient(135deg,#1e1b4b 0%,#0f172a 100%);padding:60px 24px;text-align:center}
nav{margin-bottom:24px}.brand{font-size:13px;color:#818cf8;font-weight:600;letter-spacing:.05em;text-transform:uppercase}
h1{font-size:clamp(28px,5vw,52px);font-weight:900;color:#f8fafc;letter-spacing:-1px;margin-bottom:12px}
.tagline{font-size:18px;color:#94a3b8;max-width:640px;margin:0 auto 24px}
.tags{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.tag{background:rgba(99,102,241,.2);border:1px solid rgba(99,102,241,.4);color:#a5b4fc;padding:4px 12px;border-radius:99px;font-size:13px;font-weight:500}
main{max-width:800px;margin:0 auto;padding:40px 24px}
.section{margin-bottom:40px;background:#1e293b;border:1px solid #334155;border-radius:16px;padding:28px}
h2{font-size:20px;font-weight:700;color:#f1f5f9;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #334155}
p{color:#94a3b8;font-size:15px}
.feature-list{list-style:none;display:grid;gap:10px}
.feature-list li{padding:10px 16px;background:#0f172a;border-radius:8px;border-left:3px solid #6366f1;color:#cbd5e1;font-size:14px}
.spec-section pre{background:#0f172a;padding:20px;border-radius:10px;overflow-x:auto;font-size:13px;color:#94a3b8;border:1px solid #1e293b}
footer{text-align:center;padding:24px;color:#475569;font-size:13px}
footer a{color:#6366f1;text-decoration:none}`;
  }

  private getDefaultJS(specJson: string): string {
    const safe = specJson.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    return `(function(){
  const spec = ${safe};
  const viewer = document.getElementById('spec-viewer');
  if (!viewer) return;
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(spec, null, 2);
  viewer.appendChild(pre);
})();`;
  }

  private safeStr(val: unknown): string {
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) return val.join(', ');
    return String(val || '');
  }

  private safeArr(val: unknown): string[] {
    if (Array.isArray(val)) return val.map(String);
    if (typeof val === 'string') {
      try { const p = JSON.parse(val); if (Array.isArray(p)) return p.map(String); } catch { /* */ }
      return val.split('\n').map(s => s.trim()).filter(Boolean);
    }
    return [];
  }

  private escHtml(str: string): string {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
}
