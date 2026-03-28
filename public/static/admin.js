// DEPLOY Platform — Admin Dashboard Frontend
// All calls go through Intent Layer (API endpoints only). No direct DB access.

// ============================================================
// STATE
// ============================================================
const ADMIN = {
  token: localStorage.getItem('deploy_admin_token'),
  user: null,
  currentPanel: 'dashboard',
};

const API = axios.create({ baseURL: '/api' });
API.interceptors.request.use(cfg => {
  if (ADMIN.token) cfg.headers.Authorization = `Bearer ${ADMIN.token}`;
  return cfg;
});
API.interceptors.response.use(r => r, err => {
  if (err.response?.status === 401 || err.response?.status === 403) {
    adminLogout();
  }
  return Promise.reject(err);
});

// Pagination state
let usersPage  = 1;
let loginsPage = 1;
let revenuePage= 1;
let coinsPage  = 1;
let buildsPage = 1;
let auditPage  = 1;

// Coin adjust target
let coinAdjustUserId = null;

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  if (ADMIN.token) {
    verifyAdminToken();
  }
  // Enter key on password field
  const pwEl = document.getElementById('admin-login-password');
  if (pwEl) pwEl.addEventListener('keydown', e => { if (e.key === 'Enter') adminLogin(); });
});

async function verifyAdminToken() {
  try {
    const { data } = await API.get('/auth/me');
    if (data.success && data.data.role === 'admin') {
      ADMIN.user = data.data;
      showAdminApp();
    } else {
      adminLogout();
    }
  } catch {
    adminLogout();
  }
}

// ============================================================
// AUTH
// ============================================================
async function adminLogin() {
  const email    = document.getElementById('admin-login-email').value.trim();
  const password = document.getElementById('admin-login-password').value;
  if (!email || !password) { adminToast('Enter email and password', 'error'); return; }

  try {
    const { data } = await API.post('/auth/login', { email, password });
    if (data.success) {
      if (data.data.user.role !== 'admin') {
        adminToast('Not an admin account', 'error');
        return;
      }
      ADMIN.token = data.data.token;
      ADMIN.user  = data.data.user;
      localStorage.setItem('deploy_admin_token', ADMIN.token);
      showAdminApp();
    }
  } catch (err) {
    adminToast(err.response?.data?.error || 'Login failed', 'error');
  }
}

function adminLogout() {
  ADMIN.token = null;
  ADMIN.user  = null;
  localStorage.removeItem('deploy_admin_token');
  document.getElementById('admin-login-screen').style.display = 'flex';
  document.getElementById('admin-app-screen').style.display   = 'none';
  document.getElementById('admin-login-password').value = '';
}

function showAdminApp() {
  document.getElementById('admin-login-screen').style.display = 'none';
  document.getElementById('admin-app-screen').style.display   = 'block';

  // Populate sidebar
  document.getElementById('sidebar-admin-name').textContent  = ADMIN.user?.name || 'Admin';
  document.getElementById('sidebar-admin-email').textContent = ADMIN.user?.email || '—';

  // Render API keys list
  renderApiKeysList();

  // Load dashboard
  showPanel('dashboard');
}

// ============================================================
// PANEL NAVIGATION
// ============================================================
const PANEL_META = {
  dashboard: { title: 'Dashboard', subtitle: 'Platform overview' },
  users:     { title: 'All Users', subtitle: 'Manage user accounts' },
  logins:    { title: 'Login History', subtitle: 'Recent authentication events' },
  revenue:   { title: 'Revenue', subtitle: 'All payment transactions' },
  coins:     { title: 'Coin Ledger', subtitle: 'Platform-wide coin economy' },
  builds:    { title: 'Build Jobs', subtitle: 'All AI build requests' },
  audit:     { title: 'Audit Log', subtitle: 'Every significant platform action' },
  flags:     { title: 'Feature Flags', subtitle: 'Toggle features globally' },
  stripe:    { title: 'Stripe Setup', subtitle: 'Connect bank account to receive payments' },
  apikeys:   { title: 'API Keys Guide', subtitle: 'All keys required for full operation' },
};

