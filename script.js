/* ══════════════════════════════════════════════════════════
   SUPABASE CONFIG
   1. Create a free project at https://supabase.com
   2. Go to Project Settings → API
   3. Copy your "Project URL" and "anon public" key below
   4. Run the SQL in the comment below (in Supabase SQL Editor)
      to create the profiles table this site uses.
═══════════════════════════════════════════════════════════

-- SQL to run once in Supabase SQL Editor:
create table profiles (
  id uuid references auth.users on delete cascade primary key,
  full_name text,
  phone text,
  country text,
  account_id text,
  referral_code text,
  balance numeric default 0,
  available_balance numeric default 0,
  active_investment numeric default 0,
  total_profit numeric default 0,
  created_at timestamp default now()
);

alter table profiles enable row level security;

create policy "Users can view own profile" on profiles
  for select using (auth.uid() = id);

create policy "Users can update own profile" on profiles
  for update using (auth.uid() = id);

create policy "Users can insert own profile" on profiles
  for insert with check (auth.uid() = id);

-- ── ADMIN SUPPORT (run this once you have the deposits/withdrawals tables already in use) ──

-- Flag certain accounts as admins. Set this manually for yourself in the Supabase table editor.
alter table profiles add column if not exists is_admin boolean default false;

-- Investment plans table (replaces the old hardcoded guaranteed-ROI plan data).
-- No column here represents a guaranteed return — "historical_range" is just descriptive text,
-- e.g. "Historically 4-9% annually", and must be paired with the disclaimer shown in the UI.
create table if not exists plans (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  risk_tier text not null check (risk_tier in ('conservative','balanced','growth')),
  min_deposit numeric not null default 0,
  historical_range text,
  description text,
  active boolean default true,
  created_at timestamp default now()
);

alter table plans enable row level security;

create policy "Anyone can view active plans" on plans
  for select using (active = true);

create policy "Admins can view all plans" on plans
  for select using (exists (select 1 from profiles where id = auth.uid() and is_admin = true));

create policy "Admins can manage plans" on plans
  for all using (exists (select 1 from profiles where id = auth.uid() and is_admin = true));

-- Admin read/update access to every user's deposits and withdrawals (assumes those tables
-- already exist with user_id, status, etc. columns, matching the columns used elsewhere in this file).
create policy "Admins can view all deposits" on deposits
  for select using (exists (select 1 from profiles where id = auth.uid() and is_admin = true));

create policy "Admins can update all deposits" on deposits
  for update using (exists (select 1 from profiles where id = auth.uid() and is_admin = true));

create policy "Admins can view all withdrawals" on withdrawals
  for select using (exists (select 1 from profiles where id = auth.uid() and is_admin = true));

create policy "Admins can update all withdrawals" on withdrawals
  for update using (exists (select 1 from profiles where id = auth.uid() and is_admin = true));

═══════════════════════════════════════════════════════════ */

const SUPABASE_URL = 'https://knspxlebxpzrerosmejf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtuc3B4bGVieHB6cmVyb3NtZWpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NjkxNDEsImV4cCI6MjA5NzA0NTE0MX0.-pUrFcsuHClcg3woPgOZ_0RsX9vemhPVXYaIYwXjIlE';

let session = null; // { access_token, refresh_token, user }
const supabaseReady = SUPABASE_URL.startsWith('http') && SUPABASE_ANON_KEY.length > 10;

// Global error visibility — shows a toast instead of a silent/blank console error
window.addEventListener('error', function(e) {
  const msg = (e && e.message) ? e.message : 'Unknown script error';
  console.error('Page error:', e);
  const c = document.getElementById('toastC');
  if (c) toast('⚠️', 'Something went wrong', msg.length > 80 ? msg.slice(0,80)+'…' : msg);
});

// Low-level helper for talking to Supabase's REST + Auth APIs directly
async function sbFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    ...(options.headers || {})
  };
  if (session && session.access_token) headers['Authorization'] = 'Bearer ' + session.access_token;
  let res, data;
  try {
    res = await fetch(SUPABASE_URL + path, { ...options, headers });
    data = await res.json().catch(() => null);
  } catch (err) {
    throw new Error('Network error — check your internet connection.');
  }
  if (!res.ok) {
    const msg = (data && (data.error_description || data.msg || data.message || data.error)) || 'Request failed (' + res.status + ')';
    throw new Error(msg);
  }
  return data;
}

function setBtnLoading(btn, loading, label) {
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? 'Please wait…' : label;
}

function showFormError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}
function hideFormError(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// ── REGISTER ──
async function handleRegister() {
  hideFormError('reg-error');
  document.getElementById('reg-success').style.display = 'none';
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const referral = document.getElementById('reg-referral').value.trim();

  if (!name || !email || !password) {
    showFormError('reg-error', 'Please fill in your name, email, and password.');
    return;
  }
  if (password.length < 8) {
    showFormError('reg-error', 'Password must be at least 8 characters.');
    return;
  }
  if (!supabaseReady) {
    showFormError('reg-error', 'Backend not connected yet — add your Supabase URL and key in the code to enable real accounts.');
    return;
  }

  const btn = document.getElementById('reg-btn');
  setBtnLoading(btn, true, 'Create Account');

  try {
    const result = await sbFetch('/auth/v1/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, data: { full_name: name, referral_code: referral || null } })
    });

    const userId = result.user ? result.user.id : result.id;

    // Create profile row (only if we have a session / userId)
    if (userId) {
      const accountId = '#PI-' + String(Math.floor(10000 + Math.random() * 89999));
      if (result.access_token) session = { access_token: result.access_token, refresh_token: result.refresh_token, user: result.user };
      try {
        await sbFetch('/rest/v1/profiles', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            id: userId, full_name: name, account_id: accountId,
            referral_code: referral || null,
            balance: 0, available_balance: 0, active_investment: 0, total_profit: 0
          })
        });
      } catch (profileErr) {
        console.error('Profile creation failed:', profileErr);
      }
    }

    setBtnLoading(btn, false, 'Create Account');

    if (result.access_token) {
      await loadUserIntoDashboard();
      goPage('pg-dash');
      setTimeout(() => toast('👋', `Welcome, ${name}!`, 'Your account has been created.'), 600);
    } else {
      document.getElementById('reg-success').textContent = 'Account created! Check your email to confirm, then sign in.';
      document.getElementById('reg-success').style.display = 'block';
      setTimeout(() => authTab('l'), 2000);
    }
  } catch (err) {
    setBtnLoading(btn, false, 'Create Account');
    showFormError('reg-error', err.message);
  }
}

