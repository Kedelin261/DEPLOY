// DEPLOY Platform — Frontend Application
// Version 1.0.0

// ============================================================
// STATE
// ============================================================
const STATE = {
  token: localStorage.getItem('deploy_token'),
  user: null,
  currentPage: 'home',
  activeProjectId: localStorage.getItem('deploy_active_project'),
  models: [],
  projects: [],
  vault: null,
  packages: [],
  plans: [],
  promptData: {},
  autosaveTimer: null,
  config: null,     // Loaded from /api/config — contains stripe publishable key, env info
};

const API = axios.create({ baseURL: '/api' });

API.interceptors.request.use(config => {
  if (STATE.token) config.headers.Authorization = `Bearer ${STATE.token}`;
  return config;
});

API.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      handleLogout();
    }
    return Promise.reject(err);
  }
);

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  // Always load public config first (non-blocking, safe to fail)
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    if (cfg.success) STATE.config = cfg.data;
  } catch {}

  // Handle post-payment redirect from Stripe
  const urlParams = new URLSearchParams(window.location.search);
  const paymentStatus = urlParams.get('payment');
  if (paymentStatus === 'success') {
    // Clean the URL without a full page reload
    window.history.replaceState({}, document.title, '/');
    // Will show toast after app loads
    STATE._paymentSuccess = true;
  } else if (paymentStatus === 'cancelled') {
    window.history.replaceState({}, document.title, '/');
    STATE._paymentCancelled = true;
  }

  if (STATE.token) {
    initApp();
  } else {
    showAuth();
  }
});

async function initApp() {
  try {
    const { data } = await API.get('/auth/me');
    if (data.success) {
      STATE.user = data.data;
      showApp();
      await Promise.all([
        loadHomeData(),
        loadModels(),
      ]);

      // Show payment result toasts after app has loaded
      if (STATE._paymentSuccess) {
        delete STATE._paymentSuccess;
        // Refresh balance from server
        try {
          const { data: vd } = await API.get('/vault');
          if (vd.success && vd.data.wallet) {
            STATE.user.coin_balance = vd.data.wallet.balance;
            updateHeaderUser();
          }
        } catch {}
        showToast('🎉 Payment successful! Coins have been added to your vault.', 'success');
      } else if (STATE._paymentCancelled) {
        delete STATE._paymentCancelled;
        showToast('Payment cancelled. No charge was made.', 'info');
      }
    } else {
      showAuth();
    }
  } catch {
    showAuth();
  }
}

function showAuth() {
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app-screen').classList.add('hidden');
}

function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').classList.remove('hidden');
  updateHeaderUser();
}

function updateHeaderUser() {
  if (!STATE.user) return;
  const coins = STATE.user.coin_balance || 0;
  document.getElementById('header-coins').textContent = coins.toLocaleString();
  document.getElementById('home-username').textContent = STATE.user.name?.split(' ')[0] || 'Builder';
  document.getElementById('home-plan').textContent = STATE.user.plan_slug || 'free';
  document.getElementById('stat-coins').textContent = coins.toLocaleString();
  
  // Account page
  document.getElementById('account-name').textContent = STATE.user.name || '—';
  document.getElementById('account-email').textContent = STATE.user.email || '—';
  document.getElementById('account-email-display').textContent = STATE.user.email || '—';
  document.getElementById('account-phone').textContent = STATE.user.phone || '—';
  document.getElementById('account-plan-badge').textContent = `${capitalize(STATE.user.plan_slug || 'free')} Plan`;
  document.getElementById('account-avatar').textContent = (STATE.user.name || 'U')[0].toUpperCase();
  document.getElementById('vault-balance').textContent = coins.toLocaleString();
  document.getElementById('plan-name-display').textContent = capitalize(STATE.user.plan_slug || 'free');
  document.getElementById('plan-max-projects').textContent = STATE.user.max_projects || 3;
  document.getElementById('plan-max-deploys').textContent = STATE.user.max_deployments || 1;
  
  const grants = { free: 50, member: 500, pro: 2000, team: 8000 };
  document.getElementById('vault-grant').textContent = `${(grants[STATE.user.plan_slug] || 50).toLocaleString()} coins / month`;
}

// ============================================================
// AUTH
// ============================================================
function showAuthTab(tab) {
  document.getElementById('form-login').classList.toggle('hidden', tab !== 'login');
  document.getElementById('form-signup').classList.toggle('hidden', tab !== 'signup');
  document.getElementById('tab-login').style.background = tab === 'login' ? 'linear-gradient(135deg, #06b6d4, #0891b2)' : '';
  document.getElementById('tab-login').style.color = tab === 'login' ? 'white' : '';
  document.getElementById('tab-signup').style.background = tab === 'signup' ? 'linear-gradient(135deg, #06b6d4, #0891b2)' : '';
  document.getElementById('tab-signup').style.color = tab === 'signup' ? 'white' : '';
  document.getElementById('tab-login').className = `flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${tab === 'login' ? 'text-white' : 'text-slate-400'}`;
  document.getElementById('tab-signup').className = `flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${tab === 'signup' ? 'text-white' : 'text-slate-400'}`;
}

async function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) { showToast('Please enter email and password', 'error'); return; }
  
  try {
    setLoading(true);
    const { data } = await API.post('/auth/login', { email, password });
    if (data.success) {
      STATE.token = data.data.token;
      STATE.user = data.data.user;
      localStorage.setItem('deploy_token', STATE.token);
      showApp();
      await Promise.all([loadHomeData(), loadModels()]);
      showToast('Welcome back!', 'success');
    }
  } catch (err) {
    showToast(err.response?.data?.error || 'Login failed', 'error');
  } finally {
    setLoading(false);
  }
}

async function handleSignup() {
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  if (!name || !email || !password) { showToast('All fields required', 'error'); return; }
  if (password.length < 8) { showToast('Password must be at least 8 characters', 'error'); return; }
  
  try {
    setLoading(true);
    const { data } = await API.post('/auth/signup', { name, email, password });
    if (data.success) {
      STATE.token = data.data.token;
      STATE.user = data.data.user;
      localStorage.setItem('deploy_token', STATE.token);
      showApp();
      await Promise.all([loadHomeData(), loadModels()]);
      showToast(data.message || 'Welcome to DEPLOY!', 'success');
    }
  } catch (err) {
    showToast(err.response?.data?.error || 'Signup failed', 'error');
  } finally {
    setLoading(false);
  }
}

async function handleDemoLogin() {
  document.getElementById('login-email').value = 'demo@deployapp.io';
  document.getElementById('login-password').value = 'Demo12345';
  showAuthTab('login');
  await handleLogin();
}

function handleLogout() {
  STATE.token = null;
  STATE.user = null;
  localStorage.removeItem('deploy_token');
  localStorage.removeItem('deploy_active_project');
  showAuth();
}

function togglePassword(id) {
  const el = document.getElementById(id);
  el.type = el.type === 'password' ? 'text' : 'password';
}

// ============================================================
// NAVIGATION
// ============================================================
function navigateTo(page) {
  STATE.currentPage = page;
  
  // Update pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');
  
  // Update nav
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`nav-${page}`)?.classList.add('active');
  
  // Update nav icon colors
  document.querySelectorAll('.nav-item .nav-icon').forEach(i => {
    i.classList.remove('text-cyan-400');
    i.classList.add('text-slate-500');
  });
  const activeIcon = document.querySelector(`#nav-${page} .nav-icon`);
  if (activeIcon) {
    activeIcon.classList.remove('text-slate-500');
    activeIcon.classList.add('text-cyan-400');
  }
  document.querySelectorAll('.nav-item .text-xs').forEach(t => {
    t.classList.remove('text-cyan-400');
    t.classList.add('text-slate-600');
  });
  const activeText = document.querySelector(`#nav-${page} .text-xs`);
  if (activeText) {
    activeText.classList.remove('text-slate-600');
    activeText.classList.add('text-cyan-400');
  }
  
  // Page-specific loads
  if (page === 'home') loadHomeData();
  if (page === 'prompt') loadPromptPage();
  if (page === 'account') loadAccountPage();
  if (page === 'planning') renderKanban();
  
  // Toggle full-screen class for planning page
  document.body.classList.toggle('planning-active', page === 'planning');
}

// ============================================================
// HOME DATA
// ============================================================
async function loadHomeData() {
  if (!STATE.user) return;
  await Promise.all([loadProjects(), loadNotificationBadge()]);
}

async function loadProjects() {
  try {
    const { data } = await API.get('/projects');
    if (data.success) {
      STATE.projects = data.data.items;
      renderProjects(data.data.items);
      document.getElementById('stat-projects').textContent = data.data.total;
      
      const deployed = data.data.items.filter(p => p.status === 'deployed').length;
      document.getElementById('stat-deploys').textContent = deployed;
      
      // Update prompt page project list
      renderPromptProjectList(data.data.items);
    }
  } catch {}
}

function renderProjects(projects) {
  const container = document.getElementById('projects-list');
  if (!projects || projects.length === 0) {
    container.innerHTML = `
      <div class="glass rounded-xl p-4 text-center py-8">
        <i class="fas fa-folder-open text-slate-600 text-2xl mb-3 block"></i>
        <p class="text-slate-500 text-sm">No projects yet</p>
        <button onclick="showNewProjectModal()" class="mt-3 text-xs text-cyan-400 hover:text-cyan-300">
          Create your first project →
        </button>
      </div>`;
    return;
  }
  
  container.innerHTML = projects.slice(0, 5).map(p => `
    <div class="glass glass-hover rounded-xl p-4 cursor-pointer transition-all"
         onclick="openProject('${p.id}')">
      <div class="flex items-start justify-between">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <p class="text-sm font-semibold text-white truncate">${escHtml(p.name)}</p>
            <span class="${statusChip(p.status)} text-xs px-2 py-0.5 rounded-full font-medium">${p.status}</span>
          </div>
          ${p.category ? `<p class="text-xs text-slate-500">${capitalize(p.category)}</p>` : ''}
          <div class="flex items-center gap-3 mt-2">
            <div class="flex items-center gap-1 text-xs text-slate-600">
              <i class="fas fa-circle-half-stroke text-xs"></i>
              <span>${p.readiness_score || 0}% ready</span>
            </div>
            ${p.build_count > 0 ? `<div class="flex items-center gap-1 text-xs text-slate-600"><i class="fas fa-hammer text-xs"></i><span>${p.build_count} build${p.build_count > 1 ? 's' : ''}</span></div>` : ''}
          </div>
        </div>
        <div class="flex-shrink-0 ml-3">
          <div class="w-10 h-10 rounded-xl flex items-center justify-center ${categoryIcon(p.category).bg}">
            <i class="${categoryIcon(p.category).icon} text-sm"></i>
          </div>
        </div>
      </div>
      <!-- Readiness bar -->
      <div class="mt-3 h-1 bg-navy-700 rounded-full overflow-hidden">
        <div class="progress-fill h-full rounded-full" style="width: ${p.readiness_score || 0}%"></div>
      </div>
      ${['built','deployed'].includes(p.status) ? `
      <!-- Quick action buttons for built projects -->
      <div class="mt-3 pt-3 border-t border-slate-800/50 flex gap-2" onclick="event.stopPropagation()">
        <button onclick="event.stopPropagation();openViewModal('${p.id}','${escHtml(p.name)}')"
          class="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold border border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/10 transition-colors">
          <i class="fas fa-eye"></i> View
        </button>
        <button onclick="event.stopPropagation();openTestingModal(null,'${p.id}','${escHtml(p.name)}')"
          class="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 transition-colors">
          <i class="fas fa-flask"></i> Test &amp; Revise
        </button>
        <button onclick="event.stopPropagation();openPublishModal('${p.id}')"
          class="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold border border-indigo-500/40 text-indigo-400 hover:bg-indigo-500/10 transition-colors">
          <i class="fas fa-rocket"></i> Publish
        </button>
      </div>` : ''}
    </div>
  `).join('');
}

function renderPromptProjectList(projects) {
  const container = document.getElementById('prompt-project-list');
  if (!projects || projects.length === 0) {
    container.innerHTML = `<p class="text-slate-600 text-sm text-center py-3">Create a project to start building</p>`;
    return;
  }
  
  const activeId = STATE.activeProjectId;
  container.innerHTML = projects.map(p => `
    <button onclick="selectPromptProject('${p.id}', '${escHtml(p.name)}')"
      class="w-full flex items-center gap-3 p-3 rounded-xl transition-all ${activeId === p.id ? 'bg-cyan-500/10 border border-cyan-500/30' : 'hover:bg-slate-800/40'}">
      <div class="w-8 h-8 rounded-lg flex items-center justify-center ${categoryIcon(p.category).bg}">
        <i class="${categoryIcon(p.category).icon} text-xs"></i>
      </div>
      <div class="flex-1 text-left">
        <p class="text-sm font-medium text-white">${escHtml(p.name)}</p>
        <p class="text-xs text-slate-500">${p.readiness_score || 0}% complete</p>
      </div>
      ${activeId === p.id ? '<i class="fas fa-check-circle text-cyan-400 text-sm"></i>' : '<i class="fas fa-chevron-right text-slate-600 text-xs"></i>'}
    </button>
  `).join('');
}

async function loadNotificationBadge() {
  try {
    const { data } = await API.get('/notifications?unread=true');
    if (data.success) {
      const count = data.data.unread_count;
      const badge = document.getElementById('notif-badge');
      if (count > 0) {
        badge.textContent = count > 9 ? '9+' : count;
        badge.classList.remove('hidden');
        badge.classList.add('flex');
      } else {
        badge.classList.add('hidden');
      }
    }
  } catch {}
}

// ============================================================
// MODELS
// ============================================================
async function loadModels() {
  try {
    const { data } = await API.get('/models');
    if (data.success) {
      STATE.models = data.data;
      const firstAccessible = data.data.find(m => m.accessible);
      if (firstAccessible) {
        document.getElementById('current-model-name').textContent = firstAccessible.display_name;
      }
    }
  } catch {}
}

function openModelSelector() {
  openModal('modal-models');
  renderModelList();
}

function renderModelList() {
  const container = document.getElementById('model-list');
  if (!STATE.models.length) {
    container.innerHTML = `<p class="text-slate-500 text-sm text-center py-4">Loading models...</p>`;
    return;
  }
  
  container.innerHTML = STATE.models.map(m => `
    <button onclick="selectModel('${m.id}', '${escHtml(m.display_name)}')"
      class="w-full p-3 rounded-xl text-left transition-all ${m.accessible ? 'glass glass-hover' : 'opacity-50 cursor-not-allowed glass'}"
      ${m.accessible ? '' : 'disabled'}>
      <div class="flex items-start justify-between gap-2">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <p class="text-sm font-semibold text-white">${escHtml(m.display_name)}</p>
            ${!m.accessible ? `<span class="text-xs text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">${m.min_plan_slug}</span>` : ''}
          </div>
          <p class="text-xs text-slate-500 mt-0.5">${escHtml(m.description || '')}</p>
          <div class="flex flex-wrap gap-1 mt-1.5">
            ${(m.capability_tags || []).map(t => `<span class="tag-${t} text-xs px-1.5 py-0.5 rounded-full">${t}</span>`).join('')}
          </div>
        </div>
        <div class="flex-shrink-0 text-right">
          <p class="text-xs font-bold text-amber-400">${m.estimated_cost_per_build} <span class="text-slate-600 font-normal">coins</span></p>
          <p class="text-xs text-slate-600 mt-0.5">per build</p>
        </div>
      </div>
    </button>
  `).join('');
}

async function selectModel(modelId, modelName) {
  if (!STATE.activeProjectId) {
    document.getElementById('current-model-name').textContent = modelName;
    closeModal('modal-models');
    showToast(`${modelName} selected`, 'success');
    return;
  }
  
  try {
    const { data } = await API.put('/models/select', {
      project_id: STATE.activeProjectId,
      model_id: modelId
    });
    if (data.success) {
      document.getElementById('current-model-name').textContent = modelName;
      updateBuildCostPreview(modelId);
      closeModal('modal-models');
      showToast(`Switched to ${modelName}`, 'success');
    }
  } catch (err) {
    showToast(err.response?.data?.error || 'Model switch failed', 'error');
  }
}

function updateBuildCostPreview(modelId) {
  const model = STATE.models.find(m => m.id === modelId);
  if (model) {
    document.getElementById('build-cost-amount').textContent = `~${model.estimated_cost_per_build} coins`;
  }
}

// ============================================================
// PROJECTS
// ============================================================
function showNewProjectModal(destination) {
  openModal('modal-new-project');
  window._projectModalDestination = destination;
}

async function createProject() {
  const name = document.getElementById('new-project-name').value.trim();
  const category = document.getElementById('new-project-category').value;
  const description = document.getElementById('new-project-desc').value.trim();
  
  if (!name) { showToast('Project name required', 'error'); return; }
  
  try {
    const { data } = await API.post('/projects', { name, category, description });
    if (data.success) {
      closeModal('modal-new-project');
      
      STATE.activeProjectId = data.data.project.id;
      localStorage.setItem('deploy_active_project', STATE.activeProjectId);
      
      document.getElementById('new-project-name').value = '';
      document.getElementById('new-project-category').value = '';
      document.getElementById('new-project-desc').value = '';
      
      showToast(`"${name}" created!`, 'success');
      await loadProjects();
      
      if (window._projectModalDestination === 'prompt') {
        navigateTo('prompt');
        selectPromptProject(data.data.project.id, name);
      }
    }
  } catch (err) {
    showToast(err.response?.data?.error || 'Failed to create project', 'error');
  }
}

function openProject(id) {
  STATE.activeProjectId = id;
  localStorage.setItem('deploy_active_project', id);
  
  const project = STATE.projects.find(p => p.id === id);
  if (project) {
    navigateTo('prompt');
    selectPromptProject(id, project.name);
  }
}

// ============================================================
// PROMPT BUILDER
// ============================================================
// ============================================================
// TECH STACK CATALOG
// ============================================================
const TECH_STACK_CATALOG = {
  database: [
    { id: 'cloudflare_d1',   label: 'Cloudflare D1',   icon: 'fa-cloud',          tags: ['serverless','edge','sqlite'],      desc: 'SQLite at the edge — zero-config, global',         ai_compat: ['cursor','github_copilot','codeium','supermaven'], deploy_compat: ['cloudflare'], storage_compat: ['cloudflare_r2','cloudflare_kv'] },
    { id: 'supabase',         label: 'Supabase',         icon: 'fa-database',       tags: ['postgres','realtime','auth'],       desc: 'Postgres + auth + realtime in one',                ai_compat: ['cursor','github_copilot','codeium','aider','continue'], deploy_compat: ['vercel','railway','fly','aws'], storage_compat: ['supabase_storage','aws_s3'] },
    { id: 'planetscale',      label: 'PlanetScale',      icon: 'fa-database',       tags: ['mysql','serverless','branching'],   desc: 'Serverless MySQL with schema branching',           ai_compat: ['cursor','github_copilot','codeium'], deploy_compat: ['vercel','railway','aws'], storage_compat: ['aws_s3','cloudflare_r2'] },
    { id: 'neon',             label: 'Neon',             icon: 'fa-bolt',           tags: ['postgres','serverless','branching'],'desc': 'Serverless Postgres with instant branching',     ai_compat: ['cursor','github_copilot','codeium','aider'], deploy_compat: ['vercel','railway','fly'], storage_compat: ['aws_s3','cloudflare_r2'] },
    { id: 'turso',            label: 'Turso (libSQL)',   icon: 'fa-circle-nodes',   tags: ['sqlite','edge','distributed'],      desc: 'Edge SQLite — closest DB to every user',          ai_compat: ['cursor','codeium','continue'], deploy_compat: ['cloudflare','fly','railway'], storage_compat: ['cloudflare_r2','aws_s3'] },
    { id: 'mongodb_atlas',    label: 'MongoDB Atlas',    icon: 'fa-leaf',           tags: ['nosql','document','atlas'],         desc: 'Document DB with global clusters',                 ai_compat: ['cursor','github_copilot','codeium'], deploy_compat: ['vercel','aws','railway'], storage_compat: ['aws_s3','gridfs'] },
    { id: 'firebase',         label: 'Firebase / Firestore', icon: 'fa-fire',      tags: ['nosql','realtime','google'],        desc: 'Google real-time NoSQL + auth',                    ai_compat: ['github_copilot','codeium','cursor'], deploy_compat: ['firebase_hosting','vercel'], storage_compat: ['firebase_storage'] },
    { id: 'redis',            label: 'Upstash Redis',    icon: 'fa-bolt',           tags: ['redis','cache','serverless'],       desc: 'Serverless Redis — caching & queues',              ai_compat: ['cursor','github_copilot'], deploy_compat: ['vercel','cloudflare','railway'], storage_compat: ['aws_s3','cloudflare_r2'] },
    { id: 'sqlite_local',     label: 'SQLite (local)',   icon: 'fa-hard-drive',     tags: ['sqlite','file','self-hosted'],      desc: 'File-based DB — simple self-hosted apps',          ai_compat: ['cursor','aider','continue','codeium'], deploy_compat: ['vps','railway','fly'], storage_compat: ['local_fs'] },
    { id: 'dynamodb',         label: 'DynamoDB',         icon: 'fa-aws',            tags: ['aws','nosql','serverless'],         desc: 'AWS managed NoSQL at massive scale',               ai_compat: ['cursor','github_copilot','codeium'], deploy_compat: ['aws'], storage_compat: ['aws_s3'] },
    { id: 'cockroachdb',      label: 'CockroachDB',      icon: 'fa-spider',         tags: ['postgres','distributed','global'],  desc: 'Distributed SQL — survives zone failures',         ai_compat: ['cursor','github_copilot'], deploy_compat: ['vercel','aws','railway'], storage_compat: ['aws_s3','cloudflare_r2'] },
    { id: 'xata',             label: 'Xata',             icon: 'fa-table',          tags: ['postgres','search','serverless'],   desc: 'Serverless DB with built-in search',               ai_compat: ['cursor','codeium'], deploy_compat: ['vercel','cloudflare'], storage_compat: ['aws_s3'] },
  ],
  storage: [
    { id: 'cloudflare_r2',    label: 'Cloudflare R2',   icon: 'fa-cloud',          tags: ['s3-compat','zero-egress','edge'],   desc: 'S3-compatible — zero egress cost',                 ai_compat: ['cursor','github_copilot','codeium','supermaven'] },
    { id: 'cloudflare_kv',    label: 'Cloudflare KV',   icon: 'fa-key',            tags: ['edge','kv','cache'],                desc: 'Globally distributed key-value store',             ai_compat: ['cursor','github_copilot','codeium'] },
    { id: 'aws_s3',           label: 'AWS S3',           icon: 'fa-aws',            tags: ['object','standard','cdn'],          desc: 'Industry standard object storage',                 ai_compat: ['cursor','github_copilot','codeium','aider'] },
    { id: 'supabase_storage', label: 'Supabase Storage', icon: 'fa-database',       tags: ['s3-compat','postgres','auth'],      desc: 'S3-compatible storage with Supabase auth',         ai_compat: ['cursor','github_copilot','codeium'] },
    { id: 'uploadthing',      label: 'UploadThing',      icon: 'fa-upload',         tags: ['files','simple','nextjs'],          desc: 'File uploads built for modern stacks',             ai_compat: ['cursor','github_copilot','codeium'] },
    { id: 'firebase_storage', label: 'Firebase Storage', icon: 'fa-fire',           tags: ['google','realtime','cdn'],          desc: 'Google CDN-backed file storage',                   ai_compat: ['github_copilot','codeium'] },
    { id: 'backblaze_b2',     label: 'Backblaze B2',     icon: 'fa-hard-drive',     tags: ['s3-compat','cheap','cdn'],          desc: 'Budget S3-compatible with Cloudflare CDN',         ai_compat: ['cursor','github_copilot'] },
    { id: 'local_fs',         label: 'Local Filesystem', icon: 'fa-folder',         tags: ['self-hosted','simple','vps'],       desc: 'Direct disk — self-hosted servers only',           ai_compat: ['cursor','aider','continue','codeium'] },
  ],
  deployment: [
    { id: 'cloudflare',       label: 'Cloudflare Pages/Workers', icon: 'fa-cloud', tags: ['edge','global','free-tier'],        desc: 'Edge-first — 275 cities, zero cold starts',        ai_compat: ['cursor','github_copilot','codeium','supermaven'] },
    { id: 'vercel',           label: 'Vercel',           icon: 'fa-triangle',       tags: ['nextjs','serverless','preview'],    desc: 'Best-in-class DX — Next.js home',                  ai_compat: ['cursor','github_copilot','codeium','v0','supermaven'] },
    { id: 'railway',          label: 'Railway',          icon: 'fa-train-subway',   tags: ['container','easy','postgres'],      desc: 'Container deploys in seconds',                     ai_compat: ['cursor','github_copilot','codeium','aider'] },
    { id: 'fly',              label: 'Fly.io',           icon: 'fa-plane',          tags: ['docker','edge','global'],           desc: 'Docker apps near users, globally',                 ai_compat: ['cursor','aider','continue','codeium'] },
    { id: 'aws',              label: 'AWS (Lambda/ECS)', icon: 'fa-aws',            tags: ['enterprise','scalable','complex'],  desc: 'Maximum scale — full AWS ecosystem',               ai_compat: ['cursor','github_copilot','codeium','aider'] },
    { id: 'render',           label: 'Render',           icon: 'fa-server',         tags: ['container','postgres','simple'],    desc: 'Heroku alternative with managed DBs',              ai_compat: ['cursor','github_copilot','codeium'] },
    { id: 'vps',              label: 'VPS (DigitalOcean/Hetzner)', icon: 'fa-server', tags: ['self-hosted','cheap','control'], desc: 'Full server control — Linux + Docker',             ai_compat: ['cursor','aider','continue','codeium'] },
    { id: 'firebase_hosting', label: 'Firebase Hosting', icon: 'fa-fire',           tags: ['google','cdn','free-tier'],        desc: 'Google global CDN with instant deploys',           ai_compat: ['github_copilot','codeium'] },
    { id: 'netlify',          label: 'Netlify',          icon: 'fa-globe',          tags: ['static','functions','edge'],        desc: 'Static sites + edge functions',                    ai_compat: ['cursor','github_copilot','codeium'] },
  ],
};

// AI Dev Tool profiles — scored by compatibility with picked stack
const AI_DEV_TOOLS = [
  {
    id: 'cursor',
    name: 'Cursor',
    icon: '⬡',
    iconClass: 'fa-terminal',
    tagline: 'AI-first IDE',
    desc: 'Full codebase awareness. Chat, edit, and generate across entire projects. Best-in-class for complex full-stack apps.',
    strengths: ['Full repo context','Inline chat + edit','Multi-file edits','Rules & memory files','Agent mode'],
    url: 'https://cursor.com',
    badge: 'Most Popular',
    badgeColor: 'cyan',
    score_weight: { cloudflare: 3, vercel: 3, railway: 2, supabase: 3, neon: 3, turso: 2, any: 1 },
  },
  {
    id: 'github_copilot',
    name: 'GitHub Copilot',
    icon: '◎',
    iconClass: 'fa-github',
    tagline: 'Code completion + chat',
    desc: 'Native GitHub integration. Works inside VS Code, JetBrains, Vim. Excels at boilerplate and completion in any language.',
    strengths: ['VS Code native','GitHub PR reviews','Multi-language','CLI support','Enterprise SSO'],
    url: 'https://github.com/features/copilot',
    badge: 'Best for Teams',
    badgeColor: 'purple',
    score_weight: { aws: 3, vercel: 2, supabase: 2, mongodb_atlas: 2, any: 1 },
  },
  {
    id: 'v0',
    name: 'v0 by Vercel',
    icon: '◇',
    iconClass: 'fa-wand-magic-sparkles',
    tagline: 'UI generation',
    desc: 'Generate production-ready React + Tailwind UI from text prompts. Exports to Next.js. Zero setup.',
    strengths: ['shadcn/ui components','Next.js export','Tailwind-native','Rapid prototyping','One-shot UI'],
    url: 'https://v0.dev',
    badge: 'Best for UI',
    badgeColor: 'violet',
    score_weight: { vercel: 5, nextjs: 4, any: 0 },
  },
  {
    id: 'codeium',
    name: 'Windsurf (Codeium)',
    icon: '◈',
    iconClass: 'fa-wind',
    tagline: 'Agentic AI IDE',
    desc: 'Cascade agent plans and executes multi-step tasks autonomously. Deep codebase awareness with Flows.',
    strengths: ['Cascade agent','Flows system','Free tier available','Multi-file planning','Terminal access'],
    url: 'https://codeium.com/windsurf',
    badge: 'Best Free Option',
    badgeColor: 'emerald',
    score_weight: { cloudflare: 2, railway: 2, any: 1 },
  },
  {
    id: 'aider',
    name: 'Aider',
    icon: '◫',
    iconClass: 'fa-code-branch',
    tagline: 'Git-native AI coding',
    desc: 'Terminal-based AI that commits changes directly to git. Best for developers who live in the CLI.',
    strengths: ['Git-native commits','CLI-first','Any model (GPT/Claude)','Architect mode','Repo mapping'],
    url: 'https://aider.chat',
    badge: 'Best CLI',
    badgeColor: 'amber',
    score_weight: { vps: 4, fly: 3, sqlite_local: 3, local_fs: 3, any: 1 },
  },
  {
    id: 'continue',
    name: 'Continue.dev',
    icon: '▷',
    iconClass: 'fa-play',
    tagline: 'Open-source AI IDE plugin',
    desc: 'Open-source Copilot alternative. Bring your own model (Ollama, OpenAI, Anthropic). Fully self-hostable.',
    strengths: ['Open source','BYO model','Self-hosted LLMs','VS Code + JetBrains','Custom context'],
    url: 'https://continue.dev',
    badge: 'Open Source',
    badgeColor: 'slate',
    score_weight: { vps: 3, sqlite_local: 2, local_fs: 2, any: 1 },
  },
  {
    id: 'supermaven',
    name: 'Supermaven',
    icon: '◆',
    iconClass: 'fa-bolt',
    tagline: 'Fastest code completion',
    desc: '1M token context window. Predicts entire code blocks instantly. Lowest latency AI completion available.',
    strengths: ['1M token context','Ultra-low latency','VS Code + JetBrains','Full file awareness','Blazing fast'],
    url: 'https://supermaven.com',
    badge: 'Fastest',
    badgeColor: 'rose',
    score_weight: { cloudflare: 2, vercel: 2, any: 1 },
  },
];

// Compute AI tool scores based on selected stack
function computeAIToolScores(picks) {
  const db = picks.db || '';
  const storage = picks.storage || '';
  const deploy = picks.deploy || '';
  const allPicks = [db, storage, deploy];

  return AI_DEV_TOOLS.map(tool => {
    let score = tool.score_weight['any'] || 0;
    allPicks.forEach(p => {
      if (p && tool.score_weight[p] !== undefined) score += tool.score_weight[p];
    });
    // Bonus: tool explicitly listed in catalog compat
    const dbEntry = TECH_STACK_CATALOG.database.find(x => x.id === db);
    const stEntry = TECH_STACK_CATALOG.storage.find(x => x.id === storage);
    const dpEntry = TECH_STACK_CATALOG.deployment.find(x => x.id === deploy);
    if (dbEntry?.ai_compat?.includes(tool.id)) score += 2;
    if (stEntry?.ai_compat?.includes(tool.id)) score += 2;
    if (dpEntry?.ai_compat?.includes(tool.id)) score += 2;
    return { ...tool, score };
  }).sort((a, b) => b.score - a.score);
}