function showPanel(name) {
  // Hide all panels
  Object.keys(PANEL_META).forEach(p => {
    const el = document.getElementById(`panel-${p}`);
    if (el) el.classList.add('hidden');
  });
  // Deactivate nav
  document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));

  // Show panel
  const el = document.getElementById(`panel-${name}`);
  if (el) { el.classList.remove('hidden'); el.classList.add('animate-fade-up'); }

  // Activate nav
  const navEl = document.getElementById(`nav-${name}`);
  if (navEl) navEl.classList.add('active');

  // Update header
  const meta = PANEL_META[name] || { title: name, subtitle: '' };
  document.getElementById('panel-title').textContent    = meta.title;
  document.getElementById('panel-subtitle').textContent = meta.subtitle;

  ADMIN.currentPanel = name;

  // Load data
  const loaders = {
    dashboard: loadDashboard,
    users:     () => { usersPage = 1; loadUsers(); },
    logins:    () => { loginsPage = 1; loadLogins(); },
    revenue:   () => { revenuePage = 1; loadRevenue(); },
    coins:     () => { coinsPage = 1; loadCoins(); },
    builds:    () => { buildsPage = 1; loadBuilds(); },
    audit:     () => { auditPage = 1; loadAudit(); },
    flags:     loadFlags,
  };
  if (loaders[name]) loaders[name]();
}

function refreshCurrentPanel() { showPanel(ADMIN.currentPanel); }

// ============================================================
// DASHBOARD
// ============================================================
async function loadDashboard() {
  try {
    const { data } = await API.get('/admin/stats');
    if (!data.success) return;
    const { users, projects, builds, revenue, coins, logins } = data.data;

    // Stat grid 1 — users & projects
    document.getElementById('stat-grid').innerHTML = [
      statCard('fas fa-users', 'text-cyan-400', 'Total Users', fmtNum(users?.total), `+${fmtNum(users?.last_7d)} this week`, '#06b6d4'),
      statCard('fas fa-user-check', 'text-emerald-400', 'Active Users', fmtNum(users?.active), `${fmtNum(users?.suspended)} suspended`, '#4ade80'),
      statCard('fas fa-folder', 'text-purple-400', 'Total Projects', fmtNum(projects?.total), `${fmtNum(projects?.built)} built`, '#a855f7'),
      statCard('fas fa-right-to-bracket', 'text-blue-400', 'Logins (30d)', fmtNum(logins?.total_logins_30d), 'authentication events', '#60a5fa'),
    ].join('');

    // Stat grid 2 — builds & economy
    document.getElementById('stat-grid-2').innerHTML = [
      statCard('fas fa-hammer', 'text-amber-400', 'Total Builds', fmtNum(builds?.total), `${fmtNum(builds?.completed)} completed`, '#fbbf24'),
      statCard('fas fa-xmark-circle', 'text-red-400', 'Failed Builds', fmtNum(builds?.failed), 'build failures', '#f87171'),
      statCard('fas fa-coins', 'text-amber-400', 'Coins in Circulation', fmtNum(coins?.total_coins_held), `${fmtNum(coins?.total_coins_spent)} spent total`, '#fbbf24'),
      statCard('fas fa-dollar-sign', 'text-emerald-400', 'Total Revenue', `$${((revenue?.total_cents||0)/100).toFixed(2)}`, `$${((revenue?.last_30d_cents||0)/100).toFixed(2)} last 30d`, '#4ade80'),
    ].join('');

    // Recent users
    const usersRes = await API.get('/admin/users?page=1');
    if (usersRes.data.success) {
      document.getElementById('dash-recent-users').innerHTML = usersRes.data.data.slice(0,5).map(u => `
        <div class="flex items-center justify-between py-2 border-b border-slate-800 last:border-0">
          <div>
            <p class="text-sm font-medium text-white">${escHtml(u.name)}</p>
            <p class="text-xs text-slate-500">${escHtml(u.email)}</p>
          </div>
          <div class="text-right">
            <span class="chip-${u.status} text-xs px-2 py-0.5 rounded-full">${u.status}</span>
            <p class="text-xs text-slate-600 mt-0.5">${u.plan || 'free'}</p>
          </div>
        </div>
      `).join('');
    }

    // Recent builds
    const buildsRes = await API.get('/admin/builds?page=1');
    if (buildsRes.data.success) {
      document.getElementById('dash-recent-builds').innerHTML = buildsRes.data.data.slice(0,5).map(b => `
        <div class="flex items-center justify-between py-2 border-b border-slate-800 last:border-0">
          <div>
            <p class="text-sm font-medium text-white">${escHtml(b.project_name||'—')}</p>
            <p class="text-xs text-slate-500">${escHtml(b.email||'—')} · ${b.model_id||'—'}</p>
          </div>
          <div class="text-right">
            <span class="chip-${b.status} text-xs px-2 py-0.5 rounded-full">${b.status}</span>
            <p class="text-xs text-amber-400 mt-0.5">${b.coins_charged||b.coins_held||0} coins</p>
          </div>
        </div>
      `).join('');
    }

  } catch (err) {
    console.error('Dashboard load error:', err);
  }
}

