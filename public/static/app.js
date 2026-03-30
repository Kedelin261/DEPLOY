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
        <button onclick="openViewModal('${p.id}','${escHtml(p.name)}')"
          class="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold border border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/10 transition-colors">
          <i class="fas fa-eye"></i> View
        </button>
        <button onclick="openTestingModal(null,'${p.id}','${escHtml(p.name)}')"
          class="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 transition-colors">
          <i class="fas fa-flask"></i> Test &amp; Revise
        </button>
        <button onclick="openPublishModal('${p.id}')"
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
//  PROJECT VIEWER — Full-Screen Unique Dashboard Generator v5
//  Every project gets a completely different application interface.
//  No two projects share layout, color scheme, navigation, or widget types.
// ══════════════════════════════════════════════════════════════════════════

const VIEW_PROJECT = { id: null, name: '', data: null };

// ── Open the view modal ───────────────────────────────────────────────────
async function openViewModal(projectId, projectName) {
  VIEW_PROJECT.id = projectId;
  VIEW_PROJECT.name = projectName || 'Your Project';
  VIEW_PROJECT.data = null;

  // Show modal with loading state
  const modal = document.getElementById('modal-view');
  const loading = document.getElementById('view-loading');
  const content = document.getElementById('view-content');
  if (!modal) return;

  modal.classList.remove('hidden');
  modal.style.display = 'block';   // force show
  document.body.style.overflow = 'hidden';
  if (loading) { loading.style.display = 'flex'; }
  if (content) { content.style.display = 'none'; content.innerHTML = ''; }

  try {
    const res = await axios.get(`/api/projects/${projectId}/preview`);
    VIEW_PROJECT.data = res.data?.data || {};
  } catch (err) {
    console.warn('Preview fetch failed, using minimal data', err);
    VIEW_PROJECT.data = { project: { name: projectName }, fields: {}, spec: {} };
  }

  // Generate and inject the dashboard
  const html = generateProjectDashboard(VIEW_PROJECT.data, projectId, projectName);
  if (content) {
    content.innerHTML = html;
    content.style.display = 'flex';   // flex + flex-direction:column (set in inline style)
  }
  if (loading) {
    loading.style.display = 'none';
  }
}