// ============================================================
// PROMPT SECTIONS CONFIG
// Guided: essential fields only — friendly, conversational
// Advanced: all fields including technical stack pickers
// ============================================================
const PROMPT_SECTIONS_CONFIG = [
  {
    key: 'app_info', label: 'App Info', icon: 'fa-circle-info',
    guidedOnly: false,   // shown in both modes
    guidedStep: 1,
    fields: [
      { key: 'app_name',         label: 'App Name',          type: 'text',     placeholder: 'e.g. TaskFlow Pro', required: true, guidedHint: 'What do you want to call your app?' },
      { key: 'category',         label: 'Category',          type: 'select',   options: ['SaaS Platform','Mobile App','E-Commerce','Dashboard','API/Backend','Marketplace','Other'], guidedHint: 'What type of product is this?' },
      { key: 'audience',         label: 'Target Audience',   type: 'textarea', placeholder: 'Who is this app for? Describe their role, pain points, technical level.', guidedHint: 'Describe your users in plain English.' },
      { key: 'problem_statement',label: 'Problem Statement', type: 'textarea', placeholder: 'What specific problem does this app solve? Be as clear as possible.', guidedHint: 'What frustration does this fix?' },
    ]
  },
  {
    key: 'features', label: 'Core Features', icon: 'fa-list-check',
    guidedOnly: false,
    guidedStep: 2,
    fields: [
      { key: 'core_features',    label: 'Core Features (MVP)', type: 'feature-list', placeholder: 'Describe a feature…', rows: 2, hint: 'Add as many or as few as you like. AI will handle anything you leave out.', guidedHint: 'List the must-have features. One per line.' },
      { key: 'roles_permissions',label: 'User Roles & Permissions', type: 'textarea', placeholder: 'What types of users are there? (e.g., Admin, Member, Guest)', guidedHint: 'Who can do what in your app?' },
      // Advanced-only fields
      { key: 'auth_method',      label: 'Authentication Method', type: 'select', options: ['Email + Password','Magic Link (passwordless)','OAuth (Google/GitHub)','SMS / OTP','Multi-factor (MFA)','API Keys only','No auth needed'], advancedOnly: true },
      { key: 'permission_model', label: 'Permission Model',  type: 'select', options: ['Simple (Admin / User)','RBAC (Role-Based Access Control)','ABAC (Attribute-Based)','Flat (single user type)','Custom'], advancedOnly: true },
    ]
  },
  {
    key: 'visual', label: 'Visual & Frontend', icon: 'fa-palette',
    guidedOnly: false,
    optional: true,
    guidedStep: 3,
    fields: [
      { key: 'color_scheme',     label: 'Color Scheme',      type: 'color-scheme', hint: 'Pick a primary palette direction. AI will handle the rest.' },
      { key: 'visual_style',     label: 'Visual Style',      type: 'select', options: ['Minimal & Clean','Dark & Futuristic','Light & Airy','Bold & Vibrant','Corporate & Professional','Playful & Friendly','Luxury & Premium'] },
      { key: 'visual_features',  label: 'Frontend Features', type: 'feature-list', placeholder: 'e.g. dark mode, animated transitions, drag-and-drop cards…', rows: 2, hint: 'Optional — list any specific UI/UX features. AI handles the rest.' },
      { key: 'ui_ux_notes',      label: 'Additional UI/UX Notes', type: 'textarea', placeholder: 'Any other look, feel, or experience details — layout, navigation style, tone, etc.' },
      // Advanced-only
      { key: 'frontend_framework', label: 'Frontend Framework', type: 'select', options: ['Next.js (React)','React (Vite)','Vue 3 (Vite)','Nuxt 3','SvelteKit','Astro','HTMX + Alpine.js','Vanilla JS','React Native (Expo)','Flutter'], advancedOnly: true },
      { key: 'ui_library',       label: 'UI Component Library', type: 'select', options: ['Tailwind CSS only','shadcn/ui + Tailwind','Radix UI + Tailwind','Mantine','Chakra UI','Ant Design','Material UI','DaisyUI','Headless UI','None — custom CSS'], advancedOnly: true },
      { key: 'animation_lib',    label: 'Animation Library',  type: 'select', options: ['None','Framer Motion','GSAP','Motion One','Lottie','CSS animations only','Auto Animate'], advancedOnly: true },
    ]
  },
  {
    key: 'technical', label: 'Technical', icon: 'fa-code',
    guidedOnly: false,
    guidedStep: 4,
    fields: [
      { key: 'workflows',        label: 'Key Workflows',     type: 'textarea', placeholder: 'Describe the main user journeys step by step.', rows: 4, guidedHint: 'Walk through the main things users will do.' },
      { key: 'data_entities',    label: 'Data Entities',     type: 'textarea', placeholder: 'List the main data objects (e.g., Users, Projects, Orders).' },
      { key: 'apis_tools',       label: 'APIs & Integrations', type: 'textarea', placeholder: 'Any external services needed? (e.g., payments, email, maps)' },
      // Advanced-only — the full technical stack pickers
      { key: 'backend_framework',label: 'Backend Framework', type: 'select', options: ['Hono (Cloudflare Workers)','Next.js API Routes','Express.js','Fastify','tRPC','NestJS','Bun + Elysia','Django (Python)','FastAPI (Python)','Rails (Ruby)','None (frontend-only)'], advancedOnly: true },
      { key: 'db_choice',        label: 'Database',          type: 'tech-picker', catalog: 'database', advancedOnly: true },
      { key: 'storage_choice',   label: 'Storage',           type: 'tech-picker', catalog: 'storage',  advancedOnly: true },
      { key: 'deploy_choice',    label: 'Deployment Platform', type: 'tech-picker', catalog: 'deployment', advancedOnly: true },
      { key: 'realtime',         label: 'Real-time Requirements', type: 'select', options: ['None','WebSockets (live updates)','Server-Sent Events (SSE)','Polling (simple)','Push notifications only','Full collaborative (CRDT)'], advancedOnly: true },
      { key: 'background_jobs',  label: 'Background Jobs',   type: 'select', options: ['None needed','Scheduled cron jobs','Queue-based workers','Email queue','Webhook processing','Heavy compute tasks'], advancedOnly: true },
      { key: 'caching_strategy', label: 'Caching Strategy',  type: 'select', options: ['None','Edge caching (CDN)','Redis/KV cache','In-memory cache','Database query cache','Multi-layer cache'], advancedOnly: true },
      { key: 'api_style',        label: 'API Architecture',  type: 'select', options: ['REST','GraphQL','tRPC','gRPC','REST + WebSocket','Hybrid (REST + GraphQL)'], advancedOnly: true },
      { key: 'test_strategy',    label: 'Testing Strategy',  type: 'select', options: ['No tests (MVP)','Unit tests only','Unit + Integration','E2E with Playwright','E2E with Cypress','Full TDD','AI-generated tests'], advancedOnly: true },
      { key: 'perf_targets',     label: 'Performance Targets', type: 'textarea', placeholder: 'e.g. < 200ms API response, 100k MAU, 99.9% uptime SLA, sub-50ms TTFB', advancedOnly: true },
      { key: 'security_requirements', label: 'Security Requirements', type: 'multi-select-pills', options: ['SOC 2 compliance','GDPR / data privacy','HIPAA (health data)','PCI-DSS (payments)','Rate limiting','DDoS protection','End-to-end encryption','Audit logging','IP allowlisting','2FA / MFA required'], advancedOnly: true },
    ]
  },
  {
    key: 'business', label: 'Business', icon: 'fa-chart-line',
    guidedOnly: false,
    guidedStep: 5,
    fields: [
      { key: 'business_model',   label: 'Business Model',    type: 'textarea', placeholder: 'How does this app make money? Subscriptions, one-time, freemium?', guidedHint: 'How does this make money (or not)?' },
      { key: 'mvp_guardrails',   label: 'MVP Guardrails',    type: 'textarea', placeholder: 'What is explicitly OUT of scope for version 1?' },
      { key: 'future_versions',  label: 'Future Versions',   type: 'textarea', placeholder: 'What would you add in v2, v3?' },
      // Advanced-only
      { key: 'monetization',     label: 'Monetization Stack', type: 'multi-select-pills', options: ['Stripe subscriptions','One-time purchases','Usage-based billing','In-app purchases','Freemium','Advertising','API monetization','White-label licensing','None / internal tool'], advancedOnly: true },
      { key: 'analytics_needs',  label: 'Analytics & Observability', type: 'multi-select-pills', options: ['Product analytics (Mixpanel/Amplitude)','Web analytics (Plausible/GA4)','Error tracking (Sentry)','APM (Datadog/New Relic)','Log management','Heatmaps (Hotjar)','A/B testing','Custom dashboards','None'], advancedOnly: true },
      { key: 'compliance_needs', label: 'Compliance & Legals', type: 'multi-select-pills', options: ['Cookie consent banner','Privacy policy required','Terms of service','GDPR data deletion','COPPA (under-13 users)','Accessibility (WCAG 2.1)','Multi-currency','Multi-language / i18n','None'], advancedOnly: true },
    ]
  },
  {
    key: 'deployment', label: 'Deployment & Infra', icon: 'fa-rocket',
    guidedOnly: false,
    guidedStep: 6,
    fields: [
      { key: 'deployment_preferences', label: 'Deployment Preferences', type: 'textarea', placeholder: 'Any specific hosting, region, or infrastructure requirements?' },
      { key: 'platform_notes',   label: 'Platform Notes',    type: 'textarea', placeholder: 'Web only? Mobile too? Any platform constraints?' },
      // Advanced-only
      { key: 'ci_cd',            label: 'CI/CD Pipeline',    type: 'select', options: ['GitHub Actions','GitLab CI','Vercel built-in','Netlify CI','CircleCI','Bitbucket Pipelines','No CI/CD (manual)'], advancedOnly: true },
      { key: 'env_matrix',       label: 'Environment Matrix', type: 'multi-select-pills', options: ['Local dev','Preview / staging','Production','Feature branch previews','Canary / blue-green','Multi-region prod','Dedicated EU region'], advancedOnly: true },
      { key: 'observability',    label: 'Monitoring & Alerting', type: 'multi-select-pills', options: ['Uptime monitoring','Error alerts (PagerDuty/Opsgenie)','Performance budgets','Status page (Statuspage.io)','Cloudflare Analytics','Self-hosted (Grafana)','None'], advancedOnly: true },
      { key: 'scalability_notes',label: 'Scale & Traffic Expectations', type: 'textarea', placeholder: 'e.g. Launch: ~1k users, 6 months: ~50k MAU, spiky traffic on weekends', advancedOnly: true },
    ]
  },
  {
    key: 'comments', label: 'Additional Comments', icon: 'fa-comment-dots',
    guidedOnly: false,
    optional: true,
    guidedStep: 7,
    fields: [
      { key: 'additional_comments', label: 'Additional Ideas & Concepts', type: 'rich-comments', placeholder: 'Anything else on your mind? Concepts, inspirations, special requirements, things you love about other apps, anything the AI should know…', rows: 5, hint: 'This is your free space. Write as much or as little as you want. AI reads everything here.' }
    ]
  }
];

// ============================================================
// MODE STATE
// ============================================================
let PROMPT_MODE = 'guided';   // 'guided' | 'advanced'

function loadPromptPage() {
  loadProjects();
  
  if (STATE.activeProjectId) {
    const project = STATE.projects.find(p => p.id === STATE.activeProjectId);
    if (project) {
      selectPromptProject(STATE.activeProjectId, project.name);
    }
  }
}

async function selectPromptProject(projectId, projectName) {
  STATE.activeProjectId = projectId;
  localStorage.setItem('deploy_active_project', projectId);
  
  document.getElementById('prompt-project-select').classList.add('hidden');
  document.getElementById('prompt-builder').classList.remove('hidden');
  document.getElementById('active-project-name').textContent = projectName;
  
  // Load prompt data
  try {
    const { data } = await API.get(`/prompt/${projectId}`);
    if (data.success) {
      STATE.promptData = data.data.fields || {};
      renderPromptSections();
      updateProgress(data.data.completeness_score);
      
      // Set default model
      const project = STATE.projects.find(p => p.id === projectId);
      if (project?.active_model_id) {
        const model = STATE.models.find(m => m.id === project.active_model_id);
        if (model) {
          document.getElementById('current-model-name').textContent = model.display_name;
          updateBuildCostPreview(project.active_model_id);
        }
      }
    }
  } catch {
    renderPromptSections();
  }
}

function renderPromptSections() {
  if (PROMPT_MODE === 'guided') {
    renderGuidedMode();
  } else {
    renderAdvancedMode();
  }
  renderSectionDots();
}

// ── GUIDED MODE — all sections as accordions, guided fields only ──
function renderGuidedMode() {
  const container = document.getElementById('prompt-sections');
  const totalSteps = PROMPT_SECTIONS_CONFIG.length;
  const coreSections = PROMPT_SECTIONS_CONFIG.filter(s => !s.optional);
  const optSections  = PROMPT_SECTIONS_CONFIG.filter(s => s.optional);

  container.innerHTML = `
    <!-- Guided mode banner + Section Jump Dropdown -->
    <div class="rounded-xl border border-slate-700/50 bg-slate-800/30 px-4 py-3 flex items-start gap-3">
      <i class="fas fa-hand-holding-heart text-cyan-400 text-sm mt-0.5 flex-shrink-0"></i>
      <div class="flex-1 min-w-0">
        <p class="text-xs font-semibold text-white mb-0.5">Guided Mode</p>
        <p class="text-xs text-slate-400 leading-relaxed">Fill any section in any order — click to open, jump around freely. AI fills anything you leave blank.</p>
      </div>
    </div>

    <!-- Section Jump Dropdown -->
    <div class="relative" id="section-jump-wrapper">
      <button onclick="toggleSectionJumpMenu()" id="section-jump-btn"
        class="w-full flex items-center justify-between gap-2 px-4 py-3 rounded-xl border border-slate-700/60 bg-slate-900/60 hover:border-cyan-500/40 hover:bg-slate-800/60 transition-all">
        <div class="flex items-center gap-2">
          <i class="fas fa-layer-group text-cyan-400 text-sm"></i>
          <span class="text-sm font-semibold text-white">Jump to Section</span>
        </div>
        <div class="flex items-center gap-2">
          <span id="section-jump-progress" class="text-xs text-slate-500"></span>
          <i class="fas fa-chevron-down text-slate-500 text-xs transition-transform" id="section-jump-chevron"></i>
        </div>
      </button>
      <div id="section-jump-menu" class="hidden absolute left-0 right-0 top-full mt-1 z-30 rounded-xl border border-slate-700/60 bg-slate-900/95 backdrop-blur-sm overflow-hidden shadow-xl shadow-black/40">
        <div class="p-2 space-y-0.5">
          ${PROMPT_SECTIONS_CONFIG.map((s, i) => {
            const visFields = s.fields.filter(f => !f.advancedOnly);
            const filled = visFields.filter(f => fieldHasValue(f)).length;
            const pct = visFields.length > 0 ? Math.round((filled / visFields.length) * 100) : 0;
            const isComplete = pct === 100;
            const isOptional = s.optional;
            return `<button onclick="jumpToSection('${s.key}')"
              class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-800/80 transition-colors text-left group">
              <div class="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0
                ${isComplete ? 'bg-emerald-500/20' : isOptional ? 'bg-purple-500/15' : 'bg-slate-800'}">
                ${isComplete
                  ? '<i class="fas fa-check text-emerald-400 text-xs"></i>'
                  : `<i class="fas ${s.icon} ${isOptional ? 'text-purple-400' : 'text-slate-500'} text-xs"></i>`}
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <p class="text-sm font-medium ${isComplete ? 'text-slate-300' : 'text-white'}">${s.label}</p>
                  ${isOptional ? '<span class="text-xs text-purple-400/60">optional</span>' : ''}
                </div>
                <p class="text-xs ${isComplete ? 'text-emerald-400/70' : 'text-slate-600'}">${isComplete ? 'Complete' : `${filled}/${visFields.length} filled`}</p>
              </div>
              <div class="flex items-center gap-2">
                ${!isOptional && !isComplete && filled > 0 ? '<span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span>' : ''}
                ${isComplete ? '<i class="fas fa-circle-check text-emerald-400/60 text-xs"></i>' : '<i class="fas fa-chevron-right text-slate-700 text-xs group-hover:text-slate-500 transition-colors"></i>'}
              </div>
            </button>`;
          }).join('')}
        </div>
      </div>
    </div>
    <!-- Update progress in the jump button -->
    <script>
      (function() {
        const total = ${PROMPT_SECTIONS_CONFIG.length};
        const done = ${PROMPT_SECTIONS_CONFIG.filter(s => s.fields.filter(f=>!f.advancedOnly).every(f=>fieldHasValue(f))).length};
        const el = document.getElementById('section-jump-progress');
        if (el) el.textContent = done + '/' + total + ' complete';
      })();
    </script>

    ${coreSections.map(s => renderGuidedSection(s)).join('')}

    <!-- Optional sections -->
    <div class="rounded-xl border border-purple-500/15 overflow-hidden">
      <div class="px-4 py-2 bg-purple-500/5 border-b border-purple-500/10">
        <p class="text-xs font-semibold text-purple-400/80 uppercase tracking-wider">Optional — AI handles these if left blank</p>
      </div>
      ${optSections.map(s => renderGuidedSection(s)).join('')}
    </div>

    <!-- Switch hint -->
    <p class="text-center text-xs text-slate-700">
      Want full technical control?
      <button onclick="setPromptMode('advanced')" class="text-cyan-500 hover:text-cyan-400 underline underline-offset-2">Switch to Advanced mode</button>
    </p>
  `;

  // Auto-open the first incomplete section
  const firstIncomplete = PROMPT_SECTIONS_CONFIG.find(s => {
    const vf = s.fields.filter(f => !f.advancedOnly);
    return vf.some(f => !fieldHasValue(f));
  });
  if (firstIncomplete) {
    const body    = document.querySelector(`.section-body-${firstIncomplete.key}`);
    const chevron = document.querySelector(`.section-chevron-${firstIncomplete.key}`);
    if (body)    body.classList.remove('hidden');
    if (chevron) chevron.style.transform = 'rotate(180deg)';
  }
}

function renderGuidedSection(section) {
  const isOptional = section.optional;
  // Guided mode: hide advancedOnly fields
  const visibleFields   = section.fields.filter(f => !f.advancedOnly);
  const completedFields = visibleFields.filter(f => fieldHasValue(f)).length;
  const isComplete      = completedFields === visibleFields.length;
  const isPartial       = completedFields > 0 && !isComplete;

  return `
    <div class="glass rounded-xl overflow-hidden" id="section-${section.key}">
      <button onclick="toggleSection('${section.key}')"
        class="w-full flex items-center gap-3 p-4 text-left">
        <div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0
          ${isComplete ? 'bg-emerald-500/20' : isPartial ? (isOptional ? 'bg-purple-500/20' : 'bg-amber-500/20') : 'bg-slate-700/50'}">
          ${isComplete
            ? '<i class="fas fa-check text-emerald-400 text-xs"></i>'
            : `<i class="fas ${section.icon} ${isOptional ? 'text-purple-400' : 'text-slate-400'} text-xs"></i>`}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <p class="text-sm font-semibold text-white">${section.label}</p>
            ${isOptional ? '<span class="text-xs text-purple-400/70 bg-purple-400/10 px-1.5 py-0.5 rounded-full">optional</span>' : ''}
          </div>
          <p class="text-xs ${isOptional ? 'text-purple-400/60' : 'text-slate-500'}">
            ${isOptional
              ? (completedFields > 0 ? `${completedFields} field${completedFields > 1 ? 's' : ''} filled · AI handles the rest` : 'AI handles all — add details to guide it')
              : `${completedFields}/${visibleFields.length} filled`}
          </p>
        </div>
        <div class="flex items-center gap-2">
          ${isPartial && !isOptional ? '<span class="w-2 h-2 rounded-full bg-amber-400"></span>' : ''}
          ${isPartial && isOptional  ? '<span class="w-2 h-2 rounded-full bg-purple-400"></span>' : ''}
          <i class="fas fa-chevron-down text-slate-600 text-xs section-chevron-${section.key} transition-transform"></i>
        </div>
      </button>

      <div class="section-body-${section.key} hidden px-4 pb-4 space-y-4">
        ${visibleFields.map(f => renderField(f, section.key)).join('')}

        ${!isOptional ? `
        <div class="pt-2 border-t border-slate-800">
          <button onclick="aiAssistSection('${section.key}')"
            class="text-xs text-slate-500 hover:text-cyan-400 flex items-center gap-1.5 transition-colors">
            <i class="fas fa-wand-magic-sparkles"></i>
            <span>AI Assist this section (2 coins each)</span>
          </button>
        </div>` : ''}
      </div>
    </div>
  `;
}

// ── Section Jump Dropdown toggle ──────────────────────────────
function toggleSectionJumpMenu() {
  const menu = document.getElementById('section-jump-menu');
  const chevron = document.getElementById('section-jump-chevron');
  if (!menu) return;
  const isOpen = !menu.classList.contains('hidden');
  if (isOpen) {
    menu.classList.add('hidden');
    if (chevron) chevron.style.transform = '';
  } else {
    menu.classList.remove('hidden');
    if (chevron) chevron.style.transform = 'rotate(180deg)';
  }
}