function statCard(icon, iconColor, label, value, sub, color) {
  return `
    <div class="glass rounded-2xl p-5 stat-card" style="border:1px solid rgba(34,211,238,0.1)">
      <div class="flex items-start justify-between mb-3">
        <div class="w-9 h-9 rounded-xl flex items-center justify-center" style="background:${color}22">
          <i class="${icon} ${iconColor} text-sm"></i>
        </div>
      </div>
      <p class="text-2xl font-black text-white mb-0.5">${value || '0'}</p>
      <p class="text-xs font-semibold text-slate-400">${label}</p>
      <p class="text-xs text-slate-600 mt-0.5">${sub || ''}</p>
    </div>`;
}

// ============================================================
// USERS
// ============================================================
async function loadUsers() {
  const search = document.getElementById('user-search')?.value || '';
  const status = document.getElementById('user-status-filter')?.value || '';
  const plan   = document.getElementById('user-plan-filter')?.value || '';

  try {
    const params = new URLSearchParams({ page: usersPage, search, status, plan });
    const { data } = await API.get(`/admin/users?${params}`);
    if (!data.success) return;

    const tbody = document.getElementById('users-table-body');
    tbody.innerHTML = data.data.length === 0
      ? `<tr><td colspan="7" class="text-center py-12 text-slate-500">No users found</td></tr>`
      : data.data.map(u => `
        <tr class="table-row border-b border-slate-800/50">
          <td class="px-5 py-3">
            <div>
              <p class="text-sm font-semibold text-white">${escHtml(u.name)}</p>
              <p class="text-xs text-slate-500">${escHtml(u.email)}</p>
              <p class="text-xs text-slate-600 font-mono">${u.id}</p>
            </div>
          </td>
          <td class="px-3 py-3">
            <span class="text-xs text-slate-300 capitalize">${u.plan || 'free'}</span>
          </td>
          <td class="px-3 py-3">
            <span class="chip-${u.status} text-xs px-2 py-0.5 rounded-full">${u.status}</span>
            ${u.role === 'admin' ? '<span class="chip-admin text-xs px-2 py-0.5 rounded-full ml-1">admin</span>' : ''}
          </td>
          <td class="px-3 py-3 text-right">
            <span class="text-amber-400 font-semibold text-sm">${fmtNum(u.coins||0)}</span>
          </td>
          <td class="px-3 py-3 text-right text-slate-400 text-sm">${u.project_count||0}</td>
          <td class="px-3 py-3 text-right text-xs text-slate-500">${fmtDate(u.last_login)}</td>
          <td class="px-5 py-3 text-right">
            <div class="flex items-center justify-end gap-1.5">
              <button onclick="openUserDetail('${u.id}')" class="btn-ghost px-2.5 py-1.5 rounded-lg text-xs">
                <i class="fas fa-eye"></i>
              </button>
              <button onclick="openCoinAdjust('${u.id}', '${escHtml(u.name)}')" class="btn-ghost px-2.5 py-1.5 rounded-lg text-xs text-amber-400">
                <i class="fas fa-coins"></i>
              </button>
              <button onclick="toggleUserStatus('${u.id}', '${u.status}')"
                class="${u.status === 'active' ? 'btn-danger' : 'btn-ghost text-emerald-400'} px-2.5 py-1.5 rounded-lg text-xs">
                <i class="fas fa-${u.status === 'active' ? 'ban' : 'check'}"></i>
              </button>
            </div>
          </td>
        </tr>
      `).join('');

    document.getElementById('users-count').textContent = `Showing ${data.data.length} of ${data.total} users (page ${usersPage})`;
    document.getElementById('users-prev').disabled = usersPage <= 1;
    document.getElementById('users-next').disabled = data.data.length < (data.limit || 25);
  } catch {}
}

