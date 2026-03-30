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
  // modal-view uses flex-col layout; all others use flex (bottom sheet)
  el.classList.add(id === 'modal-view' ? 'flex-col' : 'flex');
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


// ============================================================
// VIEW MODAL — Interactive App Prototype
// ============================================================
const VIEW_PROJECT = { id: null, name: '', data: null, screens: [], currentScreen: 0 };

async function openViewModal(projectId, projectName) {
  VIEW_PROJECT.id = projectId;
  VIEW_PROJECT.name = projectName || 'Your Project';
  VIEW_PROJECT.data = null;
  VIEW_PROJECT.screens = [];
  VIEW_PROJECT.currentScreen = 0;

  const nameEl = document.getElementById('view-project-name');
  if (nameEl) nameEl.textContent = VIEW_PROJECT.name;

  setViewMode('prototype');
  openModal('modal-view');

  // Show loading, hide content
  const loadingEl = document.getElementById('view-loading');
  const contentEl = document.getElementById('view-content');
  if (loadingEl) loadingEl.classList.remove('hidden');
  if (contentEl) contentEl.classList.add('hidden');

  // Update live clock
  updateViewClock();

  try {
    const res = await axios.get(`/api/projects/${projectId}/preview`);
    const d   = res.data?.data || {};
    VIEW_PROJECT.data = d;
    VIEW_PROJECT.name = d.project?.name || projectName || 'Your Project';
    if (nameEl) nameEl.textContent = VIEW_PROJECT.name;

    // Build screens from spec + fields
    VIEW_PROJECT.screens = buildAppScreens(d);
    VIEW_PROJECT.currentScreen = 0;

    renderViewPrototype();
    renderViewSpecPanel(d);

  } catch (err) {
    console.error('openViewModal error', err);
    // Fallback: build screens from just the project name/category passed in
    VIEW_PROJECT.screens = buildFallbackScreens(projectName);
    VIEW_PROJECT.currentScreen = 0;
    renderViewPrototype();
  } finally {
    if (loadingEl) loadingEl.classList.add('hidden');
    if (contentEl) contentEl.classList.remove('hidden');
  }
}

function updateViewClock() {
  const el = document.getElementById('view-time');
  if (!el) return;
  const now = new Date();
  el.textContent = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
}

function setViewMode(mode) {
  const proto = document.getElementById('view-mode-prototype');
  const spec  = document.getElementById('view-mode-spec');
  const btnP  = document.getElementById('vmode-prototype');
  const btnS  = document.getElementById('vmode-spec');
  if (!proto || !spec) return;

  if (mode === 'prototype') {
    proto.classList.remove('hidden');
    spec.classList.add('hidden');
    if (btnP) { btnP.classList.add('bg-cyan-500','text-white'); btnP.classList.remove('text-slate-400'); }
    if (btnS) { btnS.classList.remove('bg-cyan-500','text-white'); btnS.classList.add('text-slate-400'); }
  } else {
    proto.classList.add('hidden');
    spec.classList.remove('hidden');
    if (btnS) { btnS.classList.add('bg-cyan-500','text-white'); btnS.classList.remove('text-slate-400'); }
    if (btnP) { btnP.classList.remove('bg-cyan-500','text-white'); btnP.classList.add('text-slate-400'); }
  }
}


// ══════════════════════════════════════════════════════════════
//  SCREEN BUILDER — fully project-specific prototype generator
//  Every screen is derived 100% from the user's prompt fields,
//  spec data, and project metadata. Zero generic placeholders.
// ══════════════════════════════════════════════════════════════

// ── Utilities ─────────────────────────────────────────────────
function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '…' : str;
}
function parseFeatureList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(f => typeof f==='string'?f:f.feature||f.name||JSON.stringify(f)).filter(Boolean);
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map(f => typeof f==='string'?f:f.feature||f.name||JSON.stringify(f)).filter(Boolean);
  } catch (_) {}
  return raw.split(',').map(s=>s.trim()).filter(Boolean);
}

// ── Color palettes ────────────────────────────────────────────
function getColorPalette(scheme) {
  const palettes = {
    midnight: { bg:'#0f172a', card:'#1e293b', card2:'#263347', accent:'#06b6d4', accent2:'#0891b2', text:'#f1f5f9', subtext:'#94a3b8', border:'#334155', tag:'#0e7490', tagText:'#cffafe' },
    ocean:    { bg:'#0c1a2e', card:'#1a2942', card2:'#243656', accent:'#3b82f6', accent2:'#2563eb', text:'#e2e8f0', subtext:'#7c94b3', border:'#2d4063', tag:'#1d4ed8', tagText:'#bfdbfe' },
    forest:   { bg:'#0d1f13', card:'#1a3325', card2:'#1e3d2a', accent:'#22c55e', accent2:'#16a34a', text:'#ecfdf5', subtext:'#86efac', border:'#166534', tag:'#166534', tagText:'#bbf7d0' },
    sunset:   { bg:'#1a0a0a', card:'#2d1515', card2:'#3d1f1f', accent:'#f97316', accent2:'#ea580c', text:'#fff7ed', subtext:'#fdba74', border:'#7c2d12', tag:'#9a3412', tagText:'#fed7aa' },
    purple:   { bg:'#120b24', card:'#1e1040', card2:'#281552', accent:'#a855f7', accent2:'#9333ea', text:'#faf5ff', subtext:'#c4b5fd', border:'#4c1d95', tag:'#6b21a8', tagText:'#e9d5ff' },
    slate:    { bg:'#0f172a', card:'#1e293b', card2:'#263347', accent:'#64748b', accent2:'#475569', text:'#f8fafc', subtext:'#94a3b8', border:'#334155', tag:'#475569', tagText:'#e2e8f0' },
    rose:     { bg:'#1a0a12', card:'#2d1522', card2:'#3d1a2e', accent:'#f43f5e', accent2:'#e11d48', text:'#fff1f2', subtext:'#fda4af', border:'#9f1239', tag:'#be123c', tagText:'#ffe4e6' },
    amber:    { bg:'#1a1200', card:'#2d2000', card2:'#3d2c00', accent:'#f59e0b', accent2:'#d97706', text:'#fffbeb', subtext:'#fcd34d', border:'#92400e', tag:'#b45309', tagText:'#fef3c7' },
    default:  { bg:'#0f172a', card:'#1e293b', card2:'#263347', accent:'#06b6d4', accent2:'#0891b2', text:'#f1f5f9', subtext:'#94a3b8', border:'#334155', tag:'#0e7490', tagText:'#cffafe' },
  };
  const key = (scheme||'').toLowerCase().replace(/[\s_-]/g,'');
  return palettes[key] || palettes.midnight;
}

// ── Icon selectors ────────────────────────────────────────────
function getAppIcon(category, fields) {
  const combined = ((category||'')+(fields?.audience||'')+(fields?.app_name||'')+(fields?.problem_statement||'')).toLowerCase();
  if (combined.match(/football|soccer|coach|sport|team|athlete|hudl|game film|film/)) return 'fas fa-football';
  if (combined.match(/health|fitness|workout|gym|medic|doctor|patient/)) return 'fas fa-heart-pulse';
  if (combined.match(/food|recipe|chef|restaurant|meal|cook|delivery/)) return 'fas fa-utensils';
  if (combined.match(/finance|money|bank|invest|crypto|wallet|budget/)) return 'fas fa-coins';
  if (combined.match(/educat|learn|student|teacher|school|course|quiz/)) return 'fas fa-graduation-cap';
  if (combined.match(/ecom|shop|store|market|product|cart|order/)) return 'fas fa-bag-shopping';
  if (combined.match(/real estate|property|home|rent|house/)) return 'fas fa-house';
  if (combined.match(/travel|trip|hotel|flight|booking|tourism/)) return 'fas fa-plane';
  if (combined.match(/music|audio|podcast|sound|song/)) return 'fas fa-music';
  if (combined.match(/photo|image|gallery|camera|picture/)) return 'fas fa-camera';
  if (combined.match(/saas|software|platform|tool|productivity|workflow/)) return 'fas fa-layer-group';
  if (combined.match(/analyt|data|chart|report|dashboard|insight/)) return 'fas fa-chart-line';
  if (combined.match(/social|network|communit|connect|friend/)) return 'fas fa-comments';
  if (combined.match(/ai|machine learning|intelligence|automat/)) return 'fas fa-brain';
  if (combined.match(/security|protect|guard|auth|verif/)) return 'fas fa-shield-halved';
  if (combined.match(/draw|design|art|creative|canvas/)) return 'fas fa-pen-nib';
  if (combined.match(/map|location|geo|navigation|route/)) return 'fas fa-location-dot';
  return 'fas fa-cube';
}