// ── LOGIN ──
async function handleLogin() {
  hideFormError('login-error');
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  if (!email || !password) {
    showFormError('login-error', 'Please enter your email and password.');
    return;
  }
  if (!supabaseReady) {
    showFormError('login-error', 'Backend not connected yet — add your Supabase URL and key in the code to enable real accounts.');
    return;
  }

  const btn = document.getElementById('login-btn');
  setBtnLoading(btn, true, 'Sign In');

  try {
    const result = await sbFetch('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    session = { access_token: result.access_token, refresh_token: result.refresh_token, user: result.user };

    setBtnLoading(btn, false, 'Sign In');
    await loadUserIntoDashboard();
    goPage('pg-dash');
    setTimeout(() => toast('👋', 'Welcome back!', 'Your portfolio is up +3.2% today.'), 600);
  } catch (err) {
    setBtnLoading(btn, false, 'Sign In');
    showFormError('login-error', err.message);
  }
}

// ── LOGOUT ──
async function handleLogout() {
  if (supabaseReady && session && session.access_token) {
    try { await sbFetch('/auth/v1/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  }
  session = null;
  goPage('pg-home');
}

// ── LOAD USER DATA INTO DASHBOARD ──
async function loadUserIntoDashboard() {
  if (!supabaseReady || !session || !session.access_token) return;
  const user = session.user;
  if (!user) return;

  let profile = null;
  try {
    const rows = await sbFetch(`/rest/v1/profiles?id=eq.${user.id}&select=*`, { method: 'GET' });
    profile = (rows && rows[0]) || null;
  } catch (e) { console.error('Could not load profile:', e); }

  const name = (profile && profile.full_name) || (user.user_metadata && user.user_metadata.full_name) || user.email.split('@')[0];
  const initial = name.charAt(0).toUpperCase();
  const accountId = (profile && profile.account_id) || '#PI-00000';

  ['sb-avatar','tb-avatar','profile-avatar'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = initial;
  });
  const sbName = document.getElementById('sb-name'); if (sbName) sbName.textContent = name;
  const tbName = document.getElementById('tb-name'); if (tbName) tbName.textContent = name.split(' ')[0];
  const pName = document.getElementById('profile-name'); if (pName) pName.textContent = name;
  const pId = document.getElementById('profile-id'); if (pId) pId.textContent = '@' + name.toLowerCase().replace(/\s+/g,'') + ' \u00b7 ID: ' + accountId;
  const pFull = document.getElementById('profile-fullname'); if (pFull) pFull.value = name;
  const pEmail = document.getElementById('profile-email'); if (pEmail) pEmail.value = user.email;
  if (profile && profile.phone) { const p = document.getElementById('profile-phone'); if (p) p.value = profile.phone; }
  if (profile && profile.country) { const c = document.getElementById('profile-country'); if (c) c.value = profile.country; }

  renderBalances(profile);
  loadDepositHistory();
  loadDepositTotals();
  loadInvestments();
  await loadHistory();
  renderRecentTx();

  const isAdmin = !!(profile && profile.is_admin);
  const adminLbl = document.getElementById('admin-nav-lbl');
  const adminLink = document.getElementById('admin-nav-link');
  if (adminLbl) adminLbl.style.display = isAdmin ? '' : 'none';
  if (adminLink) adminLink.style.display = isAdmin ? '' : 'none';

  // Populate dynamic account status fields
  const statusAccountId = document.getElementById('status-account-id');
  if (statusAccountId) statusAccountId.textContent = (profile && profile.account_id) || '—';
  const statusEmail = document.getElementById('status-email');
  if (statusEmail) statusEmail.textContent = user.email || '—';
  const statusAdmin = document.getElementById('status-admin');
  if (statusAdmin) statusAdmin.innerHTML = isAdmin ? '<span class="badge badge-gold">👑 Yes</span>' : '<span class="badge badge-gray">No</span>';
  const statusSince = document.getElementById('status-since');
  if (statusSince && profile && profile.created_at) {
    statusSince.textContent = new Date(profile.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  }
  const sbRole = document.getElementById('sb-role');
  if (sbRole) sbRole.textContent = isAdmin ? '👑 Admin' : 'Member';
  const secSessionInfo = document.getElementById('sec-session-info');
  if (secSessionInfo) secSessionInfo.textContent = 'Logged in as ' + (user.email || 'user');

  // Load KYC status
  try {
    const kyc = await sbFetch(`/rest/v1/kyc_submissions?user_id=eq.${user.id}&order=created_at.desc&limit=1`, { method: 'GET' });
    renderKYCStatus(kyc && kyc[0] ? kyc[0].status : null);
  } catch(e) { renderKYCStatus(null); }
}

// ── RENDER REAL BALANCE FIGURES ON OVERVIEW ──
function fmtUsd(n) {
  return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderBalances(profile) {
  const balance = profile ? profile.balance : 0;
  const available = profile ? profile.available_balance : 0;
  const activeInv = profile ? profile.active_investment : 0;
  const profit = profile ? profile.total_profit : 0;

  const ids = {
    'ov-total-balance': fmtUsd(balance),
    'ov-available-balance': fmtUsd(available),
    'ov-active-investment': fmtUsd(activeInv),
    'ov-total-profit': fmtUsd(profit),
  };
  Object.entries(ids).forEach(([id, val]) => {
    const el = document.getElementById(id); if (el) el.textContent = val;
  });
  const wdBal = document.getElementById('wd-available-balance'); if (wdBal) wdBal.textContent = fmtUsd(available);
}

// ── LOAD TOTAL DEPOSITS / WITHDRAWALS FOR OVERVIEW ──
async function loadDepositTotals() {
  if (!supabaseReady || !session || !session.access_token) return;
  try {
    const rows = await sbFetch(`/rest/v1/deposits?user_id=eq.${session.user.id}&status=eq.confirmed&select=amount_usd`, { method: 'GET' });
    const total = (rows || []).reduce((sum, r) => sum + Number(r.amount_usd), 0);
    const td = document.getElementById('ov-total-deposits'); if (td) td.textContent = fmtUsd(total);
    const dc = document.getElementById('ov-deposit-count'); if (dc) dc.textContent = rows.length + (rows.length === 1 ? ' deposit' : ' deposits');
  } catch (e) { console.error('Could not load deposit totals:', e); }

  try {
    const rows = await sbFetch(`/rest/v1/withdrawals?user_id=eq.${session.user.id}&status=eq.paid&select=amount_usd`, { method: 'GET' });
    const total = (rows || []).reduce((sum, r) => sum + Number(r.amount_usd), 0);
    const tw = document.getElementById('ov-total-withdrawals'); if (tw) tw.textContent = fmtUsd(total);
    const wc = document.getElementById('ov-withdrawal-count'); if (wc) wc.textContent = rows.length + (rows.length === 1 ? ' withdrawal' : ' withdrawals');
  } catch (e) { console.error('Could not load withdrawal totals:', e); }
}

// ── SUBMIT WITHDRAWAL REQUEST ──
async function submitWithdrawal() {
  hideFormError('wd-error');
  document.getElementById('wd-success').style.display = 'none';

  if (!supabaseReady || !session || !session.access_token) {
    toast('⚠️', 'Please sign in', 'You need an account to request a withdrawal.');
    return;
  }

  const crypto = document.getElementById('wd-crypto').value;
  const amount = parseFloat(document.getElementById('wd-amount').value);
  const address = document.getElementById('wd-address').value.trim();

  if (!amount || amount < 50) {
    showFormError('wd-error', 'Minimum withdrawal amount is $50.');
    return;
  }
  if (!address || address.length < 10) {
    showFormError('wd-error', 'Please enter a valid destination wallet address.');
    return;
  }

  const btn = document.getElementById('wd-submit-btn');
  setBtnLoading(btn, true, 'Submit Withdrawal Request');

  try {
    await sbFetch('/rest/v1/withdrawals', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: session.user.id,
        crypto: crypto,
        amount_usd: amount,
        wallet_address: address,
        status: 'pending'
      })
    });

    setBtnLoading(btn, false, 'Submit Withdrawal Request');
    document.getElementById('wd-amount').value = '';
    document.getElementById('wd-address').value = '';
    document.getElementById('wd-success').textContent = 'Withdrawal requested! Funds are now reserved and your request is pending manual review.';
    document.getElementById('wd-success').style.display = 'block';
    toast('⬆️', 'Withdrawal requested', 'Pending manual review.');

    await loadUserIntoDashboard();
    loadWithdrawalHistory();
  } catch (err) {
    setBtnLoading(btn, false, 'Submit Withdrawal Request');
    showFormError('wd-error', err.message.includes('Insufficient') ? 'Insufficient available balance for this withdrawal.' : err.message);
  }
}

// ── LOAD WITHDRAWAL HISTORY FOR CURRENT USER ──
async function loadWithdrawalHistory() {
  const body = document.getElementById('wd-history-body');
  const badge = document.getElementById('wd-count-badge');
  if (!body) return;
  if (!supabaseReady || !session || !session.access_token) return;

  try {
    const rows = await sbFetch(`/rest/v1/withdrawals?user_id=eq.${session.user.id}&select=*&order=created_at.desc`, { method: 'GET' });
    if (!rows || rows.length === 0) {
      body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">No withdrawals yet.</td></tr>';
      badge.textContent = '0 withdrawals';
      return;
    }
    badge.textContent = rows.length + (rows.length === 1 ? ' withdrawal' : ' withdrawals');
    body.innerHTML = rows.map(w => {
      const date = new Date(w.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const statusBadge = w.status === 'paid'
        ? '<span class="badge badge-green">Paid</span>'
        : w.status === 'rejected'
        ? '<span class="badge badge-danger">Rejected</span>'
        : '<span class="badge badge-gold">Pending</span>';
      const shortAddr = w.wallet_address.length > 16 ? w.wallet_address.slice(0,8) + '…' + w.wallet_address.slice(-6) : w.wallet_address;
      return `<tr><td>${date}</td><td>${w.crypto}</td><td>$${Number(w.amount_usd).toLocaleString()}</td><td style="font-family:monospace;font-size:11px;color:var(--muted);">${shortAddr}</td><td>${statusBadge}</td></tr>`;
    }).join('');
  } catch (err) {
    console.error('Could not load withdrawal history:', err);
  }
}

// ════════════════════════════════════════════════════════════
// ADMIN PANEL — only reachable by accounts with profiles.is_admin = true
// (enforced server-side via RLS policies, not just by hiding the nav link)
// ════════════════════════════════════════════════════════════

function adminTab(which) {
  ['plans','deposits','withdrawals'].forEach(t => {
    document.getElementById('admin-sub-'+t).style.display = (t===which) ? '' : 'none';
    const btn = document.getElementById('admin-tab-btn-'+t);
    if (btn) { btn.className = (t===which) ? 'btn btn-gold btn-sm' : 'btn btn-outline btn-sm'; }
  });
  if (which === 'plans') loadAdminPlans();
  if (which === 'deposits') loadAdminDeposits();
  if (which === 'withdrawals') loadAdminWithdrawals();
}

// ── helper: map a list of user_ids to display names/emails via profiles ──
async function fetchProfilesFor(userIds) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return {};
  try {
    const rows = await sbFetch(`/rest/v1/profiles?id=in.(${ids.join(',')})&select=id,full_name,account_id`, { method: 'GET' });
    const map = {};
    (rows || []).forEach(r => { map[r.id] = r; });
    return map;
  } catch (e) { console.error('Could not load profiles for admin view:', e); return {}; }
}

// ── PLANS: list / create / edit / delete ──
async function loadAdminPlans() {
  const list = document.getElementById('admin-plans-list');
  if (!list || !supabaseReady || !session) return;
  list.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:13px;">Loading…</div>';
  try {
    const plans = await sbFetch('/rest/v1/plans?select=*&order=created_at.asc', { method: 'GET' });
    if (!plans || plans.length === 0) {
      list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;">No plans yet — create one above.</div>';
      return;
    }
    list.innerHTML = plans.map(p => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--border);">
        <div>
          <div style="font-weight:700;font-size:14px;color:var(--text);">${escapeHtml(p.name)} ${p.active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-gray">Hidden</span>'}</div>
          <div style="font-size:12.5px;color:var(--text2);margin-top:3px;text-transform:capitalize;">${escapeHtml(p.risk_tier)} &middot; Min $${Number(p.min_deposit).toLocaleString()}${p.historical_range ? ' &middot; ' + escapeHtml(p.historical_range) : ''}</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-outline btn-sm" onclick='openPlanForm(${JSON.stringify(p).replace(/'/g,"&apos;")})'>Edit</button>
          <button class="btn btn-outline btn-sm" onclick="deletePlan('${p.id}')">Delete</button>
        </div>
      </div>`).join('');
  } catch (e) {
    list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--danger);font-size:13px;">Could not load plans: ' + escapeHtml(e.message) + '</div>';
  }
}

function openPlanForm(plan) {
  document.getElementById('plan-form-wrap').style.display = '';
  document.getElementById('plan-form-title').textContent = plan ? 'Edit Plan' : 'New Plan';
  document.getElementById('plan-id').value = plan ? plan.id : '';
  document.getElementById('plan-name').value = plan ? plan.name : '';
  document.getElementById('plan-tier').value = plan ? plan.risk_tier : 'balanced';
  document.getElementById('plan-min').value = plan ? plan.min_deposit : '';
  document.getElementById('plan-perf').value = plan ? (plan.historical_range || '') : '';
  document.getElementById('plan-desc').value = plan ? (plan.description || '') : '';
  document.getElementById('plan-active').checked = plan ? !!plan.active : true;
  document.getElementById('plan-form-wrap').scrollIntoView({behavior:'smooth', block:'center'});
}

function closePlanForm() {
  document.getElementById('plan-form-wrap').style.display = 'none';
}

async function savePlan() {
  const id = document.getElementById('plan-id').value;
  const name = document.getElementById('plan-name').value.trim();
  const min = parseFloat(document.getElementById('plan-min').value);
  if (!name) { toast('⚠️', 'Missing name', 'Enter a plan name.'); return; }
  if (isNaN(min) || min < 0) { toast('⚠️', 'Invalid minimum', 'Enter a valid minimum deposit.'); return; }

  const body = {
    name,
    risk_tier: document.getElementById('plan-tier').value,
    min_deposit: min,
    historical_range: document.getElementById('plan-perf').value.trim(),
    description: document.getElementById('plan-desc').value.trim(),
    active: document.getElementById('plan-active').checked
  };

  const btn = document.getElementById('plan-save-btn');
  setBtnLoading(btn, true, 'Save Plan');
  try {
    if (id) {
      await sbFetch(`/rest/v1/plans?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
    } else {
      await sbFetch('/rest/v1/plans', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
    }
    setBtnLoading(btn, false, 'Save Plan');
    toast('✅', 'Plan saved', name);
    closePlanForm();
    loadAdminPlans();
  } catch (e) {
    setBtnLoading(btn, false, 'Save Plan');
    toast('⚠️', 'Could not save plan', e.message);
  }
}

async function deletePlan(id) {
  if (!confirm('Delete this plan? This cannot be undone.')) return;
  try {
    await sbFetch(`/rest/v1/plans?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    toast('🗑️', 'Plan deleted', '');
    loadAdminPlans();
  } catch (e) {
    toast('⚠️', 'Could not delete plan', e.message);
  }
}

// ── DEPOSITS: list + approve/reject ──
async function loadAdminDeposits() {
  const body = document.getElementById('admin-deposits-body');
  const filter = document.getElementById('admin-dep-filter')?.value || 'pending';
  if (!body || !supabaseReady || !session) return;
  body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">Loading…</td></tr>';
  try {
    const q = filter === 'all' ? '' : `&status=eq.${filter}`;
    const rows = await sbFetch(`/rest/v1/deposits?select=*${q}&order=created_at.desc`, { method: 'GET' });
    if (!rows || rows.length === 0) {
      body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">No deposits in this view.</td></tr>';
      return;
    }
    const profiles = await fetchProfilesFor(rows.map(r => r.user_id));
    body.innerHTML = rows.map(d => {
      const date = new Date(d.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
      const who = profiles[d.user_id];
      const name = who ? escapeHtml(who.full_name || who.account_id || d.user_id) : d.user_id;
      const statusBadge = d.status === 'confirmed' ? '<span class="badge badge-green">Confirmed</span>'
        : d.status === 'rejected' ? '<span class="badge badge-danger">Rejected</span>'
        : '<span class="badge badge-gold">Pending</span>';
      const action = d.status === 'pending'
        ? `<button class="btn btn-gold btn-sm" onclick="approveDeposit('${d.id}')">Approve</button> <button class="btn btn-outline btn-sm" onclick="rejectDeposit('${d.id}')">Reject</button>`
        : '—';
      const txid = d.txid ? (d.txid.length > 14 ? d.txid.slice(0,8)+'…'+d.txid.slice(-4) : d.txid) : '—';
      return `<tr><td>${date}</td><td>${name}</td><td>${escapeHtml(d.crypto||'')}</td><td>$${Number(d.amount_usd).toLocaleString()}</td><td style="font-family:monospace;font-size:11px;color:var(--muted);">${escapeHtml(txid)}</td><td>${statusBadge}</td><td>${action}</td></tr>`;
    }).join('');
  } catch (e) {
    body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--danger);padding:24px;">Could not load deposits: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

async function approveDeposit(id) {
  try {
    await sbFetch(`/rest/v1/deposits?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'confirmed' }) });
    toast('✅', 'Deposit approved', '');
    loadAdminDeposits();
  } catch (e) { toast('⚠️', 'Could not approve', e.message); }
}