async function openUserDetail(userId) {
  const modal = document.getElementById('modal-user');
  const content = document.getElementById('modal-user-content');
  modal.classList.remove('hidden');
  content.innerHTML = '<div class="shimmer h-48 rounded-xl"></div>';

  try {
    // Find user from current table data (re-fetch if needed)
    const { data } = await API.get(`/admin/users?search=${userId}&page=1`);
    const u = data.data?.find(x => x.id === userId);
    if (!u) { content.innerHTML = '<p class="text-slate-500 text-sm">User not found</p>'; return; }

    content.innerHTML = `
      <div class="space-y-4">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 rounded-2xl flex items-center justify-center text-lg font-black"
               style="background:linear-gradient(135deg,#06b6d4,#fbbf24)">${(u.name||'U')[0].toUpperCase()}</div>
          <div>
            <p class="font-bold text-white">${escHtml(u.name)}</p>
            <p class="text-xs text-slate-500">${escHtml(u.email)}</p>
            <div class="flex gap-1 mt-1">
              <span class="chip-${u.status} text-xs px-2 py-0.5 rounded-full">${u.status}</span>
              ${u.role === 'admin' ? '<span class="chip-admin text-xs px-2 py-0.5 rounded-full">admin</span>' : ''}
            </div>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3 text-xs">
          <div class="glass rounded-xl p-3"><p class="text-slate-500 mb-0.5">Plan</p><p class="font-semibold text-white capitalize">${u.plan||'free'}</p></div>
          <div class="glass rounded-xl p-3"><p class="text-slate-500 mb-0.5">Coins</p><p class="font-semibold text-amber-400">${fmtNum(u.coins||0)}</p></div>
          <div class="glass rounded-xl p-3"><p class="text-slate-500 mb-0.5">Projects</p><p class="font-semibold text-white">${u.project_count||0}</p></div>
          <div class="glass rounded-xl p-3"><p class="text-slate-500 mb-0.5">Builds</p><p class="font-semibold text-white">${u.build_count||0}</p></div>
          <div class="glass rounded-xl p-3"><p class="text-slate-500 mb-0.5">Ever Earned</p><p class="font-semibold text-white">${fmtNum(u.coins_ever_earned||0)} coins</p></div>
          <div class="glass rounded-xl p-3"><p class="text-slate-500 mb-0.5">Coins Spent</p><p class="font-semibold text-white">${fmtNum(u.coins_spent||0)} coins</p></div>
          <div class="glass rounded-xl p-3 col-span-2"><p class="text-slate-500 mb-0.5">Last Login</p><p class="font-semibold text-white">${u.last_login ? new Date(u.last_login).toLocaleString() : 'Never'}</p></div>
          <div class="glass rounded-xl p-3 col-span-2"><p class="text-slate-500 mb-0.5">User ID</p><p class="font-mono text-xs text-cyan-400">${u.id}</p></div>
          <div class="glass rounded-xl p-3 col-span-2"><p class="text-slate-500 mb-0.5">Joined</p><p class="font-semibold text-white">${u.created_at ? new Date(u.created_at).toLocaleString() : '—'}</p></div>
        </div>
        <div class="flex gap-2 flex-wrap">
          <button onclick="openCoinAdjust('${u.id}','${escHtml(u.name)}'); closeAdminModal('modal-user')"
            class="btn-ghost px-4 py-2 rounded-xl text-xs font-semibold flex-1">
            <i class="fas fa-coins mr-1 text-amber-400"></i> Adjust Coins
          </button>
          <button onclick="toggleUserStatus('${u.id}','${u.status}'); closeAdminModal('modal-user')"
            class="${u.status === 'active' ? 'btn-danger' : 'btn-ghost text-emerald-400'} px-4 py-2 rounded-xl text-xs font-semibold flex-1">
            <i class="fas fa-${u.status === 'active' ? 'ban' : 'check'} mr-1"></i>
            ${u.status === 'active' ? 'Suspend' : 'Reactivate'}
          </button>
          ${u.role !== 'admin' ? `
          <button onclick="promoteToAdmin('${u.id}'); closeAdminModal('modal-user')"
            class="btn-ghost px-4 py-2 rounded-xl text-xs font-semibold flex-1">
            <i class="fas fa-user-shield mr-1 text-purple-400"></i> Make Admin
          </button>` : ''}
        </div>
      </div>`;
  } catch { content.innerHTML = '<p class="text-red-400 text-sm">Error loading user details</p>'; }
}

async function toggleUserStatus(userId, currentStatus) {
  const newStatus = currentStatus === 'active' ? 'suspended' : 'active';
  const reason = currentStatus === 'active'
    ? prompt('Reason for suspending this user?')
    : 'Reactivated by admin';
  if (reason === null) return;

  try {
    await API.put(`/admin/users/${userId}/status`, { status: newStatus, reason });
    adminToast(`User ${newStatus}`, 'success');
    loadUsers();
  } catch (err) {
    adminToast(err.response?.data?.error || 'Failed', 'error');
  }
}