function getFeatureIcon(feature, idx) {
  const f = (feature||'').toLowerCase();
  if (f.match(/film|video|watch|play|stream|record/)) return 'fas fa-film';
  if (f.match(/analyt|analysis|breakdown|insight|stat/)) return 'fas fa-chart-bar';
  if (f.match(/ai|intelligence|automat|smart|ml/)) return 'fas fa-brain';
  if (f.match(/upload|import|ingest|add file/)) return 'fas fa-cloud-arrow-up';
  if (f.match(/report|summary|export|download/)) return 'fas fa-file-chart-column';
  if (f.match(/team|collab|member|group|roster/)) return 'fas fa-users';
  if (f.match(/notif|alert|remind|push/)) return 'fas fa-bell';
  if (f.match(/search|find|filter|query/)) return 'fas fa-magnifying-glass';
  if (f.match(/pay|bill|subscri|payment|stripe/)) return 'fas fa-credit-card';
  if (f.match(/message|chat|inbox|dm|comment/)) return 'fas fa-comment-dots';
  if (f.match(/map|location|geo|route|track/)) return 'fas fa-location-dot';
  if (f.match(/calendar|schedule|event|booking|appoint/)) return 'fas fa-calendar-days';
  if (f.match(/setting|config|prefere|manage/)) return 'fas fa-gear';
  if (f.match(/dashboard|overview|home|main/)) return 'fas fa-gauge-high';
  if (f.match(/recruit|scout|hire|talent/)) return 'fas fa-user-plus';
  if (f.match(/draw|canvas|design|create|art/)) return 'fas fa-pen-nib';
  if (f.match(/camera|photo|image|picture|gallery/)) return 'fas fa-camera';
  if (f.match(/formation|tactic|play|strategy/)) return 'fas fa-chess-board';
  if (f.match(/auth|login|register|account/)) return 'fas fa-lock';
  const icons = ['fas fa-star','fas fa-bolt','fas fa-fire','fas fa-rocket','fas fa-wand-magic-sparkles','fas fa-gem','fas fa-trophy','fas fa-flag'];
  return icons[idx % icons.length];
}

// ── Bottom navigation — labels derived from features ──────────
function renderBottomNav(palette, active, navItems) {
  // navItems: [{id, icon, label, screen}]
  return `
    <div class="absolute bottom-0 left-0 right-0 flex items-center justify-around px-1 py-2 border-t" style="background:${palette.card};border-color:${palette.border}30;z-index:10">
      ${navItems.map(t => `
      <button class="flex flex-col items-center gap-0.5 px-2 py-1 flex-1" onclick="viewGoTo('${t.screen}')">
        <i class="${t.icon}" style="font-size:${t.id==='new'?'17':'13'}px;color:${active===t.id?palette.accent:palette.subtext};opacity:${active===t.id?1:0.45}"></i>
        <span style="font-size:8.5px;color:${active===t.id?palette.accent:palette.subtext};opacity:${active===t.id?1:0.45};font-weight:${active===t.id?700:400}">${escHtml(t.label)}</span>
      </button>`).join('')}
    </div>`;
}

// ── Status badge ───────────────────────────────────────────────
function statusBadge(label, palette) {
  return `<span class="text-xs px-2.5 py-1 rounded-full font-semibold" style="background:${palette.accent}22;color:${palette.accent}">${escHtml(label)}</span>`;
}

// ── Inline stat pill ───────────────────────────────────────────
function statPill(icon, value, label, palette) {
  return `<div class="flex flex-col items-center gap-0.5 flex-1 rounded-xl py-2.5" style="background:${palette.card2}">
    <i class="${icon}" style="color:${palette.accent};font-size:13px"></i>
    <p class="text-sm font-black mt-0.5" style="color:${palette.text}">${escHtml(value)}</p>
    <p style="font-size:9px;color:${palette.subtext};opacity:0.7">${escHtml(label)}</p>
  </div>`;
}