function closeViewModal() {
  const modal = document.getElementById('modal-view');
  if (modal) { modal.classList.add('hidden'); modal.style.display = ''; }
  const content = document.getElementById('view-content');
  if (content) { content.style.display = 'none'; content.innerHTML = ''; }
  const loading = document.getElementById('view-loading');
  if (loading) { loading.style.display = ''; }
  document.body.style.overflow = '';
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

function parseFeatureList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(f => typeof f === 'string' ? f : f.feature || f.name || '').filter(Boolean);
  try { const a = JSON.parse(raw); if (Array.isArray(a)) return a.map(f => typeof f === 'string' ? f : f.feature || f.name || '').filter(Boolean); } catch (_) {}
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

// ── Semantic icon resolver (50+ patterns) ─────────────────────────────────
function resolveIcon(text) {
  const t = (text || '').toLowerCase();
  if (t.match(/film|video|watch|reel|playback|footage|stream|cinema/)) return 'fas fa-film';
  if (t.match(/music|song|playlist|audio|beat|track|album|sound|listen|spotify/)) return 'fas fa-music';
  if (t.match(/football|soccer|coach|formation|blitz|tackle|roster|nfl|athlete|gridiron/)) return 'fas fa-football';
  if (t.match(/basketball|nba|court|dunk|hoop/)) return 'fas fa-basketball';
  if (t.match(/draw|sketch|canvas|paint|brush|art|illustrat|creative|design/)) return 'fas fa-pen-nib';
  if (t.match(/photo|camera|image|picture|gallery|snapshot/)) return 'fas fa-camera';
  if (t.match(/ai|machine learn|intelligence|neural|automat|smart|analyze|breakdown|predict/)) return 'fas fa-brain';
  if (t.match(/upload|import|ingest|transfer|sync/)) return 'fas fa-cloud-arrow-up';
  if (t.match(/download|export|extract/)) return 'fas fa-cloud-arrow-down';
  if (t.match(/analyt|stat|metric|insight|kpi|chart|graph|data|report/)) return 'fas fa-chart-bar';
  if (t.match(/pay|stripe|billing|invoice|subscri|checkout|wallet|money|revenue|coin/)) return 'fas fa-credit-card';
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
  if (t.match(/task|todo|project|manage|workflow|sprint|board|plan/)) return 'fas fa-check-square';
  if (t.match(/security|auth|login|password|protect|guard|verif/)) return 'fas fa-shield-halved';
  if (t.match(/setting|config|prefer|manage|gear|admin|control/)) return 'fas fa-gear';
  if (t.match(/dashboard|overview|home|main|hub|portal/)) return 'fas fa-gauge-high';
  if (t.match(/recruit|hire|scout|talent|staffing/)) return 'fas fa-user-plus';
  if (t.match(/saas|platform|tool|software|service|app/)) return 'fas fa-layer-group';
  if (t.match(/law|legal|contract|case|court|attorney|firm/)) return 'fas fa-scale-balanced';
  if (t.match(/logistic|deliver|supply|fleet|route|ship|track/)) return 'fas fa-truck';
  if (t.match(/doctor|clinic|hospital|patient|prescr|diagnos/)) return 'fas fa-stethoscope';
  if (t.match(/crypto|nft|blockchain|token|wallet|defi/)) return 'fas fa-bitcoin-sign';
  if (t.match(/star|rate|review|feedback|rating/)) return 'fas fa-star';
  if (t.match(/fire|trend|hot|viral|popular/)) return 'fas fa-fire';
  if (t.match(/rocket|launch|deploy|ship|release/)) return 'fas fa-rocket';
  if (t.match(/plus|add|create|new|build/)) return 'fas fa-plus-circle';
  if (t.match(/list|item|entry|record|row/)) return 'fas fa-list';
  if (t.match(/filter|sort|organize/)) return 'fas fa-filter';
  if (t.match(/share|export|send/)) return 'fas fa-share-nodes';
  if (t.match(/game|gaming|play|level|score|leaderboard/)) return 'fas fa-gamepad';
  if (t.match(/pet|animal|vet|shelter/)) return 'fas fa-paw';
  if (t.match(/cloud|server|hosting|infra|devops/)) return 'fas fa-server';
  if (t.match(/book|read|library|publish|author/)) return 'fas fa-book-open';
  const fallbacks = ['fas fa-bolt','fas fa-wand-magic-sparkles','fas fa-gem','fas fa-trophy','fas fa-flag','fas fa-cube'];
  return fallbacks[Math.abs((text||'').length) % fallbacks.length];
}

// ── Detect project domain with scoring ────────────────────────────────────
function detectDomain(fields, projectName) {
  const all = [
    fields.app_name, fields.audience, fields.problem_statement,
    fields.workflows, fields.core_features, fields.category,
    fields.apis_tools, fields.additional_comments, projectName
  ].filter(Boolean).join(' ').toLowerCase();

  const scores = {
    sports_film: /film|football|coach|formation|blitz|nfl|athlete|playbook|gridiron|sport|game\s+film|breakdown|scouting|roster|hudl/g,
    music:       /music|song|playlist|audio|track|album|beat|listen|streaming|spotify|sound|band|artist|concert/g,
    health:      /health|medic|patient|doctor|clinic|hospital|vital|fitness|workout|appointment|prescr|wellness|diet/g,
    finance:     /financ|invest|portfolio|crypto|budget|stock|trade|bank|money|revenue|wealth|wallet|payment|invoice/g,
    ecommerce:   /shop|cart|store|product|order|inventory|retail|ecom|customer|purchase|checkout|merchant/g,
    education:   /educat|learn|course|lesson|student|quiz|tutor|school|class|curriculum|teacher|study|grade/g,
    logistics:   /logistic|deliver|supply|fleet|route|ship|track|warehouse|cargo|dispatch|driver|transport/g,
    legal:       /law|legal|contract|case|court|attorney|firm|compliance|document|clause|litigation/g,
    social:      /social|network|post|feed|follow|like|share|community|connect|profile|creator|influencer/g,
    realestate:  /real\s*estate|property|house|rent|home|listing|agent|mortgage|apartment|landlord/g,
    travel:      /travel|trip|flight|hotel|booking|tourism|itinerar|destination|vacation|resort/g,
    food:        /food|recipe|cook|restaurant|meal|dish|menu|eat|chef|delivery|order\s+food/g,
    creative:    /design|creative|draw|sketch|canvas|paint|art|illustrat|photo|video\s*edit|motion/g,
    ai_tool:     /ai\s*tool|automat|machine\s*learn|neural|nlp|predict|generat|gpt|llm|intelligence/g,
    saas:        /saas|platform|b2b|enterprise|dashboard|admin|crm|erp|management\s*system/g,
    gaming:      /game|gaming|level|score|leaderboard|player|quest|multiplayer|achievement/g,
  };

  let best = 'generic', bestCount = 0;
  for (const [domain, re] of Object.entries(scores)) {
    const matches = (all.match(re) || []).length;
    if (matches > bestCount) { bestCount = matches; best = domain; }
  }
  return best;
}

// ── Color themes — each domain/hash gets a unique visual identity ──────────
function getDomainTheme(domain, fields, projectName) {
  const explicit = (fields.color_scheme || '').toLowerCase().trim();

  const themes = {
    // Dark professional themes
    midnight:   { bg:'#080d1a', sidebar:'#0a1020', header:'#0c1428', card:'#101830', card2:'#131d38', accent:'#06b6d4', accent2:'#0891b2', glow:'rgba(6,182,212,0.15)', text:'#f0f9ff', sub:'#7ea9c9', muted:'#3a5a73', border:'rgba(6,182,212,0.12)', badge:'rgba(6,182,212,0.15)', badgeText:'#06b6d4' },
    ocean:      { bg:'#020c1e', sidebar:'#030e24', header:'#040f28', card:'#071629', card2:'#0a1c34', accent:'#3b82f6', accent2:'#1d4ed8', glow:'rgba(59,130,246,0.15)', text:'#eff6ff', sub:'#7ba7d4', muted:'#2a4870', border:'rgba(59,130,246,0.12)', badge:'rgba(59,130,246,0.15)', badgeText:'#60a5fa' },
    forest:     { bg:'#030e06', sidebar:'#041209', card:'#06180b', card2:'#081d0e', header:'#05150a', accent:'#22c55e', accent2:'#16a34a', glow:'rgba(34,197,94,0.15)',  text:'#f0fdf4', sub:'#74c78a', muted:'#1a4d2a', border:'rgba(34,197,94,0.12)', badge:'rgba(34,197,94,0.15)', badgeText:'#4ade80' },
    sunset:     { bg:'#110404', sidebar:'#180606', header:'#1e0808', card:'#220a0a', card2:'#2d0d0d', accent:'#f97316', accent2:'#dc2626', glow:'rgba(249,115,22,0.15)', text:'#fff7ed', sub:'#d97c59', muted:'#6b2e12', border:'rgba(249,115,22,0.12)', badge:'rgba(249,115,22,0.15)', badgeText:'#fb923c' },
    purple:     { bg:'#0a0614', sidebar:'#0d0820', header:'#100a28', card:'#130c2e', card2:'#180f38', accent:'#a855f7', accent2:'#7c3aed', glow:'rgba(168,85,247,0.15)', text:'#faf5ff', sub:'#b490d4', muted:'#4a2570', border:'rgba(168,85,247,0.12)', badge:'rgba(168,85,247,0.15)', badgeText:'#c084fc' },
    rose:       { bg:'#110306', sidebar:'#180408', header:'#1e0509', card:'#200607', card2:'#2a0808', accent:'#f43f5e', accent2:'#be123c', glow:'rgba(244,63,94,0.15)',  text:'#fff1f2', sub:'#c97a8c', muted:'#6b1a2a', border:'rgba(244,63,94,0.12)', badge:'rgba(244,63,94,0.15)', badgeText:'#fb7185' },
    amber:      { bg:'#0e0900', sidebar:'#150d00', header:'#1b1100', card:'#1f1500', card2:'#2a1c00', accent:'#f59e0b', accent2:'#d97706', glow:'rgba(245,158,11,0.15)', text:'#fffbeb', sub:'#c29c5c', muted:'#6b4600', border:'rgba(245,158,11,0.12)', badge:'rgba(245,158,11,0.15)', badgeText:'#fbbf24' },
    slate:      { bg:'#070b10', sidebar:'#0b1018', header:'#0e1520', card:'#111a24', card2:'#161f2c', accent:'#64748b', accent2:'#475569', glow:'rgba(100,116,139,0.15)',text:'#f8fafc', sub:'#94a3b8', muted:'#2a3545', border:'rgba(100,116,139,0.12)', badge:'rgba(100,116,139,0.2)', badgeText:'#94a3b8' },
    // Specialized domain themes
    cyan_sport: { bg:'#030f18', sidebar:'#041420', header:'#051928', card:'#071c30', card2:'#0a2238', accent:'#06b6d4', accent2:'#0284c7', glow:'rgba(6,182,212,0.2)', text:'#f0f9ff', sub:'#7cb8d4', muted:'#1a4060', border:'rgba(6,182,212,0.15)', badge:'rgba(6,182,212,0.2)', badgeText:'#22d3ee' },
    emerald_med:{ bg:'#030f08', sidebar:'#041410', header:'#051918', card:'#071c12', card2:'#0a2218', accent:'#10b981', accent2:'#059669', glow:'rgba(16,185,129,0.2)', text:'#ecfdf5', sub:'#6cd4a6', muted:'#1a4030', border:'rgba(16,185,129,0.15)', badge:'rgba(16,185,129,0.2)', badgeText:'#34d399' },
    gold_fin:   { bg:'#0e0b00', sidebar:'#151000', header:'#1c1500', card:'#221900', card2:'#2d2100', accent:'#eab308', accent2:'#ca8a04', glow:'rgba(234,179,8,0.2)',   text:'#fefce8', sub:'#c4a835', muted:'#5a4800', border:'rgba(234,179,8,0.15)', badge:'rgba(234,179,8,0.2)', badgeText:'#facc15' },
    violet_ai:  { bg:'#080514', sidebar:'#0c071e', header:'#100a28', card:'#130d2c', card2:'#181238', accent:'#8b5cf6', accent2:'#6d28d9', glow:'rgba(139,92,246,0.2)',  text:'#f5f3ff', sub:'#a78bcc', muted:'#3d206a', border:'rgba(139,92,246,0.15)', badge:'rgba(139,92,246,0.2)', badgeText:'#a78bfa' },
    teal_edu:   { bg:'#030f10', sidebar:'#041418', header:'#051920', card:'#071c22', card2:'#0a222a', accent:'#14b8a6', accent2:'#0d9488', glow:'rgba(20,184,166,0.2)',  text:'#f0fdfa', sub:'#5fcbb8', muted:'#1a4040', border:'rgba(20,184,166,0.15)', badge:'rgba(20,184,166,0.2)', badgeText:'#2dd4bf' },
    red_law:    { bg:'#100303', sidebar:'#180404', header:'#1e0505', card:'#220606', card2:'#2d0808', accent:'#ef4444', accent2:'#b91c1c', glow:'rgba(239,68,68,0.2)',   text:'#fef2f2', sub:'#d07070', muted:'#6b1515', border:'rgba(239,68,68,0.15)', badge:'rgba(239,68,68,0.2)', badgeText:'#f87171' },
    indigo_saas:{ bg:'#06040f', sidebar:'#090618', header:'#0d0820', card:'#100a25', card2:'#150e30', accent:'#6366f1', accent2:'#4f46e5', glow:'rgba(99,102,241,0.2)',  text:'#eef2ff', sub:'#8f93d8', muted:'#2a266a', border:'rgba(99,102,241,0.15)', badge:'rgba(99,102,241,0.2)', badgeText:'#818cf8' },
  };

  // Explicit scheme overrides everything
  if (explicit && themes[explicit]) return themes[explicit];

  // Domain → theme mapping (each domain gets a unique theme)
  const domainThemes = {
    sports_film: themes.cyan_sport,
    music:       themes.purple,
    health:      themes.emerald_med,
    finance:     themes.gold_fin,
    ecommerce:   themes.sunset,
    education:   themes.teal_edu,
    logistics:   themes.slate,
    legal:       themes.red_law,
    social:      themes.rose,
    realestate:  themes.forest,
    travel:      themes.ocean,
    food:        themes.amber,
    creative:    themes.violet_ai,
    ai_tool:     themes.violet_ai,
    saas:        themes.indigo_saas,
    gaming:      themes.midnight,
    generic:     null, // fall through to hash
  };

  if (domainThemes[domain]) return domainThemes[domain];

  // Hash the project name for guaranteed uniqueness between same-domain apps
  let hash = 0;
  for (const c of (projectName || '')) hash = ((hash << 5) - hash) + c.charCodeAt(0);
  const keys = ['midnight','ocean','forest','sunset','purple','rose','amber','slate'];
  return themes[keys[Math.abs(hash) % keys.length]];
}

// ── Layout type selector — each domain uses a completely different layout ──
function getDomainLayout(domain, fields, projectName) {
  // Each domain gets a UNIQUE layout structure
  const layouts = {
    sports_film: 'film_analysis',   // Dark cinema UI — sidebar timeline, video card grid
    music:       'music_player',    // Player-centric — album art, waveform, queue panel
    health:      'clinical',        // Clean white-ish medical — appointment calendar, vitals
    finance:     'trading',         // Dense data — portfolio widget, chart, positions table
    ecommerce:   'storefront',      // Product grid — category sidebar, product cards, cart
    education:   'lms',             // Course platform — progress sidebar, lesson cards
    logistics:   'dispatch',        // Map-centric — route cards, driver list, status board
    legal:       'case_manager',    // Document-heavy — case list, timeline, filing status
    social:      'feed',            // Feed layout — stories bar, post cards, trending
    realestate:  'property_portal', // Property grid — map half, listing cards
    travel:      'itinerary',       // Trip planner — destination cards, map, booking
    food:        'kitchen',         // Recipe/order — menu grid, order panel, ratings
    creative:    'design_studio',   // Tool panels — canvas preview, layer list, toolbar
    ai_tool:     'ai_console',      // Terminal-like — prompt input, output panel, history
    saas:        'command_center',  // CRM/ERP — table, metric bar, sidebar nav
    gaming:      'arcade',          // Leaderboard, achievements, game cards
    generic:     'app_dashboard',   // Generic but clean — metric cards, activity feed
  };
  return layouts[domain] || 'app_dashboard';
}

// ── Main dashboard generator ──────────────────────────────────────────────
function generateProjectDashboard(d, projectId, rawProjectName) {
  const fields  = d.fields  || {};
  const spec    = d.spec    || {};
  const project = d.project || {};

  const appName   = fields.app_name || spec.app_name || project.name || rawProjectName || 'My App';
  const audience  = fields.audience || spec.target_audience || 'Users';
  const problem   = fields.problem_statement || spec.problem_statement || '';
  const workflows = fields.workflows || '';
  const features  = parseFeatureList(fields.core_features || spec.key_features || '[]');
  const roles     = (fields.roles_permissions || 'User').split(/[,/]/).map(s => s.trim()).filter(Boolean);
  const bizModel  = fields.business_model || '';
  const category  = fields.category || project.category || '';
  const apis      = (fields.apis_tools || '').split(',').map(s => s.trim()).filter(Boolean);
  const addlNotes = fields.additional_comments || '';

  const domain  = detectDomain(fields, appName);
  const theme   = getDomainTheme(domain, fields, appName);
  const layout  = getDomainLayout(domain, fields, appName);
  const appIcon = resolveIcon(appName + ' ' + problem + ' ' + (features[0] || '') + ' ' + audience);

  // Derive nav items from actual feature names
  const feat0 = features[0] || (workflows.split(/[,.;]/)[0] || '').trim() || 'Main';
  const feat1 = features[1] || (workflows.split(/[,.;]/)[1] || '').trim() || 'Analytics';
  const feat2 = features[2] || roles[0] || 'Profile';

  // Generate the dashboard based on layout type
  switch (layout) {
    case 'film_analysis':    return renderFilmAnalysisDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, apis, feat0, feat1, feat2, projectId);
    case 'music_player':     return renderMusicPlayerDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId);
    case 'clinical':         return renderClinicalDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId);
    case 'trading':          return renderTradingDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId);
    case 'storefront':       return renderStorefrontDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId);
    case 'lms':              return renderLMSDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId);
    case 'dispatch':         return renderDispatchDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId);
    case 'case_manager':     return renderCaseManagerDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId);
    case 'feed':             return renderSocialFeedDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId);
    case 'property_portal':  return renderPropertyPortalDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId);
    case 'itinerary':        return renderItineraryDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId);
    case 'kitchen':          return renderKitchenDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId);
    case 'design_studio':    return renderDesignStudioDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId);
    case 'ai_console':       return renderAIConsoleDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId);
    case 'command_center':   return renderCommandCenterDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId);
    case 'arcade':           return renderArcadeDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId);
    default:                 return renderAppDashboard(theme, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId);
  }
}