async function promoteToAdmin(userId) {
  if (!confirm('Promote this user to admin? They will have full platform access.')) return;
  try {
    await API.put(`/admin/users/${userId}/role`, { role: 'admin' });
    adminToast('User promoted to admin', 'success');
    loadUsers();
  } catch (err) {
    adminToast(err.response?.data?.error || 'Failed', 'error');
  }
}

// Debounced search
let searchTimer;
function debounceSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { usersPage = 1; loadUsers(); }, 400);
}

// ============================================================
// COIN ADJUST
// ============================================================
function openCoinAdjust(userId, userName) {
  coinAdjustUserId = userId;
  document.getElementById('coin-adjust-user-label').textContent = `User: ${userName} (${userId})`;
  document.getElementById('coin-adjust-amount').value  = '';
  document.getElementById('coin-adjust-reason').value  = '';
  document.getElementById('modal-coin-adjust').classList.remove('hidden');
}

async function submitCoinAdjust() {
  const amount = parseInt(document.getElementById('coin-adjust-amount').value);
  const reason = document.getElementById('coin-adjust-reason').value.trim();
  if (isNaN(amount) || amount === 0) { adminToast('Enter a non-zero amount', 'error'); return; }
  if (!reason) { adminToast('Reason is required', 'error'); return; }

  try {
    await API.post('/admin/coins/adjust', { user_id: coinAdjustUserId, amount, reason });
    adminToast(`${Math.abs(amount)} coins ${amount > 0 ? 'credited' : 'debited'}`, 'success');
    closeAdminModal('modal-coin-adjust');
    if (ADMIN.currentPanel === 'users') loadUsers();
    if (ADMIN.currentPanel === 'coins') loadCoins();
  } catch (err) {
    adminToast(err.response?.data?.error || 'Failed', 'error');
  }
}

// ============================================================
// LOGINS
// ============================================================
async function loadLogins() {
  try {
    const { data } = await API.get(`/admin/logins?page=${loginsPage}`);
    if (!data.success) return;

    const tbody = document.getElementById('logins-table-body');
    tbody.innerHTML = data.data.length === 0
      ? `<tr><td colspan="5" class="text-center py-12 text-slate-500">No login events found</td></tr>`
      : data.data.map(s => `
        <tr class="table-row border-b border-slate-800/50">
          <td class="px-5 py-3">
            <p class="text-sm font-semibold text-white">${escHtml(s.name||'—')}</p>
            <p class="text-xs text-slate-500">${escHtml(s.email||'—')}</p>
          </td>
          <td class="px-3 py-3">
            ${s.role === 'admin'
              ? '<span class="chip-admin text-xs px-2 py-0.5 rounded-full">admin</span>'
              : '<span class="text-xs text-slate-400">user</span>'}
          </td>
          <td class="px-3 py-3 text-xs text-slate-400 font-mono">${escHtml(s.ip_address||'—')}</td>
          <td class="px-3 py-3 text-xs text-slate-500 max-w-xs truncate">${escHtml((s.user_agent||'').substring(0,60))}</td>
          <td class="px-5 py-3 text-right text-xs text-slate-500">${fmtDate(s.login_at)}</td>
        </tr>
      `).join('');

    document.getElementById('logins-count').textContent = `Page ${loginsPage} · ${data.data.length} events`;
    document.getElementById('logins-prev').disabled = loginsPage <= 1;
    document.getElementById('logins-next').disabled = data.data.length < 50;
  } catch {}
}