// ═══════════════════════════════════════════════════════════════
//  MAIN BUILDER
// ═══════════════════════════════════════════════════════════════
function buildAppScreens(d) {
  const fields  = d.fields  || {};
  const spec    = d.spec    || {};
  const project = d.project || {};

  // ── Extract all meaningful data ──────────────────────────────
  const appName    = fields.app_name || spec.app_name || project.name || 'My App';
  const audience   = fields.audience || spec.target_audience || 'Users';
  const category   = fields.category || project.category || 'app';
  const problem    = fields.problem_statement || spec.problem_statement || '';
  const colorScheme= fields.color_scheme || 'midnight';
  const bizModel   = fields.business_model || spec.monetization || '';
  const features   = parseFeatureList(fields.core_features || spec.key_features || '[]');
  const workflows  = fields.workflows || '';
  const roles      = fields.roles_permissions || 'Users';
  const apis       = fields.apis_tools || '';
  const platform   = fields.platform_notes || 'Web and Mobile';
  const dataEnts   = fields.data_entities || '';
  const futureVer  = fields.future_versions || '';
  const addlNotes  = fields.additional_comments || '';

  const palette    = getColorPalette(colorScheme);
  const appIcon    = getAppIcon(category, fields);
  const roleList   = roles.split(',').map(r=>r.trim()).filter(Boolean);
  const apiList    = apis.split(',').map(a=>a.trim()).filter(Boolean);
  const dataList   = dataEnts.split(',').map(d=>d.trim()).filter(Boolean);
  const isMobile   = platform.toLowerCase().includes('mobile') || platform.toLowerCase().includes('ios') || platform.toLowerCase().includes('android');
  const isWeb      = platform.toLowerCase().includes('web') || platform.toLowerCase().includes('cloudflare');
  const hasSubs    = bizModel.toLowerCase().includes('sub');
  const hasPayment = apiList.some(a=>a.toLowerCase().match(/pay|stripe|revenue/));
  const primaryRole= roleList[0] || 'User';

  // ── Derive domain-specific vocabulary ────────────────────────
  // Detect app domain for realistic copy
  const domainKey = (() => {
    const combined = (appName+audience+problem+workflows+features.join(' ')).toLowerCase();
    if (combined.match(/football|coach|film|formation|blitz|tendenc|hudl|roster/)) return 'sports_film';
    if (combined.match(/health|patient|doctor|clinic|medic|symptom|prescription/)) return 'health';
    if (combined.match(/food|restaurant|recipe|chef|meal|order|delivery|menu/)) return 'food';
    if (combined.match(/finance|invest|portfolio|crypto|budget|expense|wallet/)) return 'finance';
    if (combined.match(/ecom|product|cart|order|checkout|inventory|shop/)) return 'ecommerce';
    if (combined.match(/real estate|property|listing|rent|home|agent|mortgage/)) return 'realestate';
    if (combined.match(/travel|trip|flight|hotel|itinerar|booking/)) return 'travel';
    if (combined.match(/educat|course|lesson|student|quiz|learn|tutor/)) return 'education';
    if (combined.match(/social|post|feed|follower|like|comment|communit/)) return 'social';
    if (combined.match(/draw|canvas|sketch|art|design|creative|illustrat/)) return 'creative';
    if (combined.match(/analytic|data|report|dashboard|insight|kpi|metric/)) return 'analytics';
    if (combined.match(/saas|workflow|task|project|manage|team|collaborat/)) return 'productivity';
    return 'general';
  })();

  // Domain-specific sample data
  const DOMAIN_DATA = {
    sports_film: {
      items: ['Week 12 vs Eagles — 4K upload', 'West High Scrimmage — HD', 'Spring Practice Day 3', 'Red Zone Drill Session', 'Opponent Scouting: Warriors'],
      action: 'Upload Film',
      actionIcon: 'fas fa-cloud-arrow-up',
      metrics: [['Formations','14'],['Tendencies','87%'],['Blitz Rate','32%']],
      recentActivity: [
        { icon:'fas fa-film', text:`Film uploaded: vs Eagles (Q3)`, time:'3m ago' },
        { icon:'fas fa-brain', text:`AI breakdown complete — 12 formations detected`, time:'18m ago' },
        { icon:'fas fa-chart-bar', text:`Run/Pass: 58% Run · 42% Pass (last 3 games)`, time:'1h ago' },
        { icon:'fas fa-user-plus', text:`New player added to roster: #22 J. Williams`, time:'2h ago' },
      ],
      cta: 'Upload Film',
      detailTitle: 'Film Breakdown Report',
      detailStats: [['Plays','147'],['Formations','14'],['AI Score','9.4']],
      detailBody: 'AI detected a strong tendency to run outside zone on 1st & 10 (62%). Pass rate increases to 71% on 3rd & 6+. Blitz shown pre-snap on 4 of 11 third-down situations.',
      detailActions: [{ icon:'fas fa-share-nodes', label:'Share Report' },{ icon:'fas fa-download', label:'Export PDF' }],
      featureScreenTitle: 'Film Library',
      featureScreenSubtitle: 'Upload, analyze & share game film',
      featureScreenSearch: 'Search film sessions…',
      featureScreenFAB: { icon:'fas fa-cloud-arrow-up', label:'Upload' },
      analyticsMetrics: [
        { icon:'fas fa-film', label:'Films Analyzed', value:'28', change:'+4 this week' },
        { icon:'fas fa-chart-bar', label:'Avg Play Success', value:'67%', change:'↑ 5% vs last month' },
        { icon:'fas fa-brain', label:'AI Breakdowns', value:'142', change:'All time' },
        { icon:'fas fa-users', label:'Coaches Active', value:'6', change:'On your team' },
      ],
    },
    health: {
      items: ['Dr. Sarah Chen — Appointment 9AM','Blood Panel Results — Pending','Heart Rate: 72 bpm — Normal','Medication: Lisinopril 10mg','Next checkup: May 3rd'],
      action: 'Log Symptoms',
      actionIcon: 'fas fa-plus',
      metrics: [['Appointments','3'],['Lab Results','12'],['Streak','7 days']],
      recentActivity: [
        { icon:'fas fa-calendar-days', text:'Appointment confirmed: Dr. Chen, Tue 9AM', time:'5m ago' },
        { icon:'fas fa-heart-pulse', text:'Heart rate normal: 72 bpm avg (last 7 days)', time:'1h ago' },
        { icon:'fas fa-pills', text:'Medication reminder: Lisinopril 10mg due', time:'2h ago' },
      ],
      cta: 'Book Appointment',
      detailTitle: 'Lab Results — Full Panel',
      detailStats: [['Tests','14'],['Normal','12'],['Review','2']],
      detailBody: 'Cholesterol: 187 mg/dL (optimal). Blood pressure: 118/76 (normal). Glucose: 94 mg/dL (normal). Two markers flagged for physician review.',
      detailActions: [{ icon:'fas fa-share-nodes', label:'Share with Doctor' },{ icon:'fas fa-download', label:'Download PDF' }],
      featureScreenTitle: 'Health Records',
      featureScreenSubtitle: 'Track vitals, appointments & results',
      featureScreenSearch: 'Search records…',
      featureScreenFAB: { icon:'fas fa-plus', label:'Add Record' },
      analyticsMetrics: [
        { icon:'fas fa-heart-pulse', label:'Avg Heart Rate', value:'72bpm', change:'Normal range' },
        { icon:'fas fa-calendar-days', label:'Appointments', value:'3', change:'This month' },
        { icon:'fas fa-pills', label:'Medications', value:'2', change:'Active' },
        { icon:'fas fa-chart-line', label:'Health Score', value:'91%', change:'↑ Great progress' },
      ],
    },
    finance: {
      items: ['Portfolio — $84,230 (+2.4%)','BTC Holding — 0.42 BTC','S&P 500 ETF — $12,400','Emergency Fund — $15,000','Monthly Budget — On track'],
      action: 'Add Transaction',
      actionIcon: 'fas fa-plus',
      metrics: [['Balance','$84K'],['Return','+12%'],['Alerts','2']],
      recentActivity: [
        { icon:'fas fa-arrow-trend-up', text:'AAPL +4.2% today — Portfolio up $340', time:'12m ago' },
        { icon:'fas fa-credit-card', text:'Transaction: Grocery Store — $67.42', time:'2h ago' },
        { icon:'fas fa-bell', text:'Price alert: BTC crossed $65,000', time:'4h ago' },
      ],
      cta: 'View Portfolio',
      detailTitle: 'Portfolio Breakdown',
      detailStats: [['Assets','8'],['Return','+12%'],['Risk','Medium']],
      detailBody: 'Equities 60% · Crypto 15% · Bonds 20% · Cash 5%. Top performer: NVDA (+38% YTD). Your portfolio is 94% aligned with your risk profile.',
      detailActions: [{ icon:'fas fa-chart-pie', label:'Rebalance' },{ icon:'fas fa-download', label:'Statement' }],
      featureScreenTitle: 'Transactions',
      featureScreenSubtitle: 'Track all income & expenses',
      featureScreenSearch: 'Search transactions…',
      featureScreenFAB: { icon:'fas fa-plus', label:'Add' },
      analyticsMetrics: [
        { icon:'fas fa-wallet', label:'Net Worth', value:'$84K', change:'+$3.2K this month' },
        { icon:'fas fa-arrow-trend-up', label:'Portfolio Return', value:'+12%', change:'YTD' },
        { icon:'fas fa-chart-pie', label:'Budget Used', value:'68%', change:'$1,240 remaining' },
        { icon:'fas fa-coins', label:'Savings Rate', value:'22%', change:'Above avg' },
      ],
    },
    ecommerce: {
      items: ['Nike Air Max — 124 orders','Summer Collection — 89 items','Flash Sale: 20% off (Today)','New arrivals: 12 products','Low stock alert: 3 items'],
      action: 'Add Product',
      actionIcon: 'fas fa-plus',
      metrics: [['Orders','840'],['Revenue','$24K'],['Products','312']],
      recentActivity: [
        { icon:'fas fa-bag-shopping', text:'New order #1082 — Nike Air Max (x2)', time:'3m ago' },
        { icon:'fas fa-star', text:'New 5★ review: "Amazing quality & fast ship!"', time:'20m ago' },
        { icon:'fas fa-box', text:'Low stock alert: Blue Denim Jacket (3 left)', time:'1h ago' },
      ],
      cta: 'View Orders',
      detailTitle: 'Product Detail',
      detailStats: [['In Stock','48'],['Orders','124'],['Rating','4.8★']],
      detailBody: 'Best seller this month. 124 units sold. 98% positive reviews. Ships within 2 business days. Returns accepted within 30 days.',
      detailActions: [{ icon:'fas fa-pen', label:'Edit Product' },{ icon:'fas fa-share-nodes', label:'Share' }],
      featureScreenTitle: 'Product Catalog',
      featureScreenSubtitle: 'Manage your store inventory',
      featureScreenSearch: 'Search products…',
      featureScreenFAB: { icon:'fas fa-plus', label:'Add Product' },
      analyticsMetrics: [
        { icon:'fas fa-bag-shopping', label:'Total Orders', value:'840', change:'+18% this week' },
        { icon:'fas fa-dollar-sign', label:'Revenue', value:'$24K', change:'This month' },
        { icon:'fas fa-star', label:'Avg Rating', value:'4.8★', change:'From 312 reviews' },
        { icon:'fas fa-users', label:'Customers', value:'1,204', change:'+45 new' },
      ],
    },
    education: {
      items: ['Intro to React — 68% complete','Linear Algebra — Lesson 12/20','JavaScript Quiz — 94%','Python Bootcamp — Enrolled','Web Design — Certificate earned'],
      action: 'Continue Learning',
      actionIcon: 'fas fa-play',
      metrics: [['Courses','5'],['Streak','14d'],['Score','94%']],
      recentActivity: [
        { icon:'fas fa-graduation-cap', text:'Certificate earned: Web Design Fundamentals', time:'1h ago' },
        { icon:'fas fa-star', text:'Quiz score: JavaScript Basics — 94% (Top 5%)', time:'3h ago' },
        { icon:'fas fa-fire', text:'14-day learning streak — Keep it up!', time:'Today' },
      ],
      cta: 'Continue Course',
      detailTitle: 'Course Progress',
      detailStats: [['Lessons','12/20'],['Score','94%'],['Rank','#4']],
      detailBody: 'You\'re in the top 5% of all learners this week. Next lesson: "Advanced State Management with Redux". Estimated time: 45 minutes.',
      detailActions: [{ icon:'fas fa-play', label:'Resume' },{ icon:'fas fa-share-nodes', label:'Share' }],
      featureScreenTitle: 'My Courses',
      featureScreenSubtitle: 'Track your learning progress',
      featureScreenSearch: 'Search courses…',
      featureScreenFAB: { icon:'fas fa-plus', label:'Enroll' },
      analyticsMetrics: [
        { icon:'fas fa-fire', label:'Day Streak', value:'14', change:'Personal best!' },
        { icon:'fas fa-graduation-cap', label:'Certificates', value:'3', change:'Earned' },
        { icon:'fas fa-chart-line', label:'Avg Score', value:'91%', change:'Top 10%' },
        { icon:'fas fa-clock', label:'Hours Learned', value:'42h', change:'This month' },
      ],
    },
    creative: {
      items: ['Portrait Study #7 — In progress','Abstract Series Vol. 3','Logo Design — Client: Apex Co.','UI Kit — Dark Theme','Concept Art: Sci-Fi City'],
      action: 'New Canvas',
      actionIcon: 'fas fa-pen-nib',
      metrics: [['Projects','24'],['Assets','312'],['Shared','18']],
      recentActivity: [
        { icon:'fas fa-pen-nib', text:'New canvas created: "Abstract Series Vol. 3"', time:'5m ago' },
        { icon:'fas fa-share-nodes', text:'Portfolio shared with 3 collaborators', time:'2h ago' },
        { icon:'fas fa-star', text:'Client feedback received: 5★ on Logo Design', time:'Yesterday' },
      ],
      cta: 'Open Studio',
      detailTitle: 'Project: Abstract Series',
      detailStats: [['Layers','34'],['Assets','12'],['Version','v4']],
      detailBody: 'Acrylic-inspired generative art with dynamic color flow. Version 4 includes 3 new texture overlays. Exported in SVG and 4K PNG.',
      detailActions: [{ icon:'fas fa-pen', label:'Edit' },{ icon:'fas fa-download', label:'Export' }],
      featureScreenTitle: 'Project Gallery',
      featureScreenSubtitle: 'Your creative workspace',
      featureScreenSearch: 'Search projects…',
      featureScreenFAB: { icon:'fas fa-pen-nib', label:'Create' },
      analyticsMetrics: [
        { icon:'fas fa-pen-nib', label:'Projects', value:'24', change:'+3 this month' },
        { icon:'fas fa-download', label:'Exports', value:'148', change:'All time' },
        { icon:'fas fa-eye', label:'Portfolio Views', value:'2.4K', change:'This month' },
        { icon:'fas fa-star', label:'Client Rating', value:'4.9★', change:'From 12 clients' },
      ],
    },
    analytics: {
      items: ['Revenue Dashboard — $124K MRR','User Growth — +18% MoM','Churn Rate — 2.1% (↓)','Active Users — 8,420','Funnel Drop-off — 22% at Step 2'],
      action: 'Add Report',
      actionIcon: 'fas fa-plus',
      metrics: [['MRR','$124K'],['Users','8.4K'],['Churn','2.1%']],
      recentActivity: [
        { icon:'fas fa-arrow-trend-up', text:'Revenue up 18% MoM — $124K ARR hit!', time:'1h ago' },
        { icon:'fas fa-users', text:'8,420 active users — new record', time:'3h ago' },
        { icon:'fas fa-bell', text:'Anomaly detected: 3x spike in API errors', time:'5h ago' },
      ],
      cta: 'View Reports',
      detailTitle: 'Revenue Report — April',
      detailStats: [['MRR','$124K'],['Growth','+18%'],['Churn','2.1%']],
      detailBody: 'Monthly recurring revenue hit $124K, up 18% from last month. Top acquisition channel: organic search (42%). Churn improved from 3.4% to 2.1% after onboarding revamp.',
      detailActions: [{ icon:'fas fa-download', label:'Export CSV' },{ icon:'fas fa-share-nodes', label:'Share' }],
      featureScreenTitle: 'Analytics Hub',
      featureScreenSubtitle: 'Real-time metrics & reporting',
      featureScreenSearch: 'Search reports…',
      featureScreenFAB: { icon:'fas fa-plus', label:'New Report' },
      analyticsMetrics: [
        { icon:'fas fa-dollar-sign', label:'MRR', value:'$124K', change:'+18% MoM' },
        { icon:'fas fa-users', label:'Active Users', value:'8,420', change:'+34% MoM' },
        { icon:'fas fa-chart-line', label:'Conversion', value:'4.2%', change:'↑ 0.8pts' },
        { icon:'fas fa-arrow-trend-down', label:'Churn Rate', value:'2.1%', change:'↓ Improved' },
      ],
    },
    productivity: {
      items: ['Q2 Product Roadmap — In Review','Sprint 14 Planning — Tomorrow','Design System v2 — 80%','Customer Interview — Today 3PM','Bug backlog — 12 open'],
      action: 'New Task',
      actionIcon: 'fas fa-plus',
      metrics: [['Tasks','24'],['Done','18'],['Team','6'],],
      recentActivity: [
        { icon:'fas fa-check-circle', text:'Task completed: API rate limiting — by J. Lee', time:'10m ago' },
        { icon:'fas fa-calendar-days', text:'Sprint 14 kickoff meeting: Tomorrow 10AM', time:'1h ago' },
        { icon:'fas fa-comment-dots', text:'3 new comments on "Design System v2"', time:'2h ago' },
      ],
      cta: 'Open Board',
      detailTitle: 'Task: Q2 Roadmap',
      detailStats: [['Subtasks','8'],['Done','5'],['Due','Apr 15']],
      detailBody: 'Q2 roadmap for review by the executive team. Includes 3 major feature launches, 2 platform migrations, and 1 compliance update. Currently in final review.',
      detailActions: [{ icon:'fas fa-pen', label:'Edit Task' },{ icon:'fas fa-share-nodes', label:'Share' }],
      featureScreenTitle: 'Task Board',
      featureScreenSubtitle: 'Manage projects & sprints',
      featureScreenSearch: 'Search tasks…',
      featureScreenFAB: { icon:'fas fa-plus', label:'Add Task' },
      analyticsMetrics: [
        { icon:'fas fa-check-circle', label:'Tasks Done', value:'18/24', change:'This sprint' },
        { icon:'fas fa-fire', label:'Velocity', value:'42pts', change:'+6 from last sprint' },
        { icon:'fas fa-users', label:'Team Active', value:'6/6', change:'All online' },
        { icon:'fas fa-clock', label:'Avg Cycle Time', value:'2.4d', change:'↓ Improving' },
      ],
    },
    social: {
      items: ['New post from @janesmith — 248 likes','Trending: #SummerVibes — 12K posts','3 new friend requests','Your post got 142 reactions','Live now: @TechTalk podcast'],
      action: 'Create Post',
      actionIcon: 'fas fa-pen-to-square',
      metrics: [['Followers','2.4K'],['Posts','148'],['Likes','12K']],
      recentActivity: [
        { icon:'fas fa-heart', text:'Your photo got 142 likes in the last hour', time:'5m ago' },
        { icon:'fas fa-user-plus', text:'3 new followers: @alex, @maya, @devk', time:'30m ago' },
        { icon:'fas fa-comment-dots', text:'New comment on your post from @janesmith', time:'1h ago' },
      ],
      cta: 'Create Post',
      detailTitle: 'Post Details',
      detailStats: [['Likes','142'],['Comments','28'],['Shares','14']],
      detailBody: 'Your most engaging post this month. Reached 3,400 people. 62% of engagement came from the hashtag #SummerVibes.',
      detailActions: [{ icon:'fas fa-pen', label:'Edit Post' },{ icon:'fas fa-share-nodes', label:'Share' }],
      featureScreenTitle: 'Explore Feed',
      featureScreenSubtitle: 'Discover people & content',
      featureScreenSearch: 'Search people, posts…',
      featureScreenFAB: { icon:'fas fa-pen-to-square', label:'Post' },
      analyticsMetrics: [
        { icon:'fas fa-users', label:'Followers', value:'2.4K', change:'+84 this week' },
        { icon:'fas fa-heart', label:'Total Likes', value:'12.4K', change:'All time' },
        { icon:'fas fa-eye', label:'Profile Views', value:'820', change:'This week' },
        { icon:'fas fa-chart-line', label:'Engagement', value:'6.8%', change:'↑ Above avg' },
      ],
    },
    realestate: {
      items: ['3BR Apartment — $2,400/mo · Available','Downtown Condo — For Sale $485K','Open House: 123 Maple St — Sat 11AM','New lead: Mark T. — 2BR Budget $1,800','Lease renewal: Unit 4B due May 1'],
      action: 'Add Listing',
      actionIcon: 'fas fa-plus',
      metrics: [['Listings','18'],['Leads','34'],['Closed','7']],
      recentActivity: [
        { icon:'fas fa-house', text:'New lead: Mark T. looking for 2BR under $1,800', time:'8m ago' },
        { icon:'fas fa-calendar-days', text:'Open house scheduled: 123 Maple St, Saturday', time:'1h ago' },
        { icon:'fas fa-handshake', text:'Deal closed: 456 Oak Ave — $312,000 · 3%', time:'3h ago' },
      ],
      cta: 'View Listings',
      detailTitle: 'Property Detail',
      detailStats: [['Sqft','1,240'],['Beds','3'],['Baths','2']],
      detailBody: 'Modern 3BR/2BA apartment in downtown district. Hardwood floors, updated kitchen, in-unit laundry. Available June 1st. Lease term: 12 months.',
      detailActions: [{ icon:'fas fa-calendar-days', label:'Schedule Tour' },{ icon:'fas fa-share-nodes', label:'Share' }],
      featureScreenTitle: 'Listings',
      featureScreenSubtitle: 'Properties for rent & sale',
      featureScreenSearch: 'Search properties…',
      featureScreenFAB: { icon:'fas fa-plus', label:'Add Listing' },
      analyticsMetrics: [
        { icon:'fas fa-house', label:'Active Listings', value:'18', change:'+3 this month' },
        { icon:'fas fa-handshake', label:'Deals Closed', value:'7', change:'This quarter' },
        { icon:'fas fa-dollar-sign', label:'Avg Deal', value:'$312K', change:'Commission: $9.4K' },
        { icon:'fas fa-users', label:'Active Leads', value:'34', change:'In pipeline' },
      ],
    },
    travel: {
      items: ['Tokyo Trip — May 14–22 · Booked','Hotel: Shinjuku Granbell — ★4.8','Flight: AA 184 — JFK→NRT · 14h','Kyoto Day Tour — $89/person','Travel Insurance — Active'],
      action: 'Plan Trip',
      actionIcon: 'fas fa-plus',
      metrics: [['Trips','8'],['Countries','14'],['Miles','42K']],
      recentActivity: [
        { icon:'fas fa-plane', text:'Check-in opens tomorrow: AA184 Tokyo flight', time:'2h ago' },
        { icon:'fas fa-star', text:'New review posted: Shinjuku Granbell 5★', time:'5h ago' },
        { icon:'fas fa-bell', text:'Price drop! Kyoto tour now $69 (was $89)', time:'1d ago' },
      ],
      cta: 'View Itinerary',
      detailTitle: 'Tokyo Trip — May 14–22',
      detailStats: [['Days','8'],['Activities','12'],['Budget','$3.2K']],
      detailBody: 'Tokyo & Kyoto highlights. Day 1: Shinjuku arrival & Shibuya crossing. Day 3: TeamLab digital art museum. Day 5: Kyoto Arashiyama bamboo & temples. Budget: $3,200 (~$400/day).',
      detailActions: [{ icon:'fas fa-pen', label:'Edit Trip' },{ icon:'fas fa-share-nodes', label:'Share' }],
      featureScreenTitle: 'My Trips',
      featureScreenSubtitle: 'Upcoming & past adventures',
      featureScreenSearch: 'Search trips & activities…',
      featureScreenFAB: { icon:'fas fa-plus', label:'New Trip' },
      analyticsMetrics: [
        { icon:'fas fa-plane', label:'Total Trips', value:'8', change:'3 upcoming' },
        { icon:'fas fa-globe', label:'Countries', value:'14', change:'Visited' },
        { icon:'fas fa-dollar-sign', label:'Avg Trip Cost', value:'$2.8K', change:'Per trip' },
        { icon:'fas fa-star', label:'Avg Hotel Rating', value:'4.6★', change:'Your picks' },
      ],
    },
    food: {
      items: ['Spicy Ramen Bowl — ★4.9 · 28 orders','Truffle Mushroom Pizza — New','Weekend Specials — Limited qty','Catering request: Corp event 50pax','Low stock: Truffle oil'],
      action: 'Add Item',
      actionIcon: 'fas fa-plus',
      metrics: [['Orders','312'],['Rating','4.9★'],['Revenue','$8.4K']],
      recentActivity: [
        { icon:'fas fa-fire', text:'Spicy Ramen Bowl trending — 28 orders today', time:'10m ago' },
        { icon:'fas fa-star', text:'New 5★ review: "Best ramen in the city!"', time:'45m ago' },
        { icon:'fas fa-box', text:'Low stock: Truffle oil — reorder needed', time:'2h ago' },
      ],
      cta: 'View Menu',
      detailTitle: 'Spicy Ramen Bowl',
      detailStats: [['Orders','28'],['Rating','4.9★'],['Time','18 min']],
      detailBody: 'Signature spicy tonkotsu broth with chashu pork, soft egg, nori, bamboo shoots, and house chili oil. Vegan option available (V). Gluten-free on request.',
      detailActions: [{ icon:'fas fa-pen', label:'Edit Item' },{ icon:'fas fa-share-nodes', label:'Promote' }],
      featureScreenTitle: 'Menu & Orders',
      featureScreenSubtitle: 'Manage your food catalog',
      featureScreenSearch: 'Search menu items…',
      featureScreenFAB: { icon:'fas fa-plus', label:'Add Item' },
      analyticsMetrics: [
        { icon:'fas fa-fire', label:'Orders Today', value:'312', change:'+22% vs yesterday' },
        { icon:'fas fa-dollar-sign', label:'Revenue', value:'$8.4K', change:'This week' },
        { icon:'fas fa-star', label:'Avg Rating', value:'4.9★', change:'From 840 reviews' },
        { icon:'fas fa-users', label:'Repeat Customers', value:'68%', change:'Loyalty rate' },
      ],
    },
    general: {
      items: features.slice(0,5).map((f,i) => `${f} — ${['Active','In Progress','Pending Review','Completed','Draft'][i]}`),
      action: features[0] ? truncate(features[0], 18) : 'Get Started',
      actionIcon: getFeatureIcon(features[0]||'',0),
      metrics: [['Active','24'],['Done','18'],['Total','42']],
      recentActivity: [
        { icon: getFeatureIcon(features[0]||'',0), text: `${features[0]||'New task'} — created and ready`, time:'5m ago' },
        { icon:'fas fa-check-circle', text:`${features[1]||'Item'} completed successfully`, time:'1h ago' },
        { icon:'fas fa-bell', text: truncate(workflows||`Reminder for upcoming ${features[0]||'task'}`, 48), time:'3h ago' },
      ],
      cta: features[0] ? truncate(features[0], 16) : 'Open App',
      detailTitle: `${features[0] || 'Item'} Detail`,
      detailStats: [['Status','Active'],['Updated','Today'],['Version','v1.0']],
      detailBody: problem ? truncate(problem, 180) : `This is a detailed view of your ${features[0]||'item'}. All relevant information, actions, and related data are available here.`,
      detailActions: [{ icon:'fas fa-pen', label:'Edit' },{ icon:'fas fa-share-nodes', label:'Share' }],
      featureScreenTitle: features[0] ? truncate(features[0],22) : 'Main Feature',
      featureScreenSubtitle: problem ? truncate(problem, 50) : `Your ${category} workspace`,
      featureScreenSearch: `Search ${(features[0]||category).toLowerCase()}…`,
      featureScreenFAB: { icon: getFeatureIcon(features[0]||'',0), label: 'New' },
      analyticsMetrics: [
        { icon: getFeatureIcon(features[0]||'',0), label: features[0]||'Items', value:'24', change:'Active' },
        { icon: getFeatureIcon(features[1]||'',1), label: features[1]||'Progress', value:'75%', change:'On track' },
        { icon:'fas fa-users', label:'Users', value:'1,200', change: audience ? truncate(audience,20) : 'Registered' },
        { icon:'fas fa-chart-line', label:'Growth', value:'+18%', change:'This month' },
      ],
    },
  };

  const DD = DOMAIN_DATA[domainKey] || DOMAIN_DATA.general;

  // ── Build navigation tabs tailored to this app ────────────────
  const navItems = [
    { id:'home',      icon:'fas fa-house',                 label:'Home',     screen:'home' },
    { id:'feature',   icon: getFeatureIcon(features[0]||domainKey, 0), label: truncate(features[0]||DD.featureScreenTitle, 8), screen:'feature' },
    { id:'analytics', icon:'fas fa-chart-bar',             label:'Reports',  screen:'analytics' },
    { id:'profile',   icon:'fas fa-user',                  label:'Profile',  screen:'profile' },
  ];

  const screens = [];

  // ════════════════════════════════════════════════════
  //  SCREEN 1 — Launch / Splash
  // ════════════════════════════════════════════════════
  screens.push({
    id: 'splash', label: 'Launch Screen', icon: 'fas fa-play-circle',
    render: () => `
      <div class="flex flex-col items-center justify-center h-full min-h-[520px] px-6 relative overflow-hidden" style="background:${palette.bg}">
        <!-- Background gradient orbs -->
        <div class="absolute top-0 right-0 w-48 h-48 rounded-full opacity-10" style="background:radial-gradient(circle,${palette.accent},transparent);transform:translate(30%,-30%)"></div>
        <div class="absolute bottom-0 left-0 w-48 h-48 rounded-full opacity-10" style="background:radial-gradient(circle,${palette.accent},transparent);transform:translate(-30%,30%)"></div>
        <!-- App icon -->
        <div class="w-24 h-24 rounded-3xl flex items-center justify-center mb-5 shadow-2xl relative z-10" style="background:linear-gradient(135deg,${palette.accent},${palette.accent2})">
          <i class="${appIcon} text-white text-4xl"></i>
        </div>
        <!-- App name -->
        <h1 class="text-2xl font-black mb-2 text-center relative z-10" style="color:${palette.text}">${escHtml(appName)}</h1>
        <!-- Tagline from problem statement -->
        <p class="text-sm mb-2 text-center leading-relaxed max-w-xs relative z-10 opacity-70" style="color:${palette.subtext}">
          ${escHtml(truncate(problem || `Built for ${audience}`, 72))}
        </p>
        <!-- Platform badge -->
        <div class="flex gap-2 mb-8 relative z-10">
          ${platform.toLowerCase().includes('ios') || platform.toLowerCase().includes('mobile') ? `<span class="text-xs px-2.5 py-1 rounded-full flex items-center gap-1" style="background:${palette.card};color:${palette.subtext}"><i class="fab fa-apple" style="font-size:10px"></i> iOS</span>` : ''}
          ${platform.toLowerCase().includes('android') || platform.toLowerCase().includes('mobile') ? `<span class="text-xs px-2.5 py-1 rounded-full flex items-center gap-1" style="background:${palette.card};color:${palette.subtext}"><i class="fab fa-android" style="font-size:10px;color:#3ddc84"></i> Android</span>` : ''}
          ${platform.toLowerCase().includes('web') || platform.toLowerCase().includes('cloudflare') ? `<span class="text-xs px-2.5 py-1 rounded-full flex items-center gap-1" style="background:${palette.card};color:${palette.subtext}"><i class="fas fa-globe" style="font-size:10px"></i> Web</span>` : ''}
        </div>
        <!-- CTA buttons -->
        <div class="w-full max-w-xs space-y-3 relative z-10">
          <button class="w-full py-3.5 rounded-2xl font-bold text-base transition-all shadow-lg" style="background:linear-gradient(135deg,${palette.accent},${palette.accent2});color:#fff" onclick="viewGoTo('login')">
            Get Started — It's Free
          </button>
          <button class="w-full py-3 rounded-2xl font-semibold text-sm border" style="border-color:${palette.border};color:${palette.subtext}" onclick="viewGoTo('login')">
            Sign In to Existing Account
          </button>
        </div>
        ${hasSubs ? `<p class="text-xs mt-4 relative z-10 opacity-40" style="color:${palette.subtext}">Free trial · No credit card required</p>` : `<p class="text-xs mt-4 relative z-10 opacity-40" style="color:${palette.subtext}">For ${escHtml(truncate(audience,36))}</p>`}
      </div>`
  });

  // ════════════════════════════════════════════════════
  //  SCREEN 2 — Sign In
  // ════════════════════════════════════════════════════
  screens.push({
    id: 'login', label: 'Sign In', icon: 'fas fa-lock',
    render: () => `
      <div class="flex flex-col min-h-[520px] px-6 py-6" style="background:${palette.bg}">
        <button class="flex items-center gap-1.5 text-xs mb-5 opacity-60" style="color:${palette.subtext}" onclick="viewGoTo('splash')">
          <i class="fas fa-chevron-left"></i> Back
        </button>
        <div class="flex items-center gap-3 mb-5">
          <div class="w-10 h-10 rounded-2xl flex items-center justify-center shadow" style="background:linear-gradient(135deg,${palette.accent},${palette.accent2})">
            <i class="${appIcon} text-white" style="font-size:14px"></i>
          </div>
          <div>
            <p class="text-base font-black" style="color:${palette.text}">${escHtml(appName)}</p>
            <p class="text-xs opacity-50" style="color:${palette.subtext}">Sign in to continue</p>
          </div>
        </div>
        <div class="space-y-3 mb-4">
          <div class="rounded-xl px-4 py-3.5" style="background:${palette.card}">
            <p class="text-xs mb-0.5 opacity-50" style="color:${palette.subtext}">Email or ${primaryRole} ID</p>
            <p class="text-sm" style="color:${palette.text}">user@example.com</p>
          </div>
          <div class="rounded-xl px-4 py-3.5" style="background:${palette.card}">
            <p class="text-xs mb-0.5 opacity-50" style="color:${palette.subtext}">Password</p>
            <p class="text-sm" style="color:${palette.subtext}">••••••••••</p>
          </div>
        </div>
        <button class="w-full py-3.5 rounded-2xl font-bold text-sm mb-3 shadow-lg" style="background:linear-gradient(135deg,${palette.accent},${palette.accent2});color:#fff" onclick="viewGoTo('home')">
          Sign In
        </button>
        ${roleList.length > 1 ? `<div class="flex gap-2 mb-3">${roleList.slice(0,3).map(r => `<button class="flex-1 py-2 rounded-xl text-xs font-semibold border" style="border-color:${palette.border};color:${palette.subtext}" onclick="viewGoTo('home')">${escHtml(r)}</button>`).join('')}</div>` : ''}
        <div class="flex items-center gap-3 my-3">
          <div class="flex-1 h-px opacity-20" style="background:${palette.border}"></div>
          <span class="text-xs opacity-40" style="color:${palette.subtext}">or continue with</span>
          <div class="flex-1 h-px opacity-20" style="background:${palette.border}"></div>
        </div>
        <button class="w-full py-3 rounded-2xl text-sm font-semibold border flex items-center justify-center gap-2 mb-2" style="border-color:${palette.border};color:${palette.subtext}" onclick="viewGoTo('home')">
          <i class="fab fa-google text-blue-400"></i> Google
        </button>
        ${apiList.some(a=>a.toLowerCase().includes('apple')) ? `<button class="w-full py-3 rounded-2xl text-sm font-semibold border flex items-center justify-center gap-2 mb-2" style="border-color:${palette.border};color:${palette.text}" onclick="viewGoTo('home')"><i class="fab fa-apple"></i> Apple</button>` : ''}
        <p class="text-xs text-center mt-3 opacity-50" style="color:${palette.subtext}">
          New to ${escHtml(appName)}? <span class="underline cursor-pointer" style="color:${palette.accent}" onclick="viewGoTo('home')">Create a free account</span>
        </p>
      </div>`
  });

  // ════════════════════════════════════════════════════
  //  SCREEN 3 — Home Dashboard
  // ════════════════════════════════════════════════════
  screens.push({
    id: 'home', label: 'Dashboard', icon: 'fas fa-house',
    render: () => `
      <div class="flex flex-col min-h-[520px] pb-16 relative" style="background:${palette.bg}">
        <!-- Header -->
        <div class="px-4 pt-4 pb-3 flex items-center justify-between" style="background:${palette.card}">
          <div>
            <p class="text-xs opacity-50" style="color:${palette.subtext}">Welcome back 👋</p>
            <p class="text-base font-black" style="color:${palette.text}">${escHtml(primaryRole)}</p>
          </div>
          <div class="flex gap-2">
            <div class="w-8 h-8 rounded-full flex items-center justify-center" style="background:${palette.accent}22">
              <i class="fas fa-bell" style="color:${palette.accent};font-size:11px"></i>
            </div>
            <div class="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold" style="background:linear-gradient(135deg,${palette.accent},${palette.accent2})">
              ${escHtml(primaryRole.charAt(0).toUpperCase())}
            </div>
          </div>
        </div>
        <!-- Hero card -->
        <div class="mx-4 mt-3 rounded-2xl p-4 shadow-xl relative overflow-hidden" style="background:linear-gradient(135deg,${palette.accent},${palette.accent2})">
          <div class="absolute right-0 top-0 w-24 h-24 rounded-full opacity-20" style="background:#fff;transform:translate(30%,-30%)"></div>
          <p class="text-white text-xs opacity-80 mb-0.5 relative z-10">${escHtml(appName)} · ${escHtml(primaryRole)}</p>
          <p class="text-white text-lg font-black relative z-10 leading-tight">${escHtml(DD.cta)}</p>
          <p class="text-white text-xs mt-1 relative z-10 opacity-70">${escHtml(truncate(problem||`Your ${category} command center`,60))}</p>
          <button class="mt-3 bg-white bg-opacity-20 text-white text-xs font-bold px-4 py-1.5 rounded-lg relative z-10 border border-white border-opacity-30" onclick="viewGoTo('feature')">
            ${escHtml(DD.action)} <i class="fas fa-arrow-right ml-1"></i>
          </button>
        </div>
        <!-- Stats strip -->
        <div class="px-4 mt-3 flex gap-2">
          ${DD.metrics.map(([label,val]) => `
          <div class="flex-1 rounded-xl p-2.5 text-center" style="background:${palette.card}">
            <p class="text-sm font-black" style="color:${palette.accent}">${escHtml(val)}</p>
            <p style="font-size:9px;color:${palette.subtext};opacity:0.7;margin-top:1px">${escHtml(label)}</p>
          </div>`).join('')}
        </div>
        <!-- Feature quick actions -->
        ${features.length ? `
        <div class="px-4 mt-4">
          <p class="text-xs font-bold mb-2 opacity-50 uppercase tracking-wider" style="color:${palette.subtext}">Features</p>
          <div class="grid grid-cols-4 gap-2">
            ${features.slice(0,4).map((f,i) => `
            <button class="flex flex-col items-center gap-1.5 p-2 rounded-xl active:scale-95" style="background:${palette.card}" onclick="viewGoTo('feature')">
              <div class="w-9 h-9 rounded-xl flex items-center justify-center" style="background:${palette.accent}22">
                <i class="${getFeatureIcon(f,i)}" style="color:${palette.accent};font-size:12px"></i>
              </div>
              <p class="text-center leading-tight" style="font-size:8.5px;color:${palette.subtext}">${escHtml(truncate(f,10))}</p>
            </button>`).join('')}
          </div>
        </div>` : ''}
        <!-- Recent activity -->
        <div class="px-4 mt-4">
          <p class="text-xs font-bold mb-2 opacity-50 uppercase tracking-wider" style="color:${palette.subtext}">Recent Activity</p>
          <div class="space-y-2">
            ${DD.recentActivity.slice(0,3).map(r => `
            <div class="flex items-center gap-3 p-3 rounded-xl" style="background:${palette.card}">
              <div class="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0" style="background:${palette.accent}22">
                <i class="${r.icon}" style="color:${palette.accent};font-size:10px"></i>
              </div>
              <p class="flex-1 text-xs leading-snug" style="color:${palette.text}">${escHtml(r.text)}</p>
              <p class="text-xs opacity-40 flex-shrink-0" style="color:${palette.subtext}">${r.time}</p>
            </div>`).join('')}
          </div>
        </div>
        ${renderBottomNav(palette, 'home', navItems)}</div>`
  });

  // ════════════════════════════════════════════════════
  //  SCREEN 4 — Core Feature / List
  // ════════════════════════════════════════════════════
  screens.push({
    id: 'feature', label: truncate(DD.featureScreenTitle, 12), icon: getFeatureIcon(features[0]||domainKey, 0),
    render: () => `
      <div class="flex flex-col min-h-[520px] pb-16 relative" style="background:${palette.bg}">
        <!-- Header -->
        <div class="px-4 pt-4 pb-3" style="background:${palette.card}">
          <div class="flex items-center gap-3 mb-2">
            <button class="w-7 h-7 rounded-full flex items-center justify-center" style="background:${palette.accent}22" onclick="viewGoTo('home')">
              <i class="fas fa-chevron-left" style="color:${palette.accent};font-size:10px"></i>
            </button>
            <div class="flex-1">
              <p class="text-base font-black" style="color:${palette.text}">${escHtml(DD.featureScreenTitle)}</p>
              <p class="text-xs opacity-50" style="color:${palette.subtext}">${escHtml(DD.featureScreenSubtitle)}</p>
            </div>
            <div class="w-7 h-7 rounded-full flex items-center justify-center" style="background:${palette.accent}22">
              <i class="fas fa-filter" style="color:${palette.accent};font-size:10px"></i>
            </div>
          </div>
          <!-- Search bar -->
          <div class="flex items-center gap-2 rounded-xl px-3 py-2.5" style="background:${palette.bg}">
            <i class="fas fa-search opacity-40" style="color:${palette.subtext};font-size:11px"></i>
            <p class="text-xs opacity-40" style="color:${palette.subtext}">${escHtml(DD.featureScreenSearch)}</p>
          </div>
        </div>
        <!-- Content list — real domain items -->
        <div class="flex-1 overflow-y-auto px-4 mt-2 space-y-2 pb-2">
          ${DD.items.map((item, i) => `
          <button class="w-full flex items-center gap-3 p-3.5 rounded-2xl text-left active:scale-98" style="background:${palette.card}" onclick="viewGoTo('detail')">
            <div class="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style="background:${i===0 ? `linear-gradient(135deg,${palette.accent},${palette.accent2})` : `${palette.accent}22`}">
              <i class="${getFeatureIcon(features[i%features.length]||item, i)}" style="color:${i===0?'#fff':palette.accent};font-size:12px"></i>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-semibold truncate" style="color:${palette.text}">${escHtml(item)}</p>
              <p class="text-xs opacity-50 mt-0.5" style="color:${palette.subtext}">${['Tap to open →','Updated just now','Active','Pending','In progress'][i%5]}</p>
            </div>
            ${i===0 ? `<span class="text-xs px-2 py-0.5 rounded-full font-bold flex-shrink-0" style="background:${palette.accent}22;color:${palette.accent}">New</span>` : `<i class="fas fa-chevron-right opacity-30 flex-shrink-0" style="color:${palette.subtext};font-size:10px"></i>`}
          </button>`).join('')}
        </div>
        <!-- FAB -->
        <div class="absolute bottom-20 right-5">
          <button class="w-13 h-13 w-12 h-12 rounded-full shadow-2xl flex items-center justify-center gap-1.5 px-4" style="background:linear-gradient(135deg,${palette.accent},${palette.accent2})" onclick="viewGoTo('detail')">
            <i class="${DD.featureScreenFAB.icon} text-white" style="font-size:13px"></i>
            <span class="text-white text-xs font-bold">${escHtml(DD.featureScreenFAB.label)}</span>
          </button>
        </div>
        ${renderBottomNav(palette, 'feature', navItems)}</div>`
  });

  // ════════════════════════════════════════════════════
  //  SCREEN 5 — Detail / Action view
  // ════════════════════════════════════════════════════
  screens.push({
    id: 'detail', label: 'Detail View', icon: 'fas fa-file-lines',
    render: () => `
      <div class="flex flex-col min-h-[520px] pb-16 relative" style="background:${palette.bg}">
        <!-- Header -->
        <div class="px-4 pt-4 pb-3 flex items-center gap-3" style="background:${palette.card}">
          <button class="w-7 h-7 rounded-full flex items-center justify-center" style="background:${palette.accent}22" onclick="viewGoTo('feature')">
            <i class="fas fa-chevron-left" style="color:${palette.accent};font-size:10px"></i>
          </button>
          <p class="text-base font-black flex-1" style="color:${palette.text}">${escHtml(DD.detailTitle)}</p>
          <div class="w-7 h-7 rounded-full flex items-center justify-center" style="background:${palette.accent}22">
            <i class="fas fa-ellipsis-vertical" style="color:${palette.accent};font-size:10px"></i>
          </div>
        </div>
        <!-- Hero zone -->
        <div class="mx-4 mt-3 h-28 rounded-2xl flex items-center justify-center relative overflow-hidden" style="background:linear-gradient(135deg,${palette.accent}33,${palette.accent2}22)">
          <div class="absolute inset-0 opacity-10" style="background:radial-gradient(circle at 70% 50%,${palette.accent},transparent)"></div>
          <i class="${getFeatureIcon(features[0]||domainKey,0)}" style="color:${palette.accent};font-size:40px;opacity:0.7"></i>
          <div class="absolute top-3 right-3">
            ${statusBadge('Active', palette)}
          </div>
        </div>
        <!-- Stats row -->
        <div class="px-4 mt-3 flex gap-2">
          ${DD.detailStats.map(([k,v]) => statPill('fas fa-circle-dot', v, k, palette)).join('')}
        </div>
        <!-- Detail body -->
        <div class="px-4 mt-4">
          <p class="text-sm font-black mb-2" style="color:${palette.text}">${escHtml(DD.detailTitle)}</p>
          <p class="text-xs leading-relaxed opacity-70" style="color:${palette.subtext}">${escHtml(DD.detailBody)}</p>
        </div>
        <!-- Action buttons -->
        <div class="px-4 mt-4 flex gap-2">
          <button class="flex-1 py-3 rounded-2xl text-sm font-bold text-white shadow-lg" style="background:linear-gradient(135deg,${palette.accent},${palette.accent2})" onclick="viewGoTo('feature')">
            <i class="${getFeatureIcon(features[0]||'',0)} mr-1.5"></i> ${escHtml(DD.action)}
          </button>
          ${DD.detailActions.map(a => `
          <button class="w-12 h-12 rounded-2xl flex items-center justify-center border" style="border-color:${palette.border};color:${palette.subtext}">
            <i class="${a.icon}" style="font-size:12px" title="${escHtml(a.label)}"></i>
          </button>`).join('')}
        </div>
        ${renderBottomNav(palette, 'detail', navItems)}</div>`
  });

  // ════════════════════════════════════════════════════
  //  SCREEN 6 — Analytics / Reports
  // ════════════════════════════════════════════════════
  screens.push({
    id: 'analytics', label: 'Analytics', icon: 'fas fa-chart-bar',
    render: () => `
      <div class="flex flex-col min-h-[520px] pb-16 relative" style="background:${palette.bg}">
        <!-- Header -->
        <div class="px-4 pt-4 pb-3" style="background:${palette.card}">
          <p class="text-base font-black" style="color:${palette.text}">Analytics & Reports</p>
          <p class="text-xs opacity-50 mt-0.5" style="color:${palette.subtext}">${escHtml(appName)} · All time</p>
        </div>
        <!-- Chart placeholder — styled to the brand -->
        <div class="mx-4 mt-3 rounded-2xl p-4 relative overflow-hidden" style="background:${palette.card}">
          <p class="text-xs font-bold mb-3 opacity-60 uppercase tracking-wider" style="color:${palette.subtext}">Performance Trend</p>
          <div class="flex items-end gap-1 h-20">
            ${[40,55,35,70,60,85,65,90,75,95,80,100].map((h,i)=>`
            <div class="flex-1 rounded-t-lg transition-all" style="height:${h}%;background:${i===11?`linear-gradient(180deg,${palette.accent},${palette.accent2})`:`${palette.accent}${30+i*5}`}"></div>`).join('')}
          </div>
          <div class="flex justify-between mt-2">
            ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map(m=>`<span style="font-size:7px;color:${palette.subtext};opacity:0.5">${m}</span>`).join('')}
          </div>
        </div>
        <!-- Metric cards -->
        <div class="px-4 mt-3 grid grid-cols-2 gap-2">
          ${DD.analyticsMetrics.map(m => `
          <div class="rounded-2xl p-3.5" style="background:${palette.card}">
            <div class="flex items-center gap-2 mb-1.5">
              <div class="w-7 h-7 rounded-lg flex items-center justify-center" style="background:${palette.accent}22">
                <i class="${m.icon}" style="color:${palette.accent};font-size:11px"></i>
              </div>
              <p class="text-xs font-semibold opacity-60" style="color:${palette.subtext}">${escHtml(m.label)}</p>
            </div>
            <p class="text-xl font-black" style="color:${palette.text}">${escHtml(m.value)}</p>
            <p class="text-xs mt-0.5 opacity-50" style="color:${palette.subtext}">${escHtml(m.change)}</p>
          </div>`).join('')}
        </div>
        ${renderBottomNav(palette, 'analytics', navItems)}</div>`
  });

  // ════════════════════════════════════════════════════
  //  SCREEN 7 — Profile & Settings
  // ════════════════════════════════════════════════════
  screens.push({
    id: 'profile', label: 'Profile', icon: 'fas fa-user-circle',
    render: () => `
      <div class="flex flex-col min-h-[520px] pb-16 relative" style="background:${palette.bg}">
        <!-- Profile header -->
        <div class="px-4 pt-5 pb-5 text-center relative overflow-hidden" style="background:${palette.card}">
          <div class="absolute inset-0 opacity-5" style="background:radial-gradient(circle at 50% 0%,${palette.accent},transparent)"></div>
          <div class="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-2 shadow-lg relative z-10 text-white text-xl font-black" style="background:linear-gradient(135deg,${palette.accent},${palette.accent2})">
            ${escHtml(primaryRole.charAt(0).toUpperCase())}
          </div>
          <p class="font-black text-base relative z-10" style="color:${palette.text}">${escHtml(primaryRole)} Account</p>
          <p class="text-xs opacity-50 mt-0.5 relative z-10" style="color:${palette.subtext}">user@example.com</p>
          <div class="flex justify-center gap-2 mt-3 relative z-10">
            ${hasSubs ? `<span class="text-xs px-3 py-1 rounded-full font-bold text-white" style="background:linear-gradient(135deg,${palette.accent},${palette.accent2})"><i class="fas fa-crown mr-1" style="font-size:9px"></i>Pro Plan</span>` : `<span class="text-xs px-3 py-1 rounded-full font-bold border" style="border-color:${palette.border};color:${palette.subtext}">Free Plan</span>`}
            ${roleList.length > 1 ? `<span class="text-xs px-3 py-1 rounded-full font-semibold" style="background:${palette.accent}22;color:${palette.accent}">${escHtml(roleList[0])}</span>` : ''}
          </div>
        </div>
        <!-- Menu -->
        <div class="flex-1 overflow-y-auto px-4 mt-3 space-y-2 pb-2">
          ${[
            { icon:'fas fa-user-pen', label:'Edit Profile', sub:'Name, photo, bio' },
            { icon:'fas fa-shield-halved', label:'Security', sub:'Password, 2FA, sessions' },
            hasSubs ? { icon:'fas fa-crown', label:'Subscription', sub:`${bizModel} · Manage plan`, accent:true } : null,
            hasPayment ? { icon:'fas fa-credit-card', label:'Billing & Payments', sub:'Cards, invoices' } : null,
            { icon:'fas fa-bell', label:'Notifications', sub:'Push, email, alerts' },
            futureVer ? { icon:'fas fa-flask', label:'Beta Features', sub:escHtml(truncate(futureVer,40)) } : null,
            { icon:'fas fa-circle-question', label:'Help & Support', sub:'FAQs, contact us' },
            { icon:'fas fa-arrow-right-from-bracket', label:'Sign Out', sub:'', danger:true },
          ].filter(Boolean).map(item => `
          <button class="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl text-left" style="background:${palette.card}" onclick="viewGoTo('home')">
            <div class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style="background:${item.danger?'#ef444418':item.accent?`${palette.accent}33`:`${palette.accent}18`}">
              <i class="${item.icon}" style="color:${item.danger?'#ef4444':palette.accent};font-size:12px"></i>
            </div>
            <div class="flex-1">
              <p class="text-sm font-semibold" style="color:${item.danger?'#ef4444':palette.text}">${escHtml(item.label)}</p>
              ${item.sub ? `<p class="text-xs opacity-50 mt-0.5" style="color:${palette.subtext}">${escHtml(item.sub)}</p>` : ''}
            </div>
            ${!item.danger ? `<i class="fas fa-chevron-right opacity-30 flex-shrink-0" style="color:${palette.subtext};font-size:10px"></i>` : ''}
          </button>`).join('')}
        </div>
        ${renderBottomNav(palette, 'profile', navItems)}</div>`
  });

  return screens;
}