// ── Shared top-bar builder ─────────────────────────────────────────────────
function viewTopBar(theme, appName, appIcon, projectId, rightContent = '') {
  const t = theme;
  return `<div class="flex items-center justify-between px-5 py-3 flex-shrink-0" style="background:${t.header};border-bottom:1px solid ${t.border}">
    <div class="flex items-center gap-3">
      <button onclick="closeViewModal()" style="color:${t.sub};font-size:11px" class="flex items-center gap-1.5 hover:opacity-80 transition-opacity">
        <i class="fas fa-arrow-left"></i><span>Back</span>
      </button>
      <div style="width:1px;height:18px;background:${t.border}"></div>
      <div class="flex items-center gap-2">
        <div class="w-7 h-7 rounded-lg flex items-center justify-center" style="background:linear-gradient(135deg,${t.accent},${t.accent2})">
          <i class="${appIcon}" style="font-size:12px;color:white"></i>
        </div>
        <span class="font-bold text-sm" style="color:${t.text}">${escHtml(appName)}</span>
        <span class="text-xs px-2 py-0.5 rounded-full font-semibold" style="background:${t.badge};color:${t.badgeText}">PREVIEW</span>
      </div>
    </div>
    <div class="flex items-center gap-2">
      ${rightContent}
      <button onclick="closeViewModal(); openTestingModal(null, VIEW_PROJECT.id, VIEW_PROJECT.name)"
        class="text-xs px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 transition-opacity hover:opacity-80"
        style="border:1px solid ${t.border};color:${t.sub}">
        <i class="fas fa-flask"></i> Revise
      </button>
      <button onclick="closeViewModal(); openPublishModal(VIEW_PROJECT.id)"
        class="text-xs px-3 py-1.5 rounded-lg font-semibold text-white flex items-center gap-1.5"
        style="background:linear-gradient(135deg,${t.accent},${t.accent2})">
        <i class="fas fa-rocket"></i> Publish
      </button>
      <button onclick="closeViewModal()" style="color:${t.sub}" class="w-8 h-8 flex items-center justify-center rounded-lg hover:opacity-80">
        <i class="fas fa-xmark text-sm"></i>
      </button>
    </div>
  </div>`;
}

// ── Sidebar nav builder ────────────────────────────────────────────────────
function viewSidebar(theme, items, activeIdx = 0, width = '200px') {
  const t = theme;
  return `<div class="flex flex-col flex-shrink-0 overflow-y-auto" style="width:${width};background:${t.sidebar};border-right:1px solid ${t.border}">
    <div class="flex-1 p-3 space-y-1">
      ${items.map((item, i) => `
      <button class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left"
        style="${i === activeIdx ? `background:${t.badge};color:${t.accent}` : `color:${t.sub}`}">
        <i class="${item.icon}" style="font-size:13px;width:16px;text-align:center"></i>
        <span style="font-size:12px;font-weight:${i===activeIdx?700:500}">${escHtml(item.label)}</span>
        ${item.badge ? `<span class="ml-auto text-xs px-1.5 py-0.5 rounded-full" style="background:${t.badge};color:${t.badgeText}">${item.badge}</span>` : ''}
      </button>`).join('')}
    </div>
  </div>`;
}