// ============================================================
// REVENUE
// ============================================================
async function loadRevenue() {
  try {
    // Revenue stats from dashboard
    const statsRes = await API.get('/admin/stats');
    if (statsRes.data.success) {
      const rev = statsRes.data.data.revenue;
      document.getElementById('revenue-stats').innerHTML = [
        revStatCard('Total Revenue', `$${((rev?.total_cents||0)/100).toFixed(2)}`, 'all time', '#4ade80'),
        revStatCard('Last 30 Days',  `$${((rev?.last_30d_cents||0)/100).toFixed(2)}`, 'rolling 30d', '#22d3ee'),
        revStatCard('Transactions',  fmtNum(rev?.total_transactions), 'completed payments', '#fbbf24'),
      ].join('');
    }

    const { data } = await API.get(`/admin/revenue?page=${revenuePage}`);
    if (!data.success) return;

    const tbody = document.getElementById('revenue-table-body');
    tbody.innerHTML = data.data.length === 0
      ? `<tr><td colspan="6" class="text-center py-12 text-slate-500">No transactions yet</td></tr>`
      : data.data.map(t => `
        <tr class="table-row border-b border-slate-800/50">
          <td class="px-5 py-3">
            <p class="text-sm font-semibold text-white">${escHtml(t.name||'—')}</p>
            <p class="text-xs text-slate-500">${escHtml(t.email||'—')}</p>
          </td>
          <td class="px-3 py-3 text-xs text-slate-400">${t.event_type||'—'}</td>
          <td class="px-3 py-3">
            <span class="chip-${t.status==='completed'?'completed':t.status==='failed'?'failed':'pending'} text-xs px-2 py-0.5 rounded-full">${t.status}</span>
          </td>
          <td class="px-3 py-3 text-right text-amber-400 font-semibold text-sm">${fmtNum(t.coins_granted||0)}</td>
          <td class="px-3 py-3 text-right text-emerald-400 font-bold">${t.amount_cents ? '$'+(t.amount_cents/100).toFixed(2) : '—'}</td>
          <td class="px-5 py-3 text-right text-xs text-slate-500">${fmtDate(t.created_at)}</td>
        </tr>
      `).join('');

    document.getElementById('revenue-count').textContent = `Page ${revenuePage} · ${data.data.length} records`;
    document.getElementById('revenue-prev').disabled = revenuePage <= 1;
    document.getElementById('revenue-next').disabled = data.data.length < 50;
  } catch {}
}

function revStatCard(label, value, sub, color) {
  return `
    <div class="glass rounded-2xl p-5">
      <p class="text-xs text-slate-500 mb-1">${label}</p>
      <p class="text-2xl font-black" style="color:${color}">${value}</p>
      <p class="text-xs text-slate-600 mt-1">${sub}</p>
    </div>`;
}

// ============================================================
// COIN LEDGER
// ============================================================
async function loadCoins() {
  const type = document.getElementById('coin-type-filter')?.value || '';
  try {
    const params = new URLSearchParams({ page: coinsPage, type });
    const { data } = await API.get(`/admin/coins/ledger?${params}`);
    if (!data.success) return;

    const tbody = document.getElementById('coins-table-body');
    tbody.innerHTML = data.data.length === 0
      ? `<tr><td colspan="6" class="text-center py-12 text-slate-500">No coin events found</td></tr>`
      : data.data.map(e => {
          const isCredit = e.amount > 0;
          return `
          <tr class="table-row border-b border-slate-800/50">
            <td class="px-5 py-3">
              <p class="text-sm font-semibold text-white">${escHtml(e.name||'—')}</p>
              <p class="text-xs text-slate-500">${escHtml(e.email||'—')}</p>
            </td>
            <td class="px-3 py-3">
              <span class="text-xs px-2 py-0.5 rounded-full ${isCredit ? 'chip-completed' : 'chip-failed'}">${e.entry_type||'—'}</span>
            </td>
            <td class="px-3 py-3 text-right font-bold ${isCredit ? 'text-emerald-400' : 'text-red-400'}">
              ${isCredit ? '+' : ''}${fmtNum(e.amount)}
            </td>
            <td class="px-3 py-3 text-right text-amber-400 text-sm">${fmtNum(e.balance_after||0)}</td>
            <td class="px-3 py-3 text-xs text-slate-500 max-w-xs truncate">${escHtml((e.description||'').substring(0,60))}</td>
            <td class="px-5 py-3 text-right text-xs text-slate-500">${fmtDate(e.created_at)}</td>
          </tr>`;
        }).join('');

    document.getElementById('coins-count').textContent = `Page ${coinsPage} · ${data.data.length} events`;
    document.getElementById('coins-prev').disabled = coinsPage <= 1;
    document.getElementById('coins-next').disabled = data.data.length < 50;
  } catch {}
}