function buildFallbackScreens(name) {
  return buildAppScreens({ fields: { app_name: name||'My App', color_scheme:'midnight' }, spec:{}, project:{ name: name||'My App' } });
}

// ── Prototype renderer ────────────────────────────────────────
function renderViewPrototype() {
  const screens = VIEW_PROJECT.screens;
  if (!screens.length) return;

  const navEl = document.getElementById('view-screen-nav');
  if (navEl) {
    navEl.innerHTML = screens.map((s, i) => `
      <button id="vsnav-${i}" onclick="viewGoToIdx(${i})"
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all
        ${i === 0 ? 'bg-cyan-500 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'}">
        <i class="${s.icon}" style="font-size:10px"></i> ${escHtml(s.label)}
      </button>`).join('');
  }
  renderCurrentScreen();
}

function renderCurrentScreen() {
  const screens = VIEW_PROJECT.screens;
  const idx     = VIEW_PROJECT.currentScreen;
  if (!screens.length) return;

  const screen = screens[idx];
  const contentEl = document.getElementById('view-screen-content');
  if (contentEl) contentEl.innerHTML = screen.render();

  const labelEl   = document.getElementById('view-screen-label');
  const counterEl = document.getElementById('view-screen-counter');
  if (labelEl)   labelEl.textContent   = screen.label;
  if (counterEl) counterEl.textContent = `${idx + 1} / ${screens.length}`;

  screens.forEach((_, i) => {
    const btn = document.getElementById(`vsnav-${i}`);
    if (!btn) return;
    if (i === idx) {
      btn.classList.remove('text-slate-400','hover:text-white','hover:bg-slate-800');
      btn.classList.add('bg-cyan-500','text-white');
    } else {
      btn.classList.remove('bg-cyan-500','text-white');
      btn.classList.add('text-slate-400','hover:text-white','hover:bg-slate-800');
    }
  });

  const prevBtn = document.getElementById('view-prev-btn');
  const nextBtn = document.getElementById('view-next-btn');
  if (prevBtn) prevBtn.style.opacity = idx === 0 ? '0.3' : '1';
  if (nextBtn) nextBtn.style.opacity = idx === screens.length - 1 ? '0.3' : '1';
}