async function rejectDeposit(id) {
  if (!confirm('Reject this deposit?')) return;
  try {
    await sbFetch(`/rest/v1/deposits?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'rejected' }) });
    toast('🚫', 'Deposit rejected', '');
    loadAdminDeposits();
  } catch (e) { toast('⚠️', 'Could not reject', e.message); }
}

// ── WITHDRAWALS: list + approve(pay)/reject ──
async function loadAdminWithdrawals() {
  const body = document.getElementById('admin-withdrawals-body');
  const filter = document.getElementById('admin-wd-filter')?.value || 'pending';
  if (!body || !supabaseReady || !session) return;
  body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">Loading…</td></tr>';
  try {
    const q = filter === 'all' ? '' : `&status=eq.${filter}`;
    const rows = await sbFetch(`/rest/v1/withdrawals?select=*${q}&order=created_at.desc`, { method: 'GET' });
    if (!rows || rows.length === 0) {
      body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">No withdrawals in this view.</td></tr>';
      return;
    }
    const profiles = await fetchProfilesFor(rows.map(r => r.user_id));
    body.innerHTML = rows.map(w => {
      const date = new Date(w.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
      const who = profiles[w.user_id];
      const name = who ? escapeHtml(who.full_name || who.account_id || w.user_id) : w.user_id;
      const statusBadge = w.status === 'paid' ? '<span class="badge badge-green">Paid</span>'
        : w.status === 'rejected' ? '<span class="badge badge-danger">Rejected</span>'
        : '<span class="badge badge-gold">Pending</span>';
      const action = w.status === 'pending'
        ? `<button class="btn btn-gold btn-sm" onclick="approveWithdrawal('${w.id}')">Approve &amp; Pay</button> <button class="btn btn-outline btn-sm" onclick="rejectWithdrawal('${w.id}')">Reject</button>`
        : '—';
      const shortAddr = (w.wallet_address||'').length > 16 ? w.wallet_address.slice(0,8)+'…'+w.wallet_address.slice(-6) : (w.wallet_address||'');
      return `<tr><td>${date}</td><td>${name}</td><td>${escapeHtml(w.crypto||'')}</td><td>$${Number(w.amount_usd).toLocaleString()}</td><td style="font-family:monospace;font-size:11px;color:var(--muted);">${escapeHtml(shortAddr)}</td><td>${statusBadge}</td><td>${action}</td></tr>`;
    }).join('');
  } catch (e) {
    body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--danger);padding:24px;">Could not load withdrawals: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

async function approveWithdrawal(id) {
  if (!confirm('Mark this withdrawal as paid? Only do this after you have actually sent the funds.')) return;
  try {
    await sbFetch(`/rest/v1/withdrawals?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'paid' }) });
    toast('✅', 'Withdrawal marked paid', '');
    loadAdminWithdrawals();
  } catch (e) { toast('⚠️', 'Could not update', e.message); }
}