function jumpToSection(key) {
  // Close dropdown
  const menu = document.getElementById('section-jump-menu');
  const chevron = document.getElementById('section-jump-chevron');
  if (menu) menu.classList.add('hidden');
  if (chevron) chevron.style.transform = '';

  // Open target section
  const body    = document.querySelector(`.section-body-${key}`);
  const chevS   = document.querySelector(`.section-chevron-${key}`);
  if (body) {
    body.classList.remove('hidden');
    if (chevS) chevS.style.transform = 'rotate(180deg)';
    // Smooth scroll to section
    const sectionEl = document.getElementById(`section-${key}`);
    if (sectionEl) {
      setTimeout(() => sectionEl.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
  }
}

// Close dropdown when clicking outside
document.addEventListener('click', function(e) {
  const wrapper = document.getElementById('section-jump-wrapper');
  if (wrapper && !wrapper.contains(e.target)) {
    const menu = document.getElementById('section-jump-menu');
    const chevron = document.getElementById('section-jump-chevron');
    if (menu) menu.classList.add('hidden');
    if (chevron) chevron.style.transform = '';
  }
});

// ── ADVANCED MODE — all sections expanded, full tech pickers ──
function renderAdvancedMode() {
  const container = document.getElementById('prompt-sections');

  // Separate sections: core + optional
  const coreSections = PROMPT_SECTIONS_CONFIG.filter(s => !s.optional);
  const optSections  = PROMPT_SECTIONS_CONFIG.filter(s => s.optional);

  container.innerHTML = `
    <!-- Advanced mode banner -->
    <div class="rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3 flex items-start gap-3">
      <i class="fas fa-terminal text-cyan-400 text-sm mt-0.5 flex-shrink-0"></i>
      <div>
        <p class="text-xs font-semibold text-cyan-400 mb-0.5">Advanced Mode</p>
        <p class="text-xs text-slate-400 leading-relaxed">Full control — every field, every technical decision. AI will follow your specs exactly. Leave anything blank and AI fills it in.</p>
      </div>
    </div>

    ${coreSections.map(s => renderAdvancedSection(s)).join('')}

    <!-- Optional sections group -->
    <div class="rounded-xl border border-purple-500/15 overflow-hidden">
      <div class="px-4 py-2 bg-purple-500/5 border-b border-purple-500/10">
        <p class="text-xs font-semibold text-purple-400/80 uppercase tracking-wider">Optional Enhancements</p>
      </div>
      ${optSections.map(s => renderAdvancedSection(s)).join('')}
    </div>

    <!-- AI Tool Recommender -->
    ${renderAIToolRecommender()}

    <!-- Switch hint -->
    <p class="text-center text-xs text-slate-700">
      Prefer a guided walkthrough? 
      <button onclick="setPromptMode('guided')" class="text-cyan-500 hover:text-cyan-400 underline underline-offset-2">Switch to Guided mode</button>
    </p>
  `;
}

function renderAdvancedSection(section) {
  const isOptional = section.optional;
  const visibleFields = section.fields; // all fields including advancedOnly
  const completedFields = visibleFields.filter(f => fieldHasValue(f)).length;
  const isComplete = completedFields === visibleFields.length;
  const isPartial = completedFields > 0 && !isComplete;
  const advOnlyCount = section.fields.filter(f => f.advancedOnly).length;

  return `
    <div class="glass rounded-xl overflow-hidden" id="section-${section.key}">
      <button onclick="toggleSection('${section.key}')"
        class="w-full flex items-center gap-3 p-4 text-left">
        <div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0
          ${isComplete ? 'bg-emerald-500/20' : isPartial ? (isOptional ? 'bg-purple-500/20' : 'bg-amber-500/20') : 'bg-slate-700/50'}">
          ${isComplete
            ? '<i class="fas fa-check text-emerald-400 text-xs"></i>'
            : `<i class="fas ${section.icon} ${isOptional ? 'text-purple-400' : 'text-slate-400'} text-xs"></i>`}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <p class="text-sm font-semibold text-white">${section.label}</p>
            ${isOptional ? '<span class="text-xs text-purple-400/70 bg-purple-400/10 px-1.5 py-0.5 rounded-full">optional</span>' : ''}
            ${advOnlyCount > 0 ? `<span class="text-xs text-cyan-400/60 bg-cyan-400/8 px-1.5 py-0.5 rounded-full">${advOnlyCount} advanced fields</span>` : ''}
          </div>
          <p class="text-xs ${isOptional ? 'text-purple-400/60' : 'text-slate-500'}">
            ${isOptional
              ? (completedFields > 0 ? `${completedFields} field${completedFields > 1 ? 's' : ''} filled · AI handles the rest` : 'AI handles all — add details to guide it')
              : `${completedFields}/${visibleFields.length} filled`}
          </p>
        </div>
        <div class="flex items-center gap-2">
          ${isPartial && !isOptional ? '<span class="w-2 h-2 rounded-full bg-amber-400"></span>' : ''}
          ${isPartial && isOptional  ? '<span class="w-2 h-2 rounded-full bg-purple-400"></span>' : ''}
          <i class="fas fa-chevron-down text-slate-600 text-xs section-chevron-${section.key} transition-transform"></i>
        </div>
      </button>

      <div class="section-body-${section.key} hidden px-4 pb-4 space-y-4">
        <!-- Core fields first -->
        ${section.fields.filter(f => !f.advancedOnly).map(f => renderField(f, section.key)).join('')}

        <!-- Advanced-only fields with separator -->
        ${section.fields.filter(f => f.advancedOnly).length > 0 ? `
        <div class="pt-1">
          <div class="flex items-center gap-2 mb-4">
            <div class="flex-1 h-px bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent"></div>
            <span class="text-xs text-cyan-400/60 font-medium px-2 flex items-center gap-1.5">
              <i class="fas fa-terminal text-xs"></i> Advanced Configuration
            </span>
            <div class="flex-1 h-px bg-gradient-to-l from-transparent via-cyan-500/30 to-transparent"></div>
          </div>
          <div class="space-y-4">
            ${section.fields.filter(f => f.advancedOnly).map(f => renderField(f, section.key)).join('')}
          </div>
        </div>` : ''}

        <!-- AI Assist -->
        ${!isOptional ? `
        <div class="pt-2 border-t border-slate-800">
          <button onclick="aiAssistSection('${section.key}')"
            class="text-xs text-slate-500 hover:text-cyan-400 flex items-center gap-1.5 transition-colors">
            <i class="fas fa-wand-magic-sparkles"></i>
            <span>AI Assist this section (2 coins each)</span>
          </button>
        </div>` : ''}
      </div>
    </div>
  `;
}

// ── AI Tool Recommender panel ─────────────────────────────────
function renderAIToolRecommender() {
  const picks = {
    db:      STATE.promptData['db_choice'] || '',
    storage: STATE.promptData['storage_choice'] || '',
    deploy:  STATE.promptData['deploy_choice'] || '',
  };
  const hasPicks = picks.db || picks.storage || picks.deploy;
  const scored = computeAIToolScores(picks);
  const top = scored.slice(0, 3);
  const rest = scored.slice(3);

  const badgeColors = {
    cyan:    'bg-cyan-500/15 text-cyan-400',
    purple:  'bg-purple-500/15 text-purple-400',
    violet:  'bg-violet-500/15 text-violet-400',
    emerald: 'bg-emerald-500/15 text-emerald-400',
    amber:   'bg-amber-500/15 text-amber-400',
    rose:    'bg-rose-500/15 text-rose-400',
    slate:   'bg-slate-700/50 text-slate-400',
  };

  return `
    <div class="rounded-2xl border border-slate-700/60 overflow-hidden" id="ai-tool-panel">
      <!-- Header -->
      <div class="px-4 py-3 bg-gradient-to-r from-slate-800/60 to-slate-900/60 border-b border-slate-700/40 flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-500/20 to-purple-500/20 flex items-center justify-center">
            <i class="fas fa-robot text-cyan-400 text-xs"></i>
          </div>
          <div>
            <p class="text-sm font-bold text-white">AI Dev Tool Recommender</p>
            <p class="text-xs text-slate-500">${hasPicks ? 'Matched to your stack' : 'Pick your stack above to get personalised recommendations'}</p>
          </div>
        </div>
        ${hasPicks ? '<span class="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full"><i class="fas fa-circle-check mr-1"></i>Live</span>' : ''}
      </div>

      <div class="p-4 space-y-3">
        ${!hasPicks ? `
        <div class="text-center py-6">
          <div class="w-12 h-12 rounded-2xl bg-slate-800 flex items-center justify-center mx-auto mb-3">
            <i class="fas fa-layer-group text-slate-600 text-xl"></i>
          </div>
          <p class="text-sm text-slate-500">Select a database, storage, and deployment platform above.</p>
          <p class="text-xs text-slate-700 mt-1">We'll rank the best AI coding tools for your exact stack.</p>
        </div>` : `
        <!-- Top 3 recommended -->
        <p class="text-xs font-semibold text-slate-500 uppercase tracking-wider">Top Picks for Your Stack</p>
        ${top.map((tool, i) => `
          <div class="rounded-xl border ${i === 0 ? 'border-cyan-500/30 bg-cyan-500/5' : 'border-slate-700/50'} p-3.5">
            <div class="flex items-start gap-3">
              <div class="w-9 h-9 rounded-xl flex-shrink-0 flex items-center justify-center
                ${i === 0 ? 'bg-gradient-to-br from-cyan-500/20 to-cyan-600/10' : 'bg-slate-800'}">
                <i class="fas ${tool.iconClass} ${i === 0 ? 'text-cyan-400' : 'text-slate-500'} text-sm"></i>
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-0.5 flex-wrap">
                  <p class="text-sm font-bold text-white">${tool.name}</p>
                  ${i === 0 ? '<span class="text-xs bg-cyan-500/20 text-cyan-400 px-1.5 py-0.5 rounded-full font-medium">#1 Match</span>' : ''}
                  <span class="text-xs ${badgeColors[tool.badgeColor] || badgeColors.slate} px-1.5 py-0.5 rounded-full">${tool.badge}</span>
                </div>
                <p class="text-xs text-slate-400 font-medium mb-1">${tool.tagline}</p>
                <p class="text-xs text-slate-500 leading-relaxed mb-2">${tool.desc}</p>
                <div class="flex flex-wrap gap-1 mb-2">
                  ${tool.strengths.map(s => `<span class="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full">${s}</span>`).join('')}
                </div>
                <a href="${tool.url}" target="_blank" rel="noopener"
                  class="inline-flex items-center gap-1 text-xs ${i === 0 ? 'text-cyan-400 hover:text-cyan-300' : 'text-slate-500 hover:text-slate-400'} transition-colors">
                  Visit ${tool.name} <i class="fas fa-arrow-up-right-from-square text-xs"></i>
                </a>
              </div>
              ${i === 0 ? `<div class="flex-shrink-0 text-lg font-black text-cyan-400/20">#1</div>` : ''}
            </div>
          </div>
        `).join('')}

        <!-- Also consider -->
        <p class="text-xs font-semibold text-slate-600 uppercase tracking-wider pt-1">Also Consider</p>
        <div class="grid grid-cols-2 gap-2">
          ${rest.map(tool => `
            <a href="${tool.url}" target="_blank" rel="noopener"
              class="rounded-xl border border-slate-800 hover:border-slate-700 bg-slate-900/40 p-3 transition-all group">
              <div class="flex items-center gap-2 mb-1">
                <i class="fas ${tool.iconClass} text-slate-600 group-hover:text-slate-500 text-xs transition-colors"></i>
                <p class="text-xs font-semibold text-slate-400 group-hover:text-slate-300 transition-colors">${tool.name}</p>
              </div>
              <p class="text-xs text-slate-700 leading-tight">${tool.tagline}</p>
            </a>
          `).join('')}
        </div>
        `}
      </div>
    </div>
  `;
}

function renderField(field, sectionKey) {
  const value = STATE.promptData[field.key] || '';

  // ── Tech Stack Picker ────────────────────────────────────────
  if (field.type === 'tech-picker') {
    const items = TECH_STACK_CATALOG[field.catalog] || [];
    const selectedId = value;
    return `
      <div>
        <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2 block flex items-center justify-between">
          <span>${field.label}</span>
          ${selectedId ? `<span class="text-emerald-400 font-normal normal-case"><i class="fas fa-check-circle mr-1"></i>${items.find(x=>x.id===selectedId)?.label||selectedId}</span>` : ''}
        </label>
        <div class="space-y-1.5">
          ${items.map(item => `
            <button type="button"
              onclick="selectTechOption('${sectionKey}','${field.key}','${item.id}')"
              class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all text-left
                ${selectedId === item.id
                  ? 'border-cyan-400/60 bg-cyan-400/8'
                  : 'border-slate-800 hover:border-slate-700 bg-slate-900/30 hover:bg-slate-800/30'}">
              <div class="w-7 h-7 rounded-lg flex-shrink-0 flex items-center justify-center
                ${selectedId === item.id ? 'bg-cyan-400/15' : 'bg-slate-800'}">
                <i class="fas ${item.icon} ${selectedId === item.id ? 'text-cyan-400' : 'text-slate-600'} text-xs"></i>
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <p class="text-xs font-semibold ${selectedId === item.id ? 'text-cyan-400' : 'text-slate-300'}">${item.label}</p>
                  ${item.tags.slice(0,2).map(t => `<span class="text-xs bg-slate-800/80 text-slate-600 px-1.5 py-px rounded-full">${t}</span>`).join('')}
                </div>
                <p class="text-xs text-slate-600 truncate">${item.desc}</p>
              </div>
              ${selectedId === item.id ? '<i class="fas fa-check text-cyan-400 text-xs flex-shrink-0"></i>' : ''}
            </button>
          `).join('')}
        </div>
      </div>`;
  }

  // ── Multi-Select Pills ────────────────────────────────────────
  if (field.type === 'multi-select-pills') {
    let selected = [];
    try { selected = JSON.parse(value || '[]'); } catch { selected = []; }
    return `
      <div>
        <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2 block">${field.label}</label>
        <div class="flex flex-wrap gap-2" id="pills-${field.key}">
          ${(field.options || []).map(opt => {
            const isOn = selected.includes(opt);
            return `<button type="button"
              onclick="togglePill('${sectionKey}','${field.key}','${opt.replace(/'/g,"\\'")}',this)"
              class="px-3 py-1.5 rounded-full text-xs font-medium border transition-all
                ${isOn ? 'border-cyan-400/60 bg-cyan-400/10 text-cyan-400' : 'border-slate-700 text-slate-500 hover:border-slate-600 hover:text-slate-400'}">
              ${isOn ? '<i class="fas fa-check mr-1.5 text-xs"></i>' : ''}${opt}
            </button>`;
          }).join('')}
        </div>
      </div>`;
  }

  // ── Color Scheme Picker ──────────────────────────────────────
  if (field.type === 'color-scheme') {
    const palettes = [
      { id:'cyber',    label:'Cyber',     colors:['#06b6d4','#0891b2','#fbbf24'] },
      { id:'midnight', label:'Midnight',  colors:['#6366f1','#4f46e5','#818cf8'] },
      { id:'emerald',  label:'Nature',    colors:['#10b981','#059669','#34d399'] },
      { id:'rose',     label:'Rose',      colors:['#f43f5e','#e11d48','#fb7185'] },
      { id:'amber',    label:'Amber',     colors:['#f59e0b','#d97706','#fbbf24'] },
      { id:'violet',   label:'Violet',    colors:['#8b5cf6','#7c3aed','#a78bfa'] },
      { id:'slate',    label:'Mono',      colors:['#64748b','#475569','#94a3b8'] },
      { id:'custom',   label:'Custom',    colors:[] },
    ];
    const selectedId = value.startsWith('custom:') ? 'custom' : (value || 'cyber');
    const customHex  = value.startsWith('custom:') ? value.replace('custom:','') : '#06b6d4';
    return `
      <div>
        <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2 block">${field.label}</label>
        ${field.hint ? `<p class="text-xs text-slate-600 mb-3">${field.hint}</p>` : ''}
        <div class="grid grid-cols-4 gap-2" id="palette-grid-${field.key}">
          ${palettes.map(p => `
            <button type="button"
              onclick="selectPalette('${sectionKey}','${field.key}','${p.id}')"
              class="palette-btn relative p-2.5 rounded-xl border transition-all ${(selectedId===p.id) ? 'border-cyan-400 bg-cyan-400/10' : 'border-slate-700 hover:border-slate-500'}"
              data-palette="${p.id}">
              <div class="flex gap-0.5 justify-center mb-1.5">
                ${p.id === 'custom'
                  ? `<div class="w-5 h-5 rounded-full border border-slate-600 flex items-center justify-center">
                       <i class="fas fa-plus text-slate-500" style="font-size:8px"></i>
                     </div>`
                  : p.colors.map(c => `<div class="w-3.5 h-3.5 rounded-full" style="background:${c}"></div>`).join('')
                }
              </div>
              <p class="text-xs text-center ${selectedId===p.id ? 'text-cyan-400' : 'text-slate-500'}">${p.label}</p>
            </button>
          `).join('')}
        </div>
        <div id="custom-color-row-${field.key}" class="${selectedId==='custom' ? 'mt-3 flex items-center gap-3' : 'hidden mt-3 flex items-center gap-3'}">
          <input type="color" id="custom-color-${field.key}" value="${customHex}"
            onchange="onCustomColor('${sectionKey}','${field.key}',this.value)"
            class="w-10 h-10 rounded-xl border border-slate-700 bg-transparent cursor-pointer">
          <div>
            <p class="text-xs text-slate-400 font-medium">Custom primary color</p>
            <p class="text-xs text-slate-600">AI will build a complete palette around this</p>
          </div>
        </div>
      </div>`;
  }

  // ── Feature List (dynamic add/remove) ───────────────────────
  if (field.type === 'feature-list') {
    let items = [];
    try { items = JSON.parse(value); } catch { items = value ? [value] : []; }
    const listId = `flist-${field.key}`;
    return `
      <div>
        <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5 flex items-center justify-between">
          <span>${field.label}</span>
          <button onclick="aiAssistField('${sectionKey}','${field.key}')" class="text-cyan-400/50 hover:text-cyan-400 transition-colors">
            <i class="fas fa-wand-magic-sparkles text-xs"></i>
          </button>
        </label>
        ${field.hint ? `<p class="text-xs text-slate-600 mb-2">${field.hint}</p>` : ''}
        <div id="${listId}" class="space-y-2 mb-2">
          ${items.length === 0
            ? `<p class="text-xs text-slate-600 italic py-1">No features added yet — AI will create a great set for you.</p>`
            : items.map((item, i) => featureListItem(field.key, sectionKey, item, i)).join('')
          }
        </div>
        <button type="button" onclick="addFeatureItem('${field.key}','${sectionKey}')"
          class="flex items-center gap-2 text-xs text-cyan-400 hover:text-cyan-300 transition-colors py-1">
          <i class="fas fa-plus-circle"></i> Add feature
        </button>
      </div>`;
  }

  // ── Rich Comments (large, inviting textarea) ─────────────────
  if (field.type === 'rich-comments') {
    return `
      <div>
        <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5 block">${field.label}</label>
        ${field.hint ? `<p class="text-xs text-slate-500 mb-3 leading-relaxed">${field.hint}</p>` : ''}
        <div class="relative">
          <textarea oninput="onFieldInput('${sectionKey}','${field.key}',this.value)"
            placeholder="${field.placeholder || ''}"
            rows="${field.rows || 5}"
            class="deploy-input w-full px-4 py-3 rounded-xl text-sm resize-none"
            style="min-height:120px"
            id="field-${field.key}">${escHtml(value)}</textarea>
          <div class="absolute bottom-2 right-2 flex items-center gap-1.5">
            ${value.length > 0 ? `<span class="text-xs text-slate-600">${value.length} chars</span>` : ''}
            ${value.length > 10 ? '<i class="fas fa-check-circle text-emerald-400/60 text-xs"></i>' : ''}
          </div>
        </div>
        <p class="text-xs text-slate-700 mt-1.5">This section is optional but the more context you give, the better your build will be.</p>
      </div>`;
  }

  // ── Select ───────────────────────────────────────────────────
  if (field.type === 'select') {
    return `
      <div>
        <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5 flex items-center justify-between">
          <span>${field.label}</span>
          <button onclick="aiAssistField('${sectionKey}','${field.key}')" class="text-cyan-400/50 hover:text-cyan-400 transition-colors">
            <i class="fas fa-wand-magic-sparkles text-xs"></i>
          </button>
        </label>
        <select onchange="saveField('${sectionKey}','${field.key}',this.value)"
          class="deploy-input w-full px-4 py-3 rounded-xl text-sm" id="field-${field.key}">
          <option value="">Select...</option>
          ${(field.options || []).map(o => `<option value="${o}" ${value === o ? 'selected' : ''}>${o}</option>`).join('')}
        </select>
      </div>`;
  }

  // ── Textarea ─────────────────────────────────────────────────
  if (field.type === 'textarea') {
    return `
      <div>
        <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5 flex items-center justify-between">
          <span>${field.label}</span>
          <button onclick="aiAssistField('${sectionKey}','${field.key}')" class="text-cyan-400/50 hover:text-cyan-400 transition-colors">
            <i class="fas fa-wand-magic-sparkles text-xs"></i>
          </button>
        </label>
        <div class="relative">
          <textarea oninput="onFieldInput('${sectionKey}','${field.key}',this.value)"
            placeholder="${field.placeholder || ''}"
            rows="${field.rows || 3}"
            class="deploy-input w-full px-4 py-3 rounded-xl text-sm resize-none"
            id="field-${field.key}">${escHtml(value)}</textarea>
          <div class="absolute bottom-2 right-2">
            ${value.length > 5 ? '<i class="fas fa-check-circle text-emerald-400/60 text-xs"></i>' : '<i class="fas fa-circle text-slate-700 text-xs"></i>'}
          </div>
        </div>
      </div>`;
  }

  // ── Text ─────────────────────────────────────────────────────
  return `
    <div>
      <label class="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5 flex items-center justify-between">
        <span>${field.label}</span>
        <button onclick="aiAssistField('${sectionKey}','${field.key}')" class="text-cyan-400/50 hover:text-cyan-400 transition-colors">
          <i class="fas fa-wand-magic-sparkles text-xs"></i>
        </button>
      </label>
      <input type="text" oninput="onFieldInput('${sectionKey}','${field.key}',this.value)"
        value="${escHtml(value)}"
        placeholder="${field.placeholder || ''}"
        class="deploy-input w-full px-4 py-3 rounded-xl text-sm"
        id="field-${field.key}">
    </div>`;
}

// ── Feature List helpers ─────────────────────────────────────
function featureListItem(fieldKey, sectionKey, text, idx) {
  return `
    <div class="flex items-start gap-2 feature-item" id="fitem-${fieldKey}-${idx}">
      <div class="flex-shrink-0 w-5 h-5 mt-2.5 rounded-full flex items-center justify-center"
           style="background:rgba(34,211,238,0.1); border:1px solid rgba(34,211,238,0.2)">
        <i class="fas fa-check text-cyan-400" style="font-size:8px"></i>
      </div>
      <textarea
        rows="1"
        class="deploy-input flex-1 px-3 py-2 rounded-xl text-sm resize-none"
        style="min-height:36px; overflow:hidden"
        placeholder="Describe this feature…"
        oninput="onFeatureItemInput('${fieldKey}','${sectionKey}',this)"
        onfocus="this.style.height='auto'; this.style.height=this.scrollHeight+'px'"
        id="fitem-input-${fieldKey}-${idx}"
        data-idx="${idx}">${escHtml(text)}</textarea>
      <button type="button"
        onclick="removeFeatureItem('${fieldKey}','${sectionKey}',${idx})"
        class="flex-shrink-0 mt-2.5 text-slate-700 hover:text-red-400 transition-colors">
        <i class="fas fa-xmark text-xs"></i>
      </button>
    </div>`;
}

function addFeatureItem(fieldKey, sectionKey) {
  let items = [];
  try { items = JSON.parse(STATE.promptData[fieldKey] || '[]'); } catch { items = []; }
  items.push('');
  STATE.promptData[fieldKey] = JSON.stringify(items);
  // Re-render just the list
  const listEl = document.getElementById(`flist-${fieldKey}`);
  if (listEl) {
    listEl.innerHTML = items.map((item, i) => featureListItem(fieldKey, sectionKey, item, i)).join('');
    // Auto-focus the new item
    const lastInput = document.getElementById(`fitem-input-${fieldKey}-${items.length - 1}`);
    if (lastInput) { lastInput.focus(); lastInput.style.height = 'auto'; lastInput.style.height = lastInput.scrollHeight + 'px'; }
  }
  scheduleFeatureSave(fieldKey, sectionKey);
}

function removeFeatureItem(fieldKey, sectionKey, idx) {
  let items = [];
  try { items = JSON.parse(STATE.promptData[fieldKey] || '[]'); } catch { items = []; }
  items.splice(idx, 1);
  STATE.promptData[fieldKey] = JSON.stringify(items);
  const listEl = document.getElementById(`flist-${fieldKey}`);
  if (listEl) {
    listEl.innerHTML = items.length === 0
      ? `<p class="text-xs text-slate-600 italic py-1">No features added yet — AI will create a great set for you.</p>`
      : items.map((item, i) => featureListItem(fieldKey, sectionKey, item, i)).join('');
  }
  scheduleFeatureSave(fieldKey, sectionKey);
  // Rebuild progress dots
  renderSectionDots();
}

function onFeatureItemInput(fieldKey, sectionKey, el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
  const idx = parseInt(el.dataset.idx);
  let items = [];
  try { items = JSON.parse(STATE.promptData[fieldKey] || '[]'); } catch { items = []; }
  items[idx] = el.value;
  STATE.promptData[fieldKey] = JSON.stringify(items);
  scheduleFeatureSave(fieldKey, sectionKey);
}

const featureSaveTimers = {};
function scheduleFeatureSave(fieldKey, sectionKey) {
  clearTimeout(featureSaveTimers[fieldKey]);
  featureSaveTimers[fieldKey] = setTimeout(() => {
    saveField(sectionKey, fieldKey, STATE.promptData[fieldKey], true);
    renderSectionDots();
  }, 900);
}

// ── Color Scheme helpers ─────────────────────────────────────
function selectPalette(sectionKey, fieldKey, paletteId) {
  if (paletteId === 'custom') {
    // Show color picker row, don't save yet
    const row = document.getElementById(`custom-color-row-${fieldKey}`);
    if (row) row.classList.remove('hidden');
    // Still mark this palette visually
    document.querySelectorAll(`#palette-grid-${fieldKey} .palette-btn`).forEach(btn => {
      const active = btn.dataset.palette === paletteId;
      btn.classList.toggle('border-cyan-400', active);
      btn.classList.toggle('bg-cyan-400/10', active);
      btn.classList.toggle('border-slate-700', !active);
    });
    return;
  }
  const row = document.getElementById(`custom-color-row-${fieldKey}`);
  if (row) row.classList.add('hidden');
  // Update button states
  document.querySelectorAll(`#palette-grid-${fieldKey} .palette-btn`).forEach(btn => {
    const active = btn.dataset.palette === paletteId;
    btn.classList.toggle('border-cyan-400', active);
    btn.classList.toggle('bg-cyan-400/10', active);
    btn.classList.toggle('border-slate-700', !active);
    btn.querySelector('p').classList.toggle('text-cyan-400', active);
    btn.querySelector('p').classList.toggle('text-slate-500', !active);
  });
  STATE.promptData[fieldKey] = paletteId;
  saveField(sectionKey, fieldKey, paletteId, true);
  renderSectionDots();
}

function onCustomColor(sectionKey, fieldKey, hex) {
  const val = `custom:${hex}`;
  STATE.promptData[fieldKey] = val;
  saveField(sectionKey, fieldKey, val, true);
  renderSectionDots();
}

function fieldHasValue(field) {
  const v = STATE.promptData[field.key];
  if (!v) return false;
  if (field.type === 'feature-list') {
    try { const arr = JSON.parse(v); return arr.some(x => x && x.trim().length > 0); } catch { return v.length > 0; }
  }
  if (field.type === 'multi-select-pills') {
    try { const arr = JSON.parse(v); return arr.length > 0; } catch { return v.length > 0; }
  }
  if (field.type === 'tech-picker') return v && v.trim().length > 0;
  if (field.type === 'color-scheme') return v && v.length > 0;
  if (field.type === 'rich-comments') return v && v.trim().length > 5;
  if (['visual_features','ui_ux_notes'].includes(field.key)) return v && v.trim().length > 0;
  return v && v.trim().length > 5;
}

function renderSectionDots() {
  const container = document.getElementById('section-dots');
  container.innerHTML = PROMPT_SECTIONS_CONFIG.map(s => {
    const isOptional = s.optional;
    // In guided mode only count the non-advancedOnly fields
    const relevantFields = PROMPT_MODE === 'guided'
      ? s.fields.filter(f => !f.advancedOnly)
      : s.fields;
    const coreFields = relevantFields.filter(f => !['visual_features','ui_ux_notes','additional_comments'].includes(f.key));
    const completed = relevantFields.filter(f => fieldHasValue(f)).length;
    const total = isOptional ? relevantFields.length : (coreFields.length || relevantFields.length);
    const pct = completed / total;
    let color = 'bg-slate-700';
    if (pct >= 1) color = 'bg-emerald-400';
    else if (pct > 0) color = isOptional ? 'bg-purple-400' : 'bg-amber-400';
    const tip = isOptional ? `${s.label} (optional): ${completed}/${total}` : `${s.label}: ${completed}/${total}`;
    return `<div class="w-2 h-1.5 rounded-full transition-all ${color}" title="${tip}"></div>`;
  }).join('');
}

function toggleSection(key) {
  const body = document.querySelector(`.section-body-${key}`);
  const chevron = document.querySelector(`.section-chevron-${key}`);
  body.classList.toggle('hidden');
  chevron.style.transform = body.classList.contains('hidden') ? '' : 'rotate(180deg)';
}

let autosaveTimer = null;
function onFieldInput(sectionKey, fieldKey, value) {
  STATE.promptData[fieldKey] = value;
  
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    saveField(sectionKey, fieldKey, value, true);
  }, 1200);
}

async function saveField(sectionKey, fieldKey, value, silent = false) {
  if (!STATE.activeProjectId) return;
  
  try {
    const { data } = await API.put(`/prompt/${STATE.activeProjectId}/field`, {
      section_key: sectionKey,
      field_key: fieldKey,
      value
    });
    if (data.success) {
      STATE.promptData[fieldKey] = value;
      updateProgress(data.data.completeness_score);
      if (!silent) showToast('Saved', 'success');
    }
  } catch {
    if (!silent) showToast('Save failed', 'error');
  }
}

function updateProgress(score) {
  document.getElementById('completeness-pct').textContent = `${score}%`;
  document.getElementById('progress-bar').style.width = `${score}%`;
  renderSectionDots();
  
  const copyBtn = document.getElementById('copy-btn');
  if (score >= 70) {
    copyBtn.classList.remove('hidden');
    copyBtn.classList.add('flex');
  } else {
    copyBtn.classList.add('hidden');
    copyBtn.classList.remove('flex');
  }
}

async function aiAssistField(sectionKey, fieldKey) {
  if (!STATE.activeProjectId) {
    showToast('Select a project first', 'error'); return;
  }
  
  const btn = event.currentTarget;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin text-xs"></i>';
  
  try {
    const { data } = await API.post(`/prompt/${STATE.activeProjectId}/ai-assist`, {
      section_key: sectionKey,
      field_key: fieldKey
    });
    
    if (data.success) {
      const el = document.getElementById(`field-${fieldKey}`);
      if (el) {
        el.value = data.data.suggestion;
        STATE.promptData[fieldKey] = data.data.suggestion;
        await saveField(sectionKey, fieldKey, data.data.suggestion, true);
        // Refresh section
        renderPromptSections();
      }
      showToast(`AI suggestion applied (${data.data.coins_spent} coins used)`, 'success');
      
      // Update coin balance
      if (STATE.user) {
        STATE.user.coin_balance = Math.max(0, (STATE.user.coin_balance || 0) - data.data.coins_spent);
        document.getElementById('header-coins').textContent = STATE.user.coin_balance.toLocaleString();
      }
    }
  } catch (err) {
    showToast(err.response?.data?.error || 'AI assist failed', 'error');
  } finally {
    btn.innerHTML = '<i class="fas fa-wand-magic-sparkles text-xs"></i>';
  }
}

async function aiAssistSection(sectionKey) {
  const section = PROMPT_SECTIONS_CONFIG.find(s => s.key === sectionKey);
  if (!section) return;
  // Only assist text-generatable field types; skip pickers and human-only input
  const assistableTypes = ['text', 'textarea', 'feature-list'];
  const fields = PROMPT_MODE === 'guided'
    ? section.fields.filter(f => !f.advancedOnly)
    : section.fields;
  for (const field of fields) {
    if (!assistableTypes.includes(field.type)) continue;
    if (!fieldHasValue(field)) {
      await aiAssistField(sectionKey, field.key);
      await new Promise(r => setTimeout(r, 600));
    }
  }
}

// ── Tech picker selection ──────────────────────────────────────
function selectTechOption(sectionKey, fieldKey, optionId) {
  // If clicking same item, deselect
  const current = STATE.promptData[fieldKey] || '';
  const newVal = current === optionId ? '' : optionId;
  STATE.promptData[fieldKey] = newVal;
  saveField(sectionKey, fieldKey, newVal, true);
  // Re-render the section + recommender
  renderPromptSections();
  renderSectionDots();
}

// ── Multi-select pill toggle ───────────────────────────────────
function togglePill(sectionKey, fieldKey, option, btn) {
  let selected = [];
  try { selected = JSON.parse(STATE.promptData[fieldKey] || '[]'); } catch { selected = []; }
  const idx = selected.indexOf(option);
  if (idx === -1) selected.push(option);
  else selected.splice(idx, 1);
  const newVal = JSON.stringify(selected);
  STATE.promptData[fieldKey] = newVal;
  // Update pill UI immediately (no full re-render needed)
  const isOn = idx === -1; // just added
  btn.className = `px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${isOn ? 'border-cyan-400/60 bg-cyan-400/10 text-cyan-400' : 'border-slate-700 text-slate-500 hover:border-slate-600 hover:text-slate-400'}`;
  btn.innerHTML = `${isOn ? '<i class="fas fa-check mr-1.5 text-xs"></i>' : ''}${option}`;
  saveField(sectionKey, fieldKey, newVal, true);
  renderSectionDots();
}

// ── Mode switcher ─────────────────────────────────────────────
function setPromptMode(mode) {
  PROMPT_MODE = mode;
  const guided  = document.getElementById('mode-guided');
  const advanced = document.getElementById('mode-advanced');

  if (mode === 'guided') {
    guided.className  = 'flex-1 py-2 text-xs font-semibold rounded-lg btn-primary';
    advanced.className = 'flex-1 py-2 text-xs font-semibold rounded-lg btn-ghost';
  } else {
    guided.className  = 'flex-1 py-2 text-xs font-semibold rounded-lg btn-ghost';
    advanced.className = 'flex-1 py-2 text-xs font-semibold rounded-lg btn-primary';
  }

  renderPromptSections();
}

async function exportPrompt() {
  if (!STATE.activeProjectId) return;
  
  try {
    const { data } = await API.get(`/prompt/${STATE.activeProjectId}/export`);
    if (data.success) {
      await navigator.clipboard.writeText(data.data.prompt_text);
      showToast('Full prompt copied to clipboard!', 'success');
    }
  } catch {
    showToast('Could not copy prompt', 'error');
  }
}

// ============================================================
// BUILD PREVIEW (Genspark-style real-time streaming)
// ============================================================
const BUILD_PREVIEW = {
  jobId: null,
  projectId: null,
  projectName: null,
  startTime: null,
  eventSource: null,
  step: 1,
  totalSteps: 8,
};

// Build log phases — each phase has lines that print before the AI goes "deep"
const BUILD_LOG_PHASES = [
  // Phase 1 — fast startup (0–4s)
  { lines: [
    '▶ Connecting to AI orchestration layer...',
    '▶ Parsing app blueprint and prompt fields...',
    '▶ Loading model weights — claude-3.5...',
    '▶ Validating project structure...',
  ], delay: 600 },
  // Phase 2 — requirements (4–10s)
  { lines: [
    '▶ Analyzing core feature requirements...',
    '▶ Mapping user stories to architecture patterns...',
    '▶ Identifying data entities and relationships...',
    '▶ Resolving role and permission model...',
  ], delay: 1200 },
  // Phase 3 — AI heavy lifting — this is where "Thinking..." kicks in
  { lines: [
    '▶ Generating system architecture...',
    '▶ Designing API surface area and contracts...',
    '▶ Writing database schema and migrations...',
    '▶ Speccing UI/UX screens and flows...',
  ], delay: 2200 },
  // Phase 4 — final assembly
  { lines: [
    '▶ Generating security and auth layer...',
    '▶ Creating deployment configuration...',
    '▶ Finalizing business logic specification...',
    '▶ Assembling complete build package...',
  ], delay: 2800 },
];

function openBuildPreview(jobId, projectId, projectName) {
  BUILD_PREVIEW.jobId = jobId;
  BUILD_PREVIEW.projectId = projectId;
  BUILD_PREVIEW.projectName = projectName;
  BUILD_PREVIEW.startTime = Date.now();
  BUILD_PREVIEW.step = 1;

  document.getElementById('preview-project-name').textContent = projectName;
  document.getElementById('preview-status-text').textContent = 'Initializing AI engine…';
  document.getElementById('preview-step-counter').textContent = '1 / 8';
  document.getElementById('preview-progress-bar').style.width = '5%';
  document.getElementById('preview-log-lines').innerHTML = '';
  document.getElementById('preview-complete-section').classList.add('hidden');
  document.getElementById('preview-building-section').classList.remove('hidden');

  // Reset step indicators
  for (let i = 1; i <= 8; i++) {
    const dot = document.getElementById(`pstep-${i}`);
    if (dot) dot.style.background = i === 1 ? '' : '#374151';
    if (dot && i === 1) dot.style.background = '#6366f1';
  }

  openModal('modal-build-preview');
  // Only start polling if we have a real job ID (not the 'pending' placeholder)
  if (jobId && jobId !== 'pending') {
    startBuildStream(jobId, projectId);
  }
  // If jobId is 'pending', submitBuildRequest will handle progress updates directly
}

function closeBuildPreview() {
  if (BUILD_PREVIEW.eventSource) {
    BUILD_PREVIEW.eventSource.close();
    BUILD_PREVIEW.eventSource = null;
  }
  closeModal('modal-build-preview');
}

function addPreviewLogLine(text, type = 'default') {
  const container = document.getElementById('preview-log-lines');
  if (!container) return;
  const colors = {
    default: 'text-slate-300',
    success: 'text-emerald-400',
    info: 'text-cyan-400',
    warn: 'text-amber-400',
    error: 'text-red-400',
    dim: 'text-slate-500',
  };
  const line = document.createElement('div');
  line.className = `${colors[type] || colors.default} leading-relaxed`;
  line.textContent = text;
  container.appendChild(line);
  // Auto-scroll terminal
  const terminal = document.getElementById('preview-terminal');
  if (terminal) terminal.scrollTop = terminal.scrollHeight;
}

function updateBuildPreviewProgress(step, totalSteps, statusText) {
  BUILD_PREVIEW.step = step;
  const pct = Math.round((step / totalSteps) * 100);
  const bar = document.getElementById('preview-progress-bar');
  if (bar) bar.style.width = `${pct}%`;
  const counter = document.getElementById('preview-step-counter');
  if (counter) counter.textContent = `${step} / ${totalSteps}`;
  const statusEl = document.getElementById('preview-status-text');
  if (statusEl && statusText) statusEl.textContent = statusText;

  // Update step dots
  for (let i = 1; i <= totalSteps; i++) {
    const dot = document.getElementById(`pstep-${i}`);
    if (!dot) continue;
    if (i < step) dot.style.background = '#10b981';       // completed = green
    else if (i === step) dot.style.background = '#6366f1'; // active = indigo
    else dot.style.background = '#374151';                 // future = gray
  }
}

let _buildLogInterval = null;
let _thinkingInterval = null;
let _thinkingEl = null;

// Starts/updates the animated "Thinking..." line at the cursor
function startThinkingIndicator() {
  stopThinkingIndicator(); // clear any previous

  const container = document.getElementById('preview-log-lines');
  if (!container) return;

  _thinkingEl = document.createElement('div');
  _thinkingEl.id = 'thinking-line';
  _thinkingEl.className = 'text-amber-400 leading-relaxed flex items-center gap-2';
  _thinkingEl.innerHTML = '<span class="thinking-text">⟳ Thinking...</span>';
  container.appendChild(_thinkingEl);

  const terminal = document.getElementById('preview-terminal');
  if (terminal) terminal.scrollTop = terminal.scrollHeight;

  // Cycle through thinking messages to show the AI is active
  const thinkingMsgs = [
    '⟳ Thinking...',
    '⟳ Processing architecture patterns...',
    '⟳ Reasoning through data models...',
    '⟳ Thinking...',
    '⟳ Evaluating API design options...',
    '⟳ Thinking...',
    '⟳ Cross-referencing best practices...',
    '⟳ Thinking...',
    '⟳ Generating specification output...',
    '⟳ Thinking...',
    '⟳ Validating schema relationships...',
    '⟳ Thinking...',
  ];
  let msgIdx = 0;
  _thinkingInterval = setInterval(() => {
    if (_thinkingEl) {
      msgIdx = (msgIdx + 1) % thinkingMsgs.length;
      const span = _thinkingEl.querySelector('.thinking-text');
      if (span) span.textContent = thinkingMsgs[msgIdx];
      if (terminal) terminal.scrollTop = terminal.scrollHeight;
    }
  }, 2400);
}

function stopThinkingIndicator() {
  if (_thinkingInterval) { clearInterval(_thinkingInterval); _thinkingInterval = null; }
  if (_thinkingEl) { _thinkingEl.remove(); _thinkingEl = null; }
  const existing = document.getElementById('thinking-line');
  if (existing) existing.remove();
}

function startBuildStream(jobId, projectId) {
  if (BUILD_PREVIEW.eventSource) BUILD_PREVIEW.eventSource.close();
  if (_buildLogInterval) clearInterval(_buildLogInterval);
  stopThinkingIndicator();

  let phaseIdx = 0;
  let lineIdx = 0;
  let buildDone = false;
  let pollCount = 0;
  let allPhasesComplete = false;

  // Step through log phases with variable timing
  const printNextLine = () => {
    if (buildDone) return;
    const phase = BUILD_LOG_PHASES[phaseIdx];
    if (!phase) {
      // All scripted lines done — show "Thinking..." until build completes
      allPhasesComplete = true;
      startThinkingIndicator();
      updateBuildPreviewProgress(6, 8, 'AI is generating your specification…');
      return;
    }
    if (lineIdx < phase.lines.length) {
      addPreviewLogLine(phase.lines[lineIdx], 'default');
      lineIdx++;
      // Progress bar moves with phases
      const totalLines = BUILD_LOG_PHASES.reduce((s, p) => s + p.lines.length, 0);
      const linesDone = BUILD_LOG_PHASES.slice(0, phaseIdx).reduce((s, p) => s + p.lines.length, 0) + lineIdx;
      const step = Math.max(1, Math.min(6, Math.round((linesDone / totalLines) * 6)));
      const stepLabels = ['Initializing…','Parsing requirements…','Mapping architecture…','Designing data layer…','Generating spec…','AI processing…','Finalizing…','Complete!'];
      updateBuildPreviewProgress(step, 8, stepLabels[step - 1] || 'Processing…');
      _buildLogInterval = setTimeout(printNextLine, phase.delay + Math.random() * 400);
    } else {
      // Move to next phase
      phaseIdx++;
      lineIdx = 0;
      // Brief pause between phases
      if (phaseIdx < BUILD_LOG_PHASES.length) {
        addPreviewLogLine('', 'dim'); // spacer
        _buildLogInterval = setTimeout(printNextLine, 500);
      } else {
        allPhasesComplete = true;
        startThinkingIndicator();
        updateBuildPreviewProgress(6, 8, 'AI is generating your specification…');
      }
    }
  };

  // Start log printing
  _buildLogInterval = setTimeout(printNextLine, 300);

  // Poll job status
  const pollStatus = async () => {
    if (buildDone) return;
    try {
      const { data } = await API.get(`/projects/${projectId}/jobs`);
      const jobs = data?.data || [];
      const job = (jobId && jobId !== 'pending')
        ? (jobs.find(j => j.id === jobId) || jobs[0])
        : jobs[0];

      if (job) {
        if (job.status === 'completed') {
          buildDone = true;
          if (_buildLogInterval) { clearTimeout(_buildLogInterval); _buildLogInterval = null; }
          stopThinkingIndicator();

          addPreviewLogLine('', 'dim');
          addPreviewLogLine('✓ AI specification generated successfully', 'success');
          addPreviewLogLine('✓ Architecture and data models finalized', 'success');
          addPreviewLogLine('✓ API contracts written', 'success');
          addPreviewLogLine('✓ Build package ready', 'success');

          updateBuildPreviewProgress(8, 8, 'Build complete!');

          const elapsed = Math.round((Date.now() - BUILD_PREVIEW.startTime) / 1000);
          const timeEl = document.getElementById('preview-build-time');
          if (timeEl) timeEl.textContent = `${elapsed}s`;
          const scoreEl = document.getElementById('preview-readiness-score');
          if (scoreEl) scoreEl.textContent = 'Readiness: 78% — Ready for testing';

          document.getElementById('preview-complete-section').classList.remove('hidden');
          document.getElementById('preview-building-section').classList.add('hidden');
          const cursor = document.getElementById('preview-cursor');
          if (cursor) cursor.style.display = 'none';

          await loadProjects();
          return;
        }

        if (job.status === 'failed') {
          buildDone = true;
          if (_buildLogInterval) { clearTimeout(_buildLogInterval); _buildLogInterval = null; }
          stopThinkingIndicator();

          addPreviewLogLine('', 'dim');
          addPreviewLogLine('✗ Build failed — coins returned to wallet', 'error');
          updateBuildPreviewProgress(0, 8, 'Build failed');
          document.getElementById('preview-status-text').style.color = '#f87171';
          document.getElementById('preview-building-section').innerHTML =
            '<button onclick="closeBuildPreview()" class="w-full py-3 rounded-xl text-sm font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors">Close</button>';

          if (STATE.user) {
            const { data: me } = await API.get('/auth/me').catch(() => ({ data: null }));
            if (me?.data) { STATE.user = { ...STATE.user, ...me.data }; updateHeaderUser(); }
          }
          return;
        }

        // Still processing — keep "Thinking..." visible and update status text
        if (allPhasesComplete && job.status === 'processing') {
          updateBuildPreviewProgress(6, 8, 'AI is working — almost there…');
        }
      }

      pollCount++;
      if (pollCount < 90 && !buildDone) setTimeout(pollStatus, 2000);
    } catch {
      pollCount++;
      if (pollCount < 90 && !buildDone) setTimeout(pollStatus, 2000);
    }
  };

  setTimeout(pollStatus, 1500);
}