// ============================================================
// BUILDS
// ============================================================
async function loadBuilds() {
  const status = document.getElementById('build-status-filter')?.value || '';
  try {
    const params = new URLSearchParams({ page: buildsPage, status });
    const { data } = await API.get(`/admin/builds?${params}`);
    if (!data.success) return;

    const tbody = document.getElementById('builds-table-body');
    tbody.innerHTML = data.data.length === 0
      ? `<tr><td colspan="6" class="text-center py-12 text-slate-500">No build jobs found</td></tr>`
      : data.data.map(b => `
        <tr class="table-row border-b border-slate-800/50">
          <td class="px-5 py-3">
            <p class="text-sm font-semibold text-white">${escHtml(b.name||'—')}</p>
            <p class="text-xs text-slate-500">${escHtml(b.email||'—')}</p>
          </td>
          <td class="px-3 py-3 text-xs text-slate-400">${escHtml(b.project_name||'—')}</td>
          <td class="px-3 py-3 text-xs text-slate-400 font-mono">${b.model_id||'—'}</td>
          <td class="px-3 py-3">
            <span class="chip-${b.status} text-xs px-2 py-0.5 rounded-full">${b.status}</span>
          </td>
          <td class="px-3 py-3 text-right">
            <span class="text-amber-400 font-semibold text-sm">${b.coins_charged||b.coins_held||0}</span>
          </td>
          <td class="px-5 py-3 text-right text-xs text-slate-500">${fmtDate(b.created_at)}</td>
        </tr>
      `).join('');

    document.getElementById('builds-count').textContent = `Page ${buildsPage} · ${data.data.length} jobs`;
    document.getElementById('builds-prev').disabled = buildsPage <= 1;
    document.getElementById('builds-next').disabled = data.data.length < 50;
  } catch {}
}

// ============================================================
// AUDIT LOG
// ============================================================
async function loadAudit() {
  const action = document.getElementById('audit-action-filter')?.value || '';
  try {
    const params = new URLSearchParams({ page: auditPage, action });
    const { data } = await API.get(`/admin/audit-log?${params}`);
    if (!data.success) return;

    const tbody = document.getElementById('audit-table-body');
    tbody.innerHTML = data.data.length === 0
      ? `<tr><td colspan="5" class="text-center py-12 text-slate-500">No audit events found</td></tr>`
      : data.data.map(a => `
        <tr class="table-row border-b border-slate-800/50">
          <td class="px-5 py-3">
            <p class="text-sm font-semibold text-white font-mono">${escHtml(a.action||'—')}</p>
            ${a.entity_type ? `<p class="text-xs text-slate-500">${a.entity_type}</p>` : ''}
          </td>
          <td class="px-3 py-3">
            <p class="text-sm text-slate-300">${escHtml(a.user_name||'System')}</p>
            <p class="text-xs text-slate-500">${escHtml(a.user_email||'—')}</p>
          </td>
          <td class="px-3 py-3 text-xs text-slate-500 font-mono">${a.entity_id ? a.entity_id.substring(0,16)+'…' : '—'}</td>
          <td class="px-3 py-3 text-xs text-slate-500 font-mono">${escHtml(a.ip_address||'—')}</td>
          <td class="px-5 py-3 text-right text-xs text-slate-500">${fmtDate(a.created_at)}</td>
        </tr>
      `).join('');

    document.getElementById('audit-count').textContent = `Page ${auditPage} · ${data.data.length} events`;
    document.getElementById('audit-prev').disabled = auditPage <= 1;
    document.getElementById('audit-next').disabled = data.data.length < 50;
  } catch {}
}

let auditTimer;
function debounceAudit() {
  clearTimeout(auditTimer);
  auditTimer = setTimeout(() => { auditPage = 1; loadAudit(); }, 400);
}

// ============================================================
// FEATURE FLAGS
// ============================================================
async function loadFlags() {
  try {
    const { data } = await API.get('/admin/feature-flags');
    if (!data.success) return;

    const container = document.getElementById('flags-list');
    container.innerHTML = data.data.length === 0
      ? '<p class="text-slate-500 text-sm">No feature flags configured</p>'
      : data.data.map(f => `
        <div class="flex items-center justify-between p-4 glass rounded-xl">
          <div>
            <p class="text-sm font-semibold text-white font-mono">${escHtml(f.key)}</p>
            <p class="text-xs text-slate-500 mt-0.5">${escHtml(f.description||'')}</p>
          </div>
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" class="sr-only peer" ${f.value === 'true' ? 'checked' : ''}
              onchange="updateFlag('${f.key}', this.checked)">
            <div class="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer
              peer-checked:after:translate-x-full peer-checked:after:border-white
              after:content-[''] after:absolute after:top-[2px] after:left-[2px]
              after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all
              peer-checked:bg-cyan-500"></div>
          </label>
        </div>
      `).join('');
  } catch {}
}

async function updateFlag(key, value) {
  try {
    await API.put(`/admin/feature-flags/${key}`, { value: value ? 'true' : 'false' });
    adminToast(`Flag "${key}" ${value ? 'enabled' : 'disabled'}`, 'success');
  } catch (err) {
    adminToast(err.response?.data?.error || 'Failed', 'error');
    loadFlags(); // revert
  }
}