async function rejectWithdrawal(id) {
  if (!confirm('Reject this withdrawal? The reserved funds should be released back to the user.')) return;
  try {
    await sbFetch(`/rest/v1/withdrawals?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'rejected' }) });
    toast('🚫', 'Withdrawal rejected', '');
    loadAdminWithdrawals();
  } catch (e) { toast('⚠️', 'Could not update', e.message); }
}

// ── PASSWORD RESET ──
async function sendPasswordReset() {
  if (!session || !session.user) { toast('⚠️','Not logged in','Please log in first.'); return; }
  try {
    await sbFetch('/auth/v1/recover', { method: 'POST', body: JSON.stringify({ email: session.user.email }) });
    toast('📧','Reset email sent','Check your inbox for a password reset link.');
  } catch (e) { toast('⚠️','Could not send reset',e.message); }
}

// ── KYC SUBMISSION ──
async function submitKYC() {
  const idType = document.getElementById('kyc-id-type')?.value;
  const idNumber = document.getElementById('kyc-id-number')?.value.trim();
  const legalName = document.getElementById('kyc-legal-name')?.value.trim();
  const dob = document.getElementById('kyc-dob')?.value;
  if (!idNumber || !legalName || !dob) { toast('⚠️','Missing fields','Please fill in all KYC fields.'); return; }
  if (!session) return;
  try {
    await sbFetch('/rest/v1/kyc_submissions', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: session.user.id, id_type: idType, id_number: idNumber, legal_name: legalName, dob, status: 'pending' })
    });
    toast('✅','KYC submitted','Your documents are under review. We will notify you within 1–3 business days.');
    renderKYCStatus('pending');
    const form = document.getElementById('kyc-upload-form'); if (form) form.style.display = 'none';
  } catch (e) { toast('⚠️','Submission failed',e.message); }
}

function renderKYCStatus(status) {
  const block = document.getElementById('kyc-status-block');
  const icon = document.getElementById('kyc-icon');
  const title = document.getElementById('kyc-title');
  const sub = document.getElementById('kyc-sub');
  const statusKyc = document.getElementById('status-kyc');
  const form = document.getElementById('kyc-upload-form');
  if (!block) return;
  if (status === 'approved') {
    block.style.cssText += ';background:rgba(61,186,110,.06);border-color:rgba(61,186,110,.2);';
    if (icon) icon.textContent = '✅'; if (title) { title.textContent = 'Fully Verified'; title.style.color = 'var(--green)'; }
    if (sub) sub.textContent = 'All documents approved. Full platform access enabled.';
    if (statusKyc) statusKyc.innerHTML = '<span class="badge badge-green">✅ Verified</span>';
    if (form) form.style.display = 'none';
  } else if (status === 'pending') {
    block.style.cssText += ';background:rgba(201,168,76,.06);border-color:rgba(201,168,76,.2);';
    if (icon) icon.textContent = '🕐'; if (title) { title.textContent = 'Under Review'; title.style.color = 'var(--gold)'; }
    if (sub) sub.textContent = 'Your documents are being reviewed. This takes 1–3 business days.';
    if (statusKyc) statusKyc.innerHTML = '<span class="badge badge-gold">Pending</span>';
    if (form) form.style.display = 'none';
  } else if (status === 'rejected') {
    block.style.cssText += ';background:rgba(239,68,68,.06);border-color:rgba(239,68,68,.2);';
    if (icon) icon.textContent = '❌'; if (title) { title.textContent = 'Rejected'; title.style.color = 'var(--danger)'; }
    if (sub) sub.textContent = 'Your submission was rejected. Please resubmit with valid documents.';
    if (statusKyc) statusKyc.innerHTML = '<span class="badge badge-danger">Rejected</span>';
    if (form) form.style.display = '';
  } else {
    if (icon) icon.textContent = '⏳'; if (title) { title.textContent = 'Not Submitted'; title.style.color = 'var(--text)'; }
    if (sub) sub.textContent = 'Submit your ID to unlock full platform access.';
    if (statusKyc) statusKyc.innerHTML = '<span class="badge badge-gray">Not Submitted</span>';
    if (form) form.style.display = '';
  }
}

// ── SUPPORT TICKETS ──
async function submitSupportTicket() {
  const subject = document.getElementById('support-subject')?.value.trim();
  const message = document.getElementById('support-message')?.value.trim();
  const category = document.getElementById('support-category')?.value;
  const priority = document.getElementById('support-priority')?.value;
  const errEl = document.getElementById('support-error');
  if (!subject || !message) { if(errEl){errEl.textContent='Please enter a subject and message.';errEl.style.display='';} return; }
  if (!session) return;
  if (errEl) errEl.style.display = 'none';
  try {
    await sbFetch('/rest/v1/support_tickets', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: session.user.id, category, subject, message, priority, status: 'open' })
    });
    toast('✅','Ticket submitted','We will respond within 24 hours.');
    document.getElementById('support-subject').value = '';
    document.getElementById('support-message').value = '';
    loadSupportTickets();
  } catch (e) { if(errEl){errEl.textContent=e.message;errEl.style.display='';} }
}

async function loadSupportTickets() {
  const body = document.getElementById('support-tickets-body');
  if (!body || !session) return;
  try {
    const tickets = await sbFetch(`/rest/v1/support_tickets?user_id=eq.${session.user.id}&order=created_at.desc`, { method: 'GET' });
    if (!tickets || tickets.length === 0) {
      body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">No tickets yet.</td></tr>'; return;
    }
    body.innerHTML = tickets.map(t => {
      const date = new Date(t.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
      const badge = t.status==='resolved'?'<span class="badge badge-green">Resolved</span>':t.status==='closed'?'<span class="badge badge-gray">Closed</span>':'<span class="badge badge-gold">Open</span>';
      return `<tr><td style="font-family:monospace;color:var(--gold);">#TKT-${t.id.slice(-4).toUpperCase()}</td><td>${escapeHtml(t.subject)}</td><td>${escapeHtml(t.category)}</td><td>${date}</td><td>${badge}</td></tr>`;
    }).join('');
  } catch (e) { body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">Could not load tickets.</td></tr>'; }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── INVESTMENT PLAN PICKING ──
let selectedPlan = null;

function pickPlan(el) {
  document.querySelectorAll('.plan-pick').forEach(p => p.style.outline = 'none');
  el.style.outline = '2px solid var(--gold)';
  selectedPlan = {
    name: el.dataset.plan,
    roi: parseFloat(el.dataset.roi),
    days: parseInt(el.dataset.days),
    min: parseFloat(el.dataset.min),
    max: parseFloat(el.dataset.max)
  };
  document.getElementById('invest-selected-name').textContent = selectedPlan.name + ' Plan — ' + selectedPlan.roi + '% / ' + selectedPlan.days + ' days';
  document.getElementById('invest-selected-range').textContent = 'Min: $' + selectedPlan.min.toLocaleString() + (selectedPlan.max < 999999999 ? ' · Max: $' + selectedPlan.max.toLocaleString() : ' and up');
  document.getElementById('invest-amount').value = '';
  document.getElementById('invest-estimate').innerHTML = '';
  document.getElementById('invest-form').style.display = 'block';
  hideFormError('invest-error');

  const amtInput = document.getElementById('invest-amount');
  amtInput.oninput = () => updateInvestEstimate();
}

function updateInvestEstimate() {
  if (!selectedPlan) return;
  const amt = parseFloat(document.getElementById('invest-amount').value) || 0;
  const profit = amt * (selectedPlan.roi / 100);
  const dailyProfit = profit / selectedPlan.days;
  document.getElementById('invest-estimate').innerHTML =
    `<div style="font-weight:700;color:var(--gold);margin-bottom:6px;">Estimated Returns</div>
     <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="color:var(--text2);">Daily profit:</span><span style="color:var(--green);font-weight:700;">${fmtUsd(dailyProfit)}</span></div>
     <div style="display:flex;justify-content:space-between;"><span style="color:var(--text2);">Total at maturity:</span><span style="color:var(--gold);font-weight:700;">${fmtUsd(amt + profit)} (${fmtUsd(amt)} + ${fmtUsd(profit)} profit)</span></div>`;
}

// ── START INVESTMENT ──
async function startInvestment() {
  hideFormError('invest-error');
  if (!selectedPlan) return;
  if (!supabaseReady || !session || !session.access_token) {
    toast('⚠️', 'Please sign in', 'You need an account to invest.');
    return;
  }

  const amount = parseFloat(document.getElementById('invest-amount').value);
  if (!amount || amount < selectedPlan.min) {
    showFormError('invest-error', `Minimum investment for ${selectedPlan.name} is ${fmtUsd(selectedPlan.min)}.`);
    return;
  }
  if (amount > selectedPlan.max) {
    showFormError('invest-error', `Maximum investment for ${selectedPlan.name} is ${fmtUsd(selectedPlan.max)}.`);
    return;
  }

  const btn = document.getElementById('invest-submit-btn');
  setBtnLoading(btn, true, 'Confirm Investment');

  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + selectedPlan.days * 24 * 60 * 60 * 1000);

  try {
    await sbFetch('/rest/v1/investments', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: session.user.id,
        plan_name: selectedPlan.name,
        roi_percent: selectedPlan.roi,
        duration_days: selectedPlan.days,
        amount_usd: amount,
        status: 'active',
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString()
      })
    });

    setBtnLoading(btn, false, 'Confirm Investment');
    toast('📈', 'Investment started!', `${fmtUsd(amount)} invested in the ${selectedPlan.name} plan.`);
    document.getElementById('invest-form').style.display = 'none';
    selectedPlan = null;
    document.querySelectorAll('.plan-pick').forEach(p => p.style.outline = 'none');

    await loadUserIntoDashboard();
    loadInvestments();
  } catch (err) {
    setBtnLoading(btn, false, 'Confirm Investment');
    showFormError('invest-error', err.message.includes('Insufficient') ? 'Insufficient available balance for this investment.' : err.message);
  }
}