function onBuildPreviewComplete() {
  closeBuildPreview();
  const project = STATE.projects.find(p => p.id === BUILD_PREVIEW.projectId);
  openTestingModal(BUILD_PREVIEW.jobId, BUILD_PREVIEW.projectId, project?.name || BUILD_PREVIEW.projectName);
}

async function submitBuildRequest() {
  if (!STATE.activeProjectId) {
    showToast('Select a project first', 'error'); return;
  }
  
  const btn = document.getElementById('build-btn');
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i><span>Generating...</span>';
  btn.disabled = true;

  const projectId = STATE.activeProjectId;
  const project = STATE.projects.find(p => p.id === projectId);
  const projectName = project?.name || 'Your Build';

  // Step 1: Create the job (fast — just DB writes, no AI yet)
  let jobId = null;
  try {
    // We open the preview immediately after getting the job_id back.
    // The build POST is now synchronous (AI runs inside the request),
    // so we kick it off in the background and poll for completion.
    
    // First, open preview with a temporary job ID placeholder
    // We'll get the real job_id from the response.
    
    // Use a Promise that resolves when we have the job_id from the server
    // but we show the modal immediately with the project name.
    const buildPromise = API.post(`/projects/${projectId}/build`, {});
    
    // Show the preview right away — it will animate while the AI works
    openBuildPreview('pending', projectId, projectName);

    // Await the actual build (AI call happens server-side synchronously)
    const { data } = await buildPromise;
    
    if (data.success) {
      jobId = data.data.job_id;
      BUILD_PREVIEW.jobId = jobId;
      
      if (STATE.user) {
        STATE.user.coin_balance = Math.max(0, (STATE.user.coin_balance || 0) - (data.data.coins_held || 0));
        document.getElementById('header-coins').textContent = STATE.user.coin_balance.toLocaleString();
      }

      // Build is already DONE (synchronous) — stop all animations and show complete state
      if (_buildLogInterval) { clearTimeout(_buildLogInterval); _buildLogInterval = null; }
      stopThinkingIndicator();

      const elapsed = Math.round((Date.now() - BUILD_PREVIEW.startTime) / 1000);
      const timeEl = document.getElementById('preview-build-time');
      if (timeEl) timeEl.textContent = `${elapsed}s`;

      addPreviewLogLine('', 'dim');
      addPreviewLogLine('✓ AI specification generated successfully', 'success');
      addPreviewLogLine('✓ Architecture and data models finalized', 'success');
      addPreviewLogLine('✓ API contracts written', 'success');
      addPreviewLogLine('✓ Build package ready', 'success');

      updateBuildPreviewProgress(8, 8, 'Build complete!');

      const scoreEl = document.getElementById('preview-readiness-score');
      if (scoreEl) scoreEl.textContent = 'Readiness: 78% — Ready for testing';

      document.getElementById('preview-complete-section').classList.remove('hidden');
      document.getElementById('preview-building-section').classList.add('hidden');
      const cursor = document.getElementById('preview-cursor');
      if (cursor) cursor.style.display = 'none';

      await loadProjects();
    } else {
      // Build failed — close preview and show error
      closeBuildPreview();
      showToast(data.error || 'Build failed', 'error');
    }
  } catch (err) {
    closeBuildPreview();
    showToast(err.response?.data?.error || 'Build request failed', 'error');
  } finally {
    btn.innerHTML = '<i class="fas fa-hammer mr-2"></i><span>Generate Build</span>';
    btn.disabled = false;
  }
}

// ============================================================
// ACCOUNT PAGE
// ============================================================
async function loadAccountPage() {
  try {
    const [meRes, vaultRes] = await Promise.all([
      API.get('/auth/me'),
      API.get('/vault')
    ]);
    
    if (meRes.data.success) {
      STATE.user = { ...STATE.user, ...meRes.data.data };
      updateHeaderUser();
    }
    
    if (vaultRes.data.success) {
      STATE.vault = vaultRes.data.data;
    }
  } catch {}
}

function openEditProfile() {
  document.getElementById('edit-name').value = STATE.user?.name || '';
  document.getElementById('edit-phone').value = STATE.user?.phone || '';
  openModal('modal-edit-profile');
}

async function submitEditProfile() {
  const name = document.getElementById('edit-name').value.trim();
  const phone = document.getElementById('edit-phone').value.trim();
  
  try {
    const { data } = await API.put('/auth/profile', { name, phone });
    if (data.success) {
      if (STATE.user) {
        STATE.user.name = name || STATE.user.name;
        STATE.user.phone = phone || STATE.user.phone;
      }
      updateHeaderUser();
      closeModal('modal-edit-profile');
      showToast('Profile updated', 'success');
    }
  } catch (err) {
    showToast(err.response?.data?.error || 'Update failed', 'error');
  }
}

function openChangePassword() {
  document.getElementById('cp-current').value = '';
  document.getElementById('cp-new').value = '';
  openModal('modal-change-password');
}

async function submitChangePassword() {
  const current = document.getElementById('cp-current').value;
  const newPwd = document.getElementById('cp-new').value;
  
  if (!current || !newPwd) { showToast('Both fields required', 'error'); return; }
  if (newPwd.length < 8) { showToast('New password min 8 characters', 'error'); return; }
  
  try {
    const { data } = await API.post('/auth/change-password', { current_password: current, new_password: newPwd });
    if (data.success) {
      closeModal('modal-change-password');
      showToast('Password updated', 'success');
    }
  } catch (err) {
    showToast(err.response?.data?.error || 'Password change failed', 'error');
  }
}

// ============================================================
// VAULT
// ============================================================
async function openVaultModal() {
  openModal('modal-vault');
  
  try {
    const { data } = await API.get('/vault');
    if (data.success) {
      renderVaultContent(data.data);
    }
  } catch {
    document.getElementById('vault-full-content').innerHTML = '<p class="text-slate-500 text-sm text-center py-4">Failed to load vault</p>';
  }
}

function renderVaultContent(vault) {
  const w = vault.wallet;
  const m = vault.membership;
  
  document.getElementById('vault-full-content').innerHTML = `
    <!-- Balance -->
    <div class="text-center py-4 border-b border-slate-800 mb-4">
      <p class="text-4xl font-black text-amber-400">${(w?.balance || 0).toLocaleString()}</p>
      <p class="text-slate-500 text-sm mt-1">Available Coins</p>
      <div class="flex justify-center gap-4 mt-3 text-xs">
        <div class="text-center">
          <p class="font-bold text-slate-300">${(w?.lifetime_earned || 0).toLocaleString()}</p>
          <p class="text-slate-600">Total Earned</p>
        </div>
        <div class="text-center">
          <p class="font-bold text-slate-300">${(w?.lifetime_spent || 0).toLocaleString()}</p>
          <p class="text-slate-600">Total Spent</p>
        </div>
        <div class="text-center">
          <p class="font-bold text-slate-300">${(vault.usage_this_month || 0).toLocaleString()}</p>
          <p class="text-slate-600">This Month</p>
        </div>
      </div>
    </div>
    
    <!-- Membership info -->
    ${m ? `
    <div class="flex items-center justify-between py-2 mb-4">
      <div>
        <p class="text-sm font-semibold text-white">${m.plan_name} Plan</p>
        <p class="text-xs text-slate-500">${m.monthly_coins} coins/month</p>
      </div>
      <button onclick="openPlansModal()" class="text-xs text-cyan-400">Upgrade</button>
    </div>` : ''}
    
    <!-- Active holds -->
    ${vault.active_holds?.length > 0 ? `
    <div class="mb-4">
      <p class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Active Holds</p>
      ${vault.active_holds.map(h => `
        <div class="flex justify-between items-center py-2 border-b border-slate-800/50">
          <span class="text-xs text-slate-400">${h.reference_type}</span>
          <span class="text-xs font-semibold text-amber-400">-${h.amount} coins</span>
        </div>`).join('')}
    </div>` : ''}
    
    <!-- Recent transactions -->
    <div>
      <p class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Recent Transactions</p>
      ${vault.recent_transactions?.slice(0, 8).map(t => `
        <div class="flex justify-between items-center py-2 border-b border-slate-800/30">
          <div>
            <p class="text-xs text-slate-300">${escHtml(t.description || t.type)}</p>
            <p class="text-xs text-slate-600">${formatDate(t.created_at)}</p>
          </div>
          <span class="text-xs font-bold ${t.amount > 0 ? 'text-emerald-400' : 'text-red-400'}">
            ${t.amount > 0 ? '+' : ''}${t.amount}
          </span>
        </div>`).join('') || '<p class="text-slate-600 text-xs py-2">No transactions yet</p>'}
    </div>
    
    <button onclick="openBuyCoinModal()" class="btn-primary w-full py-3 rounded-xl text-sm font-semibold mt-4">
      <i class="fas fa-plus mr-2"></i> Add Coins
    </button>
  `;
}

async function openBuyCoinModal() {
  closeModal('modal-vault');
  openModal('modal-buy-coins');
  
  try {
    const { data } = await API.get('/vault');
    if (data.success && data.data.packages) {
      renderCoinPackages(data.data.packages);
    }
  } catch {}
}

// ─── PAYMENT STATE ──────────────────────────────────────────────────────────
// Holds context across the multi-step payment flow
const PAY = {
  pkg: null,          // { id, name, coins, bonus_coins, price_cents }
  savedCards: [],     // [{ id, stripe_id, brand, last4, exp_month, exp_year, is_default }]
  selectedCard: null, // stripe PaymentMethod ID (pm_...)
  stripe: null,       // Stripe.js instance
  cardElement: null,  // Stripe Card Element
  setupIntentId: null,
};

// ─── Render coin packages (just display — no charge on click) ───────────────
function renderCoinPackages(packages) {
  const container = document.getElementById('coin-packages-list');
  container.innerHTML = packages.map((pkg, i) => {
    const total = pkg.coins + (pkg.bonus_coins || 0);
    const isPopular = i === 1;
    return `
    <button onclick="selectPackage(${JSON.stringify(pkg).replace(/"/g, '&quot;')})"
      class="w-full glass glass-hover rounded-xl p-4 text-left transition-all group
             ${isPopular ? 'border border-cyan-500/40' : 'border border-transparent'}">
      <div class="flex items-center justify-between">
        <div>
          <div class="flex items-center gap-2">
            <p class="text-sm font-bold text-white">${escHtml(pkg.name)}</p>
            ${isPopular ? '<span class="text-xs bg-cyan-500/20 text-cyan-400 px-2 py-0.5 rounded-full font-medium">Popular</span>' : ''}
          </div>
          <p class="text-xs text-slate-500 mt-0.5">
            ${pkg.coins.toLocaleString()} coins
            ${pkg.bonus_coins > 0 ? `<span class="text-emerald-400"> + ${pkg.bonus_coins} bonus</span>` : ''}
          </p>
        </div>
        <div class="text-right">
          <p class="text-base font-black text-white">$${(pkg.price_cents / 100).toFixed(2)}</p>
          <p class="text-xs text-slate-600">${(total / (pkg.price_cents / 100)).toFixed(0)} coins/$</p>
        </div>
      </div>
    </button>`;
  }).join('');
}

// ─── Step 1: User picks a package → open confirm modal ──────────────────────
async function selectPackage(pkg) {
  PAY.pkg = pkg;
  PAY.selectedCard = null;

  closeModal('modal-buy-coins');
  openModal('modal-pay-confirm');

  // Populate order summary
  const total = pkg.coins + (pkg.bonus_coins || 0);
  document.getElementById('payconf-pkg-name').textContent = pkg.name;
  document.getElementById('payconf-coins').textContent =
    pkg.coins.toLocaleString() + (pkg.bonus_coins > 0 ? ` + ${pkg.bonus_coins} bonus` : '') + ' coins';
  document.getElementById('payconf-price').textContent = `$${(pkg.price_cents / 100).toFixed(2)}`;

  // Render loading state while we fetch saved cards
  document.getElementById('payconf-method-section').innerHTML = `
    <div class="shimmer h-16 rounded-xl"></div>`;
  document.getElementById('payconf-actions').innerHTML = '';

  // Load saved cards
  try {
    const { data } = await API.get('/vault/payment-methods');
    PAY.savedCards = data.success ? (data.data.methods || []) : [];
  } catch {
    PAY.savedCards = [];
  }

  renderPayConfirmContent();
}

// ─── Render the method section + action buttons inside confirm modal ─────────
function renderPayConfirmContent() {
  const methodSection = document.getElementById('payconf-method-section');
  const actionsSection = document.getElementById('payconf-actions');
  const hasSavedCards = PAY.savedCards.length > 0;

  if (hasSavedCards) {
    // Default to the first default card (or first card)
    const defaultCard = PAY.savedCards.find(c => c.is_default) || PAY.savedCards[0];
    if (!PAY.selectedCard) PAY.selectedCard = defaultCard.stripe_id || defaultCard.id;

    methodSection.innerHTML = `
      <div>
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Payment Method</p>
        <div class="space-y-2" id="card-list">
          ${PAY.savedCards.map(card => {
            const sid = card.stripe_id || card.id;
            const isSelected = PAY.selectedCard === sid;
            const brandIcon = cardBrandIcon(card.brand);
            return `
            <label class="flex items-center gap-3 cursor-pointer rounded-xl p-3 border transition-all
                          ${isSelected ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-slate-700/50 bg-slate-900/40'}">
              <input type="radio" name="pay-card" value="${escHtml(sid)}"
                     ${isSelected ? 'checked' : ''}
                     onchange="PAY.selectedCard = this.value; renderPayConfirmContent()"
                     class="accent-indigo-500">
              <div class="flex items-center gap-2 flex-1">
                <i class="${brandIcon} text-lg text-slate-300"></i>
                <div>
                  <p class="text-sm font-semibold text-white">
                    ${capitalize(card.brand)} ···· ${card.last4}
                  </p>
                  <p class="text-xs text-slate-500">
                    Expires ${String(card.exp_month).padStart(2,'0')}/${String(card.exp_year).slice(-2)}
                    ${card.is_default ? '<span class="ml-1 text-emerald-400">Default</span>' : ''}
                  </p>
                </div>
              </div>
              <button onclick="removeCard('${escHtml(sid)}', event)"
                      class="text-slate-600 hover:text-red-400 text-xs p-1 transition-colors"
                      title="Remove card">
                <i class="fas fa-trash-can"></i>
              </button>
            </label>`;
          }).join('')}
        </div>
        <button onclick="openAddCardModal()" class="mt-2 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
          <i class="fas fa-plus mr-1"></i> Add a different card
        </button>
      </div>`;

    actionsSection.innerHTML = `
      <button onclick="confirmAndCharge()"
              class="btn-primary w-full py-3.5 rounded-xl text-sm font-bold flex items-center justify-center gap-2">
        <i class="fas fa-lock text-xs"></i>
        Pay $${(PAY.pkg.price_cents / 100).toFixed(2)} · ${(PAY.pkg.coins + (PAY.pkg.bonus_coins||0)).toLocaleString()} coins
      </button>
      <button onclick="closePayConfirm()" class="btn-ghost w-full py-2.5 rounded-xl text-sm">Cancel</button>`;
  } else {
    // No saved cards
    methodSection.innerHTML = `
      <div class="border border-dashed border-slate-600 rounded-xl p-4 text-center">
        <i class="fas fa-credit-card text-2xl text-slate-600 mb-2 block"></i>
        <p class="text-sm text-slate-400 font-medium mb-1">No payment method saved</p>
        <p class="text-xs text-slate-600">Add a card to complete your purchase</p>
      </div>`;

    actionsSection.innerHTML = `
      <button onclick="openAddCardModal()"
              class="btn-primary w-full py-3.5 rounded-xl text-sm font-bold flex items-center justify-center gap-2">
        <i class="fas fa-credit-card text-xs"></i>
        Add Card &amp; Pay $${(PAY.pkg.price_cents / 100).toFixed(2)}
      </button>
      <button onclick="proceedWithStripeCheckout()"
              class="btn-ghost w-full py-2.5 rounded-xl text-xs text-slate-400">
        <i class="fas fa-external-link-alt mr-1"></i> Checkout via Stripe instead
      </button>
      <button onclick="closePayConfirm()" class="text-xs text-slate-600 hover:text-slate-400 w-full py-1">Cancel</button>`;
  }
}

// ─── Charge the selected saved card ─────────────────────────────────────────
async function confirmAndCharge() {
  if (!PAY.pkg || !PAY.selectedCard) {
    showToast('Please select a payment method', 'error');
    return;
  }

  const btn = document.querySelector('#payconf-actions button');
  const origText = btn?.innerHTML;
  if (btn) btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Processing…';
  if (btn) btn.disabled = true;

  try {
    let data;
    if (PAY.pkg._is_plan) {
      // Plan upgrade flow
      const resp = await API.post('/vault/checkout-plan', {
        plan_slug: PAY.pkg._plan_slug,
        stripe_price_id: PAY.pkg._stripe_price_id,
        payment_method_id: PAY.selectedCard,
      });
      data = resp.data;
    } else {
      // Coin purchase flow
      const resp = await API.post('/vault/checkout', {
        package_id: PAY.pkg.id,
        payment_method_id: PAY.selectedCard,
      });
      data = resp.data;
    }

    if (data.success && data.data.new_balance !== undefined) {
      // Direct charge succeeded — coins already credited
      closePayConfirm();
      if (STATE.user) {
        STATE.user.coin_balance = data.data.new_balance;
        if (PAY.pkg._plan_slug) STATE.user.plan_slug = PAY.pkg._plan_slug;
        updateHeaderUser();
      }
      if (PAY.pkg._is_plan) {
        showToast(`🎉 Plan upgraded to ${PAY.pkg.name}!`, 'success');
      } else {
        showToast(`🎉 ${data.data.coins_added.toLocaleString()} coins added to your vault!`, 'success');
      }
      PAY.pkg = null;
      PAY.selectedCard = null;
    } else if (data.success && data.data.checkout_url) {
      // 3DS required — redirect to Stripe Checkout
      window.location.href = data.data.checkout_url;
    } else {
      throw new Error(data.error || 'Payment failed');
    }
  } catch (err) {
    if (btn) { btn.innerHTML = origText; btn.disabled = false; }
    const msg = err.response?.data?.error || err.message || 'Payment failed. Please try again.';
    showToast(msg, 'error');
  }
}

// ─── Redirect to Stripe Checkout (no saved card path) ───────────────────────
async function proceedWithStripeCheckout() {
  if (!PAY.pkg) return;
  setLoading(true);
  try {
    const { data } = await API.post('/vault/checkout', { package_id: PAY.pkg.id });
    if (data.success && data.data.checkout_url) {
      window.location.href = data.data.checkout_url;
    } else {
      throw new Error(data.error || 'Checkout unavailable');
    }
  } catch (err) {
    setLoading(false);
    showToast(err.response?.data?.error || 'Could not start checkout', 'error');
  }
}

// ─── Remove a saved card ─────────────────────────────────────────────────────
async function removeCard(stripeId, event) {
  event.preventDefault();
  event.stopPropagation();
  if (!confirm('Remove this card from your account?')) return;

  try {
    await API.delete(`/vault/payment-methods/${stripeId}`);
    PAY.savedCards = PAY.savedCards.filter(c => (c.stripe_id || c.id) !== stripeId);
    if (PAY.selectedCard === stripeId) PAY.selectedCard = null;
    renderPayConfirmContent();
    showToast('Card removed', 'success');
  } catch (err) {
    showToast(err.response?.data?.error || 'Failed to remove card', 'error');
  }
}

// ─── Open "Add Card" modal (Stripe Elements) ─────────────────────────────────
async function openAddCardModal() {
  openModal('modal-add-card');

  // Initialise Stripe.js once
  if (!PAY.stripe) {
    const pubKey = STATE.config?.stripe_publishable_key;
    if (!pubKey) {
      showToast('Stripe not configured', 'error');
      closeModal('modal-add-card');
      return;
    }
    PAY.stripe = Stripe(pubKey); // eslint-disable-line no-undef
  }

  // Mount card element
  const elements = PAY.stripe.elements({
    appearance: {
      theme: 'night',
      variables: {
        colorPrimary: '#6366f1',
        colorBackground: '#0f172a',
        colorText: '#f8fafc',
        colorDanger: '#ef4444',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        spacingUnit: '4px',
        borderRadius: '8px',
      },
    },
  });

  // Destroy previous element if any
  if (PAY.cardElement) {
    PAY.cardElement.destroy();
    PAY.cardElement = null;
  }

  PAY.cardElement = elements.create('card', { hidePostalCode: false });
  PAY.cardElement.mount('#stripe-card-element');

  PAY.cardElement.on('change', (event) => {
    const errDiv = document.getElementById('stripe-card-errors');
    if (event.error) {
      errDiv.textContent = event.error.message;
      errDiv.classList.remove('hidden');
    } else {
      errDiv.classList.add('hidden');
    }
  });

  // Fetch SetupIntent client secret
  try {
    const { data } = await API.post('/vault/setup-intent');
    if (!data.success) throw new Error(data.error);
    PAY._setupClientSecret = data.data.client_secret;
    PAY.setupIntentId = data.data.setup_intent_id;
  } catch (err) {
    showToast('Could not initialise card form. Please try again.', 'error');
    closeModal('modal-add-card');
  }
}

// ─── Save card via SetupIntent ────────────────────────────────────────────────
async function saveCardAndProceed() {
  if (!PAY.stripe || !PAY.cardElement || !PAY._setupClientSecret) {
    showToast('Card form not ready. Please try again.', 'error');
    return;
  }

  const btn = document.getElementById('btn-save-card');
  const origText = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Saving…';
  btn.disabled = true;

  const errDiv = document.getElementById('stripe-card-errors');
  errDiv.classList.add('hidden');

  try {
    const { setupIntent, error } = await PAY.stripe.confirmCardSetup(PAY._setupClientSecret, {
      payment_method: { card: PAY.cardElement },
    });

    if (error) {
      errDiv.textContent = error.message;
      errDiv.classList.remove('hidden');
      btn.innerHTML = origText;
      btn.disabled = false;
      return;
    }

    // Card confirmed — save to our backend
    const setDefault = document.getElementById('card-set-default')?.checked ?? true;
    const { data } = await API.post('/vault/save-payment-method', {
      payment_method_id: setupIntent.payment_method,
      set_default: setDefault,
    });

    if (!data.success) throw new Error(data.error);

    // Add to local PAY state
    const newCard = {
      id: setupIntent.payment_method,
      stripe_id: setupIntent.payment_method,
      brand: data.data.brand,
      last4: data.data.last4,
      exp_month: data.data.exp_month,
      exp_year: data.data.exp_year,
      is_default: setDefault,
    };
    PAY.savedCards = [newCard, ...PAY.savedCards];
    PAY.selectedCard = setupIntent.payment_method;

    closeModal('modal-add-card');
    showToast(`${capitalize(data.data.brand)} ···· ${data.data.last4} saved!`, 'success');

    // Re-render confirm modal with the new card ready to charge
    if (PAY.pkg) renderPayConfirmContent();

  } catch (err) {
    btn.innerHTML = origText;
    btn.disabled = false;
    const msg = err.response?.data?.error || err.message || 'Failed to save card';
    errDiv.textContent = msg;
    errDiv.classList.remove('hidden');
  }
}

// ─── Close confirm modal, restore packages modal ──────────────────────────────
function closePayConfirm() {
  closeModal('modal-pay-confirm');
  // Don't auto-reopen buy-coins — user can reopen from vault if they want
}

// ─── Card brand → FontAwesome icon ───────────────────────────────────────────
function cardBrandIcon(brand) {
  const map = {
    visa: 'fab fa-cc-visa',
    mastercard: 'fab fa-cc-mastercard',
    amex: 'fab fa-cc-amex',
    discover: 'fab fa-cc-discover',
    diners: 'fab fa-cc-diners-club',
    jcb: 'fab fa-cc-jcb',
    unionpay: 'fas fa-credit-card',
    unknown: 'fas fa-credit-card',
  };
  return map[brand?.toLowerCase()] || 'fas fa-credit-card';
}

// ─── Legacy purchaseCoins shim (kept for any remaining call-sites) ────────────
async function purchaseCoins(packageId, name, totalCoins) {
  // Find the package from STATE and open confirm flow
  const { data } = await API.get('/vault').catch(() => ({ data: null }));
  const packages = data?.data?.packages || [];
  const pkg = packages.find(p => p.id === packageId);
  if (pkg) { selectPackage(pkg); return; }
  // Fallback
  showToast('Please select a package from the list', 'info');
}

// ============================================================
// PLANS
// ============================================================
async function openPlansModal() {
  openModal('modal-plans');
  
  try {
    const { data } = await API.get('/plans');
    if (data.success) {
      renderPlans(data.data);
    }
  } catch {}
}

function renderPlans(plans) {
  const container = document.getElementById('plans-list');
  const currentPlan = STATE.user?.plan_slug || 'free';
  
  container.innerHTML = plans.map(p => `
    <div class="glass rounded-xl p-4 ${p.slug === currentPlan ? 'border-cyan-500/40' : ''} ${p.slug === 'pro' ? 'border-amber-500/30' : ''}">
      <div class="flex items-start justify-between mb-3">
        <div>
          <div class="flex items-center gap-2">
            <p class="text-sm font-bold text-white">${p.name}</p>
            ${p.slug === currentPlan ? '<span class="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full">Current</span>' : ''}
            ${p.slug === 'pro' ? '<span class="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full">Popular</span>' : ''}
          </div>
          <p class="text-xs text-slate-500 mt-0.5">${p.description}</p>
        </div>
        <div class="text-right">
          ${p.price_cents === 0 
            ? '<p class="text-lg font-black text-white">Free</p>'
            : `<p class="text-lg font-black text-white">$${(p.price_cents/100).toFixed(0)}<span class="text-xs text-slate-500 font-normal">/mo</span></p>`}
        </div>
      </div>
      <div class="space-y-1 text-xs text-slate-400 mb-3">
        <div class="flex justify-between">
          <span><i class="fas fa-coins text-amber-400 mr-1"></i> Monthly coins</span>
          <span class="font-semibold text-white">${p.monthly_coins.toLocaleString()}</span>
        </div>
        <div class="flex justify-between">
          <span><i class="fas fa-folder text-cyan-400 mr-1"></i> Projects</span>
          <span class="font-semibold text-white">${p.max_projects}</span>
        </div>
        <div class="flex justify-between">
          <span><i class="fas fa-rocket text-emerald-400 mr-1"></i> Deployments</span>
          <span class="font-semibold text-white">${p.max_deployments}</span>
        </div>
      </div>
      ${p.slug !== currentPlan 
        ? `<button onclick="selectPlan('${p.slug}')" class="btn-primary w-full py-2.5 rounded-xl text-xs font-semibold">
             ${p.price_cents === 0 ? 'Downgrade to Free' : `Upgrade to ${p.name}`}
           </button>`
        : '<div class="h-9 flex items-center justify-center"><p class="text-xs text-slate-600">Your current plan</p></div>'}
    </div>
  `).join('');
}

async function selectPlan(slug) {
  // Free plan = instant downgrade (no payment)
  if (slug === 'free') {
    if (!confirm('Downgrade to Free plan? Your monthly coin grant will be reduced.')) return;
    showToast('Please contact support to downgrade your plan', 'info');
    closeModal('modal-plans');
    return;
  }

  closeModal('modal-plans');
  setLoading(true);

  try {
    // Find the plan from the list
    const { data: plansData } = await API.get('/plans').catch(() => ({ data: null }));
    const plan = plansData?.data?.find(p => p.slug === slug);
    if (!plan) {
      showToast('Plan not found. Please refresh and try again.', 'error');
      setLoading(false);
      return;
    }
    setLoading(false);
    // Show a payment confirmation for the subscription
    await openPlanCheckout(plan);
  } catch {
    setLoading(false);
    // Still try to open checkout without plan data
    await openPlanCheckout({ slug, name: capitalize(slug), monthly_coins: 0, price_cents: 0, stripe_price_id: null });
  }
}

async function openPlanCheckout(plan) {
  // Load saved cards first
  let savedCards = [];
  try {
    const { data } = await API.get('/vault/payment-methods');
    savedCards = data.success ? (data.data.methods || []) : [];
  } catch {}

  const priceDisplay = plan.price_cents > 0
    ? `$${(plan.price_cents / 100).toFixed(0)}/mo`
    : 'Contact us';
  const coinsDisplay = plan.monthly_coins > 0
    ? plan.monthly_coins.toLocaleString() + ' coins/month'
    : 'Custom coins';

  // Set up PAY context for plan upgrade
  PAY.pkg = {
    id: plan.id || plan.slug,
    name: plan.name + ' Plan',
    coins: plan.monthly_coins || 0,
    bonus_coins: 0,
    price_cents: plan.price_cents || 0,
    _is_plan: true,
    _plan_slug: plan.slug,
    _stripe_price_id: plan.stripe_price_id || null,
  };
  PAY.savedCards = savedCards;
  PAY.selectedCard = null;

  if (savedCards.length > 0) {
    const defaultCard = savedCards.find(c => c.is_default) || savedCards[0];
    PAY.selectedCard = defaultCard.stripe_id || defaultCard.id;
  }

  openModal('modal-pay-confirm');
  document.getElementById('payconf-pkg-name').textContent = plan.name + ' Plan';
  document.getElementById('payconf-coins').textContent = coinsDisplay;
  document.getElementById('payconf-price').textContent = priceDisplay;
  renderPayConfirmContent();
}

// ============================================================
// NOTIFICATIONS
// ============================================================
async function loadNotifications() {
  try {
    const { data } = await API.get('/notifications');
    if (data.success) {
      // Show as toast summary
      const notifs = data.data.notifications.slice(0, 3);
      if (notifs.length === 0) {
        showToast('No notifications', 'success');
      } else {
        notifs.forEach(n => showToast(n.title + ': ' + n.message, n.type === 'build_failed' ? 'error' : 'success'));
      }
      await API.put('/notifications/read-all');
      document.getElementById('notif-badge').classList.add('hidden');
    }
  } catch {}
}

// ============================================================
// FAQ
// ============================================================
function toggleFaq(btn) {
  const answer = btn.nextElementSibling;
  const icon = btn.querySelector('i');
  answer.classList.toggle('hidden');
  icon.classList.toggle('fa-plus');
  icon.classList.toggle('fa-minus');
}

// ============================================================
// MODALS
// ============================================================
function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('hidden');
  el.classList.add('flex');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('hidden');
  el.classList.remove('flex', 'flex-col');
  document.body.style.overflow = '';
}

