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
document.addEventListener('DOMContentLoaded', () => {
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
const PROMPT_SECTIONS_CONFIG = [
  {
    key: 'app_info', label: 'App Info', icon: 'fa-circle-info',
    fields: [
      { key: 'app_name', label: 'App Name', type: 'text', placeholder: 'e.g. TaskFlow Pro', required: true },
      { key: 'category', label: 'Category', type: 'select', options: ['SaaS Platform','Mobile App','E-Commerce','Dashboard','API/Backend','Marketplace','Other'] },
      { key: 'audience', label: 'Target Audience', type: 'textarea', placeholder: 'Who is this app for? Describe their role, pain points, technical level.' },
      { key: 'problem_statement', label: 'Problem Statement', type: 'textarea', placeholder: 'What specific problem does this app solve? Be as clear as possible.' }
    ]
  },
  {
    key: 'features', label: 'Core Features', icon: 'fa-list-check',
    fields: [
      { key: 'core_features', label: 'Core Features (MVP)', type: 'feature-list', placeholder: 'Describe a feature…', rows: 2, hint: 'Add as many or as few as you like. AI will handle anything you leave out.' },
      { key: 'roles_permissions', label: 'User Roles & Permissions', type: 'textarea', placeholder: 'What types of users are there? (e.g., Admin, Member, Guest)' }
    ]
  },
  {
    key: 'visual', label: 'Visual & Frontend', icon: 'fa-palette',
    fields: [
      { key: 'color_scheme', label: 'Color Scheme', type: 'color-scheme', hint: 'Pick a primary palette direction. AI will handle the rest.' },
      { key: 'visual_style', label: 'Visual Style', type: 'select', options: ['Minimal & Clean','Dark & Futuristic','Light & Airy','Bold & Vibrant','Corporate & Professional','Playful & Friendly','Luxury & Premium'] },
      { key: 'visual_features', label: 'Frontend Features', type: 'feature-list', placeholder: 'e.g. dark mode, animated transitions, drag-and-drop cards…', rows: 2, hint: 'Optional — list any specific UI/UX features you want. AI will handle the rest.' },
      { key: 'ui_ux_notes', label: 'Additional UI/UX Notes', type: 'textarea', placeholder: 'Any other look, feel, or experience details — layout, navigation style, tone, etc.' }
    ]
  },
  {
    key: 'technical', label: 'Technical', icon: 'fa-code',
    fields: [
      { key: 'workflows', label: 'Key Workflows', type: 'textarea', placeholder: 'Describe the main user journeys step by step.', rows: 4 },
      { key: 'data_entities', label: 'Data Entities', type: 'textarea', placeholder: 'List the main data objects (e.g., Users, Projects, Orders).' },
      { key: 'apis_tools', label: 'APIs & Integrations', type: 'textarea', placeholder: 'Any external services needed? (e.g., payments, email, maps)' }
    ]
  },
  {
    key: 'business', label: 'Business', icon: 'fa-chart-line',
    fields: [
      { key: 'business_model', label: 'Business Model', type: 'textarea', placeholder: 'How does this app make money? Subscriptions, one-time, freemium?' },
      { key: 'mvp_guardrails', label: 'MVP Guardrails', type: 'textarea', placeholder: 'What is explicitly OUT of scope for version 1?' },
      { key: 'future_versions', label: 'Future Versions', type: 'textarea', placeholder: 'What would you add in v2, v3?' }
    ]
  },
  {
    key: 'deployment', label: 'Deployment', icon: 'fa-rocket',
    fields: [
      { key: 'deployment_preferences', label: 'Deployment Preferences', type: 'textarea', placeholder: 'Any specific hosting, region, or infrastructure requirements?' },
      { key: 'platform_notes', label: 'Platform Notes', type: 'textarea', placeholder: 'Web only? Mobile too? Any platform constraints?' }
    ]
  },
  {
    key: 'comments', label: 'Additional Comments', icon: 'fa-comment-dots',
    fields: [
      { key: 'additional_comments', label: 'Additional Ideas & Concepts', type: 'rich-comments', placeholder: 'Anything else on your mind? Concepts, inspirations, special requirements, things you love about other apps, anything the AI should know…', rows: 5, hint: 'This is your free space. Write as much or as little as you want. AI reads everything here.' }
    ]
  }
];

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
  const container = document.getElementById('prompt-sections');
  
  container.innerHTML = PROMPT_SECTIONS_CONFIG.map((section, idx) => {
    const isOptional = ['visual', 'comments'].includes(section.key);
    const completedFields = section.fields.filter(f => fieldHasValue(f)).length;
    const isComplete = completedFields === section.fields.length;
    const isPartial = completedFields > 0 && !isComplete;
    
    return `
      <div class="glass rounded-xl overflow-hidden" id="section-${section.key}">
        <button onclick="toggleSection('${section.key}')" 
          class="w-full flex items-center gap-3 p-4 text-left">
          <div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${isComplete ? 'bg-emerald-500/20' : isPartial ? (isOptional ? 'bg-purple-500/20' : 'bg-amber-500/20') : 'bg-slate-700/50'}">
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
                : `${completedFields}/${section.fields.length} filled`}
            </p>
          </div>
          <div class="flex items-center gap-2">
            ${isPartial && !isOptional ? '<span class="w-2 h-2 rounded-full bg-amber-400"></span>' : ''}
            ${isPartial && isOptional  ? '<span class="w-2 h-2 rounded-full bg-purple-400"></span>' : ''}
            <i class="fas fa-chevron-down text-slate-600 text-xs section-chevron-${section.key} transition-transform"></i>
          </div>
        </button>
        
        <div class="section-body-${section.key} hidden px-4 pb-4 space-y-4">
          ${section.fields.map(field => renderField(field, section.key)).join('')}
          
          <!-- AI Assist for section (only on non-optional sections) -->
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
  }).join('');
  
  renderSectionDots();
}

function renderField(field, sectionKey) {
  const value = STATE.promptData[field.key] || '';

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
  if (field.type === 'color-scheme') return v && v.length > 0;
  if (field.type === 'rich-comments') return v && v.trim().length > 5;
  // Optional visual fields — count any non-empty value
  if (['visual_features','ui_ux_notes'].includes(field.key)) return v && v.trim().length > 0;
  return v && v.trim().length > 5;
}

function renderSectionDots() {
  const container = document.getElementById('section-dots');
  container.innerHTML = PROMPT_SECTIONS_CONFIG.map(s => {
    // Optional sections (visual extras, comments) — don't count as blocking
    const isOptional = ['visual', 'comments'].includes(s.key);
    const completed = s.fields.filter(f => fieldHasValue(f)).length;
    const total = s.fields.filter(f => !['visual_features','ui_ux_notes','additional_comments'].includes(f.key)).length || s.fields.length;
    const pct = isOptional ? (completed / s.fields.length) : (completed / total);
    let color = 'bg-slate-700';
    if (pct >= 1) color = 'bg-emerald-400';
    else if (pct > 0) color = isOptional ? 'bg-purple-400' : 'bg-amber-400';
    const tip = isOptional ? `${s.label} (optional): ${completed}/${s.fields.length}` : `${s.label}: ${completed}/${total}`;
    return `<div class="w-2 h-2 rounded-full ${color}" title="${tip}"></div>`;
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
  
  for (const field of section.fields) {
    // Skip color-scheme and rich-comments — those require human input
    if (['color-scheme', 'rich-comments'].includes(field.type)) continue;
    if (!fieldHasValue(field)) {
      await aiAssistField(sectionKey, field.key);
      await new Promise(r => setTimeout(r, 600));
    }
  }
}

function setPromptMode(mode) {
  const guided = document.getElementById('mode-guided');
  const advanced = document.getElementById('mode-advanced');
  if (mode === 'guided') {
    guided.className = 'flex-1 py-2 text-xs font-semibold rounded-lg btn-primary';
    advanced.className = 'flex-1 py-2 text-xs font-semibold rounded-lg btn-ghost';
  } else {
    guided.className = 'flex-1 py-2 text-xs font-semibold rounded-lg btn-ghost';
    advanced.className = 'flex-1 py-2 text-xs font-semibold rounded-lg btn-primary';
  }
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

async function submitBuildRequest() {
  if (!STATE.activeProjectId) {
    showToast('Select a project first', 'error'); return;
  }
  
  const btn = document.getElementById('build-btn');
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i><span>Generating...</span>';
  btn.disabled = true;
  
  try {
    const { data } = await API.post(`/projects/${STATE.activeProjectId}/build`, {});
    if (data.success) {
      showToast(`Build started! ${data.data.coins_held} coins reserved. You'll be notified when complete.`, 'success');
      
      if (STATE.user) {
        STATE.user.coin_balance = Math.max(0, (STATE.user.coin_balance || 0) - data.data.coins_held);
        document.getElementById('header-coins').textContent = STATE.user.coin_balance.toLocaleString();
      }
      
      await loadProjects();
      navigateTo('home');
    }
  } catch (err) {
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

function renderCoinPackages(packages) {
  const container = document.getElementById('coin-packages-list');
  
  container.innerHTML = packages.map((pkg, i) => `
    <button onclick="purchaseCoins('${pkg.id}', '${pkg.name}', ${pkg.coins + pkg.bonus_coins})"
      class="w-full glass glass-hover rounded-xl p-4 text-left transition-all ${i === 1 ? 'border-cyan-500/40' : ''}">
      <div class="flex items-center justify-between">
        <div>
          <div class="flex items-center gap-2">
            <p class="text-sm font-bold text-white">${escHtml(pkg.name)}</p>
            ${i === 1 ? '<span class="text-xs bg-cyan-500/20 text-cyan-400 px-2 py-0.5 rounded-full font-medium">Popular</span>' : ''}
          </div>
          <p class="text-xs text-slate-500 mt-0.5">
            ${pkg.coins.toLocaleString()} coins
            ${pkg.bonus_coins > 0 ? `<span class="text-emerald-400"> + ${pkg.bonus_coins} bonus</span>` : ''}
          </p>
        </div>
        <div class="text-right">
          <p class="text-base font-black text-white">$${(pkg.price_cents / 100).toFixed(2)}</p>
          <p class="text-xs text-slate-600">${((pkg.coins + pkg.bonus_coins) / (pkg.price_cents / 100)).toFixed(0)} coins/$</p>
        </div>
      </div>
    </button>
  `).join('');
}

async function purchaseCoins(packageId, name, totalCoins) {
  try {
    const { data } = await API.post('/vault/purchase', { package_id: packageId });
    if (data.success) {
      closeModal('modal-buy-coins');
      if (STATE.user) {
        STATE.user.coin_balance = data.data.new_balance;
        updateHeaderUser();
      }
      showToast(data.message || `${totalCoins} coins added!`, 'success');
    }
  } catch (err) {
    showToast(err.response?.data?.error || 'Purchase failed', 'error');
  }
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

function selectPlan(slug) {
  showToast('Plan selection coming soon — Stripe integration required', 'warning');
  closeModal('modal-plans');
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
  document.getElementById(id).classList.remove('hidden');
  document.getElementById(id).classList.add('flex');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  document.getElementById(id).classList.remove('flex');
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