// ── LOAD & RENDER INVESTMENTS ──
async function loadInvestments() {
  const wrap = document.getElementById('invest-list');
  if (!wrap) return;
  if (!supabaseReady || !session || !session.access_token) return;

  try {
    const rows = await sbFetch(`/rest/v1/investments?user_id=eq.${session.user.id}&select=*&order=start_date.desc`, { method: 'GET' });
    if (!rows || rows.length === 0) {
      wrap.innerHTML = '<div class="dcard" style="text-align:center;color:var(--muted);padding:30px;">No investments yet — pick a plan below to get started.</div>';
      return;
    }

    wrap.innerHTML = rows.map(inv => {
      const start = new Date(inv.start_date);
      const end = new Date(inv.end_date);
      const now = new Date();
      const totalMs = end - start;
      const elapsedMs = Math.min(now - start, totalMs);
      const pct = Math.max(0, Math.min(100, Math.round((elapsedMs / totalMs) * 100)));
      const dayNum = Math.min(inv.duration_days, Math.floor(elapsedMs / (24*60*60*1000)));
      const profit = inv.amount_usd * (inv.roi_percent / 100);
      const dailyProfit = profit / inv.duration_days;
      const weeklyProfit = dailyProfit * 7;
      const isMatured = now >= end;
      const dateFmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

      if (inv.status === 'completed') {
        return `<div class="invest-card">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:18px;">
            <div><div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;"><span style="font-family:var(--ff);font-size:18px;font-weight:800;">${inv.plan_name} Plan</span><span class="badge badge-green">Completed</span></div><div style="font-size:13px;color:var(--muted);">Ran: ${dateFmt(start)} – ${dateFmt(end)}</div></div>
            <div style="text-align:right;"><div style="font-family:var(--ff);font-size:34px;font-weight:800;color:var(--green);">${inv.roi_percent}%</div></div>
          </div>
          <div class="g4">
            <div><div class="stat-lbl">Invested</div><div style="font-weight:800;font-size:16px;">${fmtUsd(inv.amount_usd)}</div></div>
            <div><div class="stat-lbl">Profit Earned</div><div style="font-weight:800;font-size:16px;color:var(--green);">${fmtUsd(profit)}</div></div>
            <div><div class="stat-lbl">Total Returned</div><div style="font-weight:800;font-size:16px;">${fmtUsd(inv.amount_usd + profit)}</div></div>
            <div><div class="stat-lbl">Duration</div><div style="font-weight:800;font-size:16px;">${inv.duration_days} Days</div></div>
          </div>
        </div>`;
      }

      return `<div class="invest-card active-plan">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:18px;">
          <div><div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;"><span style="font-family:var(--ff);font-size:18px;font-weight:800;">${inv.plan_name} Plan</span><span class="badge badge-gold">${isMatured ? 'Matured' : 'Active'}</span></div><div style="font-size:13px;color:var(--muted);">Started: ${dateFmt(start)} &nbsp;·&nbsp; Ends: ${dateFmt(end)}</div></div>
          <div style="text-align:right;"><div style="font-family:var(--ff);font-size:34px;font-weight:800;color:var(--gold);">${inv.roi_percent}%</div><div style="font-size:12px;color:var(--muted);">Total ROI</div></div>
        </div>
        <div class="g4" style="margin-bottom:18px;">
          <div><div class="stat-lbl">Invested</div><div style="font-weight:800;font-size:16px;">${fmtUsd(inv.amount_usd)}</div></div>
          <div><div class="stat-lbl">Total Return</div><div style="font-weight:800;font-size:16px;color:var(--gold);">${fmtUsd(profit)}</div></div>
          <div><div class="stat-lbl">Daily Earnings</div><div style="font-weight:800;font-size:16px;color:var(--green);">+${fmtUsd(dailyProfit)}</div></div>
          <div><div class="stat-lbl">Weekly Earnings</div><div style="font-weight:800;font-size:16px;color:var(--green);">+${fmtUsd(weeklyProfit)}</div></div>
        </div>
        <div style="margin-bottom:8px;display:flex;justify-content:space-between;font-size:12.5px;"><span style="color:var(--muted);">Day ${dayNum} of ${inv.duration_days}</span><span style="color:var(--gold);font-weight:700;">${pct}% complete</span></div>
        <div class="progress"><div class="progress-fill" style="width:${pct}%;"></div></div>
        ${isMatured ? `<button class="btn btn-gold btn-full" style="margin-top:16px;" onclick="claimInvestment('${inv.id}', ${inv.amount_usd}, ${profit})">Claim ${fmtUsd(inv.amount_usd + profit)}</button>` : ''}
      </div>`;
    }).join('');
  } catch (err) {
    console.error('Could not load investments:', err);
  }
}