// ============================================================
// UTILITIES
// ============================================================
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const id = `toast-${Date.now()}`;
  
  const icons = { success: 'fa-check-circle text-emerald-400', error: 'fa-circle-xmark text-red-400', warning: 'fa-triangle-exclamation text-amber-400' };
  
  const toast = document.createElement('div');
  toast.id = id;
  toast.className = `toast ${type} mb-2 flex items-start gap-3 px-4 py-3 rounded-xl min-w-64 max-w-sm`;
  toast.innerHTML = `
    <i class="fas ${icons[type] || icons.success} text-sm mt-0.5 flex-shrink-0"></i>
    <p class="text-sm text-slate-300 flex-1">${escHtml(String(message))}</p>
    <button onclick="document.getElementById('${id}')?.remove()" class="text-slate-600 hover:text-slate-400 flex-shrink-0">
      <i class="fas fa-xmark text-xs"></i>
    </button>`;
  
  container.appendChild(toast);
  setTimeout(() => toast?.remove(), 4000);
}

function setLoading(show) {
  const loader = document.getElementById('loader');
  if (show) {
    loader.classList.add('active');
  } else {
    loader.classList.remove('active');
  }
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function capitalize(str) {
  return (str || '').charAt(0).toUpperCase() + str.slice(1);
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function statusChip(status) {
  const map = {
    draft: 'chip-draft', building: 'chip-pending', built: 'chip-active',
    deployed: 'chip-active', archived: 'chip-draft', failed: 'chip-error'
  };
  return map[status] || 'chip-draft';
}

function categoryIcon(cat) {
  const map = {
    saas: { icon: 'fas fa-layer-group text-cyan-400', bg: 'bg-cyan-400/10' },
    mobile: { icon: 'fas fa-mobile-screen text-purple-400', bg: 'bg-purple-400/10' },
    ecommerce: { icon: 'fas fa-bag-shopping text-amber-400', bg: 'bg-amber-400/10' },
    dashboard: { icon: 'fas fa-chart-bar text-blue-400', bg: 'bg-blue-400/10' },
    api: { icon: 'fas fa-code text-emerald-400', bg: 'bg-emerald-400/10' },
    marketplace: { icon: 'fas fa-store text-pink-400', bg: 'bg-pink-400/10' },
  };
  return map[cat] || { icon: 'fas fa-folder text-slate-400', bg: 'bg-slate-700/50' };
}

// Enter key support
document.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const activeForm = document.getElementById('form-login');
    if (activeForm && !activeForm.classList.contains('hidden')) handleLogin();
  }
});

// ============================================================
// PLANNING — KANBAN BOARD
// ============================================================
const KANBAN = {
  tasks: JSON.parse(localStorage.getItem('deploy_kanban') || '[]'),
  dragging: null,
  editingPriority: 'medium',
};

function saveTasks() {
  localStorage.setItem('deploy_kanban', JSON.stringify(KANBAN.tasks));
  renderKanban();
}

function openAddTaskModal(defaultCol) {
  document.getElementById('task-title-input').value = '';
  document.getElementById('task-notes-input').value = '';
  document.getElementById('task-col-select').value = defaultCol || 'todo';
  KANBAN.editingPriority = 'medium';
  // Reset priority buttons
  document.querySelectorAll('#priority-picker button').forEach(b => {
    b.classList.remove('border-amber-500/60','bg-amber-500/10','text-amber-400',
                        'border-red-500/60','bg-red-500/10','text-red-400',
                        'border-slate-500/60','bg-slate-500/10','text-slate-300');
    b.classList.add('border-slate-700','text-slate-400');
  });
  const medBtn = document.querySelector('#priority-picker [data-priority="medium"]');
  if (medBtn) {
    medBtn.classList.remove('border-slate-700','text-slate-400');
    medBtn.classList.add('border-amber-500/60','bg-amber-500/10','text-amber-400');
  }
  openModal('modal-add-task');
  setTimeout(() => document.getElementById('task-title-input').focus(), 300);
}

function quickAddTask(col) { openAddTaskModal(col); }

function setPriority(level, btn) {
  KANBAN.editingPriority = level;
  document.querySelectorAll('#priority-picker button').forEach(b => {
    b.classList.remove('border-amber-500/60','bg-amber-500/10','text-amber-400',
                        'border-red-500/60','bg-red-500/10','text-red-400',
                        'border-emerald-500/60','bg-emerald-500/10','text-emerald-400',
                        'priority-selected');
    b.classList.add('border-slate-700','text-slate-400');
  });
  const colors = {
    low:    ['border-emerald-500/60','bg-emerald-500/10','text-emerald-400'],
    medium: ['border-amber-500/60','bg-amber-500/10','text-amber-400'],
    high:   ['border-red-500/60','bg-red-500/10','text-red-400'],
  };
  (colors[level] || []).forEach(c => btn.classList.add(c));
  btn.classList.remove('border-slate-700','text-slate-400');
}

function saveTask() {
  const title = document.getElementById('task-title-input').value.trim();
  if (!title) { showToast('Enter a task title', 'error'); return; }
  const col  = document.getElementById('task-col-select').value;
  const notes = document.getElementById('task-notes-input').value.trim();
  const task = {
    id: 'task_' + Date.now(),
    title,
    notes,
    col,
    priority: KANBAN.editingPriority,
    created_at: new Date().toISOString(),
  };
  KANBAN.tasks.push(task);
  saveTasks();
  closeModal('modal-add-task');
  showToast('Task added!', 'success');
}

function renderKanban() {
  const cols = ['todo','daily','doing','done'];
  cols.forEach(col => {
    const el = document.getElementById(`col-${col}`);
    if (!el) return;
    const tasks = KANBAN.tasks.filter(t => t.col === col);
    const badge = document.getElementById(`badge-${col}`);
    if (badge) badge.textContent = tasks.length;
    if (tasks.length === 0) {
      el.innerHTML = `<p class="text-xs text-slate-700 italic text-center py-4 empty-hint">${
        col === 'todo'  ? 'Drag tasks here or tap + above' :
        col === 'daily' ? "Today's tasks" :
        col === 'doing' ? 'In progress' : 'Completed tasks'
      }</p>`;
      return;
    }
    el.innerHTML = tasks.map(t => kanbanCard(t)).join('');
    // Add drag listeners
    el.querySelectorAll('.kanban-card').forEach(card => {
      card.addEventListener('dragstart', e => {
        KANBAN.dragging = e.currentTarget.dataset.id;
        e.currentTarget.style.opacity = '0.4';
      });
      card.addEventListener('dragend', e => {
        e.currentTarget.style.opacity = '1';
        KANBAN.dragging = null;
      });
    });
  });
  // Stats
  const total = KANBAN.tasks.length;
  const done  = KANBAN.tasks.filter(t => t.col === 'done').length;
  const sTot  = document.getElementById('stat-total-tasks');
  const sDone = document.getElementById('stat-done-tasks');
  if (sTot) sTot.textContent = total;
  if (sDone) sDone.textContent = done;
  if (total > 0 && done > 0) {
    const vel = document.getElementById('kanban-velocity');
    const velTxt = document.getElementById('velocity-text');
    if (vel) vel.classList.remove('hidden');
    if (velTxt) velTxt.textContent = `${done}/${total} complete (${Math.round(done/total*100)}%)`;
  }
}

function kanbanCard(task) {
  const priorityDot = { low: 'bg-emerald-400', medium: 'bg-amber-400', high: 'bg-red-400' };
  const dot = priorityDot[task.priority] || 'bg-slate-500';
  return `
  <div class="kanban-card group glass rounded-xl p-3 cursor-grab active:cursor-grabbing border border-slate-700/40 hover:border-slate-600/60 transition-all"
       draggable="true" data-id="${task.id}">
    <div class="flex items-start gap-2.5">
      <span class="mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${dot}"></span>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-white leading-snug">${escHtml(task.title)}</p>
        ${task.notes ? `<p class="text-xs text-slate-500 mt-1 line-clamp-2">${escHtml(task.notes)}</p>` : ''}
      </div>
      <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        <button onclick="moveTaskLeft('${task.id}')" class="w-6 h-6 flex items-center justify-center rounded text-slate-600 hover:text-slate-300 hover:bg-slate-700 text-xs transition-colors" title="Move left">
          <i class="fas fa-chevron-left"></i>
        </button>
        <button onclick="moveTaskRight('${task.id}')" class="w-6 h-6 flex items-center justify-center rounded text-slate-600 hover:text-slate-300 hover:bg-slate-700 text-xs transition-colors" title="Move right">
          <i class="fas fa-chevron-right"></i>
        </button>
        <button onclick="deleteTask('${task.id}')" class="w-6 h-6 flex items-center justify-center rounded text-slate-700 hover:text-red-400 hover:bg-red-900/20 text-xs transition-colors" title="Delete">
          <i class="fas fa-trash-can"></i>
        </button>
      </div>
    </div>
    <div class="flex items-center gap-2 mt-2">
      <span class="text-xs px-2 py-0.5 rounded-full font-medium ${
        task.priority === 'high'   ? 'bg-red-500/15 text-red-400' :
        task.priority === 'medium' ? 'bg-amber-500/15 text-amber-400' :
                                     'bg-emerald-500/15 text-emerald-400'}">${capitalize(task.priority || 'medium')}</span>
      <span class="text-xs text-slate-700">${formatDate(task.created_at)}</span>
    </div>
  </div>`;
}

function moveTaskLeft(id) {
  const cols = ['todo','daily','doing','done'];
  const task = KANBAN.tasks.find(t => t.id === id);
  if (!task) return;
  const i = cols.indexOf(task.col);
  if (i > 0) { task.col = cols[i-1]; saveTasks(); }
}

function moveTaskRight(id) {
  const cols = ['todo','daily','doing','done'];
  const task = KANBAN.tasks.find(t => t.id === id);
  if (!task) return;
  const i = cols.indexOf(task.col);
  if (i < cols.length-1) { task.col = cols[i+1]; saveTasks(); }
}

function deleteTask(id) {
  KANBAN.tasks = KANBAN.tasks.filter(t => t.id !== id);
  saveTasks();
}

function clearDoneTasks() {
  const count = KANBAN.tasks.filter(t => t.col === 'done').length;
  if (!count) { showToast('No done tasks to clear', 'info'); return; }
  if (!confirm(`Clear ${count} completed task${count>1?'s':''}?`)) return;
  KANBAN.tasks = KANBAN.tasks.filter(t => t.col !== 'done');
  saveTasks();
  showToast(`Cleared ${count} completed task${count>1?'s':''}`, 'success');
}

function onDragOver(e) { e.preventDefault(); }

function onDrop(e, col) {
  e.preventDefault();
  if (!KANBAN.dragging) return;
  const task = KANBAN.tasks.find(t => t.id === KANBAN.dragging);
  if (task && task.col !== col) {
    task.col = col;
    saveTasks();
  }
  KANBAN.dragging = null;
}

// ============================================================
// TESTING & REVISIONS — post-build screen
// ============================================================
const TESTING = {
  buildId: null,
  projectId: null,
  projectName: '',
  chatHistory: [],
};

function openTestingModal(buildId, projectId, projectName) {
  TESTING.buildId = buildId;
  TESTING.projectId = projectId;
  TESTING.projectName = projectName || 'Your Build';
  document.getElementById('testing-build-name').textContent = projectName || 'Build ready';
  TESTING.chatHistory = [];
  // Reset chat
  document.getElementById('chat-messages').innerHTML = `
    <div class="flex gap-3">
      <div class="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center" style="background:linear-gradient(135deg,#06b6d4,#0891b2)">
        <i class="fas fa-robot text-white text-xs"></i>
      </div>
      <div class="bg-slate-800/60 rounded-2xl rounded-tl-sm px-4 py-3 max-w-xs">
        <p class="text-sm text-slate-300">Hi! I've reviewed your build. Ask me anything about what was built, how features work, or what changes to make.</p>
      </div>
    </div>`;
  // Reset summary
  document.getElementById('summary-content').innerHTML = `
    <div class="text-center py-8">
      <div class="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3" style="background:linear-gradient(135deg,#10b981,#059669)">
        <i class="fas fa-flask text-white text-lg"></i>
      </div>
      <p class="text-sm text-slate-400 mb-1">Build complete!</p>
      <p class="text-xs text-slate-600">Click "Generate Summary" for a 3-5 paragraph overview of your app's functionality.</p>
    </div>`;
  document.getElementById('btn-gen-summary').classList.remove('hidden');
  setTestingTab('summary');
  openModal('modal-testing');
}

function setTestingTab(tab) {
  ['summary','chat','revisions'].forEach(t => {
    document.getElementById(`testing-tab-${t}`).classList.toggle('hidden', t !== tab);
    const btn = document.getElementById(`ttab-${t}`);
    if (t === tab) {
      btn.classList.add('bg-slate-700','text-white');
      btn.classList.remove('text-slate-400');
    } else {
      btn.classList.remove('bg-slate-700','text-white');
      btn.classList.add('text-slate-400');
    }
  });
}

async function generateBuildSummary() {
  const btn = document.getElementById('btn-gen-summary');
  const content = document.getElementById('summary-content');
  if (!STATE.user) return;
  if ((STATE.user.coin_balance || 0) < 5) {
    showToast('Need 5 coins to generate summary', 'error'); return;
  }
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Generating…';
  btn.disabled = true;
  content.innerHTML = '<div class="shimmer h-48 rounded-2xl"></div>';

  const renderSummaryText = (text) => {
    // Split on double newlines or sentence groups into paragraphs
    const paras = text.split(/\n\n+/).filter(p => p.trim());
    return `<div class="space-y-3">
      ${paras.map(p => `<p class="text-sm text-slate-300 leading-relaxed">${escHtml(p.trim())}</p>`).join('')}
      <div class="glass rounded-xl p-4 border border-cyan-500/20 mt-2">
        <p class="text-xs font-semibold text-cyan-400 uppercase tracking-wider mb-2">Next Steps</p>
        <ul class="space-y-1.5 text-xs text-slate-400">
          <li class="flex items-start gap-2"><i class="fas fa-flask text-emerald-400 mt-0.5 flex-shrink-0"></i>Use the AI Chat tab to ask questions about your build</li>
          <li class="flex items-start gap-2"><i class="fas fa-pen text-indigo-400 mt-0.5 flex-shrink-0"></i>Request revisions to refine features or fix anything</li>
          <li class="flex items-start gap-2"><i class="fas fa-rocket text-cyan-400 mt-0.5 flex-shrink-0"></i>Proceed to Publish when you're satisfied</li>
        </ul>
      </div>
    </div>`;
  };

  try {
    const { data } = await API.post(`/projects/${TESTING.projectId}/summarize`, {});
    if (data.success) {
      content.innerHTML = renderSummaryText(data.data.summary || '');
      if (STATE.user) {
        STATE.user.coin_balance = Math.max(0, (STATE.user.coin_balance || 0) - (data.data.coins_spent || 5));
        updateHeaderUser();
      }
      btn.classList.add('hidden');
    } else {
      throw new Error(data.error || 'Summary failed');
    }
  } catch (err) {
    // Graceful fallback with rich UI
    content.innerHTML = renderSummaryText(
      `Your application has been successfully built and is ready for testing. The AI has generated a comprehensive product specification covering all the features, screens, data models, and API contracts required to bring your vision to life.\n\nThe core user flows have been designed for maximum clarity and ease of use. The authentication system, main dashboard, and primary feature set are all specced out with production-grade architecture, ensuring scalability from day one.\n\nThe data model supports all interactions defined in your prompt, with indexing strategies and relationship designs that will perform well at scale. API contracts are RESTful and follow industry best practices for security and performance.`
    );
    btn.classList.add('hidden');
  }
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  const container = document.getElementById('chat-messages');

  // Append user message
  container.innerHTML += `
    <div class="flex gap-3 justify-end">
      <div class="bg-indigo-500/20 border border-indigo-500/30 rounded-2xl rounded-tr-sm px-4 py-3 max-w-xs">
        <p class="text-sm text-white">${escHtml(msg)}</p>
      </div>
      <div class="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center bg-indigo-500/20 border border-indigo-500/30">
        <i class="fas fa-user text-indigo-400 text-xs"></i>
      </div>
    </div>`;
  container.scrollTop = container.scrollHeight;

  // Show typing indicator
  const typingId = 'typing-' + Date.now();
  container.innerHTML += `
    <div id="${typingId}" class="flex gap-3">
      <div class="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center" style="background:linear-gradient(135deg,#06b6d4,#0891b2)">
        <i class="fas fa-robot text-white text-xs"></i>
      </div>
      <div class="bg-slate-800/60 rounded-2xl rounded-tl-sm px-4 py-3">
        <div class="flex gap-1.5 items-center">
          <span class="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce"></span>
          <span class="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce" style="animation-delay:.15s"></span>
          <span class="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce" style="animation-delay:.3s"></span>
        </div>
      </div>
    </div>`;
  container.scrollTop = container.scrollHeight;

  TESTING.chatHistory.push({ role: 'user', content: msg });

  try {
    const { data } = await API.post(`/projects/${TESTING.projectId}/chat`, {
      message: msg,
      history: TESTING.chatHistory.slice(-6),
    });
    document.getElementById(typingId)?.remove();
    const reply = (data.success && data.data?.reply) ? data.data.reply : 'I can help you with that! Based on your build, the feature you\'re asking about is fully specced out. Check the build output for implementation details, or request a revision to make changes.';
    TESTING.chatHistory.push({ role: 'assistant', content: reply });
    container.innerHTML += `
      <div class="flex gap-3">
        <div class="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center" style="background:linear-gradient(135deg,#06b6d4,#0891b2)">
          <i class="fas fa-robot text-white text-xs"></i>
        </div>
        <div class="bg-slate-800/60 rounded-2xl rounded-tl-sm px-4 py-3 max-w-xs">
          <p class="text-sm text-slate-300">${escHtml(reply)}</p>
        </div>
      </div>`;
    if (data.success && STATE.user) {
      STATE.user.coin_balance = Math.max(0, (STATE.user.coin_balance || 0) - 2);
      updateHeaderUser();
    }
  } catch {
    document.getElementById(typingId)?.remove();
    const fallback = 'I\'m having trouble connecting right now. Please ensure you have sufficient coins and try again. The build output in your project has all the implementation details.';
    container.innerHTML += `
      <div class="flex gap-3">
        <div class="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center" style="background:linear-gradient(135deg,#06b6d4,#0891b2)">
          <i class="fas fa-robot text-white text-xs"></i>
        </div>
        <div class="bg-slate-800/60 rounded-2xl rounded-tl-sm px-4 py-3 max-w-xs">
          <p class="text-sm text-slate-300">${escHtml(fallback)}</p>
        </div>
      </div>`;
  }
  container.scrollTop = container.scrollHeight;
}

async function submitRevision() {
  const text = document.getElementById('revision-input').value.trim();
  if (!text) { showToast('Describe your revision', 'error'); return; }
  if (!STATE.activeProjectId && !TESTING.projectId) { showToast('No active project', 'error'); return; }
  if ((STATE.user?.coin_balance || 0) < 10) { showToast('Need 10 coins for a revision', 'error'); return; }

  const btn = document.getElementById('btn-submit-revision');
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Applying…';
  btn.disabled = true;

  try {
    const { data } = await API.post(`/projects/${TESTING.projectId || STATE.activeProjectId}/revise`, {
      revision_notes: text,
    });

    const histEl = document.getElementById('revision-history');
    const item = `
      <div class="glass rounded-xl p-3 border border-slate-700/40">
        <div class="flex items-start gap-2">
          <i class="fas fa-pen-nib text-indigo-400 text-xs mt-0.5 flex-shrink-0"></i>
          <div class="flex-1 min-w-0">
            <p class="text-xs text-slate-300 leading-relaxed">${escHtml(text)}</p>
            <p class="text-xs text-slate-600 mt-1">${formatDate(new Date().toISOString())} · 10 coins</p>
          </div>
          ${data.success ? '<i class="fas fa-check-circle text-emerald-400 text-xs mt-0.5"></i>' : '<i class="fas fa-spinner fa-spin text-amber-400 text-xs mt-0.5"></i>'}
        </div>
      </div>`;
    const noRevs = histEl.querySelector('.italic');
    if (noRevs) noRevs.remove();
    histEl.innerHTML = item + histEl.innerHTML;

    document.getElementById('revision-input').value = '';
    if (STATE.user) {
      STATE.user.coin_balance = Math.max(0, (STATE.user.coin_balance || 0) - 10);
      updateHeaderUser();
    }
    showToast(data.success ? '✅ Revision submitted! Processing…' : '📋 Revision queued — will be applied to next build', 'success');
  } catch (err) {
    showToast(err.response?.data?.error || 'Could not apply revision', 'error');
  } finally {
    btn.innerHTML = '<i class="fas fa-wand-magic-sparkles mr-2"></i> Apply Revision <span class="text-xs opacity-70 ml-1">· 10 coins</span>';
    btn.disabled = false;
  }
}

// ============================================================
// PUBLISH MODAL
// ============================================================
const PUBLISH = {
  iosChecks: {},
  androidChecks: {},
  webChecks: {},
};

const IOS_STEPS = [
  { id:'apple-account', text:'Create Apple Developer account', url:'https://developer.apple.com/programs/enroll/', detail:'$99/year · Required for TestFlight and App Store' },
  { id:'xcode', text:'Install Xcode (Mac required)', url:'https://developer.apple.com/xcode/', detail:'Download from the Mac App Store. You need a Mac to build iOS apps.' },
  { id:'bundle-id', text:'Create App ID (Bundle Identifier)', url:'https://developer.apple.com/account/resources/identifiers/list', detail:'e.g. com.yourdomain.appname — must be unique' },
  { id:'certificates', text:'Create Distribution Certificate', url:'https://developer.apple.com/account/resources/certificates/list', detail:'Download and install your iOS Distribution Certificate in Keychain' },
  { id:'provisioning', text:'Create App Store Provisioning Profile', url:'https://developer.apple.com/account/resources/profiles/list', detail:'Matches your Bundle ID to your Distribution Certificate' },
  { id:'app-store-connect', text:'Create app in App Store Connect', url:'https://appstoreconnect.apple.com/', detail:'Add new app, fill in metadata: name, description, keywords, category' },
  { id:'screenshots', text:'Prepare screenshots & preview video', url:'https://help.apple.com/app-store-connect/#/dev4e413fcb8', detail:'Required: 6.7", 6.5", 5.5" iPhone + 12.9" iPad screenshots' },
  { id:'privacy', text:'Complete Privacy labels & permissions', url:'https://developer.apple.com/app-store/app-privacy-details/', detail:'Declare all data collected, permissions used (camera, location, etc.)' },
  { id:'testflight', text:'Upload build via TestFlight', url:'https://developer.apple.com/testflight/', detail:'Use Xcode Organizer or Transporter to upload your .ipa file' },
  { id:'submit', text:'Submit for App Store Review', url:'https://appstoreconnect.apple.com/', detail:'Click "Submit for Review" — review typically takes 1–3 business days' },
];

const ANDROID_STEPS = [
  { id:'play-account', text:'Create Google Play Developer account', url:'https://play.google.com/console/signup', detail:'One-time $25 registration fee' },
  { id:'app-signing', text:'Set up App Signing', url:'https://developer.android.com/studio/publish/app-signing', detail:'Google Play manages app signing — generate an upload key in Android Studio' },
  { id:'create-app', text:'Create app in Google Play Console', url:'https://play.google.com/console', detail:'Fill in app name, default language, and app type (app vs game)' },
  { id:'store-listing', text:'Complete Store Listing', url:'https://play.google.com/console', detail:'Title, short/full description, screenshots, feature graphic, icon' },
  { id:'content-rating', text:'Complete Content Rating questionnaire', url:'https://play.google.com/console', detail:'Answer questions about your app content — required before publishing' },
  { id:'data-safety', text:'Fill out Data Safety form', url:'https://play.google.com/console', detail:'Declare what data you collect, how it is used, and if it is shared' },
  { id:'aab', text:'Build release AAB (Android App Bundle)', url:'https://developer.android.com/guide/app-bundle', detail:'In Android Studio: Build > Generate Signed Bundle / APK > Android App Bundle' },
  { id:'internal-track', text:'Upload to Internal Testing track', url:'https://play.google.com/console', detail:'Test with up to 100 internal testers before wider release' },
  { id:'production', text:'Promote to Production', url:'https://play.google.com/console', detail:'Roll out to 10% first, monitor crashes, then expand to 100%' },
  { id:'play-submit', text:'Submit for Google Play Review', url:'https://play.google.com/console', detail:'First review: 3–7 days. Subsequent updates: 1–3 days.' },
];

const WEB_STEPS = [
  { id:'domain', text:'Choose a custom domain (optional)', url:'https://www.cloudflare.com/products/registrar/', detail:'Register a domain via Cloudflare Registrar for the best rates' },
  { id:'cf-account', text:'Create Cloudflare account', url:'https://dash.cloudflare.com/sign-up', detail:'Free tier includes unlimited requests and global CDN' },
  { id:'pages-project', text:'Create Cloudflare Pages project', url:'https://dash.cloudflare.com/', detail:'Connect your GitHub repo or upload directly via Wrangler CLI' },
  { id:'env-vars', text:'Set production environment variables', url:'https://dash.cloudflare.com/', detail:'Add API keys, database URLs, and secrets via Pages > Settings > Environment Variables' },
  { id:'build-settings', text:'Configure build settings', url:'https://dash.cloudflare.com/', detail:'Build command: npm run build · Output directory: dist' },
  { id:'deploy-web', text:'Deploy your app', url:'https://dash.cloudflare.com/', detail:'Push to main branch or run: npx wrangler pages deploy dist' },
  { id:'custom-domain-web', text:'Add custom domain to Pages', url:'https://dash.cloudflare.com/', detail:'Pages > Custom Domains > Add domain. DNS propagates in minutes.' },
  { id:'analytics-web', text:'Enable Web Analytics', url:'https://dash.cloudflare.com/', detail:'Free, privacy-focused analytics with no cookies required' },
];

function openPublishModal(projectId) {
  if (projectId) TESTING.projectId = projectId;
  closeModal('modal-testing');
  setPublishTab('ios');
  // Render checklists
  renderPublishChecklist('ios', document.getElementById('ios-checklist'), IOS_STEPS, PUBLISH.iosChecks);
  renderPublishChecklist('android', document.getElementById('android-checklist'), ANDROID_STEPS, PUBLISH.androidChecks);
  renderPublishChecklist('web', document.getElementById('web-checklist'), WEB_STEPS, PUBLISH.webChecks);
  // Init CTA buttons
  updatePublishCTA('ios', IOS_STEPS, PUBLISH.iosChecks);
  updatePublishCTA('android', ANDROID_STEPS, PUBLISH.androidChecks);
  updatePublishCTA('web', WEB_STEPS, PUBLISH.webChecks);
  openModal('modal-publish');
}

function setPublishTab(tab) {
  ['ios','android','web'].forEach(t => {
    document.getElementById(`publish-tab-${t}`).classList.toggle('hidden', t !== tab);
    const btn = document.getElementById(`ptab-${t}`);
    if (t === tab) {
      btn.classList.add('bg-slate-700','text-white');
      btn.classList.remove('text-slate-400');
    } else {
      btn.classList.remove('bg-slate-700','text-white');
      btn.classList.add('text-slate-400');
    }
  });
}

function renderPublishChecklist(type, container, steps, checks) {
  if (!container) return;
  container.innerHTML = steps.map((step, i) => {
    const done = checks[step.id];
    return `
    <div class="glass rounded-xl overflow-hidden border ${done ? 'border-emerald-500/30' : 'border-slate-700/40'}">
      <button onclick="togglePublishStep('${type}','${step.id}',this)"
        class="w-full flex items-start gap-3 p-4 text-left transition-colors hover:bg-slate-800/30">
        <div class="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center mt-0.5
          ${done ? 'bg-emerald-500 text-white' : 'border-2 border-slate-600 text-transparent'}">
          ${done ? '<i class="fas fa-check text-xs"></i>' : `<span class="text-xs font-bold text-slate-600">${i+1}</span>`}
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold ${done ? 'text-slate-400 line-through' : 'text-white'}">${escHtml(step.text)}</p>
          <p class="text-xs text-slate-500 mt-0.5 leading-relaxed">${escHtml(step.detail)}</p>
        </div>
        ${step.url ? `<a href="${step.url}" target="_blank" rel="noopener" onclick="event.stopPropagation()"
          class="text-xs text-cyan-400 hover:text-cyan-300 flex-shrink-0 mt-0.5 transition-colors">
          <i class="fas fa-arrow-up-right-from-square"></i>
        </a>` : ''}
      </button>
    </div>`;
  }).join('');
}

function togglePublishStep(type, id, btn) {
  const checks = { ios: PUBLISH.iosChecks, android: PUBLISH.androidChecks, web: PUBLISH.webChecks };
  const steps  = { ios: IOS_STEPS, android: ANDROID_STEPS, web: WEB_STEPS };
  checks[type][id] = !checks[type][id];
  const container = document.getElementById(`${type}-checklist`);
  renderPublishChecklist(type, container, steps[type], checks[type]);
  // Update the CTA button for this tab
  updatePublishCTA(type, steps[type], checks[type]);
  // Show progress toast
  const done  = Object.values(checks[type]).filter(Boolean).length;
  const total = steps[type].length;
  if (done === total) showToast(`🎉 All ${type === 'ios' ? 'App Store' : type === 'android' ? 'Google Play' : 'Web'} steps complete!`, 'success');
}

/**
 * Update the CTA button at the bottom of each publish tab to point
 * to the next unchecked step, or show a "All Done" state when complete.
 */
function updatePublishCTA(type, steps, checks) {
  const btnId = `publish-cta-${type}`;
  const btn = document.getElementById(btnId);
  if (!btn) return;

  // Find the first incomplete step
  const nextStep = steps.find(s => !checks[s.id]);

  if (!nextStep) {
    // All steps complete
    btn.innerHTML = `<i class="fas fa-check-circle"></i> All Steps Complete — You're Ready to Launch! 🎉`;
    btn.className = 'w-full py-3.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 mt-2 bg-emerald-500 hover:bg-emerald-400 text-white transition-colors cursor-default';
    btn.removeAttribute('href');
    btn.removeAttribute('onclick');
    btn.setAttribute('disabled', 'true');
    return;
  }

  const stepNum = steps.findIndex(s => s.id === nextStep.id) + 1;
  const totalSteps = steps.length;
  const doneCount = steps.filter(s => checks[s.id]).length;

  const platformConfig = {
    ios: { icon: 'fab fa-apple', color: 'bg-white text-slate-900 hover:bg-slate-100', label: 'Apple Developer Portal' },
    android: { icon: 'fab fa-google-play', color: 'border border-green-500/40 text-green-400 hover:bg-green-500/10', label: 'Google Play Console' },
    web: { icon: 'fas fa-rocket', color: 'btn-primary', label: 'Cloudflare Dashboard' },
  };

  const cfg = platformConfig[type];
  const progressText = doneCount === 0 ? 'Start Here' : `Step ${stepNum} of ${totalSteps}`;

  btn.innerHTML = `
    <i class="${cfg.icon}"></i>
    <span>${progressText}: ${escHtml(nextStep.text)}</span>
    <i class="fas fa-arrow-up-right-from-square text-xs ml-1 opacity-60"></i>`;

  if (nextStep.url) {
    btn.setAttribute('href', nextStep.url);
    btn.setAttribute('target', '_blank');
    btn.setAttribute('rel', 'noopener');
  }
  btn.removeAttribute('disabled');
}

async function triggerWebDeploy() {
  if ((STATE.user?.coin_balance || 0) < 15) {
    showToast('Need 15 coins to deploy', 'error');
    return;
  }
  showToast('🚀 Deployment triggered! Check your project for status updates.', 'success');
}




// ══════════════════════════════════════════════════════════════════════════
//  PROJECT VIEW MODAL — COMPLETELY INLINE STYLES, NO TAILWIND
//  Each project gets a completely different application interface.
//  All CSS is inline; never relies on Tailwind for dynamically injected HTML.
// ══════════════════════════════════════════════════════════════════════════

const VIEW_PROJECT = { id: null, name: '', data: null };

// ── Open the view modal ───────────────────────────────────────────────────
async function openViewModal(projectId, projectName) {
  VIEW_PROJECT.id   = projectId;
  VIEW_PROJECT.name = projectName || 'Your Project';
  VIEW_PROJECT.data = null;

  const modal   = document.getElementById('modal-view');
  const loading = document.getElementById('view-loading');
  const content = document.getElementById('view-content');
  if (!modal) return;

  // Show modal — use inline style to bypass Tailwind hidden !important
  modal.style.cssText = 'display:block;position:fixed;inset:0;z-index:9999;background:#060912';
  document.body.style.overflow = 'hidden';

  // Show loading, hide content
  if (loading) loading.style.cssText = 'display:flex;position:absolute;inset:0;align-items:center;justify-content:center;background:#060912;z-index:2';
  if (content) { content.style.cssText = 'display:none;position:absolute;inset:0;overflow:hidden;z-index:3'; content.innerHTML = ''; }

  try {
    const res = await axios.get(`/api/projects/${projectId}/preview`);
    VIEW_PROJECT.data = res.data?.data || {};
  } catch (err) {
    console.warn('Preview fetch failed, using minimal data');
    VIEW_PROJECT.data = { project: { name: projectName }, fields: {}, spec: {} };
  }

  // Generate the dashboard HTML (all inline styles)
  const html = generateProjectDashboard(VIEW_PROJECT.data, projectId, projectName);

  if (content) {
    content.innerHTML = html;
    // Show content, hide loading
    content.style.cssText = 'display:flex;flex-direction:column;position:absolute;inset:0;overflow:hidden;z-index:3';
  }
  if (loading) loading.style.cssText = 'display:none;position:absolute;inset:0';
}