// ============================================================
// API KEYS LIST (static render)
// ============================================================
function renderApiKeysList() {
  const keys = [
    { icon:'fas fa-key',      color:'#fbbf24', title:'JWT_SECRET',             required:true,  desc:'32+ character random string for signing user sessions.', where:'Generate: openssl rand -hex 32' },
    { icon:'fab fa-stripe-s', color:'#a855f7', title:'STRIPE_SECRET_KEY',      required:true,  desc:'Server-side key to create charges and manage subscriptions.', where:'stripe.com → Dashboard → Developers → API Keys' },
    { icon:'fab fa-stripe-s', color:'#818cf8', title:'STRIPE_WEBHOOK_SECRET',  required:true,  desc:'Validates Stripe event webhooks (payment success, subscription updates).', where:'stripe.com → Webhooks → Add endpoint → signing secret' },
    { icon:'fab fa-stripe-s', color:'#6366f1', title:'STRIPE_PUBLISHABLE_KEY', required:true,  desc:'Frontend Stripe.js key — safe to expose in JavaScript.', where:'stripe.com → Dashboard → Developers → API Keys' },
    { icon:'fas fa-robot',    color:'#4ade80', title:'OPENAI_API_KEY',         required:true,  desc:'Access to GPT-4o, GPT-4o Mini, o1-mini AI models.', where:'platform.openai.com/api-keys' },
    { icon:'fas fa-brain',    color:'#fb923c', title:'ANTHROPIC_API_KEY',      required:true,  desc:'Access to Claude 3.5 Sonnet, Haiku, and Claude 3 Opus.', where:'console.anthropic.com → API Keys' },
    { icon:'fas fa-envelope', color:'#22d3ee', title:'RESEND_API_KEY',         required:false, desc:'Transactional email for welcome emails, password resets, notifications.', where:'resend.com → API Keys' },
    { icon:'fas fa-cloud',    color:'#60a5fa', title:'CLOUDFLARE_ACCOUNT_ID',  required:true,  desc:'Your Cloudflare account ID for D1, R2, and Workers.', where:'Cloudflare Dashboard → right sidebar → Account ID' },
    { icon:'fas fa-shield',   color:'#93c5fd', title:'CLOUDFLARE_API_TOKEN',   required:true,  desc:'Deploy token for Wrangler CLI to deploy to Pages.', where:'Cloudflare → My Profile → API Tokens → Create Token' },
  ];

  const el = document.getElementById('apikeys-list');
  if (!el) return;
  el.innerHTML = keys.map(k => `
    <div class="flex gap-4 p-4 glass rounded-xl">
      <div class="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
           style="background:${k.color}22">
        <i class="${k.icon} text-sm" style="color:${k.color}"></i>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-1">
          <code class="text-sm font-bold text-cyan-400">${k.title}</code>
          <span class="text-xs px-1.5 py-0.5 rounded-full ${k.required ? 'bg-red-500/20 text-red-400' : 'bg-slate-700 text-slate-400'}">${k.required ? 'Required' : 'Optional'}</span>
        </div>
        <p class="text-xs text-slate-400 mb-1">${k.desc}</p>
        <p class="text-xs text-slate-600"><i class="fas fa-map-marker-alt mr-1"></i>${k.where}</p>
      </div>
    </div>
  `).join('');
}

// ============================================================
// MODALS
// ============================================================
function closeAdminModal(id) {
  document.getElementById(id)?.classList.add('hidden');
}

// ============================================================
// UTILITIES
// ============================================================
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtNum(n) {
  if (n == null || n === '') return '0';
  return Number(n).toLocaleString();
}

function fmtDate(d) {
  if (!d) return '—';
  try {
    const date = new Date(d);
    const now = new Date();
    const diff = now - date;
    if (diff < 60000)       return 'Just now';
    if (diff < 3600000)     return `${Math.floor(diff/60000)}m ago`;
    if (diff < 86400000)    return `${Math.floor(diff/3600000)}h ago`;
    if (diff < 2592000000)  return `${Math.floor(diff/86400000)}d ago`;
    return date.toLocaleDateString();
  } catch { return d; }
}

function adminToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = type === 'success' ? 'fa-circle-check text-emerald-400'
              : type === 'error'  ? 'fa-circle-xmark text-red-400'
              : 'fa-circle-info text-cyan-400';
  el.innerHTML = `<i class="fas ${icon}"></i><span class="text-sm text-slate-200">${escHtml(msg)}</span>`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