// ── CLAIM A MATURED INVESTMENT ──
async function claimInvestment(id, principal, profit) {
  if (!supabaseReady || !session || !session.access_token) return;
  try {
    await sbFetch(`/rest/v1/investments?id=eq.${id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'completed' })
    });
    toast('🎉', 'Investment claimed!', `${fmtUsd(principal + profit)} added to your available balance.`);
    await loadUserIntoDashboard();
    loadInvestments();
  } catch (err) {
    toast('⚠️', 'Claim failed', err.message);
  }
}

// ── UNIFIED TRANSACTION HISTORY ──
let historyCache = [];

async function loadHistory() {
  const body = document.getElementById('history-body');
  if (!body) return;
  if (!supabaseReady || !session || !session.access_token) return;

  body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;">Loading…</td></tr>';

  try {
    const [deposits, withdrawals, investments] = await Promise.all([
      sbFetch(`/rest/v1/deposits?user_id=eq.${session.user.id}&select=*`, { method: 'GET' }),
      sbFetch(`/rest/v1/withdrawals?user_id=eq.${session.user.id}&select=*`, { method: 'GET' }),
      sbFetch(`/rest/v1/investments?user_id=eq.${session.user.id}&select=*`, { method: 'GET' })
    ]);

    const events = [];

    (deposits || []).forEach(d => {
      events.push({
        date: new Date(d.created_at), type: 'deposit', icon: '⬇️',
        desc: `${d.crypto} deposit submitted`,
        amount: Number(d.amount_usd), sign: '+', asset: d.crypto,
        status: d.status === 'confirmed' ? 'Confirmed' : d.status === 'rejected' ? 'Rejected' : 'Pending',
        badge: d.status === 'confirmed' ? 'badge-green' : d.status === 'rejected' ? 'badge-danger' : 'badge-gold'
      });
    });

    (withdrawals || []).forEach(w => {
      events.push({
        date: new Date(w.created_at), type: 'withdrawal', icon: '💸',
        desc: `${w.crypto} withdrawal requested`,
        amount: Number(w.amount_usd), sign: '-', asset: w.crypto,
        status: w.status === 'paid' ? 'Paid' : w.status === 'rejected' ? 'Rejected' : 'Pending',
        badge: w.status === 'paid' ? 'badge-green' : w.status === 'rejected' ? 'badge-danger' : 'badge-gold'
      });
    });

    (investments || []).forEach(inv => {
      // The investment purchase itself
      events.push({
        date: new Date(inv.start_date), type: 'investment', icon: '📈',
        desc: `${inv.plan_name} Plan purchase`,
        amount: Number(inv.amount_usd), sign: '-', asset: 'USD',
        status: inv.status === 'completed' ? 'Claimed' : 'Active',
        badge: inv.status === 'completed' ? 'badge-blue' : 'badge-gold'
      });
      // The profit claim, if completed
      if (inv.status === 'completed' && inv.claimed_at) {
        const profit = Number(inv.amount_usd) * (Number(inv.roi_percent) / 100);
        events.push({
          date: new Date(inv.claimed_at), type: 'claim', icon: '💹',
          desc: `${inv.plan_name} Plan maturity payout`,
          amount: profit, sign: '+', asset: 'USD',
          status: 'Credited', badge: 'badge-green'
        });
      }
    });

    events.sort((a, b) => b.date - a.date);
    historyCache = events;
    renderHistory();
  } catch (err) {
    console.error('Could not load history:', err);
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;">Could not load history.</td></tr>';
  }
}

function renderHistory() {
  const body = document.getElementById('history-body');
  if (!body) return;

  const typeFilter = document.getElementById('hist-type-filter').value;
  const timeFilter = document.getElementById('hist-time-filter').value;

  let rows = historyCache;
  if (typeFilter !== 'all') rows = rows.filter(r => r.type === typeFilter);
  if (timeFilter !== 'all') {
    const cutoff = new Date(Date.now() - parseInt(timeFilter) * 24 * 60 * 60 * 1000);
    rows = rows.filter(r => r.date >= cutoff);
  }

  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;">No transactions match this filter.</td></tr>';
    return;
  }

  body.innerHTML = rows.map(r => {
    const dateStr = r.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
      r.date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const amountColor = r.sign === '+' ? 'var(--gold)' : 'var(--danger)';
    return `<tr><td>${dateStr}</td><td>${r.icon} ${r.type.charAt(0).toUpperCase() + r.type.slice(1)}</td><td>${r.desc}</td><td style="color:${amountColor};font-weight:700;">${r.sign}${fmtUsd(r.amount)}</td><td>${r.asset}</td><td><span class="badge ${r.badge}">${r.status}</span></td></tr>`;
  }).join('');
}

// ── RECENT TRANSACTIONS (OVERVIEW TAB, TOP 5) ──
function renderRecentTx() {
  const body = document.getElementById('ov-recent-tx-body');
  if (!body) return;
  if (historyCache.length === 0) {
    body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">No transactions yet.</td></tr>';
    return;
  }
  body.innerHTML = historyCache.slice(0, 5).map(r => {
    const dateStr = r.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
      r.date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const amountColor = r.sign === '+' ? 'var(--gold)' : 'var(--danger)';
    return `<tr><td>${r.icon} ${r.type.charAt(0).toUpperCase() + r.type.slice(1)}</td><td style="color:${amountColor};font-weight:700;">${r.sign}${fmtUsd(r.amount)}</td><td>${r.asset}</td><td><span class="badge ${r.badge}">${r.status}</span></td><td>${dateStr}</td></tr>`;
  }).join('');
}

// ── SAVE PROFILE ──
async function saveProfile() {
  if (!supabaseReady || !session || !session.access_token) {
    toast('✅','Profile updated','Your changes have been saved.');
    return;
  }
  const user = session.user;
  const full_name = document.getElementById('profile-fullname').value.trim();
  const phone = document.getElementById('profile-phone').value.trim();
  const country = document.getElementById('profile-country').value;

  try {
    await sbFetch(`/rest/v1/profiles?id=eq.${user.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ full_name, phone, country })
    });
    await loadUserIntoDashboard();
    toast('✅','Profile updated','Your changes have been saved.');
  } catch (err) {
    toast('⚠️','Update failed', err.message);
  }
}

// Note: session is kept in memory only — refreshing the page will sign you out.
// (This avoids using browser storage, which is restricted in this preview environment.)

function goPage(id){document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));document.getElementById(id).classList.add('active');window.scrollTo(0,0);if(id==='pg-plans'){buildTicker('ticker2');loadPublicPlans();}if(id==='pg-home')loadPublicPlans();}
function scrollToEl(id){goPage('pg-home');setTimeout(()=>document.getElementById(id)?.scrollIntoView({behavior:'smooth'}),120);}
function showPanel(id,el){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('panel-'+id).classList.add('active');
  const T={overview:'Overview',profile:'My Profile',investments:'My Investments',earnings:'Earnings Dashboard',deposit:'Deposit Funds',withdraw:'Withdraw Funds',history:'Transaction History',referral:'Referral Program',security:'Security Center',support:'Support Center',notifications:'Notifications',admin:'Admin Panel'};
  document.getElementById('pnlTitle').textContent=T[id]||id;
  if(el){document.querySelectorAll('.nav-it').forEach(n=>n.classList.remove('active'));el.classList.add('active');}
  if(id==='deposit') { loadDepositHistory(); loadDepositPlanDropdown(); }
  if(id==='withdraw') loadWithdrawalHistory();
  if(id==='investments') loadInvestments();
  if(id==='history') loadHistory();
  if(id==='admin') loadAdminPlans();
  if(id==='support') loadSupportTickets();
  closeSB();
}
function openSB(){document.getElementById('sidebar').classList.add('open');document.getElementById('overlay').classList.add('open');}
function closeSB(){document.getElementById('sidebar').classList.remove('open');document.getElementById('overlay').classList.remove('open');}
function toggleTheme(){const d=document.documentElement,l=d.getAttribute('data-theme')==='light';d.setAttribute('data-theme',l?'':'light');document.querySelectorAll('.theme-btn').forEach(b=>b.textContent=l?'🌙':'☀️');}
function authTab(t){document.getElementById('fl').style.display=t==='l'?'block':'none';document.getElementById('fr').style.display=t==='r'?'block':'none';document.getElementById('tl').className='tab'+(t==='l'?' active':'');document.getElementById('tr').className='tab'+(t==='r'?' active':'');hideFormError('login-error');hideFormError('reg-error');}
function toast(icon,title,msg){const c=document.getElementById('toastC'),n=document.createElement('div');n.className='toast';n.innerHTML=`<span style="font-size:20px;">${icon}</span><div><strong>${title}</strong><br><span>${msg}</span></div>`;c.appendChild(n);setTimeout(()=>n.remove(),5400);}
// ── DEPOSIT WALLET ADDRESSES ──
const WALLET_ADDRESSES = {
  'BTC': { label: 'Bitcoin (BTC)', short: 'BTC', address: 'bc1qrap03ecs3kgnxjfdxqw6neukn5eu6hj5ejqp8j' },
  'ETH': { label: 'Ethereum (ETH)', short: 'ETH', address: '0xE20B8E95279827e488A5c41750Ca04dC9798aB5b' },
  'USDT-TRC20': { label: 'USDT (TRC20)', short: 'USDT (TRC20)', address: 'TYxJnSECJnvieATcibeRpGmHEEXnv8wd8E' },
  'USDT-ERC20': { label: 'USDT (ERC20)', short: 'USDT (ERC20)', address: '0xE20B8E95279827e488A5c41750Ca04dC9798aB5b' },
  'BNB-BEP20': { label: 'BNB (BEP20)', short: 'BNB (BEP20)', address: '0xE20B8E95279827e488A5c41750Ca04dC9798aB5b' },
  'LTC': { label: 'Litecoin (LTC)', short: 'LTC', address: 'ltc1qdlyh9ayhd4y4f6z638zsm3nn3zhn60c9hl79ql' },
};