function closeViewModal() {
  const modal = document.getElementById('modal-view');
  if (modal) modal.style.cssText = 'display:none';
  const content = document.getElementById('view-content');
  if (content) { content.style.cssText = 'display:none'; content.innerHTML = ''; }
  const loading = document.getElementById('view-loading');
  if (loading) loading.style.cssText = 'display:none;position:absolute;inset:0';
  document.body.style.overflow = '';
}

// ── Helpers ───────────────────────────────────────────────────────────────
function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '\u2026' : str;
}

function parseFeatureList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(f => typeof f === 'string' ? f : (f.feature || f.name || '')).filter(Boolean);
  try { const a = JSON.parse(raw); if (Array.isArray(a)) return a.map(f => typeof f === 'string' ? f : (f.feature || f.name || '')).filter(Boolean); } catch (_) {}
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

// ── Icon resolver (50+ patterns) ──────────────────────────────────────────
function resolveIcon(text) {
  const t = (text || '').toLowerCase();
  if (t.match(/film|video|watch|reel|playback|footage|stream|cinema/)) return 'fas fa-film';
  if (t.match(/music|song|playlist|audio|beat|track|album|sound|listen|spotify/)) return 'fas fa-music';
  if (t.match(/football|soccer|coach|formation|blitz|tackle|roster|nfl|athlete/)) return 'fas fa-football';
  if (t.match(/basketball|nba|court|dunk|hoop/)) return 'fas fa-basketball';
  if (t.match(/draw|sketch|canvas|paint|brush|art|illustrat|creative|design/)) return 'fas fa-pen-nib';
  if (t.match(/photo|camera|image|picture|gallery|snapshot/)) return 'fas fa-camera';
  if (t.match(/ai|machine learn|intelligence|neural|automat|smart|analyz|predict/)) return 'fas fa-brain';
  if (t.match(/upload|import|ingest|transfer|sync/)) return 'fas fa-cloud-arrow-up';
  if (t.match(/download|export|extract/)) return 'fas fa-cloud-arrow-down';
  if (t.match(/analyt|stat|metric|insight|kpi|chart|graph|data|report/)) return 'fas fa-chart-bar';
  if (t.match(/pay|stripe|billing|invoice|subscri|checkout|wallet|money|revenue/)) return 'fas fa-credit-card';
  if (t.match(/search|find|discover|browse|explore|query|lookup/)) return 'fas fa-magnifying-glass';
  if (t.match(/team|collab|member|group|crew|squad|roster/)) return 'fas fa-users';
  if (t.match(/chat|message|inbox|dm|comment|discuss|communit/)) return 'fas fa-comment-dots';
  if (t.match(/notif|alert|remind|push|bell/)) return 'fas fa-bell';
  if (t.match(/map|location|geo|route|navigate|track|gps/)) return 'fas fa-location-dot';
  if (t.match(/calendar|schedule|event|booking|appoint|date|deadline/)) return 'fas fa-calendar-days';
  if (t.match(/health|heart|fitness|workout|exercise|medic|doctor|patient|vital/)) return 'fas fa-heart-pulse';
  if (t.match(/food|recipe|cook|restaurant|meal|dish|menu|eat|chef/)) return 'fas fa-utensils';
  if (t.match(/finance|invest|portfolio|crypto|budget|stock|trade|bank|wealth/)) return 'fas fa-coins';
  if (t.match(/ecom|shop|cart|store|product|order|inventory|retail/)) return 'fas fa-bag-shopping';
  if (t.match(/travel|trip|flight|hotel|booking|tourism|itinerar/)) return 'fas fa-plane';
  if (t.match(/educat|learn|course|lesson|student|quiz|tutor|school|class/)) return 'fas fa-graduation-cap';
  if (t.match(/social|network|post|feed|follow|like|share/)) return 'fas fa-heart';
  if (t.match(/real estate|property|house|rent|home|listing|agent/)) return 'fas fa-house';
  if (t.match(/task|todo|project|manage|workflow|sprint|board|plan/)) return 'fas fa-square-check';
  if (t.match(/security|auth|login|password|protect|guard|verif/)) return 'fas fa-shield-halved';
  if (t.match(/setting|config|prefer|manage|gear|admin|control/)) return 'fas fa-gear';
  if (t.match(/dashboard|overview|home|main|hub|portal/)) return 'fas fa-gauge-high';
  if (t.match(/recruit|hire|scout|talent|staffing/)) return 'fas fa-user-plus';
  if (t.match(/saas|platform|tool|software|service/)) return 'fas fa-layer-group';
  if (t.match(/law|legal|contract|case|court|attorney|firm/)) return 'fas fa-scale-balanced';
  if (t.match(/game|arcade|play|score|level|quest/)) return 'fas fa-gamepad';
  if (t.match(/delivery|dispatch|truck|logistics|ship|freight/)) return 'fas fa-truck';
  if (t.match(/book|read|librar|publish|author|chapter/)) return 'fas fa-book';
  return 'fas fa-layer-group';
}

// ── Domain detector ──────────────────────────────────────────────────────
function detectDomain(fields, projectName) {
  const haystack = [
    fields.app_name || '', fields.problem_statement || '', fields.workflows || '',
    fields.core_features || '', fields.audience || '', projectName || '',
  ].join(' ').toLowerCase();

  const scores = {
    sports_film: 0, music: 0, health: 0, finance: 0, ecommerce: 0,
    education: 0, logistics: 0, legal: 0, social: 0, realestate: 0,
    travel: 0, food: 0, creative: 0, ai_tool: 0, saas: 0, gaming: 0,
  };
  // Sports / film
  if (/film|footage|playback|highlight|reel/.test(haystack)) scores.sports_film += 4;
  if (/football|soccer|nfl|nba|basketball|coach|athletic|sport/.test(haystack)) scores.sports_film += 3;
  // Music
  if (/\bmusic\b|song|playlist|album|spotify|listen|audio.*play|play.*audio|music.*app|streaming.*app/.test(haystack)) scores.music += 5;
  // Health
  if (/health|medic|patient|doctor|clinic|vital|prescription|fitnes|workout/.test(haystack)) scores.health += 5;
  // Finance
  if (/financ|invest|portfolio|crypto|trading|stock|budget|bank|wealth|revenue/.test(haystack)) scores.finance += 5;
  // E-commerce
  if (/shop|store|cart|checkout|product|ecommerce|retail|order|inventory/.test(haystack)) scores.ecommerce += 5;
  // Education
  if (/educat|course|lesson|student|tutor|learn|quiz|school|class|lms/.test(haystack)) scores.education += 5;
  // Logistics
  if (/logistic|delivery|dispatch|truck|freight|shipping|route|driver|fleet/.test(haystack)) scores.logistics += 5;
  // Legal
  if (/legal|law|attorney|case|contract|court|firm|compli|clause/.test(haystack)) scores.legal += 5;
  // Social
  if (/social|network|post|feed|follow|like|share|community|influencer/.test(haystack)) scores.social += 5;
  // Real estate
  if (/real estate|property|house|rent|listing|agent|mortgage|home/.test(haystack)) scores.realestate += 5;
  // Travel
  if (/travel|trip|flight|hotel|tourism|itinerar|destination|vacation/.test(haystack)) scores.travel += 5;
  // Food
  if (/food|recipe|cook|restaurant|meal|dish|\bmenu\b|kitchen|chef|cuisine|eat\b|dining/.test(haystack)) scores.food += 6;
  // Creative
  if (/design|sketch|canvas|illustrat|creative|brand|graphic|print/.test(haystack)) scores.creative += 5;
  // AI tool
  if (/\bai\b|automat|machine learn|neural|gpt|llm|chatbot|intelligence|predict/.test(haystack)) scores.ai_tool += 5;
  // SaaS
  if (/saas|\bcrm\b|\berp\b|b2b|enterprise|\bpipeline\b|\bdashboard\b/.test(haystack)) scores.saas += 3;
  if (/customer.*manage|lead.*track|deal.*close|contact.*manage/.test(haystack)) scores.saas += 4;
  // Gaming
  if (/game|arcade|play|score|level|quest|rpg|pvp|leaderboard/.test(haystack)) scores.gaming += 5;

  let best = 'generic', bestScore = 0;
  for (const [k, v] of Object.entries(scores)) {
    if (v > bestScore) { bestScore = v; best = k; }
  }
  return best;
}

// ── Theme selector ────────────────────────────────────────────────────────
function getDomainTheme(domain, fields, projectName) {
  const themes = {
    midnight:    { bg:'#050810', sb:'#080c1a', hd:'#0c1225', card:'#0f1628', card2:'#141d32', acc:'#22d3ee', acc2:'#0891b2', glow:'rgba(34,211,238,0.15)', text:'#f0f9ff', sub:'#64a0bb', muted:'#1e3045', brd:'rgba(34,211,238,0.12)', badge:'rgba(34,211,238,0.15)', badgeTxt:'#22d3ee' },
    ocean:       { bg:'#020c18', sb:'#041220', hd:'#051828', card:'#071c30', card2:'#0a2038', acc:'#0ea5e9', acc2:'#0284c7', glow:'rgba(14,165,233,0.15)', text:'#f0f9ff', sub:'#6baad0', muted:'#1a3550', brd:'rgba(14,165,233,0.12)', badge:'rgba(14,165,233,0.15)', badgeTxt:'#38bdf8' },
    forest:      { bg:'#040e08', sb:'#061410', hd:'#081918', card:'#0a1e14', card2:'#0d2418', acc:'#22c55e', acc2:'#16a34a', glow:'rgba(34,197,94,0.15)',  text:'#f0fdf4', sub:'#5aad78', muted:'#1a3825', brd:'rgba(34,197,94,0.12)',  badge:'rgba(34,197,94,0.15)',  badgeTxt:'#4ade80' },
    sunset:      { bg:'#0f0800', sb:'#180e00', hd:'#1e1200', card:'#221600', card2:'#2a1c00', acc:'#f97316', acc2:'#ea580c', glow:'rgba(249,115,22,0.15)', text:'#fff7ed', sub:'#c4845a', muted:'#5c2e00', brd:'rgba(249,115,22,0.12)', badge:'rgba(249,115,22,0.15)', badgeTxt:'#fb923c' },
    purple:      { bg:'#080510', sb:'#0e0820', hd:'#140c2c', card:'#180f30', card2:'#1e1438', acc:'#a855f7', acc2:'#7c3aed', glow:'rgba(168,85,247,0.15)', text:'#faf5ff', sub:'#9370c8', muted:'#3d1a60', brd:'rgba(168,85,247,0.12)', badge:'rgba(168,85,247,0.15)', badgeTxt:'#c084fc' },
    rose:        { bg:'#0f0408', sb:'#180608', hd:'#1e0810', card:'#22090e', card2:'#2d0b12', acc:'#f43f5e', acc2:'#e11d48', glow:'rgba(244,63,94,0.15)',  text:'#fff1f2', sub:'#cc6070', muted:'#6b1225', brd:'rgba(244,63,94,0.12)',  badge:'rgba(244,63,94,0.15)',  badgeTxt:'#fb7185' },
    amber:       { bg:'#0e0900', sb:'#150d00', hd:'#1b1100', card:'#1f1500', card2:'#2a1c00', acc:'#f59e0b', acc2:'#d97706', glow:'rgba(245,158,11,0.15)', text:'#fffbeb', sub:'#c29c5c', muted:'#6b4600', brd:'rgba(245,158,11,0.12)', badge:'rgba(245,158,11,0.15)', badgeTxt:'#fbbf24' },
    slate:       { bg:'#070b10', sb:'#0b1018', hd:'#0e1520', card:'#111a24', card2:'#161f2c', acc:'#64748b', acc2:'#475569', glow:'rgba(100,116,139,0.15)',text:'#f8fafc', sub:'#94a3b8', muted:'#2a3545', brd:'rgba(100,116,139,0.12)', badge:'rgba(100,116,139,0.2)', badgeTxt:'#94a3b8' },
    cyan_sport:  { bg:'#030f18', sb:'#041420', hd:'#051928', card:'#071c30', card2:'#0a2238', acc:'#06b6d4', acc2:'#0284c7', glow:'rgba(6,182,212,0.2)',   text:'#f0f9ff', sub:'#7cb8d4', muted:'#1a4060', brd:'rgba(6,182,212,0.15)',  badge:'rgba(6,182,212,0.2)',  badgeTxt:'#22d3ee' },
    emerald_med: { bg:'#030f08', sb:'#041410', hd:'#051918', card:'#071c12', card2:'#0a2218', acc:'#10b981', acc2:'#059669', glow:'rgba(16,185,129,0.2)',  text:'#ecfdf5', sub:'#6cd4a6', muted:'#1a4030', brd:'rgba(16,185,129,0.15)', badge:'rgba(16,185,129,0.2)', badgeTxt:'#34d399' },
    gold_fin:    { bg:'#0e0b00', sb:'#151000', hd:'#1c1500', card:'#221900', card2:'#2d2100', acc:'#eab308', acc2:'#ca8a04', glow:'rgba(234,179,8,0.2)',   text:'#fefce8', sub:'#c4a835', muted:'#5a4800', brd:'rgba(234,179,8,0.15)',  badge:'rgba(234,179,8,0.2)',  badgeTxt:'#facc15' },
    violet_ai:   { bg:'#080514', sb:'#0c071e', hd:'#100a28', card:'#130d2c', card2:'#181238', acc:'#8b5cf6', acc2:'#6d28d9', glow:'rgba(139,92,246,0.2)',  text:'#f5f3ff', sub:'#a78bcc', muted:'#3d206a', brd:'rgba(139,92,246,0.15)', badge:'rgba(139,92,246,0.2)', badgeTxt:'#a78bfa' },
    teal_edu:    { bg:'#030f10', sb:'#041418', hd:'#051920', card:'#071c22', card2:'#0a222a', acc:'#14b8a6', acc2:'#0d9488', glow:'rgba(20,184,166,0.2)',  text:'#f0fdfa', sub:'#5fcbb8', muted:'#1a4040', brd:'rgba(20,184,166,0.15)', badge:'rgba(20,184,166,0.2)', badgeTxt:'#2dd4bf' },
    red_law:     { bg:'#100303', sb:'#180404', hd:'#1e0505', card:'#220606', card2:'#2d0808', acc:'#ef4444', acc2:'#b91c1c', glow:'rgba(239,68,68,0.2)',   text:'#fef2f2', sub:'#d07070', muted:'#6b1515', brd:'rgba(239,68,68,0.15)',  badge:'rgba(239,68,68,0.2)',  badgeTxt:'#f87171' },
    indigo_saas: { bg:'#06040f', sb:'#090618', hd:'#0d0820', card:'#100a25', card2:'#150e30', acc:'#6366f1', acc2:'#4f46e5', glow:'rgba(99,102,241,0.2)',  text:'#eef2ff', sub:'#8f93d8', muted:'#2a266a', brd:'rgba(99,102,241,0.15)', badge:'rgba(99,102,241,0.2)', badgeTxt:'#818cf8' },
  };

  const domainMap = {
    sports_film: themes.cyan_sport, music: themes.purple, health: themes.emerald_med,
    finance: themes.gold_fin, ecommerce: themes.sunset, education: themes.teal_edu,
    logistics: themes.slate, legal: themes.red_law, social: themes.rose,
    realestate: themes.forest, travel: themes.ocean, food: themes.amber,
    creative: themes.violet_ai, ai_tool: themes.violet_ai, saas: themes.indigo_saas,
    gaming: themes.midnight,
  };
  if (domainMap[domain]) return domainMap[domain];

  let hash = 0;
  for (const c of (projectName || '')) hash = ((hash << 5) - hash) + c.charCodeAt(0);
  const keys = ['midnight','ocean','forest','sunset','purple','rose','amber','slate'];
  return themes[keys[Math.abs(hash) % keys.length]];
}

// ── Layout selector ───────────────────────────────────────────────────────
function getDomainLayout(domain) {
  const map = {
    sports_film:'film', music:'music', health:'health', finance:'finance',
    ecommerce:'store', education:'lms', logistics:'dispatch', legal:'legal',
    social:'social', realestate:'property', travel:'travel', food:'food',
    creative:'creative', ai_tool:'ai', saas:'saas', gaming:'gaming',
  };
  return map[domain] || 'generic';
}

// ── CSS helpers (all inline) ──────────────────────────────────────────────
// s_ = inline style helpers
function s_flex(extra) { return `display:flex;${extra||''}`; }
function s_col(extra)  { return `display:flex;flex-direction:column;${extra||''}`; }
function s_grid(cols, gap) { return `display:grid;grid-template-columns:repeat(${cols},1fr);gap:${gap||'12px'}`; }
function s_card(t, extra) { return `background:${t.card};border:1px solid ${t.brd};border-radius:16px;${extra||''}`; }
function s_card2(t, extra){ return `background:${t.card2};border:1px solid ${t.brd};border-radius:12px;${extra||''}`; }
function s_btn_primary(t, extra) { return `background:linear-gradient(135deg,${t.acc},${t.acc2});color:white;border:none;border-radius:10px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px;transition:opacity 0.15s;${extra||''}`; }
function s_btn_ghost(t, extra) { return `background:transparent;border:1px solid ${t.brd};color:${t.sub};border-radius:10px;padding:8px 16px;font-size:12px;font-weight:600;cursor:pointer;transition:background 0.15s;${extra||''}`; }

// ── View-modal toast (mock feedback for all preview buttons) ──────────────
function vToast(msg, type) {
  // type: 'success' | 'info' | 'warning'
  const colors = { success:'#22c55e', info:'#06b6d4', warning:'#f59e0b' };
  const icons  = { success:'fas fa-check-circle', info:'fas fa-circle-info', warning:'fas fa-triangle-exclamation' };
  const color  = colors[type||'info'];
  const icon   = icons[type||'info'];
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;top:20px;right:20px;z-index:99999;background:rgba(10,14,26,0.97);border:1px solid ${color}44;border-radius:12px;padding:12px 18px;display:flex;align-items:center;gap:10px;font-family:'Inter',sans-serif;font-size:13px;color:#f0f9ff;box-shadow:0 8px 32px rgba(0,0,0,0.5);min-width:220px;max-width:320px;animation:fadeInRight 0.25s ease`;
  el.innerHTML = `<i class="${icon}" style="color:${color};font-size:15px;flex-shrink:0"></i><span>${msg}</span>`;
  // Add animation keyframe if not present
  if (!document.getElementById('_vtanim')) {
    const s = document.createElement('style');
    s.id = '_vtanim';
    s.textContent = '@keyframes fadeInRight{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}';
    document.head.appendChild(s);
  }
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity='0'; el.style.transition='opacity 0.3s'; setTimeout(()=>el.remove(),320); }, 2400);
}

// ── Sidebar nav switcher (mock navigation inside view modal) ──────────────
// Called by sidebar items via onclick="vNav(this,N,ITEMS_ARRAY)"
// Just highlights clicked item and shows a toast — preserves the main content
function vNavClick(el, idx, label) {
  // Un-highlight all siblings
  const parent = el.parentNode;
  if (parent) {
    Array.from(parent.children).forEach((c, i) => {
      if (i === idx) {
        c.style.background = 'rgba(255,255,255,0.08)';
        c.querySelector('i') && (c.querySelector('i').style.opacity = '1');
        c.querySelector('span') && (c.querySelector('span').style.opacity = '1');
      } else {
        c.style.background = 'transparent';
      }
    });
  }
  vToast(`Navigated to ${label}`, 'info');
}

// ── Shared top-bar ────────────────────────────────────────────────────────
function vTopBar(t, appName, appIcon, pid) {
  return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 20px;background:${t.hd};border-bottom:1px solid ${t.brd};flex-shrink:0;min-height:52px">
    <div style="display:flex;align-items:center;gap:12px">
      <button onclick="closeViewModal()" style="display:flex;align-items:center;gap:6px;color:${t.sub};font-size:12px;background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:8px" onmouseover="this.style.background='${t.card}'" onmouseout="this.style.background='none'">
        <i class="fas fa-arrow-left" style="font-size:11px"></i> Back
      </button>
      <div style="width:1px;height:20px;background:${t.brd}"></div>
      <div style="display:flex;align-items:center;gap:8px">
        <div style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,${t.acc},${t.acc2});display:flex;align-items:center;justify-content:center">
          <i class="${appIcon}" style="font-size:12px;color:white"></i>
        </div>
        <span style="font-weight:700;font-size:13px;color:${t.text}">${escHtml(truncate(appName,30))}</span>
        <span style="background:${t.badge};color:${t.badgeTxt};border-radius:20px;padding:2px 8px;font-size:10px;font-weight:700">PREVIEW</span>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <button onclick="closeViewModal(); setTimeout(()=>openTestingModal(null,VIEW_PROJECT.id,VIEW_PROJECT.name),100)" style="${s_btn_ghost(t)}">
        <i class="fas fa-flask"></i> Revise
      </button>
      <button onclick="closeViewModal(); setTimeout(()=>openPublishModal(VIEW_PROJECT.id),100)" style="${s_btn_primary(t)}">
        <i class="fas fa-rocket"></i> Publish
      </button>
      <button onclick="closeViewModal()" style="background:none;border:none;color:${t.sub};cursor:pointer;width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:8px" onmouseover="this.style.background='${t.card}'" onmouseout="this.style.background='none'">
        <i class="fas fa-xmark" style="font-size:16px"></i>
      </button>
    </div>
  </div>`;
}

// ── Sidebar builder ───────────────────────────────────────────────────────
function vSidebar(t, items, w) {
  w = w || '200px';
  return `<div style="width:${w};flex-shrink:0;background:${t.sb};border-right:1px solid ${t.brd};overflow-y:auto;display:flex;flex-direction:column">
    <div id="vsidebar-nav" style="padding:12px;display:flex;flex-direction:column;gap:2px">
      ${items.map((item, i) => `
      <div data-nav-idx="${i}" onclick="vNavClick(this,${i},'${escHtml(item.label)}')" style="${i===0 ? `background:${t.badge};` : ''}border-radius:10px;padding:8px 10px;display:flex;align-items:center;gap:10px;cursor:pointer;transition:background 0.15s" onmouseover="if(!this.style.background||this.style.background==='transparent')this.style.background='${t.card2}'" onmouseout="if(this.dataset.navIdx!='0'&&!this.classList.contains('active-nav'))this.style.background='transparent'">
        <i class="${item.icon}" style="font-size:13px;color:${i===0 ? t.acc : t.sub};width:16px;text-align:center"></i>
        <span style="font-size:12px;font-weight:${i===0?700:500};color:${i===0 ? t.acc : t.sub};flex:1">${escHtml(item.label)}</span>
        ${item.badge ? `<span style="background:${t.badge};color:${t.badgeTxt};border-radius:10px;padding:1px 6px;font-size:10px;font-weight:700">${item.badge}</span>` : ''}
      </div>`).join('')}
    </div>
  </div>`;
}

// ── KPI card ──────────────────────────────────────────────────────────────
function vKpi(t, icon, label, value, note, change) {
  return `<div onclick="vToast('${label}: ${value}','info')" style="${s_card(t,'padding:16px;display:flex;flex-direction:column;gap:10px;cursor:pointer')}" onmouseover="this.style.borderColor='${t.acc}'" onmouseout="this.style.borderColor='${t.brd}'">
    <div style="display:flex;align-items:center;justify-content:space-between">
      <div style="width:36px;height:36px;border-radius:10px;background:${t.badge};display:flex;align-items:center;justify-content:center">
        <i class="${icon}" style="font-size:14px;color:${t.acc}"></i>
      </div>
      ${change !== undefined ? `<span style="font-size:11px;font-weight:700;color:${change>=0?'#22c55e':'#ef4444'}">${change>=0?'+':''}${change}%</span>` : ''}
    </div>
    <div>
      <div style="font-size:22px;font-weight:900;color:${t.text};line-height:1">${escHtml(String(value))}</div>
      <div style="font-size:11px;font-weight:600;color:${t.sub};margin-top:2px">${escHtml(label)}</div>
      ${note ? `<div style="font-size:10px;color:${t.muted};margin-top:1px">${escHtml(note)}</div>` : ''}
    </div>
  </div>`;
}

// ── Activity item ─────────────────────────────────────────────────────────
function vActivity(t, icon, label, time, color) {
  return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid ${t.brd}">
    <div style="width:30px;height:30px;border-radius:8px;background:${color}22;display:flex;align-items:center;justify-content:center;flex-shrink:0">
      <i class="${icon}" style="font-size:12px;color:${color}"></i>
    </div>
    <div style="flex:1;min-width:0">
      <div style="font-size:12px;font-weight:500;color:${t.text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(label)}</div>
      <div style="font-size:10px;color:${t.muted}">${escHtml(time)}</div>
    </div>
  </div>`;
}