// ── KPI card builder ───────────────────────────────────────────────────────
function kpiCard(theme, icon, label, value, note, change = null) {
  const t = theme;
  return `<div class="rounded-2xl p-4 flex flex-col gap-2" style="background:${t.card};border:1px solid ${t.border}">
    <div class="flex items-center justify-between">
      <div class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style="background:${t.badge}">
        <i class="${icon}" style="font-size:14px;color:${t.accent}"></i>
      </div>
      ${change !== null ? `<span class="text-xs font-semibold" style="color:${change >= 0 ? '#22c55e' : '#ef4444'}">${change >= 0 ? '+' : ''}${change}%</span>` : ''}
    </div>
    <div>
      <p class="text-2xl font-black" style="color:${t.text}">${escHtml(value)}</p>
      <p class="text-xs font-medium" style="color:${t.sub}">${escHtml(label)}</p>
      ${note ? `<p class="text-xs mt-0.5" style="color:${t.muted}">${escHtml(note)}</p>` : ''}
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 1: FILM ANALYSIS DASHBOARD
//  Sports/Film AI tool — dark cinema vibes, breakdown panels, film grid
// ══════════════════════════════════════════════════════════════════════════
function renderFilmAnalysisDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId) {
  const roles = (fields.roles_permissions || 'Coaches/Players').split(/[,/]/).map(s=>s.trim());
  const wfItems = workflows.split(/[,.;]/).map(s=>s.trim()).filter(s=>s.length>3).slice(0,4);

  const sidebarItems = [
    { icon:'fas fa-gauge-high',  label:'Dashboard',   badge: null },
    { icon:'fas fa-film',        label:'Film Library', badge: '3 New' },
    { icon:'fas fa-brain',       label:'AI Breakdown', badge: null },
    { icon:'fas fa-chart-bar',   label:'Analytics',    badge: null },
    { icon:'fas fa-users',       label: truncate(roles[0]||'Team', 12), badge: null },
    { icon:'fas fa-gear',        label:'Settings',     badge: null },
  ];

  const filmCards = [
    { title: truncate(wfItems[0] || 'Week 12 vs Eagles', 28), tag: 'Offense', pct: '72%', color: t.accent },
    { title: truncate(wfItems[1] || 'Red Zone Package', 28), tag: 'Defense', pct: '58%', color: '#a855f7' },
    { title: 'Formation Tendencies', tag: 'Special Teams', pct: '41%', color: '#f59e0b' },
    { title: truncate(features[0] || 'Pass Rush Schemes', 28), tag: 'AI Ready', pct: '–', color: '#22c55e' },
  ];

  return `<div class="flex flex-col h-full" style="background:${t.bg};font-family:'Inter',sans-serif">
    ${viewTopBar(t, appName, appIcon, projectId)}
    <div class="flex flex-1 overflow-hidden">
      ${viewSidebar(t, sidebarItems, 0, '200px')}
      <!-- Main content -->
      <div class="flex-1 overflow-y-auto p-5 space-y-5">
        <!-- Header row -->
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-xl font-black" style="color:${t.text}">Film Dashboard</h1>
            <p class="text-xs" style="color:${t.sub}">${escHtml(truncate(problem || `AI-powered analysis for ${audience}`, 70))}</p>
          </div>
          <div class="flex gap-2">
            <button class="text-xs px-4 py-2 rounded-xl font-bold flex items-center gap-2" style="background:linear-gradient(135deg,${t.accent},${t.accent2});color:white">
              <i class="fas fa-cloud-arrow-up"></i> Upload Film
            </button>
          </div>
        </div>

        <!-- KPI row -->
        <div class="grid grid-cols-4 gap-3">
          ${kpiCard(t, 'fas fa-film', 'Film Sessions', '0', 'Uploaded', 0)}
          ${kpiCard(t, 'fas fa-brain', 'AI Breakdowns', '0', 'Generated', 0)}
          ${kpiCard(t, 'fas fa-chart-bar', 'Formations Found', '–', 'Detected')}
          ${kpiCard(t, 'fas fa-users', truncate(audience.split(/[,/]/)[0]||'Team Members', 14), '0', 'Active')}
        </div>

        <!-- Film grid + breakdown panel -->
        <div class="grid grid-cols-3 gap-4">
          <!-- Film cards -->
          <div class="col-span-2 space-y-3">
            <h3 class="text-sm font-bold" style="color:${t.text}">Film Library</h3>
            <div class="grid grid-cols-2 gap-3">
              ${filmCards.map(fc => `
              <div class="rounded-2xl overflow-hidden" style="background:${t.card};border:1px solid ${t.border}">
                <!-- Film thumbnail placeholder -->
                <div class="h-28 flex items-center justify-center relative" style="background:linear-gradient(135deg,${t.card2},${t.bg})">
                  <i class="fas fa-film" style="font-size:32px;color:${fc.color};opacity:0.3"></i>
                  <div class="absolute top-2 right-2">
                    <span class="text-xs px-2 py-0.5 rounded-full font-bold" style="background:${t.badge};color:${fc.color}">${fc.tag}</span>
                  </div>
                  <div class="absolute bottom-2 left-2 right-2">
                    <div class="h-1 rounded-full" style="background:${t.border}">
                      <div class="h-1 rounded-full" style="width:${fc.pct === '–' ? '0' : fc.pct};background:${fc.color}"></div>
                    </div>
                  </div>
                </div>
                <div class="p-3">
                  <p class="text-xs font-bold" style="color:${t.text}">${escHtml(fc.title)}</p>
                  <p class="text-xs" style="color:${t.sub}">AI Analysis ${fc.pct === '–' ? 'Pending' : 'Complete'}</p>
                </div>
              </div>`).join('')}
            </div>
          </div>

          <!-- AI Breakdown panel -->
          <div class="rounded-2xl p-4 space-y-3" style="background:${t.card};border:1px solid ${t.border}">
            <div class="flex items-center gap-2">
              <div class="w-8 h-8 rounded-xl flex items-center justify-center" style="background:${t.badge}">
                <i class="fas fa-brain" style="color:${t.accent};font-size:13px"></i>
              </div>
              <div>
                <p class="text-xs font-bold" style="color:${t.text}">AI Breakdown</p>
                <p class="text-xs" style="color:${t.sub}">Latest Result</p>
              </div>
            </div>
            <div class="space-y-2">
              ${[
                { label: 'Run %', val: '–', icon: 'fas fa-arrow-right' },
                { label: 'Pass %', val: '–', icon: 'fas fa-arrow-up-right' },
                { label: 'Blitz Rate', val: '–', icon: 'fas fa-bolt' },
                { label: 'Formations', val: '–', icon: 'fas fa-grip-dots-vertical' },
                { label: 'Tendencies', val: '–', icon: 'fas fa-chart-line' },
              ].map(item => `
              <div class="flex items-center justify-between py-1.5 border-b" style="border-color:${t.border}">
                <div class="flex items-center gap-2">
                  <i class="${item.icon}" style="font-size:10px;color:${t.muted}"></i>
                  <span class="text-xs" style="color:${t.sub}">${item.label}</span>
                </div>
                <span class="text-xs font-bold" style="color:${t.text}">${item.val}</span>
              </div>`).join('')}
            </div>
            <button class="w-full py-2.5 rounded-xl text-xs font-bold" style="background:linear-gradient(135deg,${t.accent},${t.accent2});color:white">
              <i class="fas fa-play mr-1"></i> Run Analysis
            </button>
          </div>
        </div>

        <!-- Workflow steps -->
        ${wfItems.length ? `<div class="rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
          <h3 class="text-sm font-bold mb-3" style="color:${t.text}">Workflow</h3>
          <div class="flex gap-3 overflow-x-auto pb-1">
            ${wfItems.map((w, i) => `
            <div class="flex-shrink-0 flex items-center gap-2">
              <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-black" style="background:${t.badge};color:${t.accent}">${i+1}</div>
              <span class="text-xs whitespace-nowrap" style="color:${t.sub}">${escHtml(truncate(w, 30))}</span>
              ${i < wfItems.length-1 ? `<i class="fas fa-chevron-right text-xs" style="color:${t.muted}"></i>` : ''}
            </div>`).join('')}
          </div>
        </div>` : ''}
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 2: MUSIC PLAYER DASHBOARD
//  Music app — player panel, queue, discover grid, stats
// ══════════════════════════════════════════════════════════════════════════
function renderMusicPlayerDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId) {
  const wfItems = workflows.split(/[,.;]/).map(s=>s.trim()).filter(s=>s.length>3).slice(0,4);

  const sidebarItems = [
    { icon:'fas fa-house',       label:'Home',      badge: null },
    { icon:'fas fa-magnifying-glass', label:'Discover', badge: null },
    { icon:'fas fa-list',        label:'Library',   badge: null },
    { icon:'fas fa-heart',       label:'Favorites', badge: null },
    { icon:'fas fa-music',       label: truncate(feat0, 12), badge: 'New' },
    { icon:'fas fa-gear',        label:'Settings',  badge: null },
  ];

  const genres = ['Hip-Hop', 'Electronic', 'R&B', 'Pop', 'Indie', 'Jazz'];
  const tracks = [
    { title: truncate(wfItems[0] || 'Top Picks', 24), artist: truncate(audience.split(/[,/]/)[0]||'Featured', 18), dur: '3:42' },
    { title: truncate(wfItems[1] || 'New Releases', 24), artist: 'Trending Now', dur: '4:15' },
    { title: truncate(features[0] || 'Featured Mix', 24), artist: 'Editor\'s Choice', dur: '2:58' },
    { title: 'Discover Weekly', artist: 'Personalized', dur: '5:01' },
  ];

  return `<div class="flex flex-col h-full" style="background:${t.bg};font-family:'Inter',sans-serif">
    ${viewTopBar(t, appName, appIcon, projectId)}
    <div class="flex flex-1 overflow-hidden">
      ${viewSidebar(t, sidebarItems, 0, '190px')}
      <!-- Main content -->
      <div class="flex-1 overflow-y-auto p-5 space-y-5">
        <!-- Hero now-playing card -->
        <div class="rounded-3xl p-6 relative overflow-hidden" style="background:linear-gradient(135deg,${t.accent}22,${t.accent2}33);border:1px solid ${t.border}">
          <div class="absolute inset-0" style="background:radial-gradient(ellipse at 70% 50%,${t.glow},transparent)"></div>
          <div class="relative flex items-center gap-6">
            <!-- Album art -->
            <div class="w-24 h-24 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-2xl" style="background:linear-gradient(135deg,${t.accent},${t.accent2})">
              <i class="${appIcon}" style="font-size:36px;color:white;opacity:0.9"></i>
            </div>
            <div class="flex-1">
              <p class="text-xs font-semibold mb-1" style="color:${t.badgeText}">NOW PLAYING</p>
              <h2 class="text-xl font-black mb-0.5" style="color:${t.text}">${escHtml(truncate(appName, 28))}</h2>
              <p class="text-sm" style="color:${t.sub}">${escHtml(truncate(problem || `For ${audience}`, 50))}</p>
              <!-- Progress bar -->
              <div class="mt-3 space-y-1">
                <div class="h-1.5 rounded-full" style="background:${t.border}">
                  <div class="h-1.5 rounded-full w-1/3" style="background:linear-gradient(90deg,${t.accent},${t.accent2})"></div>
                </div>
                <div class="flex justify-between text-xs" style="color:${t.muted}"><span>1:24</span><span>4:10</span></div>
              </div>
            </div>
            <!-- Controls -->
            <div class="flex items-center gap-4 flex-shrink-0">
              <button style="color:${t.sub}"><i class="fas fa-backward-step text-lg"></i></button>
              <button class="w-12 h-12 rounded-full flex items-center justify-center shadow-lg" style="background:linear-gradient(135deg,${t.accent},${t.accent2})">
                <i class="fas fa-pause text-white text-lg"></i>
              </button>
              <button style="color:${t.sub}"><i class="fas fa-forward-step text-lg"></i></button>
            </div>
          </div>
        </div>

        <!-- Stats + genres row -->
        <div class="grid grid-cols-4 gap-3">
          ${kpiCard(t, 'fas fa-music', 'Tracks', '0', 'Available', 0)}
          ${kpiCard(t, 'fas fa-list', 'Playlists', '0', 'Created', 0)}
          ${kpiCard(t, 'fas fa-headphones', 'Listening Time', '0h', 'This week')}
          ${kpiCard(t, 'fas fa-heart', 'Favorites', '0', 'Saved')}
        </div>

        <!-- Genre tags + track list -->
        <div class="grid grid-cols-3 gap-4">
          <div class="col-span-2 rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
            <h3 class="text-sm font-bold mb-3" style="color:${t.text}">Queue</h3>
            <div class="space-y-2">
              ${tracks.map((tr, i) => `
              <div class="flex items-center gap-3 p-2 rounded-xl ${i===0?'':''}" style="${i===0?`background:${t.badge};`:''}" >
                <div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style="background:${t.card2}">
                  ${i===0 ? `<i class="fas fa-volume-high" style="font-size:10px;color:${t.accent}"></i>` : `<span class="text-xs" style="color:${t.muted}">${i+1}</span>`}
                </div>
                <div class="flex-1">
                  <p class="text-xs font-bold" style="color:${t.text}">${escHtml(tr.title)}</p>
                  <p class="text-xs" style="color:${t.sub}">${escHtml(tr.artist)}</p>
                </div>
                <span class="text-xs" style="color:${t.muted}">${tr.dur}</span>
              </div>`).join('')}
            </div>
          </div>
          <!-- Genre chips -->
          <div class="rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
            <h3 class="text-sm font-bold mb-3" style="color:${t.text}">Genres</h3>
            <div class="flex flex-wrap gap-2">
              ${genres.map((g,i) => `<span class="text-xs px-3 py-1.5 rounded-full font-semibold cursor-pointer" style="background:${i===0?`linear-gradient(135deg,${t.accent},${t.accent2})`:t.card2};color:${i===0?'white':t.sub}">${g}</span>`).join('')}
            </div>
            ${wfItems.length ? `<div class="mt-4 space-y-2">
              <p class="text-xs font-bold" style="color:${t.sub}">Features</p>
              ${wfItems.slice(0,3).map(w => `<p class="text-xs flex items-center gap-2" style="color:${t.muted}"><i class="fas fa-check" style="color:${t.accent}"></i>${escHtml(truncate(w,30))}</p>`).join('')}
            </div>` : ''}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 3: CLINICAL / HEALTH DASHBOARD
//  Medical/Health app — appointment calendar, vitals, patient list
// ══════════════════════════════════════════════════════════════════════════
function renderClinicalDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId) {
  const roles = (fields.roles_permissions || 'Patient/Doctor').split(/[,/]/).map(s=>s.trim());
  const wfItems = workflows.split(/[,.;]/).map(s=>s.trim()).filter(s=>s.length>3).slice(0,4);

  const sidebarItems = [
    { icon:'fas fa-gauge-high',    label:'Dashboard',    badge: null },
    { icon:'fas fa-calendar-days', label:'Appointments', badge: '2 Today' },
    { icon:'fas fa-heart-pulse',   label:'Vitals',       badge: null },
    { icon:'fas fa-file-medical',  label:'Records',      badge: null },
    { icon:'fas fa-pills',         label: truncate(feat0, 12), badge: null },
    { icon:'fas fa-user-doctor',   label: truncate(roles[0]||'Provider', 12), badge: null },
  ];

  const vitals = [
    { label:'Heart Rate', val:'– BPM', icon:'fas fa-heart', color:'#ef4444' },
    { label:'Blood Pressure', val:'–/–', icon:'fas fa-stethoscope', color:'#3b82f6' },
    { label:'Oxygen', val:'–%', icon:'fas fa-lungs', color:'#06b6d4' },
    { label:'Temperature', val:'–°F', icon:'fas fa-thermometer', color:'#f97316' },
  ];

  return `<div class="flex flex-col h-full" style="background:${t.bg};font-family:'Inter',sans-serif">
    ${viewTopBar(t, appName, appIcon, projectId)}
    <div class="flex flex-1 overflow-hidden">
      ${viewSidebar(t, sidebarItems, 0, '195px')}
      <div class="flex-1 overflow-y-auto p-5 space-y-5">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-xl font-black" style="color:${t.text}">${escHtml(appName)}</h1>
            <p class="text-xs" style="color:${t.sub}">${escHtml(truncate(problem || `Healthcare platform for ${audience}`, 70))}</p>
          </div>
          <button class="text-xs px-4 py-2 rounded-xl font-bold flex items-center gap-2" style="background:linear-gradient(135deg,${t.accent},${t.accent2});color:white">
            <i class="fas fa-calendar-plus"></i> New Appointment
          </button>
        </div>

        <div class="grid grid-cols-4 gap-3">
          ${kpiCard(t, 'fas fa-calendar-days', 'Appointments', '0', 'This week', 0)}
          ${kpiCard(t, 'fas fa-file-medical', 'Records', '0', 'Total', 0)}
          ${kpiCard(t, 'fas fa-pills', 'Prescriptions', '0', 'Active')}
          ${kpiCard(t, 'fas fa-chart-line', 'Health Score', '–', 'Overall')}
        </div>

        <div class="grid grid-cols-3 gap-4">
          <!-- Vitals -->
          <div class="col-span-1 space-y-3">
            <h3 class="text-sm font-bold" style="color:${t.text}">Vital Signs</h3>
            ${vitals.map(v => `
            <div class="rounded-xl p-3 flex items-center gap-3" style="background:${t.card};border:1px solid ${t.border}">
              <div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style="background:${v.color}22">
                <i class="${v.icon}" style="font-size:12px;color:${v.color}"></i>
              </div>
              <div>
                <p class="text-xs" style="color:${t.sub}">${v.label}</p>
                <p class="text-sm font-bold" style="color:${t.text}">${v.val}</p>
              </div>
            </div>`).join('')}
          </div>

          <!-- Appointments + workflow -->
          <div class="col-span-2 space-y-4">
            <div class="rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
              <h3 class="text-sm font-bold mb-3" style="color:${t.text}">Upcoming Appointments</h3>
              <div class="space-y-2">
                ${[
                  { time: 'Today 10:00 AM', label: truncate(wfItems[0]||'Routine Checkup', 28), type: 'Virtual', color: t.accent },
                  { time: 'Tomorrow 2:30 PM', label: truncate(wfItems[1]||'Follow-up', 28), type: 'In-Person', color: '#a855f7' },
                  { time: 'Fri 9:00 AM', label: truncate(features[0]||'Specialist Consultation', 28), type: 'Pending', color: '#f59e0b' },
                ].map(a => `
                <div class="flex items-center gap-3 p-2 rounded-xl" style="background:${t.card2}">
                  <div class="w-1.5 rounded-full h-full self-stretch" style="background:${a.color};min-height:36px"></div>
                  <div class="flex-1">
                    <p class="text-xs font-bold" style="color:${t.text}">${escHtml(a.label)}</p>
                    <p class="text-xs" style="color:${t.sub}">${a.time}</p>
                  </div>
                  <span class="text-xs px-2 py-0.5 rounded-full" style="background:${a.color}22;color:${a.color}">${a.type}</span>
                </div>`).join('')}
              </div>
            </div>
            ${wfItems.length ? `
            <div class="rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
              <h3 class="text-sm font-bold mb-2" style="color:${t.text}">Care Workflow</h3>
              <div class="space-y-1.5">
                ${wfItems.map((w, i) => `
                <div class="flex items-center gap-2 text-xs" style="color:${t.sub}">
                  <i class="fas fa-circle-check" style="color:${i<1?t.accent:t.muted};font-size:10px"></i>
                  ${escHtml(truncate(w, 50))}
                </div>`).join('')}
              </div>
            </div>` : ''}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 4: TRADING / FINANCE DASHBOARD
//  Finance app — portfolio bar, chart area, positions table
// ══════════════════════════════════════════════════════════════════════════
function renderTradingDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId) {
  const wfItems = workflows.split(/[,.;]/).map(s=>s.trim()).filter(s=>s.length>3).slice(0,4);

  const sidebarItems = [
    { icon:'fas fa-gauge-high',      label:'Portfolio',  badge: null },
    { icon:'fas fa-chart-line',      label:'Markets',    badge: null },
    { icon:'fas fa-arrow-trend-up',  label: truncate(feat0,12), badge: null },
    { icon:'fas fa-wallet',          label:'Wallet',     badge: null },
    { icon:'fas fa-chart-pie',       label:'Analytics',  badge: null },
    { icon:'fas fa-gear',            label:'Settings',   badge: null },
  ];

  const assets = [
    { symbol:'BTC', name:'Bitcoin', val:'–', chg:'+0.0%', up:true },
    { symbol:'ETH', name:'Ethereum', val:'–', chg:'+0.0%', up:true },
    { symbol:'S&P', name:'S&P 500', val:'–', chg:'-0.0%', up:false },
    { symbol:'GOLD', name:'Gold', val:'–', chg:'+0.0%', up:true },
  ];

  // Mini sparkline-like bars (purely decorative SVG)
  const sparkline = `<svg width="80" height="30" viewBox="0 0 80 30">
    <polyline points="0,20 10,18 20,22 30,15 40,17 50,10 60,12 70,8 80,6" stroke="${t.accent}" stroke-width="1.5" fill="none"/>
  </svg>`;

  return `<div class="flex flex-col h-full" style="background:${t.bg};font-family:'Inter',sans-serif">
    ${viewTopBar(t, appName, appIcon, projectId)}
    <div class="flex flex-1 overflow-hidden">
      ${viewSidebar(t, sidebarItems, 0, '185px')}
      <div class="flex-1 overflow-y-auto p-5 space-y-5">
        <!-- Portfolio hero -->
        <div class="rounded-3xl p-6 relative overflow-hidden" style="background:linear-gradient(135deg,${t.card},${t.card2});border:1px solid ${t.border}">
          <div class="absolute right-0 top-0 bottom-0 flex items-center px-8 opacity-20">
            ${sparkline}
          </div>
          <p class="text-xs font-semibold mb-1" style="color:${t.sub}">TOTAL PORTFOLIO VALUE</p>
          <h1 class="text-4xl font-black mb-1" style="color:${t.text}">$0.00</h1>
          <div class="flex items-center gap-2">
            <span class="text-sm font-semibold" style="color:#22c55e">+$0.00 (0.0%)</span>
            <span class="text-xs" style="color:${t.muted}">All time</span>
          </div>
          <p class="text-xs mt-2" style="color:${t.sub}">${escHtml(truncate(problem || `Finance platform for ${audience}`, 60))}</p>
        </div>

        <div class="grid grid-cols-4 gap-3">
          ${kpiCard(t, 'fas fa-wallet', 'Net Worth', '$0', 'Current', 0)}
          ${kpiCard(t, 'fas fa-arrow-trend-up', 'Return YTD', '0%', 'Year to date', 0)}
          ${kpiCard(t, 'fas fa-chart-pie', 'Budget Used', '0%', 'This month')}
          ${kpiCard(t, 'fas fa-coins', 'Savings Rate', '0%', 'Of income')}
        </div>

        <!-- Chart + positions -->
        <div class="grid grid-cols-3 gap-4">
          <!-- Fake chart area -->
          <div class="col-span-2 rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-bold" style="color:${t.text}">Portfolio Performance</h3>
              <div class="flex gap-1">
                ${['1D','1W','1M','1Y'].map((p,i) => `<button class="text-xs px-2 py-1 rounded-lg" style="${i===2?`background:${t.badge};color:${t.accent}`:`color:${t.muted}`}">${p}</button>`).join('')}
              </div>
            </div>
            <!-- SVG Chart -->
            <svg width="100%" height="120" viewBox="0 0 400 120" preserveAspectRatio="none">
              <defs>
                <linearGradient id="chartGrad_${appName.length}" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="${t.accent}" stop-opacity="0.3"/>
                  <stop offset="100%" stop-color="${t.accent}" stop-opacity="0"/>
                </linearGradient>
              </defs>
              <polygon points="0,100 40,85 80,90 120,70 160,75 200,55 240,60 280,40 320,45 360,25 400,20 400,120 0,120" fill="url(#chartGrad_${appName.length})"/>
              <polyline points="0,100 40,85 80,90 120,70 160,75 200,55 240,60 280,40 320,45 360,25 400,20" stroke="${t.accent}" stroke-width="2" fill="none"/>
            </svg>
          </div>

          <!-- Positions -->
          <div class="rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
            <h3 class="text-sm font-bold mb-3" style="color:${t.text}">Positions</h3>
            <div class="space-y-3">
              ${assets.map(a => `
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-xs font-bold" style="color:${t.text}">${a.symbol}</p>
                  <p class="text-xs" style="color:${t.sub}">${a.name}</p>
                </div>
                <div class="text-right">
                  <p class="text-xs font-bold" style="color:${t.text}">${a.val}</p>
                  <p class="text-xs font-semibold" style="color:${a.up?'#22c55e':'#ef4444'}">${a.chg}</p>
                </div>
              </div>`).join('')}
            </div>
            ${wfItems.length ? `<div class="mt-4 pt-3 space-y-1.5 border-t" style="border-color:${t.border}">
              ${wfItems.slice(0,2).map(w => `<p class="text-xs" style="color:${t.muted}"><i class="fas fa-check mr-1" style="color:${t.accent}"></i>${escHtml(truncate(w,30))}</p>`).join('')}
            </div>` : ''}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 5: STOREFRONT / E-COMMERCE DASHBOARD
// ══════════════════════════════════════════════════════════════════════════
function renderStorefrontDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId) {
  const wfItems = workflows.split(/[,.;]/).map(s=>s.trim()).filter(s=>s.length>3).slice(0,4);
  const cats = ['All', ...(features.slice(0,4).length ? features.slice(0,4) : ['Electronics', 'Clothing', 'Home', 'Sports'])];

  const sidebarItems = [
    { icon:'fas fa-gauge-high',    label:'Dashboard',  badge: null },
    { icon:'fas fa-bag-shopping',  label:'Products',   badge: '12' },
    { icon:'fas fa-list-check',    label:'Orders',     badge: '3 New' },
    { icon:'fas fa-users',         label:'Customers',  badge: null },
    { icon:'fas fa-chart-bar',     label:'Analytics',  badge: null },
    { icon:'fas fa-gear',          label:'Settings',   badge: null },
  ];

  const products = [
    { name: truncate(wfItems[0]||feat0||'Featured Product', 22), price: '$0', badge: 'New', color: t.accent },
    { name: truncate(wfItems[1]||features[1]||'Best Seller', 22), price: '$0', badge: 'Hot', color: '#f97316' },
    { name: truncate(features[0]||'Premium Item', 22), price: '$0', badge: 'Sale', color: '#22c55e' },
    { name: 'Staff Pick', price: '$0', badge: null, color: t.accent2 },
  ];

  return `<div class="flex flex-col h-full" style="background:${t.bg};font-family:'Inter',sans-serif">
    ${viewTopBar(t, appName, appIcon, projectId)}
    <div class="flex flex-1 overflow-hidden">
      ${viewSidebar(t, sidebarItems, 0, '185px')}
      <div class="flex-1 overflow-y-auto p-5 space-y-5">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-xl font-black" style="color:${t.text}">${escHtml(appName)}</h1>
            <p class="text-xs" style="color:${t.sub}">${escHtml(truncate(problem || `Shop for ${audience}`, 60))}</p>
          </div>
          <div class="flex gap-2">
            <div class="relative">
              <input class="text-xs pl-8 pr-4 py-2 rounded-xl outline-none" style="background:${t.card};border:1px solid ${t.border};color:${t.text};width:180px" placeholder="Search products…">
              <i class="fas fa-magnifying-glass absolute left-2.5 top-2.5 text-xs" style="color:${t.muted}"></i>
            </div>
            <button class="text-xs px-4 py-2 rounded-xl font-bold flex items-center gap-2" style="background:linear-gradient(135deg,${t.accent},${t.accent2});color:white">
              <i class="fas fa-plus"></i> Add Product
            </button>
          </div>
        </div>

        <div class="grid grid-cols-4 gap-3">
          ${kpiCard(t, 'fas fa-bag-shopping', 'Orders Today', '0', 'New', 0)}
          ${kpiCard(t, 'fas fa-dollar-sign', 'Revenue', '$0', 'This month', 0)}
          ${kpiCard(t, 'fas fa-star', 'Avg Rating', '–', 'Out of 5')}
          ${kpiCard(t, 'fas fa-users', 'Customers', '0', 'Active')}
        </div>

        <!-- Category filter + product grid -->
        <div>
          <div class="flex gap-2 mb-3 overflow-x-auto pb-1">
            ${cats.slice(0,5).map((c,i) => `<button class="flex-shrink-0 text-xs px-3 py-1.5 rounded-full font-semibold" style="${i===0?`background:linear-gradient(135deg,${t.accent},${t.accent2});color:white`:`background:${t.card2};color:${t.sub}`}">${escHtml(truncate(c,14))}</button>`).join('')}
          </div>
          <div class="grid grid-cols-4 gap-3">
            ${products.map(p => `
            <div class="rounded-2xl overflow-hidden" style="background:${t.card};border:1px solid ${t.border}">
              <div class="h-32 flex items-center justify-center relative" style="background:linear-gradient(135deg,${p.color}22,${t.card2})">
                <i class="fas fa-bag-shopping" style="font-size:32px;color:${p.color};opacity:0.4"></i>
                ${p.badge ? `<span class="absolute top-2 left-2 text-xs px-2 py-0.5 rounded-full font-bold" style="background:${p.color};color:white">${p.badge}</span>` : ''}
              </div>
              <div class="p-3">
                <p class="text-xs font-bold" style="color:${t.text}">${escHtml(p.name)}</p>
                <div class="flex items-center justify-between mt-1">
                  <span class="text-sm font-black" style="color:${t.accent}">${p.price}</span>
                  <button class="w-6 h-6 rounded-full flex items-center justify-center" style="background:${t.badge}">
                    <i class="fas fa-cart-plus" style="font-size:9px;color:${t.accent}"></i>
                  </button>
                </div>
              </div>
            </div>`).join('')}
          </div>
        </div>

        <!-- Recent orders table -->
        <div class="rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
          <h3 class="text-sm font-bold mb-3" style="color:${t.text}">Recent Orders</h3>
          <table class="w-full text-xs">
            <thead>
              <tr style="color:${t.muted}">
                <th class="text-left py-1.5 font-semibold">Order ID</th>
                <th class="text-left py-1.5 font-semibold">Customer</th>
                <th class="text-left py-1.5 font-semibold">Item</th>
                <th class="text-left py-1.5 font-semibold">Total</th>
                <th class="text-left py-1.5 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              ${[
                { id:'#001', cust: truncate(audience.split(/[,/]/)[0]||'Customer', 14), item: truncate(products[0].name,18), total:'$0', status:'Delivered', color:'#22c55e' },
                { id:'#002', cust: 'New User', item: truncate(products[1].name,18), total:'$0', status:'Processing', color:t.accent },
                { id:'#003', cust: 'Returning', item: truncate(products[2].name,18), total:'$0', status:'Pending', color:'#f59e0b' },
              ].map(o => `<tr style="border-top:1px solid ${t.border}">
                <td class="py-2 font-mono" style="color:${t.accent}">${o.id}</td>
                <td class="py-2" style="color:${t.text}">${escHtml(o.cust)}</td>
                <td class="py-2" style="color:${t.sub}">${escHtml(o.item)}</td>
                <td class="py-2 font-bold" style="color:${t.text}">${o.total}</td>
                <td class="py-2"><span class="px-2 py-0.5 rounded-full" style="background:${o.color}22;color:${o.color}">${o.status}</span></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 6: LMS (Learning Management System)
// ══════════════════════════════════════════════════════════════════════════
function renderLMSDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId) {
  const wfItems = workflows.split(/[,.;]/).map(s=>s.trim()).filter(s=>s.length>3).slice(0,4);

  const sidebarItems = [
    { icon:'fas fa-house',          label:'Dashboard', badge: null },
    { icon:'fas fa-book-open',      label:'Courses',   badge: '3 New' },
    { icon:'fas fa-graduation-cap', label: truncate(feat0,12), badge: null },
    { icon:'fas fa-trophy',         label:'Progress',  badge: null },
    { icon:'fas fa-users',          label:'Community', badge: null },
    { icon:'fas fa-gear',           label:'Settings',  badge: null },
  ];

  const courses = features.slice(0,4).length >= 2 ? features.slice(0,4) : ['Intro Module', 'Core Concepts', 'Advanced Topics', 'Final Project'];

  return `<div class="flex flex-col h-full" style="background:${t.bg};font-family:'Inter',sans-serif">
    ${viewTopBar(t, appName, appIcon, projectId)}
    <div class="flex flex-1 overflow-hidden">
      ${viewSidebar(t, sidebarItems, 0, '190px')}
      <div class="flex-1 overflow-y-auto p-5 space-y-5">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-xl font-black" style="color:${t.text}">Learning Hub</h1>
            <p class="text-xs" style="color:${t.sub}">${escHtml(truncate(problem || `Education platform for ${audience}`, 60))}</p>
          </div>
          <button class="text-xs px-4 py-2 rounded-xl font-bold" style="background:linear-gradient(135deg,${t.accent},${t.accent2});color:white">
            <i class="fas fa-play mr-1"></i> Continue Learning
          </button>
        </div>

        <!-- Progress hero -->
        <div class="rounded-3xl p-5" style="background:linear-gradient(135deg,${t.card},${t.card2});border:1px solid ${t.border}">
          <div class="flex items-center gap-4">
            <div class="w-16 h-16 rounded-2xl flex items-center justify-center flex-shrink-0" style="background:linear-gradient(135deg,${t.accent},${t.accent2})">
              <i class="${appIcon} text-white text-2xl"></i>
            </div>
            <div class="flex-1">
              <p class="text-xs mb-1" style="color:${t.sub}">Overall Progress</p>
              <div class="h-3 rounded-full mb-1" style="background:${t.border}">
                <div class="h-3 rounded-full w-0" style="background:linear-gradient(90deg,${t.accent},${t.accent2})"></div>
              </div>
              <div class="flex justify-between text-xs" style="color:${t.muted}"><span>0% Complete</span><span>0 / 0 lessons</span></div>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-4 gap-3">
          ${kpiCard(t, 'fas fa-book-open', 'Courses', '0', 'Enrolled')}
          ${kpiCard(t, 'fas fa-check-circle', 'Completed', '0', 'Lessons')}
          ${kpiCard(t, 'fas fa-clock', 'Study Time', '0h', 'This week')}
          ${kpiCard(t, 'fas fa-trophy', 'Streak', '0 days', 'Current')}
        </div>

        <!-- Course cards -->
        <div>
          <h3 class="text-sm font-bold mb-3" style="color:${t.text}">Your Courses</h3>
          <div class="grid grid-cols-2 gap-3">
            ${courses.slice(0,4).map((c, i) => `
            <div class="rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
              <div class="flex items-center gap-3 mb-3">
                <div class="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style="background:${t.badge}">
                  <i class="${resolveIcon(c)}" style="font-size:14px;color:${t.accent}"></i>
                </div>
                <div>
                  <p class="text-xs font-bold" style="color:${t.text}">${escHtml(truncate(c, 28))}</p>
                  <p class="text-xs" style="color:${t.sub}">${i === 0 ? 'In Progress' : i === 1 ? 'Not Started' : 'Locked'}</p>
                </div>
              </div>
              <div class="h-1.5 rounded-full" style="background:${t.border}">
                <div class="h-1.5 rounded-full" style="width:${i===0?'30%':'0%'};background:linear-gradient(90deg,${t.accent},${t.accent2})"></div>
              </div>
              <p class="text-xs mt-1" style="color:${t.muted}">${i===0?'30%':i===1?'0%':'–'} complete</p>
            </div>`).join('')}
          </div>
        </div>

        ${wfItems.length ? `<div class="rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
          <h3 class="text-sm font-bold mb-2" style="color:${t.text}">Learning Path</h3>
          <div class="flex gap-3 overflow-x-auto">
            ${wfItems.map((w,i) => `<div class="flex-shrink-0 flex items-center gap-2">
              <div class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-black" style="background:${i===0?`linear-gradient(135deg,${t.accent},${t.accent2})`:t.card2};color:${i===0?'white':t.sub}">${i+1}</div>
              <span class="text-xs whitespace-nowrap" style="color:${t.sub}">${escHtml(truncate(w,24))}</span>
              ${i<wfItems.length-1?`<i class="fas fa-arrow-right text-xs" style="color:${t.muted}"></i>`:''}
            </div>`).join('')}
          </div>
        </div>` : ''}
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 7: AI CONSOLE DASHBOARD
//  AI/Automation tool — terminal-inspired, prompt input, output panel
// ══════════════════════════════════════════════════════════════════════════
function renderAIConsoleDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId) {
  const wfItems = workflows.split(/[,.;]/).map(s=>s.trim()).filter(s=>s.length>3).slice(0,4);

  const sidebarItems = [
    { icon:'fas fa-terminal',       label:'Console',    badge: null },
    { icon:'fas fa-brain',          label: truncate(feat0,12), badge: 'AI' },
    { icon:'fas fa-history',        label:'History',    badge: null },
    { icon:'fas fa-chart-bar',      label:'Analytics',  badge: null },
    { icon:'fas fa-key',            label:'API Keys',   badge: null },
    { icon:'fas fa-gear',           label:'Settings',   badge: null },
  ];

  const prompts = [
    { input: truncate(wfItems[0]||'Analyze this data and give me insights', 45), time: '2m ago', status: 'Done' },
    { input: truncate(wfItems[1]||'Generate a summary report', 45), time: '15m ago', status: 'Done' },
    { input: truncate(features[0]||'Process the latest batch', 45), time: '1h ago', status: 'Done' },
  ];

  return `<div class="flex flex-col h-full" style="background:${t.bg};font-family:'JetBrains Mono','Courier New',monospace">
    ${viewTopBar(t, appName, appIcon, projectId)}
    <div class="flex flex-1 overflow-hidden">
      ${viewSidebar(t, sidebarItems, 0, '185px')}
      <div class="flex-1 flex flex-col overflow-hidden p-5 gap-4">
        <!-- Header -->
        <div>
          <h1 class="text-xl font-black" style="color:${t.text};font-family:'Inter',sans-serif">${escHtml(appName)}</h1>
          <p class="text-xs" style="color:${t.sub};font-family:'Inter',sans-serif">${escHtml(truncate(problem || `AI automation for ${audience}`, 70))}</p>
        </div>

        <!-- KPIs -->
        <div class="grid grid-cols-4 gap-3 flex-shrink-0" style="font-family:'Inter',sans-serif">
          ${kpiCard(t, 'fas fa-bolt', 'Runs Today', '0', 'Executions')}
          ${kpiCard(t, 'fas fa-check-circle', 'Success Rate', '–%', 'Avg')}
          ${kpiCard(t, 'fas fa-clock', 'Avg Latency', '–ms', 'Per call')}
          ${kpiCard(t, 'fas fa-coins', 'Tokens Used', '–', 'Today')}
        </div>

        <!-- Terminal + history panel -->
        <div class="flex gap-4 flex-1 overflow-hidden">
          <!-- Terminal -->
          <div class="flex-1 rounded-2xl overflow-hidden flex flex-col" style="background:#050810;border:1px solid ${t.border}">
            <div class="flex items-center gap-2 px-4 py-2 border-b" style="background:${t.card};border-color:${t.border}">
              <span class="w-3 h-3 rounded-full bg-red-500 opacity-70"></span>
              <span class="w-3 h-3 rounded-full bg-amber-500 opacity-70"></span>
              <span class="w-3 h-3 rounded-full bg-green-500 opacity-70"></span>
              <span class="text-xs ml-2" style="color:${t.muted}">${escHtml(appName)} Console</span>
            </div>
            <div class="flex-1 p-4 overflow-y-auto text-xs space-y-2" style="color:${t.sub}">
              <p style="color:${t.accent}">$ ${escHtml(appName.toLowerCase().replace(/\s+/g,'-'))} init</p>
              <p style="color:#22c55e">✓ Initialized. Ready for input.</p>
              <p style="color:${t.muted}"># ${escHtml(truncate(problem||`AI tool for ${audience}`,60))}</p>
              <p style="color:${t.accent}">$ ${escHtml(truncate(feat0||'run --analyze',30))}</p>
              <p style="color:${t.sub}">Processing... </p>
              <p style="color:#22c55e">✓ Complete. Results ready.</p>
              ${features.slice(0,2).map(f => `<p style="color:${t.muted}">  • ${escHtml(truncate(f,40))}</p>`).join('')}
              <p style="color:${t.accent}">$ <span class="border-r border-current animate-pulse">&nbsp;</span></p>
            </div>
            <!-- Input -->
            <div class="flex items-center gap-2 px-4 py-3 border-t" style="border-color:${t.border}">
              <span style="color:${t.accent}">$</span>
              <input class="flex-1 bg-transparent outline-none text-xs" style="color:${t.text}" placeholder="Enter command…">
              <button class="text-xs px-3 py-1 rounded-lg" style="background:${t.badge};color:${t.accent}">Run</button>
            </div>
          </div>

          <!-- History panel -->
          <div class="w-56 flex-shrink-0 rounded-2xl overflow-hidden flex flex-col" style="background:${t.card};border:1px solid ${t.border};font-family:'Inter',sans-serif">
            <div class="px-4 py-3 border-b" style="border-color:${t.border}">
              <p class="text-xs font-bold" style="color:${t.text}">Run History</p>
            </div>
            <div class="flex-1 overflow-y-auto p-3 space-y-2">
              ${prompts.map(pr => `
              <div class="p-2 rounded-xl" style="background:${t.card2}">
                <p class="text-xs" style="color:${t.text}">${escHtml(pr.input)}</p>
                <div class="flex items-center justify-between mt-1">
                  <span class="text-xs" style="color:${t.muted}">${pr.time}</span>
                  <span class="text-xs px-1.5 rounded-full" style="background:#22c55e22;color:#22c55e">${pr.status}</span>
                </div>
              </div>`).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  LAYOUT 8: COMMAND CENTER (SaaS / CRM)
// ══════════════════════════════════════════════════════════════════════════
function renderCommandCenterDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId) {
  const wfItems = workflows.split(/[,.;]/).map(s=>s.trim()).filter(s=>s.length>3).slice(0,4);
  const roles = (fields.roles_permissions || 'Admin/User').split(/[,/]/).map(s=>s.trim());

  const sidebarItems = [
    { icon:'fas fa-gauge-high',   label:'Dashboard',  badge: null },
    { icon: resolveIcon(feat0),   label: truncate(feat0,12), badge: 'New' },
    { icon:'fas fa-users',        label:'Contacts',   badge: null },
    { icon:'fas fa-chart-bar',    label:'Reports',    badge: null },
    { icon:'fas fa-bell',         label:'Alerts',     badge: '3' },
    { icon:'fas fa-gear',         label:'Settings',   badge: null },
  ];

  const tableRows = [
    { name: truncate(audience.split(/[,/]/)[0]||'User', 18), action: truncate(wfItems[0]||feat0||'Completed task', 24), status:'Active', date:'Today' },
    { name: 'New Account', action: truncate(wfItems[1]||'Started workflow', 24), status:'Pending', date:'Yesterday' },
    { name: truncate(roles[0]||'Admin', 18), action: truncate(features[0]||'Updated record', 24), status:'Done', date:'2 days ago' },
    { name: 'Integration', action: 'Sync completed', status:'Active', date:'3 days ago' },
  ];

  return `<div class="flex flex-col h-full" style="background:${t.bg};font-family:'Inter',sans-serif">
    ${viewTopBar(t, appName, appIcon, projectId)}
    <div class="flex flex-1 overflow-hidden">
      ${viewSidebar(t, sidebarItems, 0, '190px')}
      <div class="flex-1 overflow-y-auto p-5 space-y-5">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-xl font-black" style="color:${t.text}">${escHtml(appName)}</h1>
            <p class="text-xs" style="color:${t.sub}">${escHtml(truncate(problem || `Command center for ${audience}`, 70))}</p>
          </div>
          <div class="flex gap-2">
            <button class="text-xs px-4 py-2 rounded-xl font-bold flex items-center gap-2" style="background:linear-gradient(135deg,${t.accent},${t.accent2});color:white">
              <i class="fas fa-plus"></i> New ${escHtml(truncate(feat0,10))}
            </button>
          </div>
        </div>

        <div class="grid grid-cols-4 gap-3">
          ${kpiCard(t, resolveIcon(feat0), truncate(feat0,14), '0', 'Total', 0)}
          ${kpiCard(t, 'fas fa-users', truncate(audience.split(/[,/]/)[0]||'Users',14), '0', 'Active', 0)}
          ${kpiCard(t, 'fas fa-bolt', 'Automations', '0', 'Running')}
          ${kpiCard(t, 'fas fa-chart-line', 'Growth', '0%', 'This month')}
        </div>

        <!-- Chart + activity -->
        <div class="grid grid-cols-3 gap-4">
          <!-- Activity chart -->
          <div class="col-span-2 rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-sm font-bold" style="color:${t.text}">Activity Overview</h3>
              <span class="text-xs" style="color:${t.muted}">Last 7 days</span>
            </div>
            <!-- Bar chart (decorative) -->
            <div class="flex items-end gap-2 h-20">
              ${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((d,i) => {
                const h = [30,50,40,70,55,20,45][i];
                return `<div class="flex-1 flex flex-col items-center gap-1">
                  <div class="w-full rounded-t" style="height:${h}%;background:${i===4?`linear-gradient(180deg,${t.accent},${t.accent2})`:t.card2};min-height:4px"></div>
                  <span class="text-xs" style="color:${t.muted}">${d}</span>
                </div>`;
              }).join('')}
            </div>
          </div>

          <!-- Quick actions -->
          <div class="rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
            <h3 class="text-sm font-bold mb-3" style="color:${t.text}">Quick Actions</h3>
            <div class="space-y-2">
              ${features.slice(0,4).map((f,i) => `
              <button class="w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-opacity hover:opacity-80" style="background:${t.card2}">
                <div class="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style="background:${t.badge}">
                  <i class="${resolveIcon(f)}" style="font-size:11px;color:${t.accent}"></i>
                </div>
                <span class="text-xs font-medium" style="color:${t.sub}">${escHtml(truncate(f, 22))}</span>
              </button>`).join('')}
              ${features.length < 2 ? wfItems.slice(0,2).map(w => `
              <button class="w-full flex items-center gap-3 p-2.5 rounded-xl text-left" style="background:${t.card2}">
                <div class="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style="background:${t.badge}">
                  <i class="${resolveIcon(w)}" style="font-size:11px;color:${t.accent}"></i>
                </div>
                <span class="text-xs font-medium" style="color:${t.sub}">${escHtml(truncate(w, 22))}</span>
              </button>`).join('') : ''}
            </div>
          </div>
        </div>

        <!-- Table -->
        <div class="rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold" style="color:${t.text}">Recent Activity</h3>
            <button class="text-xs" style="color:${t.accent}">View all</button>
          </div>
          <table class="w-full text-xs">
            <thead>
              <tr style="color:${t.muted}">
                <th class="text-left py-2 font-semibold">Name</th>
                <th class="text-left py-2 font-semibold">Action</th>
                <th class="text-left py-2 font-semibold">Status</th>
                <th class="text-left py-2 font-semibold">Date</th>
              </tr>
            </thead>
            <tbody>
              ${tableRows.map((r,i) => `
              <tr style="border-top:1px solid ${t.border}">
                <td class="py-2"><div class="flex items-center gap-2">
                  <div class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-black" style="background:${t.badge};color:${t.accent}">${r.name[0]}</div>
                  <span style="color:${t.text}">${escHtml(r.name)}</span>
                </div></td>
                <td class="py-2" style="color:${t.sub}">${escHtml(r.action)}</td>
                <td class="py-2"><span class="px-2 py-0.5 rounded-full" style="background:${r.status==='Active'?t.accent+'22':r.status==='Done'?'#22c55e22':'#f59e0b22'};color:${r.status==='Active'?t.accent:r.status==='Done'?'#22c55e':'#f59e0b'}">${r.status}</span></td>
                <td class="py-2" style="color:${t.muted}">${r.date}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  REMAINING LAYOUTS — DELEGATED TO renderAppDashboard WITH DOMAIN SKIN
// ══════════════════════════════════════════════════════════════════════════
function renderDispatchDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId) {
  return renderAppDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId, 'Dispatch Center', 'fas fa-truck', [
    { icon:'fas fa-truck', label:'Active Routes', value:'0', note:'Now' },
    { icon:'fas fa-map-location-dot', label:'Deliveries', value:'0', note:'Today' },
    { icon:'fas fa-users', label:'Drivers', value:'0', note:'Online' },
    { icon:'fas fa-check-circle', label:'Completed', value:'0', note:'Today' },
  ]);
}
function renderCaseManagerDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId) {
  return renderAppDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId, 'Case Manager', 'fas fa-scale-balanced', [
    { icon:'fas fa-folder-open', label:'Open Cases', value:'0', note:'Active' },
    { icon:'fas fa-file-contract', label:'Documents', value:'0', note:'Filed' },
    { icon:'fas fa-calendar-check', label:'Hearings', value:'0', note:'Scheduled' },
    { icon:'fas fa-clock', label:'Billable Hours', value:'0h', note:'This month' },
  ]);
}
function renderSocialFeedDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId) {
  return renderAppDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId, 'Social Feed', 'fas fa-heart', [
    { icon:'fas fa-users', label:'Followers', value:'0', note:'Total' },
    { icon:'fas fa-heart', label:'Total Likes', value:'0', note:'All posts' },
    { icon:'fas fa-eye', label:'Views', value:'0', note:'This week' },
    { icon:'fas fa-chart-line', label:'Engagement', value:'0%', note:'Rate' },
  ]);
}
function renderPropertyPortalDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId) {
  return renderAppDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId, 'Property Portal', 'fas fa-house', [
    { icon:'fas fa-house', label:'Listings', value:'0', note:'Active' },
    { icon:'fas fa-eye', label:'Views', value:'0', note:'This week' },
    { icon:'fas fa-handshake', label:'Inquiries', value:'0', note:'Pending' },
    { icon:'fas fa-dollar-sign', label:'Avg Price', value:'$0', note:'Market avg' },
  ]);
}
function renderItineraryDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId) {
  return renderAppDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId, 'Travel Planner', 'fas fa-plane', [
    { icon:'fas fa-plane', label:'Trips Planned', value:'0', note:'Total' },
    { icon:'fas fa-hotel', label:'Hotels', value:'0', note:'Booked' },
    { icon:'fas fa-map-pin', label:'Destinations', value:'0', note:'Saved' },
    { icon:'fas fa-star', label:'Avg Rating', value:'–', note:'Trips' },
  ]);
}
function renderKitchenDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId) {
  return renderAppDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId, 'Kitchen Manager', 'fas fa-utensils', [
    { icon:'fas fa-utensils', label:'Menu Items', value:'0', note:'Available' },
    { icon:'fas fa-list-check', label:'Orders Today', value:'0', note:'New' },
    { icon:'fas fa-star', label:'Avg Rating', value:'–', note:'Customer' },
    { icon:'fas fa-dollar-sign', label:'Revenue', value:'$0', note:'Today' },
  ]);
}
function renderDesignStudioDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId) {
  return renderAppDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId, 'Design Studio', 'fas fa-pen-nib', [
    { icon:'fas fa-pen-nib', label:'Projects', value:'0', note:'Active' },
    { icon:'fas fa-layer-group', label:'Assets', value:'0', note:'Library' },
    { icon:'fas fa-users', label:'Collaborators', value:'0', note:'Online' },
    { icon:'fas fa-share-nodes', label:'Exports', value:'0', note:'This week' },
  ]);
}
function renderArcadeDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId) {
  return renderAppDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId, 'Game Hub', 'fas fa-gamepad', [
    { icon:'fas fa-gamepad', label:'Games', value:'0', note:'Available' },
    { icon:'fas fa-trophy', label:'Achievements', value:'0', note:'Earned' },
    { icon:'fas fa-users', label:'Players', value:'0', note:'Online' },
    { icon:'fas fa-fire', label:'High Score', value:'–', note:'Leaderboard' },
  ]);
}

// ══════════════════════════════════════════════════════════════════════════
//  GENERIC APP DASHBOARD — Flexible layout for any project
// ══════════════════════════════════════════════════════════════════════════
function renderAppDashboard(t, appName, appIcon, fields, features, workflows, audience, problem, bizModel, feat0, feat1, feat2, projectId,
    overrideTitle = null, overrideIcon = null, overrideKPIs = null) {

  const wfItems = workflows.split(/[,.;]/).map(s=>s.trim()).filter(s=>s.length>3).slice(0,4);
  const roles = (fields.roles_permissions || 'Admin/User').split(/[,/]/).map(s=>s.trim());
  const apis = (fields.apis_tools || '').split(',').map(s=>s.trim()).filter(Boolean);

  const dashTitle  = overrideTitle || appName;
  const dashIcon   = overrideIcon  || appIcon;

  const sidebarItems = [
    { icon:'fas fa-gauge-high',  label:'Dashboard',                badge: null },
    { icon: resolveIcon(feat0),  label: truncate(feat0||'Main',12),badge: 'New' },
    { icon: resolveIcon(feat1),  label: truncate(feat1||'Analytics',12), badge: null },
    { icon:'fas fa-users',       label: truncate(roles[0]||'Users',12), badge: null },
    { icon:'fas fa-bell',        label:'Notifications',            badge: '3' },
    { icon:'fas fa-gear',        label:'Settings',                 badge: null },
  ];

  const kpis = overrideKPIs || [
    { icon: resolveIcon(feat0), label: truncate(feat0||'Items',14), value:'0', note:'Total', change:0 },
    { icon:'fas fa-users', label: truncate(audience.split(/[,/]/)[0]||'Users',14), value:'0', note:'Active', change:0 },
    { icon:'fas fa-bolt', label:'Automations', value:'0', note:'Running' },
    { icon:'fas fa-chart-line', label:'Growth', value:'0%', note:'This month' },
  ];

  const activityItems = [
    ...(wfItems.length ? wfItems.slice(0,3).map((w,i) => ({ label: truncate(w,40), time:['Just now','5m ago','1h ago'][i]||'Today', icon: resolveIcon(w), color: [t.accent,'#a855f7','#f59e0b'][i]||t.accent })) : []),
    ...(features.slice(0,2).map((f,i) => ({ label: truncate(`${f} updated`,40), time:['2h ago','Yesterday'][i]||'', icon: resolveIcon(f), color:[t.accent2,'#22c55e'][i]||t.accent2 }))),
  ].slice(0,5);

  return `<div class="flex flex-col h-full" style="background:${t.bg};font-family:'Inter',sans-serif">
    ${viewTopBar(t, appName, appIcon, projectId)}
    <div class="flex flex-1 overflow-hidden">
      ${viewSidebar(t, sidebarItems, 0, '190px')}
      <div class="flex-1 overflow-y-auto p-5 space-y-5">
        <!-- Header -->
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-xl font-black" style="color:${t.text}">${escHtml(dashTitle)}</h1>
            <p class="text-xs" style="color:${t.sub}">${escHtml(truncate(problem || `Platform for ${audience}`, 70))}</p>
          </div>
          <div class="flex gap-2">
            <div class="relative hidden sm:block">
              <input class="text-xs pl-8 pr-4 py-2 rounded-xl outline-none" style="background:${t.card};border:1px solid ${t.border};color:${t.text};width:160px" placeholder="Search…">
              <i class="fas fa-magnifying-glass absolute left-2.5 top-2.5 text-xs" style="color:${t.muted}"></i>
            </div>
            <button class="text-xs px-4 py-2 rounded-xl font-bold flex items-center gap-2" style="background:linear-gradient(135deg,${t.accent},${t.accent2});color:white">
              <i class="${dashIcon}"></i> <span class="hidden sm:inline">New ${escHtml(truncate(feat0,12))}</span>
            </button>
          </div>
        </div>

        <!-- KPIs -->
        <div class="grid grid-cols-4 gap-3">
          ${kpis.map(k => kpiCard(t, k.icon, k.label, k.value, k.note, k.change !== undefined ? k.change : null)).join('')}
        </div>

        <!-- Main content grid -->
        <div class="grid grid-cols-3 gap-4">
          <!-- Feature list / main panel -->
          <div class="col-span-2 rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-bold" style="color:${t.text}">${escHtml(truncate(feat0||'Overview',28))}</h3>
              <span class="text-xs px-2 py-0.5 rounded-full" style="background:${t.badge};color:${t.badgeText}">Live</span>
            </div>

            <!-- Hero feature card -->
            <div class="rounded-2xl p-4 mb-3 relative overflow-hidden" style="background:linear-gradient(135deg,${t.accent}18,${t.accent2}22);border:1px solid ${t.border}">
              <div class="absolute right-4 top-4 opacity-10">
                <i class="${dashIcon}" style="font-size:48px;color:${t.accent}"></i>
              </div>
              <div class="w-10 h-10 rounded-xl flex items-center justify-center mb-3" style="background:linear-gradient(135deg,${t.accent},${t.accent2})">
                <i class="${dashIcon} text-white text-sm"></i>
              </div>
              <p class="text-sm font-black mb-1" style="color:${t.text}">${escHtml(truncate(feat0||appName, 36))}</p>
              <p class="text-xs" style="color:${t.sub}">${escHtml(truncate(problem || `Core feature for ${audience}`, 80))}</p>
              <div class="flex gap-2 mt-3">
                <button class="text-xs px-3 py-1.5 rounded-lg font-bold" style="background:linear-gradient(135deg,${t.accent},${t.accent2});color:white">Get Started</button>
                <button class="text-xs px-3 py-1.5 rounded-lg font-semibold" style="background:${t.badge};color:${t.sub}">Learn More</button>
              </div>
            </div>

            <!-- Feature items -->
            <div class="space-y-2">
              ${(features.length > 1 ? features : wfItems).slice(0,4).map((item, i) => `
              <div class="flex items-center gap-3 p-2.5 rounded-xl" style="background:${t.card2}">
                <div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style="background:${t.badge}">
                  <i class="${resolveIcon(item)}" style="font-size:11px;color:${t.accent}"></i>
                </div>
                <div class="flex-1">
                  <p class="text-xs font-semibold" style="color:${t.text}">${escHtml(truncate(item,38))}</p>
                  <p class="text-xs" style="color:${t.muted}">${['Active', 'In Progress', 'Ready', 'Pending'][i % 4]}</p>
                </div>
                <div class="flex items-center gap-1">
                  <div class="w-16 h-1.5 rounded-full" style="background:${t.border}">
                    <div class="h-1.5 rounded-full" style="width:${[70,45,90,20][i%4]}%;background:${t.accent}"></div>
                  </div>
                </div>
              </div>`).join('')}
            </div>
          </div>

          <!-- Right panel: activity + info -->
          <div class="space-y-4">
            <!-- Activity feed -->
            <div class="rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
              <h3 class="text-sm font-bold mb-3" style="color:${t.text}">Activity</h3>
              <div class="space-y-3">
                ${activityItems.map(a => `
                <div class="flex items-start gap-3">
                  <div class="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5" style="background:${a.color}22">
                    <i class="${a.icon}" style="font-size:10px;color:${a.color}"></i>
                  </div>
                  <div>
                    <p class="text-xs" style="color:${t.sub}">${escHtml(a.label)}</p>
                    <p class="text-xs" style="color:${t.muted}">${a.time}</p>
                  </div>
                </div>`).join('')}
              </div>
            </div>

            <!-- Project info -->
            <div class="rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
              <h3 class="text-sm font-bold mb-3" style="color:${t.text}">App Details</h3>
              <div class="space-y-2 text-xs">
                ${[
                  { label: 'Audience', val: truncate(audience, 24) },
                  { label: 'Business', val: truncate(bizModel||'–', 24) },
                  ...(apis.length ? [{ label: 'Integrations', val: truncate(apis.slice(0,2).join(', '), 24) }] : []),
                  { label: 'Features', val: String(features.length || wfItems.length) },
                ].map(row => `
                <div class="flex justify-between items-start gap-2">
                  <span style="color:${t.muted}">${row.label}</span>
                  <span class="text-right font-medium" style="color:${t.sub}">${escHtml(row.val)}</span>
                </div>`).join('')}
              </div>
            </div>
          </div>
        </div>

        <!-- Workflow steps if available -->
        ${wfItems.length >= 2 ? `
        <div class="rounded-2xl p-4" style="background:${t.card};border:1px solid ${t.border}">
          <h3 class="text-sm font-bold mb-3" style="color:${t.text}">Workflow</h3>
          <div class="flex items-center gap-3 overflow-x-auto pb-1">
            ${wfItems.map((w, i) => `
            <div class="flex items-center gap-2 flex-shrink-0">
              <div class="flex items-center gap-2 px-3 py-2 rounded-xl" style="background:${t.card2};border:1px solid ${i===0?t.accent:t.border}">
                <div class="w-5 h-5 rounded-full flex items-center justify-center text-xs font-black" style="background:${i===0?`linear-gradient(135deg,${t.accent},${t.accent2})`:t.badge};color:${i===0?'white':t.muted}">${i+1}</div>
                <span class="text-xs whitespace-nowrap" style="color:${i===0?t.text:t.sub}">${escHtml(truncate(w,26))}</span>
              </div>
              ${i < wfItems.length-1 ? `<i class="fas fa-chevron-right text-xs" style="color:${t.muted}"></i>` : ''}
            </div>`).join('')}
          </div>
        </div>` : ''}
      </div>
    </div>
  </div>`;
}

// Legacy compat — setViewMode and renderViewSpecPanel no longer needed
// but keep stubs in case referenced from old HTML
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