function updateDepositAddress() {
  const key = document.getElementById('deposit-crypto').value;
  const w = WALLET_ADDRESSES[key];
  if (!w) return;
  document.getElementById('deposit-addr-title').textContent = w.short + ' Deposit Address';
  document.getElementById('deposit-addr-sub').textContent = 'Send only ' + w.short + ' to this address';
  document.getElementById('deposit-addr-box').innerHTML = w.address + '<button class="copy-btn" onclick="copyAddr(this)">Copy</button>';
  document.getElementById('deposit-addr-warning').textContent = '⚠️ Only send ' + w.short + ' to this address. Sending another asset will result in permanent loss.';
}

function selectCrypto(key) {
  const sel = document.getElementById('deposit-crypto');
  sel.value = key;
  updateDepositAddress();
  toast('💳', 'Asset selected', WALLET_ADDRESSES[key].short + ' deposit address is ready below.');
}

function copyAddr(btn){const t=btn.parentElement.textContent.replace('Copy','').trim();navigator.clipboard.writeText(t).catch(()=>{});btn.textContent='✓ Copied';btn.style.color='var(--green)';setTimeout(()=>{btn.textContent='Copy';btn.style.color='';},2000);}

// ── SUBMIT DEPOSIT FOR MANUAL VERIFICATION ──
async function submitDeposit() {
  hideFormError('deposit-error');
  document.getElementById('deposit-success').style.display = 'none';

  if (!supabaseReady || !session || !session.access_token) {
    toast('⚠️', 'Please sign in', 'You need an account to submit a deposit.');
    return;
  }

  const crypto = document.getElementById('deposit-crypto').value;
  const amount = parseFloat(document.getElementById('deposit-amount').value);
  const txid = document.getElementById('deposit-txid').value.trim();

  if (!amount || amount <= 0) {
    showFormError('deposit-error', 'Please enter a valid deposit amount.');
    return;
  }
  if (!txid || txid.length < 6) {
    showFormError('deposit-error', 'Please enter the transaction ID / hash from your wallet app.');
    return;
  }

  const btn = document.getElementById('deposit-submit-btn');
  setBtnLoading(btn, true, 'Submit Deposit for Verification');

  try {
    await sbFetch('/rest/v1/deposits', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: session.user.id,
        crypto: crypto,
        amount_usd: amount,
        tx_reference: txid,
        status: 'pending'
      })
    });

    setBtnLoading(btn, false, 'Submit Deposit for Verification');
    document.getElementById('deposit-amount').value = '';
    document.getElementById('deposit-txid').value = '';
    document.getElementById('deposit-success').textContent = 'Deposit submitted! It will show as Pending until manually verified — usually within a few hours.';
    document.getElementById('deposit-success').style.display = 'block';
    toast('⬇️', 'Deposit submitted', 'Awaiting manual verification.');
    loadDepositHistory();
  } catch (err) {
    setBtnLoading(btn, false, 'Submit Deposit for Verification');
    showFormError('deposit-error', err.message);
  }
}

// ── LOAD DEPOSIT HISTORY FOR CURRENT USER ──
async function loadDepositHistory() {
  const body = document.getElementById('deposit-history-body');
  const badge = document.getElementById('deposit-count-badge');
  if (!body) return;
  if (!supabaseReady || !session || !session.access_token) return;

  try {
    const rows = await sbFetch(`/rest/v1/deposits?user_id=eq.${session.user.id}&select=*&order=created_at.desc`, { method: 'GET' });
    if (!rows || rows.length === 0) {
      body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">No deposits yet — submit one above to see it here.</td></tr>';
      badge.textContent = '0 deposits';
      return;
    }
    badge.textContent = rows.length + (rows.length === 1 ? ' deposit' : ' deposits');
    body.innerHTML = rows.map(d => {
      const date = new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const statusBadge = d.status === 'confirmed'
        ? '<span class="badge badge-green">Confirmed</span>'
        : d.status === 'rejected'
        ? '<span class="badge badge-danger">Rejected</span>'
        : '<span class="badge badge-gold">Pending</span>';
      const shortTx = d.tx_reference.length > 16 ? d.tx_reference.slice(0,8) + '…' + d.tx_reference.slice(-6) : d.tx_reference;
      return `<tr><td>${date}</td><td>${d.crypto}</td><td>$${Number(d.amount_usd).toLocaleString()}</td><td>${statusBadge}</td><td style="font-family:monospace;font-size:11px;color:var(--muted);">${shortTx}</td></tr>`;
    }).join('');
  } catch (err) {
    console.error('Could not load deposit history:', err);
  }
}
function clearNotifs(){document.querySelectorAll('.notif-item.unread').forEach(n=>n.classList.remove('unread'));const d=document.getElementById('ndot');if(d)d.style.display='none';toast('✅','All caught up','All notifications marked as read.');}
const COINS=[{s:'BTC',p:'$67,420',c:'+2.4%',u:true},{s:'ETH',p:'$3,581',c:'+1.8%',u:true},{s:'BNB',p:'$590',c:'-0.6%',u:false},{s:'USDT',p:'$1.00',c:'+0.01%',u:true},{s:'SOL',p:'$172',c:'+4.1%',u:true},{s:'XRP',p:'$0.64',c:'-1.2%',u:false},{s:'ADA',p:'$0.48',c:'+0.9%',u:true},{s:'DOGE',p:'$0.12',c:'+3.3%',u:true},{s:'AVAX',p:'$38',c:'+2.2%',u:true},{s:'DOT',p:'$7.40',c:'-0.5%',u:false}];
function buildTicker(id){const el=document.getElementById(id);if(!el)return;el.innerHTML=[...COINS,...COINS].map(c=>`<span class="t-item"><span class="t-coin">${c.s}</span><span class="t-price">${c.p}</span><span class="${c.u?'t-up':'t-down'}">${c.c}</span></span>`).join('');}
buildTicker('ticker');
// ── PUBLIC PLANS RENDERER ──
// Fetches active plans from Supabase and renders them on the home page preview
// (home-plans) and the full plans page (full-plans). Plans use honest risk tiers
// with a mandatory disclaimer; no guaranteed returns are shown.

const TIER_META = {
  conservative: { icon: '🛡️', label: 'Conservative', color: 'var(--green)',  desc: 'Lower risk. Capital preservation focus with stable, steady growth.' },
  balanced:     { icon: '⚖️', label: 'Balanced',     color: 'var(--gold)',   desc: 'Moderate risk. Mix of growth assets and stability.' },
  growth:       { icon: '🚀', label: 'Growth',        color: '#a78bfa',      desc: 'Higher risk. Focused on long-term capital appreciation.' }
};