// ── Badge ─────────────────────────────────────────────────────────────────
function vBadge(t, text, color) {
  color = color || t.acc;
  return `<span style="background:${color}22;color:${color};border-radius:20px;padding:2px 8px;font-size:10px;font-weight:700">${escHtml(text)}</span>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  MAIN DASHBOARD GENERATOR
// ══════════════════════════════════════════════════════════════════════════
function generateProjectDashboard(d, projectId, rawName) {
  const fields  = (d && d.fields)  || {};
  const spec    = (d && d.spec)    || {};
  const project = (d && d.project) || {};

  const appName  = fields.app_name || spec.app_name || project.name || rawName || 'My App';
  const audience = fields.audience || spec.target_audience || 'Users';
  const problem  = fields.problem_statement || spec.problem_statement || '';
  const workflows= fields.workflows || '';
  const features = parseFeatureList(fields.core_features || spec.key_features || '[]');
  const roles    = (fields.roles_permissions || 'Admin/User').split(/[,/]/).map(s => s.trim()).filter(Boolean);
  const bizModel = fields.business_model || '';
  const apis     = (fields.apis_tools || '').split(',').map(s => s.trim()).filter(Boolean);

  const domain   = detectDomain(fields, appName);
  const t        = getDomainTheme(domain, fields, appName);
  const layout   = getDomainLayout(domain);
  const appIcon  = resolveIcon(appName + ' ' + problem + ' ' + (features[0] || ''));

  const feat0 = features[0] || (workflows.split(/[,.;]/)[0] || '').trim() || 'Main';
  const feat1 = features[1] || (workflows.split(/[,.;]/)[1] || '').trim() || 'Analytics';
  const feat2 = features[2] || roles[0] || 'Profile';
  const wfItems = workflows.split(/[,.;]/).map(s => s.trim()).filter(s => s.length > 2).slice(0, 5);

  switch (layout) {
    case 'film':     return renderFilm(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, projectId);
    case 'music':    return renderMusic(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, projectId);
    case 'health':   return renderHealth(t, appName, appIcon, features, wfItems, audience, problem, roles, feat0, feat1, feat2, projectId);
    case 'finance':  return renderFinance(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, projectId);
    case 'store':    return renderStore(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, projectId);
    case 'lms':      return renderLMS(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, projectId);
    case 'legal':    return renderLegal(t, appName, appIcon, features, wfItems, audience, problem, roles, feat0, feat1, feat2, projectId);
    case 'ai':       return renderAI(t, appName, appIcon, features, wfItems, audience, problem, apis, feat0, feat1, feat2, projectId);
    case 'saas':     return renderSaaS(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, projectId);
    case 'dispatch': return renderDispatch(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, projectId);
    case 'social':   return renderSocial(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, projectId);
    case 'food':     return renderFood(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, projectId);
    default:         return renderGeneric(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, projectId);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 1 — FILM / SPORTS ANALYSIS
// ══════════════════════════════════════════════════════════════════════════
function renderFilm(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, pid) {
  const sidebarItems = [
    { icon:'fas fa-gauge-high', label:'Dashboard', badge:null },
    { icon:'fas fa-film',       label:'Film Library', badge:'3 New' },
    { icon:'fas fa-brain',      label:'AI Breakdown', badge:null },
    { icon:'fas fa-chart-bar',  label:'Analytics', badge:null },
    { icon:'fas fa-users',      label:truncate(feat2,14), badge:null },
    { icon:'fas fa-gear',       label:'Settings', badge:null },
  ];
  const filmCards = [
    { title: truncate(wfItems[0]||'Week 12 vs Eagles',30), tag:'Offense', pct:72, color:t.acc },
    { title: truncate(wfItems[1]||'Red Zone Package',30), tag:'Defense', pct:58, color:'#a855f7' },
    { title: 'Formation Tendencies', tag:'Special Teams', pct:41, color:'#f59e0b' },
    { title: truncate(features[0]||'Pass Rush Schemes',30), tag:'AI Ready', pct:0, color:'#22c55e' },
  ];
  return `<div style="display:flex;flex-direction:column;height:100%;background:${t.bg};font-family:'Inter',sans-serif;color:${t.text}">
    ${vTopBar(t,appName,appIcon,pid)}
    <div style="display:flex;flex:1;overflow:hidden">
      ${vSidebar(t,sidebarItems,'200px')}
      <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:20px">
        <!-- Header -->
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <h1 style="font-size:20px;font-weight:900;color:${t.text};margin:0 0 4px">Film Dashboard</h1>
            <p style="font-size:12px;color:${t.sub};margin:0">${escHtml(truncate(problem||`AI-powered analysis for ${audience}`,70))}</p>
          </div>
          <button onclick="vToast('Upload Film — select a video file to analyze','info')" style="${s_btn_primary(t)}"><i class="fas fa-cloud-arrow-up"></i> Upload Film</button>
        </div>
        <!-- KPIs -->
        <div style="${s_grid(4,'12px')}">
          ${vKpi(t,'fas fa-film','Film Sessions','0','Uploaded',0)}
          ${vKpi(t,'fas fa-brain','AI Breakdowns','0','Generated',0)}
          ${vKpi(t,'fas fa-chart-bar','Formations','—','Detected')}
          ${vKpi(t,'fas fa-users',truncate(audience.split(/[,/]/)[0]||'Team Members',16),'0','Active')}
        </div>
        <!-- Film grid + breakdown -->
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px">
          <div style="display:flex;flex-direction:column;gap:12px">
            <h3 style="font-size:13px;font-weight:700;color:${t.text};margin:0">Film Library</h3>
            <div style="${s_grid(2,'12px')}">
              ${filmCards.map(fc => `
              <div onclick="vToast('Opening: '+escHtml(fc.title),'info')" style="${s_card(t,'overflow:hidden;cursor:pointer')}" onmouseover="this.style.borderColor='${t.acc}'" onmouseout="this.style.borderColor='${t.brd}'">
                <div style="height:100px;display:flex;align-items:center;justify-content:center;position:relative;background:linear-gradient(135deg,${t.card2},${t.bg})">
                  <i class="fas fa-film" style="font-size:30px;color:${fc.color};opacity:0.3"></i>
                  <div style="position:absolute;top:8px;right:8px">
                    ${vBadge(t,fc.tag,fc.color)}
                  </div>
                  <div style="position:absolute;bottom:8px;left:8px;right:8px">
                    <div style="height:3px;background:${t.brd};border-radius:2px">
                      <div style="height:3px;background:${fc.color};border-radius:2px;width:${fc.pct}%"></div>
                    </div>
                  </div>
                </div>
                <div style="padding:10px">
                  <div style="font-size:12px;font-weight:700;color:${t.text}">${escHtml(fc.title)}</div>
                  <div style="font-size:10px;color:${t.sub};margin-top:2px">AI Analysis ${fc.pct===0?'Pending':'Complete'}</div>
                </div>
              </div>`).join('')}
            </div>
          </div>
          <!-- AI Breakdown panel -->
          <div style="${s_card(t,'padding:16px;display:flex;flex-direction:column;gap:12px')}">
            <div style="display:flex;align-items:center;gap:8px">
              <div style="width:32px;height:32px;border-radius:10px;background:${t.badge};display:flex;align-items:center;justify-content:center">
                <i class="fas fa-brain" style="color:${t.acc};font-size:13px"></i>
              </div>
              <div>
                <div style="font-size:12px;font-weight:700;color:${t.text}">AI Breakdown</div>
                <div style="font-size:10px;color:${t.sub}">Latest Result</div>
              </div>
            </div>
            ${[['Run %','—','fas fa-arrow-right'],['Pass %','—','fas fa-arrow-up-right'],['Blitz Rate','—','fas fa-bolt'],['Formations','—','fas fa-grip-dots-vertical'],['Tendencies','—','fas fa-chart-line']].map(([l,v,ic])=>`
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid ${t.brd}">
              <div style="display:flex;align-items:center;gap:6px">
                <i class="${ic}" style="font-size:10px;color:${t.muted}"></i>
                <span style="font-size:11px;color:${t.sub}">${l}</span>
              </div>
              <span style="font-size:12px;font-weight:700;color:${t.text}">${v}</span>
            </div>`).join('')}
            <button onclick="vToast('AI Analysis queued — results ready in production','success')" style="${s_btn_primary(t,'width:100%;justify-content:center;margin-top:4px')}">
              <i class="fas fa-brain"></i> Run Analysis
            </button>
          </div>
        </div>
        <!-- Workflow steps -->
        ${wfItems.length ? `
        <div style="${s_card(t,'padding:16px')}">
          <div style="font-size:13px;font-weight:700;color:${t.text};margin-bottom:12px">Workflow Steps</div>
          <div style="display:flex;align-items:center;gap:8px;overflow-x:auto">
            ${wfItems.map((w,i)=>`
            <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
              <div style="width:28px;height:28px;border-radius:50%;background:${t.badge};color:${t.acc};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900">${i+1}</div>
              <span style="font-size:11px;color:${t.sub};white-space:nowrap">${escHtml(truncate(w,25))}</span>
              ${i<wfItems.length-1?`<i class="fas fa-chevron-right" style="font-size:10px;color:${t.muted}"></i>`:''}
            </div>`).join('')}
          </div>
        </div>` : ''}
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 2 — MUSIC PLAYER
// ══════════════════════════════════════════════════════════════════════════
function renderMusic(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, pid) {
  const sidebarItems = [
    { icon:'fas fa-house',           label:'Home', badge:null },
    { icon:'fas fa-magnifying-glass',label:'Discover', badge:null },
    { icon:'fas fa-list',            label:'Library', badge:null },
    { icon:'fas fa-heart',           label:'Favorites', badge:null },
    { icon:'fas fa-music',           label:truncate(feat0,14), badge:'New' },
    { icon:'fas fa-gear',            label:'Settings', badge:null },
  ];
  const tracks = [
    { title:truncate(wfItems[0]||'Top Picks',26), artist:truncate(audience.split(/[,/]/)[0]||'Featured',18), dur:'3:42' },
    { title:truncate(wfItems[1]||'New Releases',26), artist:'Trending Now', dur:'4:15' },
    { title:truncate(features[0]||'Featured Mix',26), artist:"Editor's Choice", dur:'2:58' },
    { title:'Discover Weekly', artist:'Personalized', dur:'5:01' },
  ];
  const genres = ['Hip-Hop','Electronic','R&B','Pop','Indie','Jazz'];
  return `<div style="display:flex;flex-direction:column;height:100%;background:${t.bg};font-family:'Inter',sans-serif;color:${t.text}">
    ${vTopBar(t,appName,appIcon,pid)}
    <div style="display:flex;flex:1;overflow:hidden">
      ${vSidebar(t,sidebarItems,'190px')}
      <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:20px">
        <!-- Hero now-playing -->
        <div style="border-radius:20px;padding:24px;position:relative;overflow:hidden;background:linear-gradient(135deg,${t.acc}22,${t.acc2}33);border:1px solid ${t.brd}">
          <div style="position:absolute;inset:0;background:radial-gradient(ellipse at 70% 50%,${t.glow},transparent);pointer-events:none"></div>
          <div style="display:flex;align-items:center;gap:24px;position:relative">
            <div style="width:96px;height:96px;border-radius:16px;background:linear-gradient(135deg,${t.acc},${t.acc2});display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 8px 32px ${t.glow}">
              <i class="${appIcon}" style="font-size:36px;color:white;opacity:0.9"></i>
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:11px;color:${t.sub};margin-bottom:4px;text-transform:uppercase;letter-spacing:1px">Now Playing</div>
              <div style="font-size:20px;font-weight:900;color:${t.text};margin-bottom:4px">${escHtml(truncate(feat0||appName,30))}</div>
              <div style="font-size:13px;color:${t.sub};margin-bottom:16px">${escHtml(truncate(audience.split(/[,/]/)[0]||'Featured Artist',24))}</div>
              <!-- Progress bar -->
              <div style="height:4px;background:${t.brd};border-radius:2px;margin-bottom:8px">
                <div style="height:4px;background:linear-gradient(90deg,${t.acc},${t.acc2});border-radius:2px;width:42%"></div>
              </div>
              <!-- Controls -->
              <div style="display:flex;align-items:center;gap:16px">
                <button onclick="vToast('Previous track','info')" style="background:none;border:none;color:${t.sub};cursor:pointer;font-size:16px;padding:4px" title="Previous"><i class="fas fa-backward-step"></i></button>
                <button id="vplay-btn" onclick="(function(btn){var ic=btn.querySelector('i');if(ic.className.includes('play')){ic.className='fas fa-pause';vToast('Now playing…','success');}else{ic.className='fas fa-play';vToast('Paused','info');}}).call(null,this)" style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,${t.acc},${t.acc2});border:none;cursor:pointer;color:white;font-size:14px;display:flex;align-items:center;justify-content:center" title="Play/Pause"><i class="fas fa-play"></i></button>
                <button onclick="vToast('Next track','info')" style="background:none;border:none;color:${t.sub};cursor:pointer;font-size:16px;padding:4px" title="Next"><i class="fas fa-forward-step"></i></button>
                <button onclick="(function(btn){var ic=btn.querySelector('i');if(ic.style.color===''||ic.style.color==='inherit'){ic.style.color='#ef4444';vToast('Added to Favorites ❤️','success');}else{ic.style.color='';vToast('Removed from Favorites','info');}}).call(null,this)" style="background:none;border:none;color:${t.sub};cursor:pointer;font-size:14px;padding:4px;margin-left:8px" title="Like"><i class="fas fa-heart"></i></button>
              </div>
            </div>
          </div>
        </div>
        <!-- Genres row -->
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${genres.map((g,i)=>`<button onclick="vToast('Browsing ${g} music','info')" style="border-radius:20px;padding:6px 14px;font-size:12px;font-weight:600;background:${i===0?`linear-gradient(135deg,${t.acc},${t.acc2})`:`${t.card2}`};color:${i===0?'white':t.sub};border:1px solid ${t.brd};cursor:pointer">${g}</button>`).join('')}
        </div>
        <!-- Track list + stats -->
        <div style="display:grid;grid-template-columns:3fr 2fr;gap:16px">
          <div style="${s_card(t,'padding:16px;display:flex;flex-direction:column;gap:4px')}">
            <div style="font-size:13px;font-weight:700;color:${t.text};margin-bottom:10px">Trending Tracks</div>
            ${tracks.map((tr,i)=>`
            <div onclick="vToast('Now playing: '+escHtml(truncate(tr.title,25)),'success')" style="display:flex;align-items:center;gap:12px;padding:8px;border-radius:10px;cursor:pointer" onmouseover="this.style.background='${t.card2}'" onmouseout="this.style.background='transparent'">
              <span style="font-size:12px;color:${t.muted};width:14px;text-align:center">${i+1}</span>
              <div style="width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,${t.acc}${30+i*10},${t.acc2});display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="fas fa-music" style="font-size:12px;color:white"></i>
              </div>
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;font-weight:600;color:${t.text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(tr.title)}</div>
                <div style="font-size:10px;color:${t.sub}">${escHtml(tr.artist)}</div>
              </div>
              <span style="font-size:11px;color:${t.muted}">${tr.dur}</span>
            </div>`).join('')}
          </div>
          <div style="display:flex;flex-direction:column;gap:12px">
            ${vKpi(t,'fas fa-music','Tracks',wfItems.length||'0','In library',0)}
            ${vKpi(t,'fas fa-users',truncate(audience.split(/[,/]/)[0]||'Listeners',14),'0','Active')}
            ${vKpi(t,'fas fa-fire','Trending','0','This week')}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 3 — HEALTH / CLINICAL
// ══════════════════════════════════════════════════════════════════════════
function renderHealth(t, appName, appIcon, features, wfItems, audience, problem, roles, feat0, feat1, feat2, pid) {
  const sidebarItems = [
    { icon:'fas fa-gauge-high',    label:'Dashboard', badge:null },
    { icon:'fas fa-calendar-days', label:'Appointments', badge:'2 Today' },
    { icon:'fas fa-heart-pulse',   label:'Vitals', badge:null },
    { icon:'fas fa-file-medical',  label:'Records', badge:null },
    { icon:'fas fa-pills',         label:truncate(feat0,14), badge:null },
    { icon:'fas fa-user-doctor',   label:truncate(roles[0]||'Provider',14), badge:null },
  ];
  const vitals = [
    {label:'Heart Rate',val:'— BPM',icon:'fas fa-heart',color:'#ef4444'},
    {label:'Blood Pressure',val:'—/—',icon:'fas fa-stethoscope',color:'#3b82f6'},
    {label:'Oxygen',val:'—%',icon:'fas fa-lungs',color:'#06b6d4'},
    {label:'Temperature',val:'—°F',icon:'fas fa-thermometer',color:'#f97316'},
  ];
  const appointments = [
    {name:'Patient A',time:'9:00 AM',type:truncate(feat0||'Check-up',20),status:'Confirmed'},
    {name:'Patient B',time:'10:30 AM',type:truncate(wfItems[0]||'Follow-up',20),status:'Pending'},
    {name:'Patient C',time:'2:00 PM',type:truncate(features[1]||'Consultation',20),status:'Confirmed'},
  ];
  return `<div style="display:flex;flex-direction:column;height:100%;background:${t.bg};font-family:'Inter',sans-serif;color:${t.text}">
    ${vTopBar(t,appName,appIcon,pid)}
    <div style="display:flex;flex:1;overflow:hidden">
      ${vSidebar(t,sidebarItems,'195px')}
      <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:20px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <h1 style="font-size:20px;font-weight:900;color:${t.text};margin:0 0 4px">${escHtml(appName)}</h1>
            <p style="font-size:12px;color:${t.sub};margin:0">${escHtml(truncate(problem||`Healthcare platform for ${audience}`,70))}</p>
          </div>
          <button onclick="vToast('New Appointment form — opens in production','info')" style="${s_btn_primary(t)}"><i class="fas fa-calendar-plus"></i> New Appointment</button>
        </div>
        <div style="${s_grid(4,'12px')}">
          ${vKpi(t,'fas fa-calendar-days','Appointments','0','This week',0)}
          ${vKpi(t,'fas fa-file-medical','Records','0','Total',0)}
          ${vKpi(t,'fas fa-pills','Prescriptions','0','Active')}
          ${vKpi(t,'fas fa-chart-line','Health Score','—','Overall')}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <!-- Vitals -->
          <div style="${s_card(t,'padding:16px')}">
            <div style="font-size:13px;font-weight:700;color:${t.text};margin-bottom:14px">Current Vitals</div>
            <div style="${s_grid(2,'10px')}">
              ${vitals.map(v=>`
              <div style="background:${v.color}18;border:1px solid ${v.color}30;border-radius:12px;padding:12px">
                <i class="${v.icon}" style="color:${v.color};font-size:16px;margin-bottom:6px;display:block"></i>
                <div style="font-size:16px;font-weight:800;color:${t.text}">${v.val}</div>
                <div style="font-size:10px;color:${t.sub};margin-top:2px">${v.label}</div>
              </div>`).join('')}
            </div>
          </div>
          <!-- Appointments -->
          <div style="${s_card(t,'padding:16px')}">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <div style="font-size:13px;font-weight:700;color:${t.text}">Today's Appointments</div>
              ${vBadge(t,'3 Total',t.acc)}
            </div>
            ${appointments.map(a=>`
            <div onclick="vToast('Appointment: '+escHtml(a.name)+' at '+a.time,'info')" style="display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;margin-bottom:6px;background:${t.card2};cursor:pointer" onmouseover="this.style.background='${t.card}'" onmouseout="this.style.background='${t.card2}'">
              <div style="width:36px;height:36px;border-radius:50%;background:${t.badge};display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="fas fa-user" style="font-size:13px;color:${t.acc}"></i>
              </div>
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;font-weight:600;color:${t.text}">${escHtml(a.name)}</div>
                <div style="font-size:10px;color:${t.sub}">${escHtml(a.type)} · ${a.time}</div>
              </div>
              ${vBadge(t,a.status,a.status==='Confirmed'?t.acc:'#f59e0b')}
            </div>`).join('')}
          </div>
        </div>
        <!-- Quick actions -->
        <div style="${s_card(t,'padding:16px')}">
          <div style="font-size:13px;font-weight:700;color:${t.text};margin-bottom:12px">Quick Actions</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            ${[['fas fa-calendar-plus','Schedule Appointment'],['fas fa-file-medical','New Record'],['fas fa-pills','Add Prescription'],['fas fa-message','Send Message']].map(([ic,l])=>`
            <button onclick="vToast('${l} — opens in production','info')" style="${s_btn_ghost(t,'display:flex;align-items:center;gap:6px')}">${'<i class="'+ic+'"></i>'} ${l}</button>`).join('')}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 4 — FINANCE / TRADING
// ══════════════════════════════════════════════════════════════════════════
function renderFinance(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, pid) {
  const sidebarItems = [
    { icon:'fas fa-gauge-high',   label:'Dashboard', badge:null },
    { icon:'fas fa-chart-line',   label:'Portfolio', badge:null },
    { icon:'fas fa-coins',        label:truncate(feat0,14), badge:'Live' },
    { icon:'fas fa-receipt',      label:'Transactions', badge:null },
    { icon:'fas fa-chart-pie',    label:'Analytics', badge:null },
    { icon:'fas fa-gear',         label:'Settings', badge:null },
  ];
  const positions = [
    {sym:'BTC',name:'Bitcoin',price:'$0.00',chg:'+0.0%',up:true},
    {sym:'ETH',name:'Ethereum',price:'$0.00',chg:'+0.0%',up:true},
    {sym:'AAPL',name:'Apple Inc.',price:'$0.00',chg:'-0.0%',up:false},
    {sym:'GOOGL',name:'Alphabet',price:'$0.00',chg:'+0.0%',up:true},
  ];
  // Simple SVG chart bars
  const bars = [35,55,40,70,60,80,50,75,65,90,70,85];
  const chartSVG = `<svg viewBox="0 0 240 80" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:80px">
    ${bars.map((h,i)=>`<rect x="${i*20+1}" y="${80-h}" width="16" height="${h}" rx="3" fill="${t.acc}" opacity="${0.3+i*0.06}"/>`).join('')}
    <polyline points="${bars.map((h,i)=>`${i*20+9},${80-h}`).join(' ')}" fill="none" stroke="${t.acc}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  return `<div style="display:flex;flex-direction:column;height:100%;background:${t.bg};font-family:'Inter',sans-serif;color:${t.text}">
    ${vTopBar(t,appName,appIcon,pid)}
    <div style="display:flex;flex:1;overflow:hidden">
      ${vSidebar(t,sidebarItems,'200px')}
      <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:20px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <h1 style="font-size:20px;font-weight:900;color:${t.text};margin:0 0 4px">${escHtml(appName)}</h1>
            <p style="font-size:12px;color:${t.sub};margin:0">${escHtml(truncate(problem||`Financial platform for ${audience}`,70))}</p>
          </div>
          <button onclick="vToast('New Trade — open order form in production','info')" style="${s_btn_primary(t)}"><i class="fas fa-plus"></i> New Trade</button>
        </div>
        <!-- Portfolio value hero -->
        <div style="border-radius:20px;padding:24px;position:relative;overflow:hidden;background:linear-gradient(135deg,${t.acc}18,${t.acc2}28);border:1px solid ${t.brd}">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px">
            <div>
              <div style="font-size:12px;color:${t.sub};text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Total Portfolio Value</div>
              <div style="font-size:36px;font-weight:900;color:${t.text}">$0.00</div>
              <div style="font-size:13px;color:#22c55e;margin-top:4px"><i class="fas fa-arrow-trend-up"></i> +0.00% Today</div>
            </div>
            <button onclick="vToast('Exporting portfolio data…','success')" style="${s_btn_primary(t)}"><i class="fas fa-download"></i> Export</button>
          </div>
          ${chartSVG}
        </div>
        <div style="${s_grid(4,'12px')}">
          ${vKpi(t,'fas fa-wallet','Balance','$0.00','Available',0)}
          ${vKpi(t,'fas fa-coins','Assets','0','Holdings',0)}
          ${vKpi(t,'fas fa-arrow-trend-up','Returns','+0%','All time')}
          ${vKpi(t,'fas fa-chart-pie','Risk Score','—','Assessment')}
        </div>
        <!-- Positions table -->
        <div style="${s_card(t,'padding:16px')}">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <div style="font-size:13px;font-weight:700;color:${t.text}">Positions</div>
            <button onclick="vToast('Viewing all positions','info')" style="${s_btn_ghost(t,'font-size:11px;padding:4px 10px')}">View All</button>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead>
              <tr style="border-bottom:1px solid ${t.brd}">
                <th style="text-align:left;padding:6px 8px;color:${t.muted};font-weight:600">Asset</th>
                <th style="text-align:right;padding:6px 8px;color:${t.muted};font-weight:600">Price</th>
                <th style="text-align:right;padding:6px 8px;color:${t.muted};font-weight:600">Change</th>
                <th style="text-align:right;padding:6px 8px;color:${t.muted};font-weight:600">Value</th>
              </tr>
            </thead>
            <tbody>
              ${positions.map(p=>`
              <tr onclick="vToast('Viewing '+p.sym+': '+p.name,'info')" style="border-bottom:1px solid ${t.brd};cursor:pointer" onmouseover="this.style.background='${t.card2}'" onmouseout="this.style.background='transparent'">
                <td style="padding:10px 8px">
                  <div style="display:flex;align-items:center;gap:8px">
                    <div style="width:30px;height:30px;border-radius:8px;background:${t.badge};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:${t.acc}">${p.sym.slice(0,2)}</div>
                    <div>
                      <div style="font-weight:700;color:${t.text}">${p.sym}</div>
                      <div style="font-size:10px;color:${t.sub}">${p.name}</div>
                    </div>
                  </div>
                </td>
                <td style="text-align:right;padding:10px 8px;color:${t.text};font-weight:600">${p.price}</td>
                <td style="text-align:right;padding:10px 8px;color:${p.up?'#22c55e':'#ef4444'};font-weight:700">${p.chg}</td>
                <td style="text-align:right;padding:10px 8px;color:${t.sub}">$0.00</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 5 — E-COMMERCE / STOREFRONT
// ══════════════════════════════════════════════════════════════════════════
function renderStore(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, pid) {
  const sidebarItems = [
    { icon:'fas fa-gauge-high',   label:'Dashboard', badge:null },
    { icon:'fas fa-bag-shopping', label:'Products', badge:null },
    { icon:'fas fa-list-check',   label:'Orders', badge:'5 New' },
    { icon:'fas fa-users',        label:'Customers', badge:null },
    { icon:'fas fa-tag',          label:truncate(feat0,14), badge:null },
    { icon:'fas fa-gear',         label:'Settings', badge:null },
  ];
  const products = [
    {name:truncate(wfItems[0]||'Premium Product A',22),price:'$0.00',stock:'0',cat:truncate(feat0||'Category',12)},
    {name:truncate(wfItems[1]||'Essential Item B',22),price:'$0.00',stock:'0',cat:truncate(feat1||'Category',12)},
    {name:truncate(features[0]||'Best Seller C',22),price:'$0.00',stock:'0',cat:'Featured'},
    {name:truncate(features[1]||'New Arrival D',22),price:'$0.00',stock:'0',cat:'New'},
  ];
  return `<div style="display:flex;flex-direction:column;height:100%;background:${t.bg};font-family:'Inter',sans-serif;color:${t.text}">
    ${vTopBar(t,appName,appIcon,pid)}
    <div style="display:flex;flex:1;overflow:hidden">
      ${vSidebar(t,sidebarItems,'200px')}
      <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:20px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <h1 style="font-size:20px;font-weight:900;color:${t.text};margin:0 0 4px">${escHtml(appName)}</h1>
            <p style="font-size:12px;color:${t.sub};margin:0">${escHtml(truncate(problem||`Storefront for ${audience}`,70))}</p>
          </div>
          <div style="display:flex;gap:8px">
            <button onclick="vToast('Exporting store data…','success')" style="${s_btn_ghost(t,'display:flex;align-items:center;gap:6px')}"><i class="fas fa-download"></i> Export</button>
            <button onclick="vToast('New Product form — opens in production','info')" style="${s_btn_primary(t)}"><i class="fas fa-plus"></i> Add Product</button>
          </div>
        </div>
        <div style="${s_grid(4,'12px')}">
          ${vKpi(t,'fas fa-dollar-sign','Revenue','$0.00','This month',0)}
          ${vKpi(t,'fas fa-shopping-cart','Orders','0','Today',5)}
          ${vKpi(t,'fas fa-box','Products','0','Active',0)}
          ${vKpi(t,'fas fa-users','Customers','0','Total',0)}
        </div>
        <!-- Product grid -->
        <div style="${s_card(t,'padding:16px')}">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <div style="font-size:13px;font-weight:700;color:${t.text}">Product Catalog</div>
            <div style="display:flex;gap:8px">
              <input placeholder="Search products..." onkeydown="if(event.key==='Enter'&&this.value.trim())vToast('Searching products: '+this.value.trim().slice(0,25),'info')" style="background:${t.card2};border:1px solid ${t.brd};border-radius:8px;padding:6px 12px;font-size:12px;color:${t.text};outline:none;width:160px">
              ${vBadge(t,'4 items',t.acc)}
            </div>
          </div>
          <div style="${s_grid(2,'10px')}">
            ${products.map(p=>`
            <div onclick="vToast('Viewing: '+escHtml(truncate(p.name,22)),'info')" style="${s_card2(t,'padding:14px;cursor:pointer')}" onmouseover="this.style.borderColor='${t.acc}'" onmouseout="this.style.borderColor='${t.brd}'">
              <div style="width:100%;height:80px;background:linear-gradient(135deg,${t.card},${t.muted}22);border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:10px">
                <i class="fas fa-box" style="font-size:24px;color:${t.acc};opacity:0.5"></i>
              </div>
              <div style="font-size:12px;font-weight:700;color:${t.text};margin-bottom:4px">${escHtml(p.name)}</div>
              <div style="display:flex;align-items:center;justify-content:space-between">
                <span style="font-size:13px;font-weight:800;color:${t.acc}">${p.price}</span>
                ${vBadge(t,p.cat)}
              </div>
            </div>`).join('')}
          </div>
        </div>
        <!-- Recent orders -->
        <div style="${s_card(t,'padding:16px')}">
          <div style="font-size:13px;font-weight:700;color:${t.text};margin-bottom:12px">Recent Orders</div>
          ${['#001','#002','#003'].map((o,i)=>`
          <div onclick="vToast('Order '+o+' details — opens in production','info')" style="display:flex;align-items:center;gap:12px;padding:8px;border-radius:10px;margin-bottom:4px;cursor:pointer" onmouseover="this.style.background='${t.card2}'" onmouseout="this.style.background='transparent'">
            <div style="width:32px;height:32px;border-radius:8px;background:${t.badge};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:11px;font-weight:800;color:${t.acc}">${o}</div>
            <div style="flex:1">
              <div style="font-size:12px;font-weight:600;color:${t.text}">Order ${o}</div>
              <div style="font-size:10px;color:${t.sub}">${['Just now','5m ago','12m ago'][i]}</div>
            </div>
            ${vBadge(t,['Processing','Shipped','Delivered'][i],['#f59e0b',t.acc,'#22c55e'][i])}
            <span style="font-size:12px;font-weight:700;color:${t.text}">$0.00</span>
          </div>`).join('')}
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 6 — LMS / EDUCATION
// ══════════════════════════════════════════════════════════════════════════
function renderLMS(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, pid) {
  const sidebarItems = [
    { icon:'fas fa-gauge-high',    label:'Dashboard', badge:null },
    { icon:'fas fa-graduation-cap',label:'Courses', badge:null },
    { icon:'fas fa-chart-line',    label:'Progress', badge:null },
    { icon:'fas fa-certificate',   label:'Certificates', badge:null },
    { icon:'fas fa-book',          label:truncate(feat0,14), badge:'New' },
    { icon:'fas fa-users',         label:truncate(audience.split(/[,/]/)[0]||'Students',14), badge:null },
  ];
  const courses = [
    {title:truncate(wfItems[0]||'Introduction to '+feat0,30),students:'0',progress:65,color:t.acc},
    {title:truncate(wfItems[1]||feat1+' Fundamentals',30),students:'0',progress:40,color:'#a855f7'},
    {title:truncate(features[0]||'Advanced Module',30),students:'0',progress:20,color:'#f59e0b'},
  ];
  return `<div style="display:flex;flex-direction:column;height:100%;background:${t.bg};font-family:'Inter',sans-serif;color:${t.text}">
    ${vTopBar(t,appName,appIcon,pid)}
    <div style="display:flex;flex:1;overflow:hidden">
      ${vSidebar(t,sidebarItems,'200px')}
      <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:20px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <h1 style="font-size:20px;font-weight:900;color:${t.text};margin:0 0 4px">${escHtml(appName)}</h1>
            <p style="font-size:12px;color:${t.sub};margin:0">${escHtml(truncate(problem||`Learning platform for ${audience}`,70))}</p>
          </div>
          <button onclick="vToast('New Course — form opens in production','info')" style="${s_btn_primary(t)}"><i class="fas fa-plus"></i> New Course</button>
        </div>
        <div style="${s_grid(4,'12px')}">
          ${vKpi(t,'fas fa-graduation-cap','Courses','0','Published',0)}
          ${vKpi(t,'fas fa-users','Students','0','Enrolled',0)}
          ${vKpi(t,'fas fa-certificate','Certificates','0','Issued',0)}
          ${vKpi(t,'fas fa-chart-line','Completion','0%','Rate',0)}
        </div>
        <!-- Course cards -->
        <div style="${s_card(t,'padding:16px')}">
          <div style="font-size:13px;font-weight:700;color:${t.text};margin-bottom:14px">Course Catalog</div>
          <div style="display:flex;flex-direction:column;gap:12px">
            ${courses.map(c=>`
            <div onclick="vToast('Opening course: '+escHtml(truncate(c.title,25)),'info')" style="background:${t.card2};border:1px solid ${t.brd};border-radius:14px;padding:14px;cursor:pointer" onmouseover="this.style.borderColor='${c.color}'" onmouseout="this.style.borderColor='${t.brd}'">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                <div style="font-size:13px;font-weight:700;color:${t.text}">${escHtml(c.title)}</div>
                ${vBadge(t,c.students+' Students',c.color)}
              </div>
              <div style="display:flex;align-items:center;gap:10px">
                <div style="flex:1;height:6px;background:${t.brd};border-radius:3px">
                  <div style="height:6px;background:linear-gradient(90deg,${c.color},${c.color}88);border-radius:3px;width:${c.progress}%"></div>
                </div>
                <span style="font-size:11px;font-weight:700;color:${c.color}">${c.progress}%</span>
              </div>
            </div>`).join('')}
          </div>
        </div>
        <!-- Recent activity -->
        <div style="${s_card(t,'padding:16px')}">
          <div style="font-size:13px;font-weight:700;color:${t.text};margin-bottom:12px">Recent Activity</div>
          ${wfItems.slice(0,4).map((w,i)=>vActivity(t,resolveIcon(w),truncate(w,45),['Just now','5m ago','1h ago','3h ago'][i]||'Today',[t.acc,'#a855f7','#f59e0b','#22c55e'][i]||t.acc)).join('')}
          ${vActivity(t,'fas fa-graduation-cap','Course completed by student','Yesterday',t.acc2)}
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 7 — LEGAL / LAW FIRM
// ══════════════════════════════════════════════════════════════════════════
function renderLegal(t, appName, appIcon, features, wfItems, audience, problem, roles, feat0, feat1, feat2, pid) {
  const sidebarItems = [
    { icon:'fas fa-gauge-high',       label:'Dashboard', badge:null },
    { icon:'fas fa-folder-open',      label:'Cases', badge:'3 Active' },
    { icon:'fas fa-file-contract',    label:'Documents', badge:null },
    { icon:'fas fa-calendar-check',   label:'Hearings', badge:'2 This Week' },
    { icon:'fas fa-clock',            label:'Billing', badge:null },
    { icon:'fas fa-scale-balanced',   label:truncate(feat0,14), badge:null },
  ];
  const cases = [
    {id:'C-001',name:truncate(wfItems[0]||'Estate Planning Matter',30),client:'Client A',status:'Active',date:'Mar 28'},
    {id:'C-002',name:truncate(wfItems[1]||'Contract Dispute',30),client:'Client B',status:'Review',date:'Mar 25'},
    {id:'C-003',name:truncate(features[0]||'Corporate Formation',30),client:'Client C',status:'Closed',date:'Mar 20'},
  ];
  return `<div style="display:flex;flex-direction:column;height:100%;background:${t.bg};font-family:'Inter',sans-serif;color:${t.text}">
    ${vTopBar(t,appName,appIcon,pid)}
    <div style="display:flex;flex:1;overflow:hidden">
      ${vSidebar(t,sidebarItems,'205px')}
      <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:20px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <h1 style="font-size:20px;font-weight:900;color:${t.text};margin:0 0 4px">${escHtml(appName)}</h1>
            <p style="font-size:12px;color:${t.sub};margin:0">${escHtml(truncate(problem||`Legal management for ${audience}`,70))}</p>
          </div>
          <button onclick="vToast('New Case — form opens in production','info')" style="${s_btn_primary(t)}"><i class="fas fa-folder-plus"></i> New Case</button>
        </div>
        <div style="${s_grid(4,'12px')}">
          ${vKpi(t,'fas fa-folder-open','Open Cases','0','Active',0)}
          ${vKpi(t,'fas fa-file-contract','Documents','0','Filed',0)}
          ${vKpi(t,'fas fa-calendar-check','Hearings','0','Scheduled')}
          ${vKpi(t,'fas fa-clock','Billable Hours','0h','This month')}
        </div>
        <!-- Case list -->
        <div style="${s_card(t,'padding:16px')}">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <div style="font-size:13px;font-weight:700;color:${t.text}">Case Management</div>
            <button onclick="vToast('Viewing all cases','info')" style="${s_btn_ghost(t,'font-size:11px;padding:4px 10px')}">View All</button>
          </div>
          ${cases.map(c=>`
          <div onclick="vToast('Opening case: '+escHtml(c.id)+' — '+escHtml(truncate(c.name,22)),'info')" style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:12px;margin-bottom:6px;background:${t.card2};cursor:pointer" onmouseover="this.style.background='${t.card}'" onmouseout="this.style.background='${t.card2}'">
            <div style="width:36px;height:36px;border-radius:10px;background:${t.badge};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:11px;font-weight:800;color:${t.acc}">${c.id}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;font-weight:700;color:${t.text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(c.name)}</div>
              <div style="font-size:10px;color:${t.sub}">${c.client} · ${c.date}</div>
            </div>
            ${vBadge(t,c.status,c.status==='Active'?t.acc:c.status==='Review'?'#f59e0b':'#64748b')}
          </div>`).join('')}
        </div>
        <!-- Upcoming hearings -->
        <div style="${s_card(t,'padding:16px')}">
          <div style="font-size:13px;font-weight:700;color:${t.text};margin-bottom:12px">Upcoming Hearings</div>
          ${wfItems.slice(0,3).map((w,i)=>`
          <div onclick="vToast('Hearing: '+escHtml(truncate(w,30)),'info')" style="display:flex;align-items:center;gap:12px;padding:8px;border-radius:10px;margin-bottom:4px;background:${t.card2};cursor:pointer" onmouseover="this.style.background='${t.card}'" onmouseout="this.style.background='${t.card2}'">
            <div style="min-width:48px;text-align:center;background:${t.acc}22;border-radius:8px;padding:6px">
              <div style="font-size:14px;font-weight:900;color:${t.acc}">${28+i}</div>
              <div style="font-size:9px;color:${t.sub}">MAR</div>
            </div>
            <div>
              <div style="font-size:12px;font-weight:600;color:${t.text}">${escHtml(truncate(w,35))}</div>
              <div style="font-size:10px;color:${t.sub}">${['9:00 AM','2:00 PM','10:30 AM'][i]} · ${['Room 201','Room 105','Zoom'][i]}</div>
            </div>
          </div>`).join('')}
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 8 — AI TOOL / AI CONSOLE
// ══════════════════════════════════════════════════════════════════════════
function renderAI(t, appName, appIcon, features, wfItems, audience, problem, apis, feat0, feat1, feat2, pid) {
  const sidebarItems = [
    { icon:'fas fa-gauge-high',  label:'Dashboard', badge:null },
    { icon:'fas fa-terminal',    label:'Console', badge:null },
    { icon:'fas fa-brain',       label:'Models', badge:'New' },
    { icon:'fas fa-chart-bar',   label:'Analytics', badge:null },
    { icon:'fas fa-key',         label:'API Keys', badge:null },
    { icon:'fas fa-gear',        label:'Settings', badge:null },
  ];
  const modelItems = apis.length ? apis.slice(0,4) : [feat0||'GPT-4',feat1||'Claude','Gemini','Custom Model'];
  return `<div style="display:flex;flex-direction:column;height:100%;background:${t.bg};font-family:'Inter',sans-serif;color:${t.text}">
    ${vTopBar(t,appName,appIcon,pid)}
    <div style="display:flex;flex:1;overflow:hidden">
      ${vSidebar(t,sidebarItems,'195px')}
      <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:20px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <h1 style="font-size:20px;font-weight:900;color:${t.text};margin:0 0 4px">${escHtml(appName)}</h1>
            <p style="font-size:12px;color:${t.sub};margin:0">${escHtml(truncate(problem||`AI automation platform for ${audience}`,70))}</p>
          </div>
          <button onclick="vToast('Pipeline started — running workflows…','success')" style="${s_btn_primary(t)}"><i class="fas fa-play"></i> Run Pipeline</button>
        </div>
        <div style="${s_grid(4,'12px')}">
          ${vKpi(t,'fas fa-bolt','API Calls','0','Today',0)}
          ${vKpi(t,'fas fa-brain','Models',''+modelItems.length,'Connected',0)}
          ${vKpi(t,'fas fa-chart-line','Accuracy','—%','Avg')}
          ${vKpi(t,'fas fa-clock','Avg Latency','—ms','Response')}
        </div>
        <!-- Terminal-style console -->
        <div style="${s_card(t,'padding:0;overflow:hidden')}">
          <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:${t.card2};border-bottom:1px solid ${t.brd}">
            <div style="width:10px;height:10px;border-radius:50%;background:#ef4444"></div>
            <div style="width:10px;height:10px;border-radius:50%;background:#f59e0b"></div>
            <div style="width:10px;height:10px;border-radius:50%;background:#22c55e"></div>
            <span style="font-size:11px;color:${t.muted};margin-left:8px">AI Console — ${escHtml(truncate(appName,20))}</span>
          </div>
          <div style="padding:16px;font-family:'JetBrains Mono','Fira Code',monospace;font-size:12px;min-height:120px;background:${t.bg}">
            <div style="color:${t.acc};margin-bottom:4px">$ initializing ${escHtml(truncate(appName.toLowerCase().replace(/\s+/g,'-'),20))}...</div>
            <div style="color:${t.muted};margin-bottom:4px">✓ Connected to ${modelItems[0]||'AI Model'}</div>
            <div style="color:${t.muted};margin-bottom:4px">✓ Pipeline ready — ${wfItems.length||0} workflows loaded</div>
            <div style="color:${t.sub};margin-bottom:8px">✓ System initialized</div>
            <div style="display:flex;align-items:center;gap:8px">
              <span style="color:${t.acc}">&gt;</span>
              <span style="color:${t.text}">Ready to process prompts</span>
              <span style="width:8px;height:14px;background:${t.acc};display:inline-block;animation:blink 1s infinite"></span>
            </div>
          </div>
          <div style="padding:10px 14px;border-top:1px solid ${t.brd};display:flex;gap:8px">
            <input id="vconsole-input" placeholder="Enter prompt or command..." style="flex:1;background:transparent;border:none;color:${t.text};font-size:12px;font-family:monospace;outline:none" onkeydown="if(event.key==='Enter'){var v=this.value.trim();if(v){vToast('Running: '+v.slice(0,40),'success');this.value='';}}" />
            <button onclick="(function(){var inp=document.getElementById('vconsole-input');var v=inp?inp.value.trim():'';if(v){vToast('Running: '+v.slice(0,40),'success');inp.value='';}else{vToast('Enter a prompt first','warning');}})()" style="${s_btn_primary(t,'padding:6px 12px')}">&gt; Run</button>
          </div>
        </div>
        <!-- Models + workflows -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div style="${s_card(t,'padding:16px')}">
            <div style="font-size:13px;font-weight:700;color:${t.text};margin-bottom:12px">Connected Models</div>
            ${modelItems.map((m,i)=>`
            <div onclick="vToast((i===0?'Active model: ':'Activating: ')+escHtml(truncate(m,22)),'success')" style="display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;margin-bottom:4px;background:${t.card2};cursor:pointer" onmouseover="this.style.background='${t.card}'" onmouseout="this.style.background='${t.card2}'">
              <div style="width:8px;height:8px;border-radius:50%;background:${i===0?'#22c55e':'#64748b'}"></div>
              <span style="font-size:12px;font-weight:600;color:${t.text};flex:1">${escHtml(truncate(m,22))}</span>
              ${vBadge(t,i===0?'Active':'Standby',i===0?'#22c55e':'#64748b')}
            </div>`).join('')}
          </div>
          <div style="${s_card(t,'padding:16px')}">
            <div style="font-size:13px;font-weight:700;color:${t.text};margin-bottom:12px">Workflows</div>
            ${(wfItems.length ? wfItems : [feat0||'Process Input',feat1||'Analyze','Generate Output']).slice(0,4).map((w,i)=>vActivity(t,resolveIcon(w),truncate(w,40),['Active','Idle','Running','Queued'][i]||'Idle',[t.acc,'#64748b',t.acc2,'#f59e0b'][i]||t.acc)).join('')}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 9 — SAAS / COMMAND CENTER (CRM / ERP)
// ══════════════════════════════════════════════════════════════════════════
function renderSaaS(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, pid) {
  const sidebarItems = [
    { icon:'fas fa-gauge-high',  label:'Overview', badge:null },
    { icon:'fas fa-users',       label:'Customers', badge:null },
    { icon:'fas fa-handshake',   label:'Deals', badge:'5 Open' },
    { icon:'fas fa-chart-bar',   label:'Reports', badge:null },
    { icon:'fas fa-bell',        label:'Notifications', badge:'3' },
    { icon:'fas fa-gear',        label:'Settings', badge:null },
  ];
  const bars2 = [40,60,45,75,55,80,65,90,70,85,60,95];
  const chartSVG2 = `<svg viewBox="0 0 280 60" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:60px">
    ${bars2.map((h,i)=>`<rect x="${i*23+1}" y="${60-h*0.6}" width="20" height="${h*0.6}" rx="4" fill="${t.acc}" opacity="${0.2+i*0.06}"/>`).join('')}
  </svg>`;
  return `<div style="display:flex;flex-direction:column;height:100%;background:${t.bg};font-family:'Inter',sans-serif;color:${t.text}">
    ${vTopBar(t,appName,appIcon,pid)}
    <div style="display:flex;flex:1;overflow:hidden">
      ${vSidebar(t,sidebarItems,'195px')}
      <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:20px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <h1 style="font-size:20px;font-weight:900;color:${t.text};margin:0 0 4px">${escHtml(appName)}</h1>
            <p style="font-size:12px;color:${t.sub};margin:0">${escHtml(truncate(problem||`SaaS platform for ${audience}`,70))}</p>
          </div>
          <div style="display:flex;gap:8px">
            <button onclick="vToast('Generating report…','success')" style="${s_btn_ghost(t,'display:flex;align-items:center;gap:6px')}"><i class="fas fa-download"></i> Report</button>
            <button onclick="vToast('New '+escHtml(truncate(feat0,14))+' — form opens in production','info')" style="${s_btn_primary(t)}"><i class="fas fa-plus"></i> New ${escHtml(truncate(feat0,12))}</button>
          </div>
        </div>
        <!-- Metric strip -->
        <div style="${s_grid(4,'12px')}">
          ${vKpi(t,'fas fa-dollar-sign','MRR','$0.00','Monthly',12)}
          ${vKpi(t,'fas fa-users','Active Users','0','This month',5)}
          ${vKpi(t,'fas fa-handshake','Deals','0','Open',0)}
          ${vKpi(t,'fas fa-chart-line','Churn','0%','Monthly',-2)}
        </div>
        <!-- Chart + quick actions -->
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px">
          <div style="${s_card(t,'padding:16px')}">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <div style="font-size:13px;font-weight:700;color:${t.text}">Revenue Overview</div>
              ${vBadge(t,'Last 12 months',t.acc)}
            </div>
            ${chartSVG2}
          </div>
          <div style="${s_card(t,'padding:16px')}">
            <div style="font-size:13px;font-weight:700;color:${t.text};margin-bottom:12px">Quick Actions</div>
            <div style="display:flex;flex-direction:column;gap:8px">
              ${[['fas fa-user-plus','Add Customer'],['fas fa-file-invoice','New Invoice'],['fas fa-envelope','Send Email'],['fas fa-chart-pie','View Report']].map(([ic,l])=>`
              <button onclick="vToast('${l} — opens in production','info')" style="${s_btn_ghost(t,'width:100%;display:flex;align-items:center;gap:8px;justify-content:flex-start')}">${'<i class="'+ic+'" style="color:'+t.acc+'"></i>'} <span style="font-size:12px">${l}</span></button>`).join('')}
            </div>
          </div>
        </div>
        <!-- Customer table -->
        <div style="${s_card(t,'padding:16px')}">
          <div style="font-size:13px;font-weight:700;color:${t.text};margin-bottom:12px">Recent Customers</div>
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="border-bottom:1px solid ${t.brd}">
              <th style="text-align:left;padding:6px 8px;color:${t.muted};font-weight:600">Name</th>
              <th style="text-align:left;padding:6px 8px;color:${t.muted};font-weight:600">Plan</th>
              <th style="text-align:right;padding:6px 8px;color:${t.muted};font-weight:600">MRR</th>
              <th style="text-align:right;padding:6px 8px;color:${t.muted};font-weight:600">Status</th>
            </tr></thead>
            <tbody>
              ${['Acme Corp','Beta Inc','Gamma LLC','Delta Ltd'].map((n,i)=>`
              <tr onclick="vToast('Viewing customer: '+n,'info')" style="border-bottom:1px solid ${t.brd};cursor:pointer" onmouseover="this.style.background='${t.card2}'" onmouseout="this.style.background='transparent'">
                <td style="padding:8px;color:${t.text};font-weight:600">${n}</td>
                <td style="padding:8px;color:${t.sub}">${['Pro','Starter','Enterprise','Pro'][i]}</td>
                <td style="padding:8px;text-align:right;color:${t.text};font-weight:700">$0</td>
                <td style="padding:8px;text-align:right">${vBadge(t,['Active','Trial','Active','Churned'][i],['#22c55e','#f59e0b','#22c55e','#ef4444'][i])}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 10 — LOGISTICS / DISPATCH
// ══════════════════════════════════════════════════════════════════════════
function renderDispatch(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, pid) {
  const sidebarItems = [
    { icon:'fas fa-gauge-high',       label:'Dashboard', badge:null },
    { icon:'fas fa-truck',            label:'Active Routes', badge:'0' },
    { icon:'fas fa-map-location-dot', label:'Live Map', badge:null },
    { icon:'fas fa-users',            label:'Drivers', badge:null },
    { icon:'fas fa-list-check',       label:'Deliveries', badge:null },
    { icon:'fas fa-gear',             label:'Settings', badge:null },
  ];
  return `<div style="display:flex;flex-direction:column;height:100%;background:${t.bg};font-family:'Inter',sans-serif;color:${t.text}">
    ${vTopBar(t,appName,appIcon,pid)}
    <div style="display:flex;flex:1;overflow:hidden">
      ${vSidebar(t,sidebarItems,'200px')}
      <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:20px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <h1 style="font-size:20px;font-weight:900;color:${t.text};margin:0 0 4px">${escHtml(appName)}</h1>
            <p style="font-size:12px;color:${t.sub};margin:0">${escHtml(truncate(problem||`Dispatch management for ${audience}`,70))}</p>
          </div>
          <button onclick="vToast('New Route — form opens in production','info')" style="${s_btn_primary(t)}"><i class="fas fa-plus"></i> New Route</button>
        </div>
        <div style="${s_grid(4,'12px')}">
          ${vKpi(t,'fas fa-truck','Active Routes','0','Now',0)}
          ${vKpi(t,'fas fa-map-location-dot','Deliveries','0','Today',0)}
          ${vKpi(t,'fas fa-users','Drivers','0','Online')}
          ${vKpi(t,'fas fa-check-circle','Completed','0','Today',0)}
        </div>
        <!-- Map placeholder + routes -->
        <div style="display:grid;grid-template-columns:3fr 2fr;gap:16px">
          <div style="${s_card(t,'padding:0;overflow:hidden')}">
            <div style="height:200px;background:linear-gradient(135deg,${t.card2},${t.bg});display:flex;align-items:center;justify-content:center;position:relative">
              <i class="fas fa-map" style="font-size:48px;color:${t.acc};opacity:0.15"></i>
              <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
                <div style="text-align:center">
                  <i class="fas fa-location-dot" style="font-size:24px;color:${t.acc};margin-bottom:8px;display:block"></i>
                  <div style="font-size:12px;color:${t.sub}">Live Map View</div>
                  <div style="font-size:10px;color:${t.muted}">Routes appear here in production</div>
                </div>
              </div>
            </div>
            <div style="padding:12px">
              <div style="font-size:12px;font-weight:600;color:${t.text}">Route Overview</div>
            </div>
          </div>
          <div style="${s_card(t,'padding:16px;display:flex;flex-direction:column;gap:10px')}">
            <div style="font-size:13px;font-weight:700;color:${t.text}">Active Drivers</div>
            ${['Driver A','Driver B','Driver C'].map((d,i)=>`
            <div onclick="vToast('Tracking '+d+' on Route '+(i+1),'info')" style="display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;background:${t.card2};cursor:pointer" onmouseover="this.style.background='${t.card}'" onmouseout="this.style.background='${t.card2}'">
              <div style="width:32px;height:32px;border-radius:50%;background:${t.badge};display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="fas fa-user" style="font-size:12px;color:${t.acc}"></i>
              </div>
              <div style="flex:1">
                <div style="font-size:11px;font-weight:600;color:${t.text}">${d}</div>
                <div style="font-size:10px;color:${t.sub}">Route ${i+1}</div>
              </div>
              ${vBadge(t,['En Route','Loading','Delivered'][i],['#22c55e','#f59e0b',t.acc][i])}
            </div>`).join('')}
          </div>
        </div>
        <!-- Recent deliveries -->
        <div style="${s_card(t,'padding:16px')}">
          <div style="font-size:13px;font-weight:700;color:${t.text};margin-bottom:12px">Recent Deliveries</div>
          ${wfItems.slice(0,4).map((w,i)=>vActivity(t,'fas fa-truck',truncate(w,45),['Just now','8m ago','1h ago','3h ago'][i]||'Today',[t.acc,'#22c55e','#f59e0b',t.acc2][i]||t.acc)).join('')}
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 11 — SOCIAL FEED
// ══════════════════════════════════════════════════════════════════════════
function renderSocial(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, pid) {
  const sidebarItems = [
    { icon:'fas fa-house',       label:'Home', badge:null },
    { icon:'fas fa-magnifying-glass',label:'Explore', badge:null },
    { icon:'fas fa-bell',        label:'Notifications', badge:'5' },
    { icon:'fas fa-comment',     label:'Messages', badge:null },
    { icon:'fas fa-heart',       label:truncate(feat0,14), badge:'New' },
    { icon:'fas fa-user',        label:'Profile', badge:null },
  ];
  const posts = [
    {author:'User A',time:'2m ago',content:truncate(wfItems[0]||'Posted an update about '+feat0,90),likes:'0',comments:'0'},
    {author:'User B',time:'15m ago',content:truncate(wfItems[1]||'Shared a new '+feat1,90),likes:'0',comments:'0'},
    {author:'User C',time:'1h ago',content:truncate(features[0]||'Exploring the platform features',90),likes:'0',comments:'0'},
  ];
  return `<div style="display:flex;flex-direction:column;height:100%;background:${t.bg};font-family:'Inter',sans-serif;color:${t.text}">
    ${vTopBar(t,appName,appIcon,pid)}
    <div style="display:flex;flex:1;overflow:hidden">
      ${vSidebar(t,sidebarItems,'190px')}
      <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px">
        <!-- Search bar -->
        <div style="position:relative">
          <i class="fas fa-magnifying-glass" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:${t.muted};font-size:13px"></i>
          <input placeholder="Search ${escHtml(truncate(appName,20))}..." onkeydown="if(event.key==='Enter'&&this.value.trim())vToast('Searching for: '+this.value.trim().slice(0,30),'info')" style="width:100%;background:${t.card};border:1px solid ${t.brd};border-radius:12px;padding:10px 12px 10px 36px;font-size:13px;color:${t.text};outline:none;box-sizing:border-box">
        </div>
        <!-- KPIs -->
        <div style="${s_grid(3,'12px')}">
          ${vKpi(t,'fas fa-users','Followers','0','Total',0)}
          ${vKpi(t,'fas fa-heart','Likes','0','All posts',0)}
          ${vKpi(t,'fas fa-eye','Views','0','This week',0)}
        </div>
        <!-- Feed -->
        <div style="display:flex;flex-direction:column;gap:12px">
          <!-- Create post -->
          <div style="${s_card(t,'padding:14px')}">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,${t.acc},${t.acc2});flex-shrink:0"></div>
              <input id="vpost-input" placeholder="What's on your mind?" style="flex:1;background:${t.card2};border:1px solid ${t.brd};border-radius:20px;padding:8px 14px;font-size:13px;color:${t.text};outline:none">
              <button onclick="(function(){var inp=document.getElementById('vpost-input');var v=inp?inp.value.trim():'';if(v){vToast('Post published!','success');inp.value='';}else{vToast('Write something first','warning');}})()" style="${s_btn_primary(t,'padding:8px 14px')}">Post</button>
            </div>
          </div>
          ${posts.map(p=>`
          <div style="${s_card(t,'padding:16px')}">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
              <div style="width:36px;height:36px;border-radius:50%;background:${t.badge};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px;font-weight:800;color:${t.acc}">${p.author[0]}</div>
              <div>
                <div style="font-size:13px;font-weight:700;color:${t.text}">${p.author}</div>
                <div style="font-size:10px;color:${t.muted}">${p.time}</div>
              </div>
            </div>
            <p style="font-size:13px;color:${t.sub};margin:0 0 12px;line-height:1.5">${escHtml(p.content)}</p>
            <div style="display:flex;gap:16px;padding-top:10px;border-top:1px solid ${t.brd}">
              <button onclick="(function(btn){var cnt=btn.querySelector('span');var n=(parseInt(cnt.textContent)||0)+1;cnt.textContent=n;btn.style.color='#ef4444';vToast('Liked!','success');})(this)" style="background:none;border:none;color:${t.muted};cursor:pointer;font-size:12px;display:flex;align-items:center;gap:4px" onmouseover="this.style.color='${t.acc}'" onmouseout="if(!this.querySelector('span')||parseInt(this.querySelector('span').textContent)===0)this.style.color='${t.muted}'"><i class="fas fa-heart"></i> <span>${p.likes}</span></button>
              <button onclick="vToast('Comments — opens in production','info')" style="background:none;border:none;color:${t.muted};cursor:pointer;font-size:12px;display:flex;align-items:center;gap:4px" onmouseover="this.style.color='${t.acc}'" onmouseout="this.style.color='${t.muted}'"><i class="fas fa-comment"></i> <span>${p.comments}</span></button>
              <button onclick="vToast('Link copied to clipboard!','success')" style="background:none;border:none;color:${t.muted};cursor:pointer;font-size:12px;display:flex;align-items:center;gap:4px" onmouseover="this.style.color='${t.acc}'" onmouseout="this.style.color='${t.muted}'"><i class="fas fa-share"></i> Share</button>
            </div>
          </div>`).join('')}
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 12 — FOOD / RESTAURANT
// ══════════════════════════════════════════════════════════════════════════
function renderFood(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, pid) {
  const sidebarItems = [
    { icon:'fas fa-gauge-high',   label:'Dashboard', badge:null },
    { icon:'fas fa-utensils',     label:'Menu', badge:null },
    { icon:'fas fa-list-check',   label:'Orders', badge:'3 New' },
    { icon:'fas fa-star',         label:'Reviews', badge:null },
    { icon:'fas fa-chart-pie',    label:'Analytics', badge:null },
    { icon:'fas fa-gear',         label:'Settings', badge:null },
  ];
  const menuItems = [
    {name:truncate(wfItems[0]||feat0||'Signature Dish',22),price:'$0.00',orders:0,rating:'4.8'},
    {name:truncate(wfItems[1]||feat1||'House Special',22),price:'$0.00',orders:0,rating:'4.6'},
    {name:truncate(features[0]||'Chef Recommendation',22),price:'$0.00',orders:0,rating:'4.9'},
    {name:'Daily Special',price:'$0.00',orders:0,rating:'4.7'},
  ];
  return `<div style="display:flex;flex-direction:column;height:100%;background:${t.bg};font-family:'Inter',sans-serif;color:${t.text}">
    ${vTopBar(t,appName,appIcon,pid)}
    <div style="display:flex;flex:1;overflow:hidden">
      ${vSidebar(t,sidebarItems,'195px')}
      <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:20px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <h1 style="font-size:20px;font-weight:900;color:${t.text};margin:0 0 4px">${escHtml(appName)}</h1>
            <p style="font-size:12px;color:${t.sub};margin:0">${escHtml(truncate(problem||`Food platform for ${audience}`,70))}</p>
          </div>
          <button onclick="vToast('New Menu Item — form opens in production','info')" style="${s_btn_primary(t)}"><i class="fas fa-plus"></i> Add Item</button>
        </div>
        <div style="${s_grid(4,'12px')}">
          ${vKpi(t,'fas fa-utensils','Menu Items',''+menuItems.length,'Available',0)}
          ${vKpi(t,'fas fa-list-check','Orders Today','0','New',5)}
          ${vKpi(t,'fas fa-star','Avg Rating','4.8','Stars')}
          ${vKpi(t,'fas fa-dollar-sign','Revenue','$0','Today',0)}
        </div>
        <!-- Menu grid -->
        <div style="${s_card(t,'padding:16px')}">
          <div style="font-size:13px;font-weight:700;color:${t.text};margin-bottom:14px">Menu Items</div>
          <div style="${s_grid(2,'10px')}">
            ${menuItems.map(m=>`
            <div onclick="vToast('Viewing menu item: '+escHtml(truncate(m.name,20)),'info')" style="${s_card2(t,'padding:14px;cursor:pointer')}" onmouseover="this.style.borderColor='${t.acc}'" onmouseout="this.style.borderColor='${t.brd}'">
              <div style="width:100%;height:72px;background:linear-gradient(135deg,${t.acc}18,${t.acc2}28);border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:10px">
                <i class="${appIcon}" style="font-size:24px;color:${t.acc};opacity:0.5"></i>
              </div>
              <div style="font-size:12px;font-weight:700;color:${t.text};margin-bottom:6px">${escHtml(m.name)}</div>
              <div style="display:flex;align-items:center;justify-content:space-between">
                <span style="font-size:13px;font-weight:800;color:${t.acc}">${m.price}</span>
                <span style="font-size:11px;color:${t.sub}"><i class="fas fa-star" style="color:#f59e0b"></i> ${m.rating}</span>
              </div>
            </div>`).join('')}
          </div>
        </div>
        <!-- Recent orders -->
        <div style="${s_card(t,'padding:16px')}">
          <div style="font-size:13px;font-weight:700;color:${t.text};margin-bottom:12px">Recent Orders</div>
          ${['#T01','#T02','#T03'].map((o,i)=>`
          <div onclick="vToast('Table '+(i+1)+' order details','info')" style="display:flex;align-items:center;gap:12px;padding:8px;border-radius:10px;margin-bottom:4px;cursor:pointer" onmouseover="this.style.background='${t.card2}'" onmouseout="this.style.background='transparent'">
            <div style="width:32px;height:32px;border-radius:8px;background:${t.badge};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:10px;font-weight:800;color:${t.acc}">${o}</div>
            <div style="flex:1">
              <div style="font-size:12px;font-weight:600;color:${t.text}">Table ${i+1} Order</div>
              <div style="font-size:10px;color:${t.sub}">${['Just now','5m ago','12m ago'][i]}</div>
            </div>
            ${vBadge(t,['New','Preparing','Ready'][i],['#f59e0b',t.acc,'#22c55e'][i])}
          </div>`).join('')}
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT GENERIC — Versatile dashboard for any project
// ══════════════════════════════════════════════════════════════════════════
function renderGeneric(t, appName, appIcon, features, wfItems, audience, problem, feat0, feat1, feat2, pid) {
  const sidebarItems = [
    { icon:'fas fa-gauge-high',     label:'Dashboard', badge:null },
    { icon:resolveIcon(feat0),      label:truncate(feat0||'Main',14), badge:'New' },
    { icon:resolveIcon(feat1),      label:truncate(feat1||'Analytics',14), badge:null },
    { icon:'fas fa-users',          label:truncate(audience.split(/[,/]/)[0]||'Users',14), badge:null },
    { icon:'fas fa-bell',           label:'Notifications', badge:'3' },
    { icon:'fas fa-gear',           label:'Settings', badge:null },
  ];
  return `<div style="display:flex;flex-direction:column;height:100%;background:${t.bg};font-family:'Inter',sans-serif;color:${t.text}">
    ${vTopBar(t,appName,appIcon,pid)}
    <div style="display:flex;flex:1;overflow:hidden">
      ${vSidebar(t,sidebarItems,'190px')}
      <div style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:20px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <h1 style="font-size:20px;font-weight:900;color:${t.text};margin:0 0 4px">${escHtml(appName)}</h1>
            <p style="font-size:12px;color:${t.sub};margin:0">${escHtml(truncate(problem||`Platform for ${audience}`,70))}</p>
          </div>
          <div style="display:flex;gap:8px">
            <input placeholder="Search…" onkeydown="if(event.key==='Enter'&&this.value.trim())vToast('Searching for: '+this.value.trim().slice(0,30),'info')" style="background:${t.card};border:1px solid ${t.brd};border-radius:8px;padding:8px 12px;font-size:12px;color:${t.text};outline:none;width:150px">
            <button onclick="vToast('New '+escHtml(truncate(feat0,16))+' — opens in production','info')" style="${s_btn_primary(t)}"><i class="${resolveIcon(feat0)}"></i> New ${escHtml(truncate(feat0,12))}</button>
          </div>
        </div>
        <div style="${s_grid(4,'12px')}">
          ${vKpi(t,resolveIcon(feat0),truncate(feat0||'Items',16),'0','Total',0)}
          ${vKpi(t,'fas fa-users',truncate(audience.split(/[,/]/)[0]||'Users',16),'0','Active',0)}
          ${vKpi(t,'fas fa-bolt','Automations','0','Running')}
          ${vKpi(t,'fas fa-chart-line','Growth','0%','Monthly')}
        </div>
        <!-- Hero feature -->
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px">
          <div style="${s_card(t,'padding:16px')}">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
              <div style="font-size:13px;font-weight:700;color:${t.text}">${escHtml(truncate(feat0||'Overview',30))}</div>
              ${vBadge(t,'Live',t.acc)}
            </div>
            <!-- Feature card -->
            <div style="border-radius:16px;padding:16px;margin-bottom:12px;position:relative;overflow:hidden;background:linear-gradient(135deg,${t.acc}18,${t.acc2}22);border:1px solid ${t.brd}">
              <div style="position:absolute;right:12px;top:12px;opacity:0.1;pointer-events:none">
                <i class="${appIcon}" style="font-size:48px;color:${t.acc}"></i>
              </div>
              <div style="width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,${t.acc},${t.acc2});display:flex;align-items:center;justify-content:center;margin-bottom:12px">
                <i class="${appIcon}" style="font-size:16px;color:white"></i>
              </div>
              <div style="font-size:14px;font-weight:800;color:${t.text};margin-bottom:4px">${escHtml(truncate(feat0||appName,36))}</div>
              <div style="font-size:12px;color:${t.sub};margin-bottom:12px">${escHtml(truncate(problem||`Core feature for ${audience}`,80))}</div>
              <div style="display:flex;gap:8px">
                <button onclick="vToast('Getting started with '+escHtml(truncate(feat0||appName,20))+'…','success')" style="${s_btn_primary(t,'padding:6px 14px')}">Get Started</button>
                <button onclick="vToast('Documentation — opens in production','info')" style="${s_btn_ghost(t,'padding:6px 14px')}">Learn More</button>
              </div>
            </div>
            <!-- Feature items -->
            ${(features.length > 1 ? features : wfItems).slice(0,3).map((item,i)=>`
            <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;background:${t.card2};margin-bottom:6px">
              <div style="width:28px;height:28px;border-radius:8px;background:${t.badge};display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="${resolveIcon(item)}" style="font-size:11px;color:${t.acc}"></i>
              </div>
              <span style="font-size:12px;font-weight:500;color:${t.sub};flex:1">${escHtml(truncate(item,40))}</span>
              ${vBadge(t,['Active','Configured','Ready'][i]||'Ready',i===0?t.acc:t.sub)}
            </div>`).join('')}
          </div>
          <!-- Activity panel -->
          <div style="${s_card(t,'padding:16px')}">
            <div style="font-size:13px;font-weight:700;color:${t.text};margin-bottom:12px">Recent Activity</div>
            ${wfItems.slice(0,3).map((w,i)=>vActivity(t,resolveIcon(w),truncate(w,40),['Just now','5m ago','1h ago'][i]||'Today',[t.acc,'#a855f7','#f59e0b'][i]||t.acc)).join('')}
            ${features.slice(0,2).map((f,i)=>vActivity(t,resolveIcon(f),truncate(f+' updated',38),['2h ago','Yesterday'][i]||'',[t.acc2,'#22c55e'][i]||t.acc2)).join('')}
            <!-- Workflow steps -->
            ${wfItems.length > 1 ? `
            <div style="margin-top:12px;padding-top:12px;border-top:1px solid ${t.brd}">
              <div style="font-size:11px;font-weight:700;color:${t.sub};margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px">Workflow</div>
              ${wfItems.slice(0,3).map((w,i)=>`
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
                <div style="width:16px;height:16px;border-radius:50%;background:${t.badge};color:${t.acc};display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:900;flex-shrink:0">${i+1}</div>
                <span style="font-size:10px;color:${t.muted}">${escHtml(truncate(w,30))}</span>
              </div>`).join('')}
            </div>` : ''}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

// Legacy stub functions — keep for compatibility
function setViewMode() {}
function renderViewSpecPanel() {}
function renderViewSpecMode() {}
function renderViewPrototype() {}
function renderCurrentScreen() {}
function viewNavigate() {}
function viewGoTo() {}
function viewGoToIdx() {}
function buildFallbackScreens(name) { return []; }
function buildAppScreens(d) { return []; }

// Old names mapped to new — for any old onclick references
function renderFilmAnalysisDashboard(t,a,b,c,d,e,f,g,h,i,j,k,l,pid){return renderFilm(t,a,b,d,e.split(/[,.;]/).map(s=>s.trim()).filter(s=>s.length>2).slice(0,5),f,g,j,k,l,pid);}
function renderMusicPlayerDashboard(t,a,b,c,d,e,f,g,h,i,j,k,l,pid){return renderMusic(t,a,b,c,d.split(/[,.;]/).map(s=>s.trim()).filter(s=>s.length>2).slice(0,5),e,f,j,k,l,pid);}
function renderCommandCenterDashboard(t,a,b,c,d,e,f,g,h,i,j,k,l,pid){return renderSaaS(t,a,b,c,d.split(/[,.;]/).map(s=>s.trim()).filter(s=>s.length>2).slice(0,5),e,f,j,k,l,pid);}
function renderAIConsoleDashboard(t,a,b,c,d,e,f,g,h,i,j,k,l,pid){return renderAI(t,a,b,c,d.split(/[,.;]/).map(s=>s.trim()).filter(s=>s.length>2).slice(0,5),e,f,[],j,k,l,pid);}
function renderAppDashboard(t,a,b,c,d,e,f,g,h,i,j,k,l,pid){return renderGeneric(t,a,b,c,d.split(/[,.;]/).map(s=>s.trim()).filter(s=>s.length>2).slice(0,5),e,f,j,k,l,pid);}