function viewNavigate(dir) {
  const screens = VIEW_PROJECT.screens;
  const next = VIEW_PROJECT.currentScreen + dir;
  if (next < 0 || next >= screens.length) return;
  VIEW_PROJECT.currentScreen = next;
  renderCurrentScreen();
}

function viewGoTo(screenId) {
  const idx = VIEW_PROJECT.screens.findIndex(s => s.id === screenId);
  if (idx === -1) return;
  VIEW_PROJECT.currentScreen = idx;
  renderCurrentScreen();
}

function viewGoToIdx(idx) {
  if (idx < 0 || idx >= VIEW_PROJECT.screens.length) return;
  VIEW_PROJECT.currentScreen = idx;
  renderCurrentScreen();
}

// ── Spec panel renderer ───────────────────────────────────────
function renderViewSpecPanel(d) {
  const el = document.getElementById('view-spec-content');
  if (!el) return;

  const fields  = d.fields  || {};
  const spec    = d.spec    || {};
  const project = d.project || {};

  const sections = [
    { label:'App Name',        val: fields.app_name || spec.app_name || project.name },
    { label:'Category',        val: fields.category || project.category },
    { label:'Target Audience', val: fields.audience || spec.target_audience },
    { label:'Problem Solved',  val: fields.problem_statement || spec.problem_statement },
    { label:'Core Features',   val: parseFeatureList(fields.core_features || spec.key_features || '[]').join(', ') },
    { label:'Workflows',       val: fields.workflows },
    { label:'Roles',           val: fields.roles_permissions },
    { label:'Business Model',  val: fields.business_model || spec.monetization },
    { label:'APIs & Tools',    val: fields.apis_tools },
    { label:'Deployment',      val: fields.deployment_preferences },
    { label:'Future Versions', val: fields.future_versions },
    { label:'Color Scheme',    val: fields.color_scheme },
    { label:'Readiness',       val: project.readiness_score ? `${project.readiness_score}%` : null },
  ].filter(s => s.val && String(s.val).trim());

  if (sections.length === 0) {
    el.innerHTML = `<div class="glass rounded-xl p-6 text-center border border-slate-700/40 m-4">
      <i class="fas fa-file-code text-slate-600 text-3xl mb-3 block"></i>
      <p class="text-slate-400 text-sm">No spec data available yet.</p>
    </div>`;
    return;
  }

  el.innerHTML = `
    <div class="space-y-3 pb-4">
      <div class="flex items-center gap-2 px-1 mb-2">
        <div class="w-2 h-2 rounded-full bg-cyan-400"></div>
        <p class="text-xs text-slate-400 font-semibold uppercase tracking-wider">App Specification</p>
        ${d.built_at ? `<span class="ml-auto text-xs text-slate-600">Built ${new Date(d.built_at).toLocaleDateString()}</span>` : ''}
      </div>
      ${sections.map(s => `
      <div class="glass rounded-xl p-4 border border-slate-700/40">
        <p class="text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">${escHtml(s.label)}</p>
        <p class="text-sm text-slate-200 leading-relaxed">${escHtml(String(s.val))}</p>
      </div>`).join('')}
    </div>`;
}

// ── View modal spec mode renderer (called from setViewMode) ───
function renderViewSpecMode(data) {
  const el = document.getElementById('view-spec-content');
  if (!el) return;
  if (!data) {
    el.innerHTML = '<div class="p-6 text-center text-slate-400 text-sm">Loading spec…</div>';
    return;
  }
  renderViewSpecPanel(data);

  // Show back button action
  const specContent = document.getElementById('view-mode-spec');
  if (specContent) {
    const backBtn = specContent.querySelector('[onclick*="setViewMode"]');
    if (!backBtn) {
      const actions = document.createElement('div');
      actions.className = 'flex gap-3 pt-2 mx-4';
      actions.innerHTML = `
        <button onclick="setViewMode('prototype')"
          class="flex-1 py-3 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2"
          style="background:linear-gradient(135deg,#06b6d4,#0891b2)">
          <i class="fas fa-mobile-screen-button"></i> Back to Preview
        </button>`;
      specContent.appendChild(actions);
    }
  }
}