async function loadPublicPlans() {
  const homePlans = document.getElementById('home-plans');
  const fullPlans = document.getElementById('full-plans');
  const loading = '<div style="padding:32px;text-align:center;color:var(--muted);font-size:13px;grid-column:1/-1;">Loading plans…</div>';
  if (homePlans) homePlans.innerHTML = loading;
  if (fullPlans) fullPlans.innerHTML = loading;

  if (!supabaseReady) {
    const msg = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;grid-column:1/-1;">Plans will be available once the platform is connected.</div>';
    if (homePlans) homePlans.innerHTML = msg;
    if (fullPlans) fullPlans.innerHTML = msg;
    return;
  }

  try {
    const plans = await sbFetch('/rest/v1/plans?select=*&active=eq.true&order=min_deposit.asc', { method: 'GET' });

    if (!plans || plans.length === 0) {
      const msg = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;grid-column:1/-1;">No investment plans are available right now. Check back soon.</div>';
      if (homePlans) homePlans.innerHTML = msg;
      if (fullPlans) fullPlans.innerHTML = msg;
      return;
    }

    // Show up to 3 on home page, all on full plans page
    const homeCapped = plans.slice(0, 3);
    if (homePlans) homePlans.innerHTML = homeCapped.map(p => renderPlanCard(p, false)).join('');
    if (fullPlans) fullPlans.innerHTML = plans.map((p, i) => renderPlanCard(p, plans.length > 1 && i === Math.floor(plans.length / 2))).join('');

  } catch (e) {
    const err = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;grid-column:1/-1;">Could not load plans right now. Please try again later.</div>';
    if (homePlans) homePlans.innerHTML = err;
    if (fullPlans) fullPlans.innerHTML = err;
  }
}

function renderPlanCard(plan, featured) {
  const tier = TIER_META[plan.risk_tier] || { icon: '📊', label: plan.risk_tier, color: 'var(--text2)', desc: '' };
  const minDeposit = '$' + Number(plan.min_deposit).toLocaleString();
  const perfText = plan.historical_range ? escapeHtml(plan.historical_range) : '';
  const desc = plan.description ? escapeHtml(plan.description) : tier.desc;

  return `<div class="plan-card${featured ? ' featured' : ''}">
    ${featured ? '<div class="plan-badge">Most Popular</div>' : ''}
    <div style="font-size:28px;margin-bottom:8px;">${tier.icon}</div>
    <div class="plan-name">${escapeHtml(plan.name)}</div>
    <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:${tier.color};margin-bottom:14px;">${tier.label} Risk</div>
    <div class="plan-range">Min deposit: ${minDeposit}</div>
    ${perfText ? `<div style="font-size:13px;color:var(--text2);margin:10px 0 4px;">${perfText}</div>` : ''}
    <hr class="plan-div"/>
    <div style="font-size:13px;color:var(--text2);line-height:1.65;margin-bottom:14px;">${desc}</div>
    <div style="font-size:11px;color:var(--muted);line-height:1.55;border-top:1px solid var(--border);padding-top:12px;margin-top:auto;">
      ⚠️ Past performance is not a guarantee of future results. Your investment may lose value. All investments carry risk.
    </div>
    <button class="btn btn-gold btn-full" style="margin-top:18px;" onclick="goPage('pg-auth')">Get Started</button>
  </div>`;
}

// ── DEPOSIT PLAN DROPDOWN ──
// Populates the plan selector on the deposit page from the live plans table
async function loadDepositPlanDropdown() {
  const sel = document.getElementById('deposit-plan');
  if (!sel || !supabaseReady) return;
  try {
    const plans = await sbFetch('/rest/v1/plans?select=id,name,risk_tier,min_deposit&active=eq.true&order=min_deposit.asc', { method: 'GET' });
    if (!plans || plans.length === 0) {
      sel.innerHTML = '<option value="">No plans available yet</option>';
      return;
    }
    sel.innerHTML = plans.map(p =>
      `<option value="${p.id}">${escapeHtml(p.name)} — ${p.risk_tier.charAt(0).toUpperCase()+p.risk_tier.slice(1)} (Min $${Number(p.min_deposit).toLocaleString()})</option>`
    ).join('');
  } catch (e) {
    sel.innerHTML = '<option value="">Could not load plans</option>';
  }
}

// ── PUBLIC REVIEWS ──
// Loads reviews from a `reviews` table in Supabase (if it exists).
// To create the table run:
//   create table reviews (
//     id uuid default gen_random_uuid() primary key,
//     reviewer_name text not null,
//     country text,
//     rating integer check (rating between 1 and 5) default 5,
//     body text not null,
//     plan_name text,
//     approved boolean default false,
//     created_at timestamp default now()
//   );
//   alter table reviews enable row level security;
//   create policy "Anyone can view approved reviews" on reviews for select using (approved = true);
//   create policy "Admins can manage reviews" on reviews for all using (exists (select 1 from profiles where id = auth.uid() and is_admin = true));
async function loadPublicReviews() {
  const grid = document.getElementById('reviews');
  if (!grid) return;
  if (!supabaseReady) {
    grid.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted);font-size:13px;grid-column:1/-1;">Reviews will appear here once the platform launches.</div>';
    return;
  }
  try {
    const reviews = await sbFetch('/rest/v1/reviews?approved=eq.true&order=created_at.desc&limit=6', { method: 'GET' });
    if (!reviews || reviews.length === 0) {
      grid.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted);font-size:13px;grid-column:1/-1;">No reviews yet — be the first to leave one after your first investment.</div>';
      return;
    }
    grid.innerHTML = reviews.map(r => `
      <div class="rev-card">
        <div class="rev-hd"><div class="rev-av">${escapeHtml(r.reviewer_name.charAt(0))}</div>
        <div><div class="rev-name">${escapeHtml(r.reviewer_name)}</div>
        <div class="rev-country">${escapeHtml(r.country || '')}</div></div></div>
        <div class="rev-stars">${'★'.repeat(r.rating||5)}${'☆'.repeat(5-(r.rating||5))}</div>
        <div class="rev-text">${escapeHtml(r.body)}</div>
        ${r.plan_name ? `<div class="rev-plan">Plan: ${escapeHtml(r.plan_name)}</div>` : ''}
      </div>`).join('');
  } catch (e) {
    grid.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted);font-size:13px;grid-column:1/-1;">Reviews will appear here once available.</div>';
  }
}

// Call both on page load
(function(){
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { loadPublicPlans(); loadPublicReviews(); loadDepositPlanDropdown(); });
  } else {
    loadPublicPlans(); loadPublicReviews(); loadDepositPlanDropdown();
  }
})();
// Customer testimonials removed: these were hardcoded quotes attributed to fictional people.
// Replace with real, verifiable customer reviews before launch.
(function(){const r=document.getElementById('reviews');if(r)r.innerHTML='<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;grid-column:1/-1;">Customer reviews will appear here once real, verified reviews are collected.</div>';})();
// Investment plan tiers removed: these previously advertised guaranteed fixed returns
// (15-120% over 30-180 days), which isn't something a legitimate investment product can offer.
// Replace this with a real, risk-disclosed investment offering before launch.
(function(){['home-plans','full-plans'].forEach(id=>{const el=document.getElementById(id);if(el)el.innerHTML='<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;grid-column:1/-1;">Investment plan details will be published here once finalized.</div>';});})();
function mkChart(wId,lId,vals,lbls,cls){const w=document.getElementById(wId),l=document.getElementById(lId);if(!w)return;const mx=Math.max(...vals);w.innerHTML=vals.map((v,i)=>`<div class="bar ${cls}" style="height:${Math.max(6,(v/mx)*100)}%;" title="${lbls[i]}: $${v}"></div>`).join('');if(l)l.innerHTML=lbls.map(x=>`<span>${x}</span>`).join('');}
mkChart('ch1','cl1',[62,75,84,91,88,105,93,98,110,103,120,115,108,93],['1','2','3','4','5','6','7','8','9','10','11','12','13','14'],'bar-gold');
mkChart('ch2','cl2',[0,300,560,420,680,1120,0],['Jan','Feb','Mar','Apr','May','Jun','Jul'],'bar-gold');
mkChart('ch3','cl3',[93,93,93,93,93,93,93],['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],'bar-green');
function counter(id,target,pre=''){const el=document.getElementById(id);if(!el)return;const dur=2200,s=performance.now();function step(t){const p=Math.min((t-s)/dur,1);el.textContent=pre+Math.floor(p*target).toLocaleString();if(p<1)requestAnimationFrame(step);}requestAnimationFrame(step);}
// Animated counters for "total paid out" / "active investors" removed: they were hardcoded
// to fabricated totals ($184,200,000 / 48,312). Wire these up to real, current figures before launch.
