const STATE = {
  apiData: null,
  plansData: null,
  tpData: null,
  activeTab: 'api',
  currencyMode: 'native', // 'native' | 'USD' | 'CNY'
  fxRate: 7.2,
  // Tab 1 (API) filters & sorting
  search: '',
  region: 'all',
  providerIds: new Set(),
  tier: 'all',
  minContextTokens: 0,
  cacheMode: 'all',
  ttlFilter: 'all',
  maxBlended: null,
  workloadPreset: 'agent_85',
  deepseekOffPeak: false,
  showThirdPartyCol: false,
  sortKey: 'default',
  sortDir: 'asc',
  mobileApiView: 'cards', // 'cards' | 'table'
  providerOrder: [],
  expandedModelIds: new Set(),
  // Tab 2 (Plans) estimator & filters
  planSearch: '',
  planCategory: 'all',
  planRegion: 'all',
  planMethod: 'all',
  planVendors: new Set(),
  planMaxBudget: null,
  planOnlyCredits: false,
  planSort: 'default',
  cacheHitPct: 80,
  outSharePct: 20,
  tokensPerReqK: 15,
  zhipuOffPeak: false,
  // Tab 3 (Third-party) filters
  tpSearch: '',
  tpChannel: 'all',
  tpStatus: 'all',
};

const WORKLOAD_PRESETS = {
  agent_85: { inShare: 0.75, outShare: 0.25, cacheHit: 0.85, label: '75%输入(85%缓存)+25%输出' },
  chat_50: { inShare: 0.75, outShare: 0.25, cacheHit: 0.5, label: '75%输入(50%缓存)+25%输出' },
  raw_0: { inShare: 0.75, outShare: 0.25, cacheHit: 0.0, label: '75%未缓存输入+25%输出' },
};

const PLAN_SCENES = {
  agent: { cacheHitPct: 80, outSharePct: 20, tokensPerReqK: 18 },
  daily: { cacheHitPct: 50, outSharePct: 25, tokensPerReqK: 15 },
  chat: { cacheHitPct: 20, outSharePct: 35, tokensPerReqK: 10 },
};

const TIER_LABELS = {
  flagship: '旗舰',
  balanced: '均衡',
  fast: '极速轻量',
  'long-context': '长上下文',
};

const DEFAULT_PROVIDER_PRIORITY = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'xai',
  'zhipu',
  'aliyun',
  'kimi',
  'minimax',
  'volcengine',
];

const PROVIDER_ORDER_STORAGE_KEY = 'llm-pricing-provider-order';

function getDefaultProviderOrder(providers) {
  const validIds = new Set(providers.map((p) => p.id));
  const result = [];
  for (const id of DEFAULT_PROVIDER_PRIORITY) {
    if (validIds.has(id) && !result.includes(id)) result.push(id);
  }
  for (const p of providers) {
    if (!result.includes(p.id)) result.push(p.id);
  }
  return result;
}

function sanitizeProviderOrder(savedOrder, providers) {
  const validIds = new Set(providers.map((p) => p.id));
  const fallback = getDefaultProviderOrder(providers);
  const result = [];
  if (Array.isArray(savedOrder)) {
    for (const id of savedOrder) {
      if (typeof id === 'string' && validIds.has(id) && !result.includes(id)) {
        result.push(id);
      }
    }
  }
  for (const id of fallback) {
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

function loadProviderOrder(providers) {
  try {
    const raw = localStorage.getItem(PROVIDER_ORDER_STORAGE_KEY);
    if (!raw) return getDefaultProviderOrder(providers);
    return sanitizeProviderOrder(JSON.parse(raw), providers);
  } catch {
    return getDefaultProviderOrder(providers);
  }
}

function saveProviderOrder(order) {
  try {
    localStorage.setItem(PROVIDER_ORDER_STORAGE_KEY, JSON.stringify(order));
    return true;
  } catch {
    return false;
  }
}

function isCustomProviderOrder() {
  if (!STATE.apiData) return false;
  const def = getDefaultProviderOrder(STATE.apiData.providers);
  if (STATE.providerOrder.length !== def.length) return true;
  return STATE.providerOrder.some((id, idx) => id !== def[idx]);
}

function getProviderRank(providerId) {
  const idx = STATE.providerOrder.indexOf(providerId);
  return idx === -1 ? STATE.providerOrder.length : idx;
}

function getPlanDefaultRank(plan) {
  if (plan.category === 'ide_coding') return 3.5;
  return getProviderRank(plan.providerId);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseContextTokens(ctxStr) {
  if (!ctxStr || typeof ctxStr !== 'string') return 0;
  const match = ctxStr.trim().match(/^(\d+(?:\.\d+)?)\s*([KM])?/i);
  if (!match) return 0;
  const num = Number.parseFloat(match[1]);
  const unit = (match[2] || '').toUpperCase();
  if (unit === 'M') return num * 1_000_000;
  if (unit === 'K') return num * 1_000;
  return num;
}

function convertCurrency(amount, fromCurrency, targetCurrency) {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return null;
  if (targetCurrency === 'native' || fromCurrency === targetCurrency) return amount;
  if (fromCurrency === 'USD' && targetCurrency === 'CNY') return amount * STATE.fxRate;
  if (fromCurrency === 'CNY' && targetCurrency === 'USD') return amount / STATE.fxRate;
  return amount;
}

function currencySymbol(currency) {
  return currency === 'CNY' ? '¥' : '$';
}

function formatPrice(amount, nativeCurrency, targetMode = STATE.currencyMode) {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  const cur = targetMode === 'native' ? nativeCurrency : targetMode;
  const val = convertCurrency(amount, nativeCurrency, cur);
  const sym = currencySymbol(cur);
  if (val === 0) return `${sym}0`;
  if (val < 0.01) return `${sym}${val.toFixed(4)}`;
  if (val < 0.1) return `${sym}${val.toFixed(3)}`;
  if (val < 100) return `${sym}${val.toFixed(2)}`;
  return `${sym}${val.toFixed(0)}`;
}

function formatTokens(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return '—';
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(2)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
  return `${Math.round(tokens)}`;
}

function getEffectiveModelRates(model) {
  const factor = STATE.deepseekOffPeak && model.offPeakFactor ? model.offPeakFactor : 1;
  return {
    input: model.input * factor,
    output: model.output * factor,
    cacheRead: model.cacheRead * factor,
    factor,
  };
}

function computeBlendedPrice(model, inShare, outShare, cacheHit) {
  const rates = getEffectiveModelRates(model);
  const effIn = (1 - cacheHit) * rates.input + cacheHit * rates.cacheRead;
  return inShare * effIn + outShare * rates.output;
}

function computeModelBlendedForPreset(model) {
  const preset = WORKLOAD_PRESETS[STATE.workloadPreset] || WORKLOAD_PRESETS.agent_85;
  return computeBlendedPrice(model, preset.inShare, preset.outShare, preset.cacheHit);
}

function initTheme() {
  const saved = localStorage.getItem('llm-pricing-theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  applyTheme(theme);

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('llm-pricing-theme', next);
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById('theme-toggle').textContent = theme === 'dark' ? '浅色' : '深色';
}

function syncTabFromHash() {
  const raw = window.location.hash.replace(/^#/, '');
  const valid = ['api', 'plans', 'third-party'];
  setActiveTab(valid.includes(raw) ? raw : 'api', false);
}

function setActiveTab(tabId, updateHash = true) {
  STATE.activeTab = tabId;
  closeHeaderPopover();
  if (updateHash && window.location.hash !== `#${tabId}`) {
    history.replaceState(null, '', `#${tabId}`);
  }
  document.querySelectorAll('.tab-link').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach((el) => {
    el.classList.toggle('active', el.id === `panel-${tabId}`);
  });
  syncTableStickyScroll();
}

function syncTopbarHeight() {
  const topbar = document.querySelector('.topbar');
  const tabsNav = document.querySelector('.tabs-nav');
  const headerH = topbar ? Math.ceil(topbar.getBoundingClientRect().height) : 0;
  const navH = tabsNav ? Math.ceil(tabsNav.getBoundingClientRect().height) : 0;
  if (headerH > 0) {
    document.documentElement.style.setProperty('--header-height', `${headerH}px`);
  }
  const isHeaderSticky = topbar && window.getComputedStyle(topbar).position === 'sticky';
  const totalStickyH = (isHeaderSticky ? headerH : 0) + navH;
  if (totalStickyH > 0) {
    document.documentElement.style.setProperty('--topbar-height', `${totalStickyH}px`);
  }
}

let stickyScrollRaf = 0;
function syncTableStickyScroll() {
  if (stickyScrollRaf) cancelAnimationFrame(stickyScrollRaf);
  stickyScrollRaf = requestAnimationFrame(() => {
    stickyScrollRaf = 0;
    document.querySelectorAll('.table-scroll').forEach((scrollEl) => {
      const table = scrollEl.querySelector('.pricing-table');
      if (!table) return;
      if (scrollEl.offsetWidth === 0) {
        scrollEl.classList.remove('has-x-overflow');
        return;
      }
      const needsXScroll = table.scrollWidth > scrollEl.offsetWidth + 1;
      scrollEl.classList.toggle('has-x-overflow', needsXScroll);
    });
  });
}

function syncFilterUnits() {
  document.getElementById('api-max-blended-unit').textContent = STATE.currencyMode === 'CNY' ? '¥/1M' : '$/1M';
  document.getElementById('plan-max-budget-unit').textContent = STATE.currencyMode === 'USD' ? '$/月' : '¥/月';
}

function countApiActiveFilters() {
  let count = 0;
  if (STATE.search.trim() !== '') count += 1;
  if (STATE.region !== 'all') count += 1;
  if (STATE.providerIds.size > 0) count += 1;
  if (STATE.tier !== 'all') count += 1;
  if (STATE.minContextTokens > 0) count += 1;
  if (STATE.cacheMode !== 'all') count += 1;
  if (STATE.ttlFilter !== 'all') count += 1;
  if (STATE.maxBlended !== null && Number.isFinite(STATE.maxBlended)) count += 1;
  return count;
}

function resetApiFilters() {
  STATE.search = '';
  STATE.region = 'all';
  STATE.providerIds.clear();
  STATE.tier = 'all';
  STATE.minContextTokens = 0;
  STATE.cacheMode = 'all';
  STATE.ttlFilter = 'all';
  STATE.maxBlended = null;

  document.getElementById('api-search').value = '';
  document.querySelectorAll('#region-filter [data-region]').forEach((b) => {
    b.classList.toggle('active', b.dataset.region === 'all');
  });
  document.getElementById('api-tier-filter').value = 'all';
  document.getElementById('api-ctx-filter').value = '0';
  document.getElementById('cache-mode-filter').value = 'all';
  document.getElementById('api-ttl-filter').value = 'all';
  document.getElementById('api-max-blended').value = '';

  renderProviderChips();
  renderApiTable();
}

function renderProviderChips() {
  const container = document.getElementById('provider-chips');
  const providers = [...STATE.apiData.providers].sort(
    (a, b) => getProviderRank(a.id) - getProviderRank(b.id)
  );
  const counts = new Map();
  let visibleTotal = 0;
  for (const m of STATE.apiData.models) {
    counts.set(m.providerId, (counts.get(m.providerId) || 0) + 1);
  }
  const chips = [];
  for (const p of providers) {
    if (STATE.region !== 'all' && p.region !== STATE.region) continue;
    const count = counts.get(p.id) || 0;
    visibleTotal += count;
    const active = STATE.providerIds.has(p.id);
    chips.push(
      `<button type="button" class="chip ${active ? 'active' : ''}" data-provider="${escapeHtml(
        p.id
      )}">${escapeHtml(p.name)} (${count})</button>`
    );
  }
  const allChip = `<button type="button" class="chip ${
    STATE.providerIds.size === 0 ? 'active' : ''
  }" data-provider="all">全部 (${visibleTotal})</button>`;
  container.innerHTML = allChip + chips.join('');
}

function matchesTtlFilter(model, ttlFilter) {
  if (ttlFilter === 'all') return true;
  if (ttlFilter === 'auto_only') return model.cacheWriteMode === 'free_auto';
  if (ttlFilter === 'explicit_ttl') return /(5m|30m|1h|12h|168h)/i.test(model.cacheTtl || '');
  if (ttlFilter === 'long_ttl') return /(1h|12h|168h)/i.test(model.cacheTtl || '');
  return true;
}

function renderCacheWriteCell(model) {
  if (model.cacheWriteMode === 'multiplier') {
    const parts = [];
    if (model.cacheWrite5m !== undefined && model.cacheWrite5m !== null) {
      parts.push(`5m: ${formatPrice(model.cacheWrite5m, model.currency)}`);
    }
    if (model.cacheWrite30m !== undefined && model.cacheWrite30m !== null) {
      parts.push(`30m: ${formatPrice(model.cacheWrite30m, model.currency)}`);
    }
    if (model.cacheWrite1h !== undefined && model.cacheWrite1h !== null) {
      parts.push(`1h: ${formatPrice(model.cacheWrite1h, model.currency)}`);
    }
    if (model.cacheWrite12h !== undefined && model.cacheWrite12h !== null) {
      parts.push(`12h: ${formatPrice(model.cacheWrite12h, model.currency)}`);
    }
    return `<div class="mono">${parts.join('<br>')}</div>`;
  }
  if (model.cacheWriteMode === 'storage_hourly') {
    const storeText =
      model.cacheStoragePerHour === 0
        ? '写入按输入 · 存储限时免费'
        : `写入按输入<span class="sub-metric">存储 ${formatPrice(model.cacheStoragePerHour, model.currency)}/1M/h</span>`;
    return `<div>${storeText}</div>`;
  }
  return '<span class="badge badge-green">免写入/存储费</span>';
}

function renderThirdPartyCell(model) {
  const matches = (STATE.tpData?.benchmarks || []).filter((b) => b.modelId === model.id);
  if (matches.length === 0) {
    return '<span class="muted small">暂未收录</span>';
  }
  const chMap = new Map((STATE.tpData.channels || []).map((c) => [c.id, c]));
  return matches
    .map((b) => {
      const ch = chMap.get(b.channelId);
      const speed = b.tokensPerSec !== null ? `${b.tokensPerSec} tok/s` : '待实测 tok/s';
      const delta = b.priceDeltaPct === 0 ? '标价 0% 差' : `${b.priceDeltaPct > 0 ? '+' : ''}${b.priceDeltaPct}%`;
      return `<div><strong>${escapeHtml(ch ? ch.name : b.channelId)}</strong><span class="sub-metric">${escapeHtml(
        delta
      )} · ${escapeHtml(speed)}</span></div>`;
    })
    .join('');
}

function renderApiTable() {
  const providerMap = new Map(STATE.apiData.providers.map((p) => [p.id, p]));
  const query = STATE.search.trim().toLowerCase();
  const blendedFilterCur = STATE.currencyMode === 'CNY' ? 'CNY' : 'USD';

  const rows = STATE.apiData.models.filter((m) => {
    const p = providerMap.get(m.providerId);
    if (!p) return false;
    if (STATE.region !== 'all' && p.region !== STATE.region) return false;
    if (STATE.providerIds.size > 0 && !STATE.providerIds.has(m.providerId)) return false;
    if (STATE.tier !== 'all' && m.tier !== STATE.tier) return false;
    if (STATE.minContextTokens > 0 && parseContextTokens(m.contextWindow) < STATE.minContextTokens) return false;
    if (STATE.cacheMode !== 'all' && m.cacheWriteMode !== STATE.cacheMode) return false;
    if (!matchesTtlFilter(m, STATE.ttlFilter)) return false;
    if (STATE.maxBlended !== null && Number.isFinite(STATE.maxBlended)) {
      const blendedInTarget = convertCurrency(computeModelBlendedForPreset(m), m.currency, blendedFilterCur);
      if (blendedInTarget > STATE.maxBlended) return false;
    }
    if (query) {
      const hay = `${p.name} ${m.name} ${m.modelId} ${m.notes || ''} ${m.promoNote || ''} ${
        TIER_LABELS[m.tier] || ''
      }`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  const modelIndexMap = new Map(STATE.apiData.models.map((m, idx) => [m.id, idx]));

  rows.sort((a, b) => {
    if (STATE.sortKey === 'default') {
      const ra = getProviderRank(a.providerId);
      const rb = getProviderRank(b.providerId);
      if (ra !== rb) {
        return STATE.sortDir === 'asc' ? ra - rb : rb - ra;
      }
      return (modelIndexMap.get(a.id) ?? 0) - (modelIndexMap.get(b.id) ?? 0);
    }
    const pa = providerMap.get(a.providerId);
    const pb = providerMap.get(b.providerId);
    if (STATE.sortKey === 'provider') {
      const va = `${pa.name} ${a.name}`;
      const vb = `${pb.name} ${b.name}`;
      return STATE.sortDir === 'asc' ? va.localeCompare(vb, 'zh-CN') : vb.localeCompare(va, 'zh-CN');
    }
    let va;
    let vb;
    if (STATE.sortKey === 'blended') {
      va = convertCurrency(computeModelBlendedForPreset(a), a.currency, 'USD');
      vb = convertCurrency(computeModelBlendedForPreset(b), b.currency, 'USD');
    } else {
      const ra = getEffectiveModelRates(a);
      const rb = getEffectiveModelRates(b);
      va = convertCurrency(ra[STATE.sortKey], a.currency, 'USD');
      vb = convertCurrency(rb[STATE.sortKey], b.currency, 'USD');
    }
    return STATE.sortDir === 'asc' ? va - vb : vb - va;
  });

  document.getElementById('api-result-summary').textContent = `当前显示 ${rows.length} / ${STATE.apiData.models.length} 个模型`;
  const activeCount = countApiActiveFilters();
  const resetBtn = document.getElementById('api-reset-filters');
  resetBtn.classList.toggle('hidden', activeCount === 0);
  if (activeCount > 0) {
    resetBtn.textContent = `重置筛选 (${activeCount})`;
  }
  const advBtn = document.getElementById('api-toggle-advanced');
  if (advBtn) {
    advBtn.textContent = activeCount > 0 ? `筛选 (${activeCount})` : '筛选';
    advBtn.classList.toggle('has-active', activeCount > 0);
  }

  document.querySelectorAll('#api-table .tp-col').forEach((th) => {
    th.classList.toggle('hidden', !STATE.showThirdPartyCol);
  });

  renderApiMobileCards(rows, providerMap);

  const tbody = document.getElementById('api-tbody');
  const colSpan = STATE.showThirdPartyCol ? 9 : 8;
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colSpan}" style="padding:28px;text-align:center;">
      <div class="muted" style="margin-bottom:10px;">没有匹配当前筛选条件的模型。</div>
      <button type="button" class="btn-reset" data-action="reset-api-filters">清空全部筛选条件</button>
    </td></tr>`;
    return;
  }

  const html = [];
  for (const m of rows) {
    const p = providerMap.get(m.providerId);
    const eff = getEffectiveModelRates(m);
    const blended = computeModelBlendedForPreset(m);
    const cacheRatio = m.input > 0 ? m.cacheRead / m.input : 0;
    const isExpanded = STATE.expandedModelIds.has(m.id);

    const badges = [
      `<span class="badge badge-neutral">${escapeHtml(m.contextWindow)}</span>`,
      `<span class="badge badge-neutral">${escapeHtml(TIER_LABELS[m.tier] || m.tier)}</span>`,
    ];
    if (m.offPeakFactor && STATE.deepseekOffPeak) {
      badges.push('<span class="badge badge-green">已按空闲 5 折</span>');
    } else if (m.offPeakFactor) {
      badges.push('<span class="badge badge-accent">空闲半价</span>');
    }
    if (m.promoNote) {
      badges.push(`<span class="badge badge-warn">${escapeHtml(m.promoNote)}</span>`);
    }
    if (m.longContextRule) {
      badges.push(`<span class="badge badge-purple">${escapeHtml(m.longContextRule)}</span>`);
    }

    const extraLinksHtml = (p.extraUrls || [])
      .map(
        (ex) =>
          `<a class="ext-link" href="${escapeHtml(ex.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
            ex.label
          )} ↗</a>`
      )
      .join('');

    html.push(`
      <tr class="model-row ${isExpanded ? 'expanded' : ''}" data-model-id="${escapeHtml(m.id)}">
        <td>
          <div class="provider-line">
            <span>${escapeHtml(p.name)}</span>
            <span>·</span>
            <span class="mono">${escapeHtml(m.modelId)}</span>
          </div>
          <div class="model-name">${escapeHtml(m.name)}</div>
          <div class="model-badges">${badges.join('')}</div>
        </td>
        <td class="num">
          <span class="price-strong">${escapeHtml(formatPrice(eff.input, m.currency))}</span>
          ${
            STATE.currencyMode !== 'native' && STATE.currencyMode !== m.currency
              ? `<span class="sub-metric">原价 ${escapeHtml(formatPrice(eff.input, m.currency, 'native'))}</span>`
              : ''
          }
        </td>
        <td class="num">
          <span class="price-strong">${escapeHtml(formatPrice(eff.output, m.currency))}</span>
        </td>
        <td class="num">
          <span class="price-strong">${escapeHtml(formatPrice(eff.cacheRead, m.currency))}</span>
          <span class="sub-metric">${(cacheRatio * 100).toFixed(cacheRatio < 0.05 ? 1 : 0)}% (${cacheRatio.toFixed(
            cacheRatio < 0.05 ? 3 : 2
          )}x)</span>
        </td>
        <td>${renderCacheWriteCell(m)}</td>
        <td>
          <div>${escapeHtml(m.cacheTtl)}</div>
        </td>
        <td class="num">
          <span class="blended-val">${escapeHtml(formatPrice(blended, m.currency))}</span>
          <span class="sub-metric">${escapeHtml(WORKLOAD_PRESETS[STATE.workloadPreset].label)}</span>
        </td>
        <td class="tp-col ${STATE.showThirdPartyCol ? '' : 'hidden'}">${renderThirdPartyCell(m)}</td>
        <td class="right">
          <div class="source-links">
            <a class="ext-link" href="${escapeHtml(m.sourceUrl)}" target="_blank" rel="noopener noreferrer">官方定价 ↗</a>
            ${extraLinksHtml}
          </div>
        </td>
      </tr>
    `);

    if (isExpanded) {
      html.push(`
        <tr class="detail-row">
          <td colspan="${colSpan}">
            <div class="detail-grid">
              <div>
                <div class="detail-item-label">缓存与 TTL 细则</div>
                <div class="detail-item-val">${escapeHtml(m.cacheTtlDetail || m.cacheTtl)}</div>
              </div>
              <div>
                <div class="detail-item-label">计费备注 / 阶梯规则</div>
                <div class="detail-item-val">${escapeHtml(m.notes || '—')}</div>
              </div>
              <div>
                <div class="detail-item-label">厂商通用政策（${escapeHtml(p.name)}）</div>
                <div class="detail-item-val">${escapeHtml(p.billingNotes)}</div>
              </div>
              <div>
                <div class="detail-item-label">全部官方链接</div>
                <div class="detail-item-val">
                  <a class="ext-link" href="${escapeHtml(m.sourceUrl)}" target="_blank" rel="noopener noreferrer">模型价格页 ↗</a>
                  ${
                    p.pricingUrl !== m.sourceUrl
                      ? ` · <a class="ext-link" href="${escapeHtml(p.pricingUrl)}" target="_blank" rel="noopener noreferrer">厂商定价页 ↗</a>`
                      : ''
                  }
                  ${(p.extraUrls || [])
                    .map(
                      (ex) =>
                        ` · <a class="ext-link" href="${escapeHtml(ex.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
                          ex.label
                        )} ↗</a>`
                    )
                    .join('')}
                </div>
              </div>
            </div>
          </td>
        </tr>
      `);
    }
  }
  tbody.innerHTML = html.join('');
  syncTableStickyScroll();
}

function renderApiMobileCards(rows, providerMap) {
  const container = document.getElementById('api-mobile-cards');
  if (!container) return;

  if (rows.length === 0) {
    container.innerHTML = `<div class="card empty-state">
      <div>没有匹配当前筛选条件的模型。</div>
      <button type="button" class="btn-reset" data-action="reset-api-filters">清空全部筛选条件</button>
    </div>`;
    return;
  }

  container.innerHTML = rows
    .map((m) => {
      const p = providerMap.get(m.providerId);
      const eff = getEffectiveModelRates(m);
      const blended = computeModelBlendedForPreset(m);
      const cacheRatio = m.input > 0 ? m.cacheRead / m.input : 0;
      const isExpanded = STATE.expandedModelIds.has(m.id);

      const badges = [
        `<span class="badge badge-neutral">${escapeHtml(m.contextWindow)}</span>`,
        `<span class="badge badge-neutral">${escapeHtml(TIER_LABELS[m.tier] || m.tier)}</span>`,
      ];
      if (m.offPeakFactor && STATE.deepseekOffPeak) {
        badges.push('<span class="badge badge-green">已按空闲 5 折</span>');
      } else if (m.offPeakFactor) {
        badges.push('<span class="badge badge-accent">空闲半价</span>');
      }
      if (m.promoNote) {
        badges.push(`<span class="badge badge-warn">${escapeHtml(m.promoNote)}</span>`);
      }
      if (m.longContextRule) {
        badges.push(`<span class="badge badge-purple">${escapeHtml(m.longContextRule)}</span>`);
      }

      const detailHtml = isExpanded
        ? `<div class="mcard-detail detail-grid">
            <div>
              <div class="detail-item-label">缓存与 TTL 细则</div>
              <div class="detail-item-val">${escapeHtml(m.cacheTtlDetail || m.cacheTtl)}</div>
            </div>
            <div>
              <div class="detail-item-label">计费备注 / 阶梯规则</div>
              <div class="detail-item-val">${escapeHtml(m.notes || '—')}</div>
            </div>
            <div>
              <div class="detail-item-label">厂商通用政策（${escapeHtml(p.name)}）</div>
              <div class="detail-item-val">${escapeHtml(p.billingNotes)}</div>
            </div>
            ${
              STATE.showThirdPartyCol
                ? `<div><div class="detail-item-label">第三方渠道（预留）</div><div class="detail-item-val">${renderThirdPartyCell(
                    m
                  )}</div></div>`
                : ''
            }
            <div>
              <div class="detail-item-label">全部官方链接</div>
              <div class="detail-item-val">
                <a class="ext-link" href="${escapeHtml(m.sourceUrl)}" target="_blank" rel="noopener noreferrer">模型价格页 ↗</a>
                ${
                  p.pricingUrl !== m.sourceUrl
                    ? ` · <a class="ext-link" href="${escapeHtml(p.pricingUrl)}" target="_blank" rel="noopener noreferrer">厂商定价页 ↗</a>`
                    : ''
                }
                ${(p.extraUrls || [])
                  .map(
                    (ex) =>
                      ` · <a class="ext-link" href="${escapeHtml(ex.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
                        ex.label
                      )} ↗</a>`
                  )
                  .join('')}
              </div>
            </div>
          </div>`
        : '';

      return `
        <article class="card mcard ${isExpanded ? 'expanded' : ''}" data-model-id="${escapeHtml(m.id)}">
          <div class="mcard-head">
            <div>
              <div class="provider-line">
                <span>${escapeHtml(p.name)}</span>
                <span>·</span>
                <span class="mono">${escapeHtml(m.modelId)}</span>
              </div>
              <div class="model-name">${escapeHtml(m.name)}</div>
              <div class="model-badges">${badges.join('')}</div>
            </div>
            <a class="ext-link" href="${escapeHtml(m.sourceUrl)}" target="_blank" rel="noopener noreferrer">官方 ↗</a>
          </div>

          <div class="mcard-metrics">
            <div class="mcard-metric-item">
              <span class="mcard-metric-label">输入 / 1M</span>
              <span class="mcard-metric-val mono">${escapeHtml(formatPrice(eff.input, m.currency))}</span>
            </div>
            <div class="mcard-metric-item">
              <span class="mcard-metric-label">输出 / 1M</span>
              <span class="mcard-metric-val mono">${escapeHtml(formatPrice(eff.output, m.currency))}</span>
            </div>
            <div class="mcard-metric-item">
              <span class="mcard-metric-label">综合估算<button type="button" class="th-help-btn" data-help="blended" aria-label="查看综合估算价说明" aria-expanded="false">?</button></span>
              <span class="mcard-metric-val mono blended-val">${escapeHtml(formatPrice(blended, m.currency))}</span>
            </div>
          </div>

          <div class="mcard-cache-grid">
            <div class="mcard-cache-cell">
              <span class="mcard-metric-label">缓存读<button type="button" class="th-help-btn" data-help="cacheRead" aria-label="查看缓存读说明" aria-expanded="false">?</button></span>
              <span class="mono"><strong>${escapeHtml(formatPrice(eff.cacheRead, m.currency))}</strong> <span class="muted">(${(
                cacheRatio * 100
              ).toFixed(cacheRatio < 0.05 ? 1 : 0)}%)</span></span>
            </div>
            <div class="mcard-cache-cell">
              <span class="mcard-metric-label">缓存写/存储<button type="button" class="th-help-btn" data-help="cacheWrite" aria-label="查看缓存写与存储费说明" aria-expanded="false">?</button></span>
              <div>${renderCacheWriteCell(m)}</div>
            </div>
            <div class="mcard-cache-cell">
              <span class="mcard-metric-label">TTL<button type="button" class="th-help-btn" data-help="cacheTtl" aria-label="查看缓存时间 TTL 说明" aria-expanded="false">?</button></span>
              <div>${escapeHtml(m.cacheTtl)}</div>
            </div>
          </div>

          ${detailHtml}
        </article>
      `;
    })
    .join('');
}

function renderProviderSourcesGrid() {
  const grid = document.getElementById('providers-sources-grid');
  const sortedProviders = [...STATE.apiData.providers].sort(
    (a, b) => getProviderRank(a.id) - getProviderRank(b.id)
  );
  grid.innerHTML = sortedProviders
    .map((p) => {
      const regionTag =
        p.region === 'global'
          ? '<span class="badge badge-neutral">海外</span>'
          : '<span class="badge badge-accent">国内</span>';
      const extras = (p.extraUrls || [])
        .map(
          (ex) =>
            `<a class="ext-link" href="${escapeHtml(ex.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
              ex.label
            )} ↗</a>`
        )
        .join('');
      return `
        <article class="card source-card">
          <div class="source-card-top">
            <h3>${escapeHtml(p.name)}</h3>
            ${regionTag}
          </div>
          <div class="small muted">${escapeHtml(p.cacheSummary)}</div>
          <div class="source-card-links">
            <a class="ext-link" href="${escapeHtml(p.pricingUrl)}" target="_blank" rel="noopener noreferrer">官方定价文档 ↗</a>
            ${extras}
          </div>
        </article>
      `;
    })
    .join('');
}

function updateSortIndicators() {
  document.querySelectorAll('#api-table th.sortable').forEach((th) => {
    const active = th.dataset.sort === STATE.sortKey;
    th.classList.toggle('active-sort', active);
    const oldArrow = th.querySelector('.sort-arrow');
    if (oldArrow) oldArrow.remove();
    if (active) {
      const span = document.createElement('span');
      span.className = 'sort-arrow';
      span.textContent = STATE.sortDir === 'asc' ? ' ↑' : ' ↓';
      const helpBtn = th.querySelector('.th-help-btn');
      if (helpBtn) {
        th.insertBefore(span, helpBtn);
      } else {
        th.appendChild(span);
      }
    }
  });
  const mobileSort = document.getElementById('api-mobile-sort');
  if (mobileSort) {
    const val = `${STATE.sortKey}:${STATE.sortDir}`;
    if ([...mobileSort.options].some((o) => o.value === val)) {
      mobileSort.value = val;
    }
  }
}

function estimatePlanTokens(plan, modelMap) {
  const est = plan.estimation;
  const refModel = modelMap.get(est.refModelId);
  const outShare = STATE.outSharePct / 100;
  const inShare = 1 - outShare;
  const cacheHit = STATE.cacheHitPct / 100;

  const refBlendedNative = computeBlendedPrice(refModel, inShare, outShare, cacheHit);
  const refBlendedUsd = convertCurrency(refBlendedNative, refModel.currency, 'USD');

  if (est.kind === 'formula_points') {
    const uncachedInShare = inShare * (1 - cacheHit);
    const cachedInShare = inShare * cacheHit;
    const ptsPer1MTokens =
      (uncachedInShare * est.inWeight + cachedInShare * est.cacheWeight + outShare * est.outWeight) *
      (1_000_000 / est.divisor);
    const monthlyPoints = est.weeklyPoints * 4.33;
    const multiplier = STATE.zhipuOffPeak && est.offPeakFactor ? 1 / est.offPeakFactor : 1;
    const totalTokens = ((monthlyPoints * multiplier) / ptsPer1MTokens) * 1_000_000;
    const apiValueNative = (totalTokens / 1_000_000) * refBlendedNative;
    return {
      badgeClass: 'badge-green',
      estTokensMid: totalTokens,
      tokensLabel: `约 ${formatTokens(totalTokens)} Tokens / 月`,
      valueLabel: `等效 ${refModel.name} API 价值约 ${formatPrice(apiValueNative, refModel.currency)}`,
      detailFormula: `月 ${Math.round(monthlyPoints).toLocaleString()} 积分 ÷ ${ptsPer1MTokens.toFixed(1)} 积分/1M${
        multiplier > 1 ? '（含非高峰 2× 效能）' : ''
      }`,
    };
  }

  if (est.kind === 'credits_usd') {
    const totalTokens = (est.includedCreditsUsd / refBlendedUsd) * 1_000_000;
    return {
      badgeClass: 'badge-accent',
      estTokensMid: totalTokens,
      tokensLabel: `约 ${formatTokens(totalTokens)} Tokens / 月`,
      valueLabel: `含固定 ${formatPrice(est.includedCreditsUsd, 'USD')} AI Credits（另含无限补全）`,
      detailFormula: `按 ${refModel.name} 混合单价 ${formatPrice(refBlendedNative, refModel.currency)}/1M 精确折算`,
    };
  }

  if (est.kind === 'requests_based') {
    const [minUtil, maxUtil] = est.typicalUtilizationRange;
    const tokensPerReq = STATE.tokensPerReqK * 1000;
    const minTokens = est.monthlyRequests * tokensPerReq * minUtil;
    const maxTokens = est.monthlyRequests * tokensPerReq * maxUtil;
    const minVal = (minTokens / 1_000_000) * refBlendedNative;
    const maxVal = (maxTokens / 1_000_000) * refBlendedNative;
    return {
      badgeClass: 'badge-warn',
      estTokensMid: (minTokens + maxTokens) / 2,
      tokensLabel: `${formatTokens(minTokens)} – ${formatTokens(maxTokens)} Tokens / 月`,
      valueLabel: `等效 ${refModel.name} API 约 ${formatPrice(minVal, refModel.currency)} – ${formatPrice(
        maxVal,
        refModel.currency
      )}`,
      detailFormula: `${est.monthlyRequests.toLocaleString()} 次/月 × ${STATE.tokensPerReqK}K/次 × ${Math.round(
        minUtil * 100
      )}%–${Math.round(maxUtil * 100)}% 利用率`,
    };
  }

  let minUsd;
  let maxUsd;
  if (est.estimatedApiValueRangeUsd) {
    [minUsd, maxUsd] = est.estimatedApiValueRangeUsd;
  } else {
    const [minCny, maxCny] = est.estimatedApiValueRangeCny;
    minUsd = convertCurrency(minCny, 'CNY', 'USD');
    maxUsd = convertCurrency(maxCny, 'CNY', 'USD');
  }
  const minTokens = (minUsd / refBlendedUsd) * 1_000_000;
  const maxTokens = (maxUsd / refBlendedUsd) * 1_000_000;
  const minDisp = est.estimatedApiValueRangeCny
    ? formatPrice(est.estimatedApiValueRangeCny[0], 'CNY')
    : formatPrice(minUsd, 'USD');
  const maxDisp = est.estimatedApiValueRangeCny
    ? formatPrice(est.estimatedApiValueRangeCny[1], 'CNY')
    : formatPrice(maxUsd, 'USD');
  const creditTag =
    est.includedApiCreditUsd > 0 ? ` · 含 ${formatPrice(est.includedApiCreditUsd, 'USD')} 直用 API Credits` : '';

  return {
    badgeClass: 'badge-purple',
    estTokensMid: (minTokens + maxTokens) / 2,
    tokensLabel: `${formatTokens(minTokens)} – ${formatTokens(maxTokens)} Tokens / 月`,
    valueLabel: `等效 API 价值估算 ${minDisp} – ${maxDisp}${creditTag}`,
    detailFormula: `按 ${refModel.name} 混合单价 ${formatPrice(refBlendedNative, refModel.currency)}/1M 折算`,
  };
}

function countPlanActiveFilters() {
  let count = 0;
  if (STATE.planSearch.trim() !== '') count += 1;
  if (STATE.planCategory !== 'all') count += 1;
  if (STATE.planRegion !== 'all') count += 1;
  if (STATE.planMethod !== 'all') count += 1;
  if (STATE.planVendors.size > 0) count += 1;
  if (STATE.planMaxBudget !== null && Number.isFinite(STATE.planMaxBudget)) count += 1;
  if (STATE.planOnlyCredits) count += 1;
  return count;
}

function resetPlanFilters() {
  STATE.planSearch = '';
  STATE.planCategory = 'all';
  STATE.planRegion = 'all';
  STATE.planMethod = 'all';
  STATE.planVendors.clear();
  STATE.planMaxBudget = null;
  STATE.planOnlyCredits = false;
  STATE.planSort = 'default';

  document.getElementById('plan-search').value = '';
  document.querySelectorAll('#plan-category-filter [data-category]').forEach((b) => {
    b.classList.toggle('active', b.dataset.category === 'all');
  });
  document.querySelectorAll('#plan-region-filter [data-plan-region]').forEach((b) => {
    b.classList.toggle('active', b.dataset.planRegion === 'all');
  });
  document.getElementById('plan-method-filter').value = 'all';
  document.getElementById('plan-max-budget').value = '';
  document.getElementById('plan-only-credits').checked = false;
  document.getElementById('plan-sort').value = 'default';

  renderPlanVendorChips();
  renderPlans();
}

function renderPlanVendorChips() {
  const container = document.getElementById('plan-vendor-chips');
  const vendorStats = new Map();
  let visibleTotal = 0;
  for (const pl of STATE.plansData.plans) {
    if (STATE.planRegion !== 'all' && pl.region !== STATE.planRegion) continue;
    const rank = getPlanDefaultRank(pl);
    const existing = vendorStats.get(pl.vendorName);
    if (existing) {
      existing.count += 1;
      existing.rank = Math.min(existing.rank, rank);
    } else {
      vendorStats.set(pl.vendorName, { count: 1, rank });
    }
    visibleTotal += 1;
  }

  const sortedVendors = [...vendorStats.entries()].sort((a, b) => a[1].rank - b[1].rank);
  const chips = [
    `<button type="button" class="chip ${
      STATE.planVendors.size === 0 ? 'active' : ''
    }" data-plan-vendor="all">全部 (${visibleTotal})</button>`,
  ];
  for (const [vendorName, info] of sortedVendors) {
    const active = STATE.planVendors.has(vendorName);
    chips.push(
      `<button type="button" class="chip ${active ? 'active' : ''}" data-plan-vendor="${escapeHtml(
        vendorName
      )}">${escapeHtml(vendorName)} (${info.count})</button>`
    );
  }
  container.innerHTML = chips.join('');
}

function renderPlans() {
  const modelMap = new Map(STATE.apiData.models.map((m) => [m.id, m]));
  const planIndexMap = new Map(STATE.plansData.plans.map((pl, idx) => [pl.id, idx]));
  const query = STATE.planSearch.trim().toLowerCase();
  const budgetCur = STATE.currencyMode === 'USD' ? 'USD' : 'CNY';

  const enriched = STATE.plansData.plans
    .filter((pl) => {
      if (STATE.planCategory !== 'all' && pl.category !== STATE.planCategory) return false;
      if (STATE.planRegion !== 'all' && pl.region !== STATE.planRegion) return false;
      if (STATE.planMethod !== 'all' && pl.estimation.kind !== STATE.planMethod) return false;
      if (STATE.planVendors.size > 0 && !STATE.planVendors.has(pl.vendorName)) return false;
      if (STATE.planOnlyCredits) {
        const hasCredits =
          (pl.estimation.includedApiCreditUsd && pl.estimation.includedApiCreditUsd > 0) ||
          pl.estimation.kind === 'credits_usd';
        if (!hasCredits) return false;
      }
      if (STATE.planMaxBudget !== null && Number.isFinite(STATE.planMaxBudget)) {
        if (pl.monthlyPrice === null) return false;
        const priceInTarget = convertCurrency(pl.monthlyPrice, pl.currency, budgetCur);
        if (priceInTarget > STATE.planMaxBudget) return false;
      }
      if (query) {
        const hay = `${pl.vendorName} ${pl.planName} ${pl.models.join(' ')} ${pl.quotaSummary} ${
          pl.annualNote || ''
        } ${pl.resetRule}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    })
    .map((pl) => {
      const calc = estimatePlanTokens(pl, modelMap);
      const priceUsd = pl.monthlyPrice === null ? null : convertCurrency(pl.monthlyPrice, pl.currency, 'USD');
      return { pl, calc, priceUsd };
    });

  if (STATE.planSort === 'default') {
    enriched.sort((a, b) => {
      const ra = getPlanDefaultRank(a.pl);
      const rb = getPlanDefaultRank(b.pl);
      if (ra !== rb) return ra - rb;
      return (planIndexMap.get(a.pl.id) ?? 0) - (planIndexMap.get(b.pl.id) ?? 0);
    });
  } else {
    enriched.sort((a, b) => {
      if (STATE.planSort === 'price_asc') {
        if (a.priceUsd === null && b.priceUsd === null) return 0;
        if (a.priceUsd === null) return 1;
        if (b.priceUsd === null) return -1;
        return a.priceUsd - b.priceUsd;
      }
      if (STATE.planSort === 'price_desc') {
        if (a.priceUsd === null && b.priceUsd === null) return 0;
        if (a.priceUsd === null) return 1;
        if (b.priceUsd === null) return -1;
        return b.priceUsd - a.priceUsd;
      }
      if (STATE.planSort === 'tokens_desc') {
        return b.calc.estTokensMid - a.calc.estTokensMid;
      }
      if (STATE.planSort === 'value_ratio_desc') {
        const ra = a.priceUsd && a.priceUsd > 0 ? a.calc.estTokensMid / a.priceUsd : -1;
        const rb = b.priceUsd && b.priceUsd > 0 ? b.calc.estTokensMid / b.priceUsd : -1;
        return rb - ra;
      }
      return 0;
    });
  }

  document.getElementById('plans-count-summary').textContent = `显示 ${enriched.length} / ${STATE.plansData.plans.length} 个档位`;
  const activeCount = countPlanActiveFilters();
  const resetBtn = document.getElementById('plan-reset-filters');
  resetBtn.classList.toggle('hidden', activeCount === 0);
  if (activeCount > 0) {
    resetBtn.textContent = `重置筛选 (${activeCount})`;
  }
  const planAdvBtn = document.getElementById('plan-toggle-advanced');
  if (planAdvBtn) {
    planAdvBtn.textContent = activeCount > 0 ? `筛选 (${activeCount})` : '筛选';
    planAdvBtn.classList.toggle('has-active', activeCount > 0);
  }

  const grid = document.getElementById('plans-grid');
  if (enriched.length === 0) {
    grid.innerHTML = `<div class="card empty-state">
      <div>没有匹配当前筛选条件的套餐档位。</div>
      <button type="button" class="btn-reset" data-action="reset-plan-filters">清空全部筛选条件</button>
    </div>`;
    return;
  }

  grid.innerHTML = enriched
    .map(({ pl, calc }) => {
      const priceText =
        pl.monthlyPrice === null
          ? escapeHtml(pl.priceLabel)
          : `${escapeHtml(formatPrice(pl.monthlyPrice, pl.currency))}<span class="muted small"> / 月</span>`;
      const nativeHint =
        pl.monthlyPrice !== null && STATE.currencyMode !== 'native' && STATE.currencyMode !== pl.currency
          ? `<span class="muted small">原价 ${escapeHtml(formatPrice(pl.monthlyPrice, pl.currency, 'native'))}/月</span>`
          : '';
      const extraLinks = (pl.extraUrls || [])
        .map(
          (ex) =>
            `<a class="ext-link" href="${escapeHtml(ex.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
              ex.label
            )} ↗</a>`
        )
        .join('');

      return `
        <article class="card plan-card">
          <div class="plan-head">
            <div>
              <div class="plan-vendor">${escapeHtml(pl.vendorName)} · ${pl.region === 'global' ? '海外' : '国内'}</div>
              <h3 class="plan-title">${escapeHtml(pl.planName)}</h3>
            </div>
            <span class="badge ${calc.badgeClass}">${escapeHtml(pl.estimation.methodLabel)}</span>
          </div>

          <div class="plan-price-row">
            <div class="plan-price mono">${priceText}</div>
            ${nativeHint}
          </div>
          ${pl.annualNote ? `<div class="muted small">${escapeHtml(pl.annualNote)}</div>` : ''}

          <div class="plan-estimate-box">
            <div class="plan-estimate-label">
              <span>月可用 Token 估算</span>
              <span class="mono">${escapeHtml(calc.detailFormula)}</span>
            </div>
            <div class="plan-estimate-tokens mono">${escapeHtml(calc.tokensLabel)}</div>
            <div class="small muted">${escapeHtml(calc.valueLabel)}</div>
          </div>

          <div class="plan-models">
            ${pl.models.map((m) => `<span class="model-pill">${escapeHtml(m)}</span>`).join('')}
          </div>

          <p class="plan-quota"><strong>配额与重置：</strong>${escapeHtml(pl.quotaSummary)}（${escapeHtml(
            pl.resetRule
          )}）</p>
          <p class="plan-basis"><strong>估算依据：</strong>${escapeHtml(pl.estimation.basisNote)}</p>

          <div class="plan-foot">
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <a class="ext-link" href="${escapeHtml(pl.sourceUrl)}" target="_blank" rel="noopener noreferrer">官方套餐页 ↗</a>
              ${extraLinks}
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

function populateThirdPartyChannelFilter() {
  const select = document.getElementById('tp-channel-filter');
  const options = ['<option value="all">全部渠道</option>'];
  for (const ch of STATE.tpData.channels) {
    options.push(`<option value="${escapeHtml(ch.id)}">${escapeHtml(ch.name)}</option>`);
  }
  select.innerHTML = options.join('');
}

function countThirdPartyActiveFilters() {
  let count = 0;
  if (STATE.tpSearch.trim() !== '') count += 1;
  if (STATE.tpChannel !== 'all') count += 1;
  if (STATE.tpStatus !== 'all') count += 1;
  return count;
}

function resetThirdPartyFilters() {
  STATE.tpSearch = '';
  STATE.tpChannel = 'all';
  STATE.tpStatus = 'all';
  document.getElementById('tp-search').value = '';
  document.getElementById('tp-channel-filter').value = 'all';
  document.getElementById('tp-status-filter').value = 'all';
  renderThirdParty();
}

function renderThirdParty() {
  document.getElementById('tp-description').textContent = STATE.tpData.meta.description;

  const channelsGrid = document.getElementById('tp-channels-grid');
  channelsGrid.innerHTML = STATE.tpData.channels
    .map(
      (ch) => `
      <article class="card channel-card">
        <div class="source-card-top">
          <h3>${escapeHtml(ch.name)}</h3>
          <span class="badge badge-warn">${escapeHtml(ch.modelCountNote)}</span>
        </div>
        <div class="small"><strong>计费与网关：</strong>${escapeHtml(ch.pricingModel)}</div>
        <div class="small muted"><strong>缓存说明：</strong>${escapeHtml(ch.cacheBehavior)}</div>
        <div class="small muted"><strong>API 入口：</strong><code>${escapeHtml(ch.apiBaseUrl)}</code></div>
        <div class="source-card-links">
          <a class="ext-link" href="${escapeHtml(ch.sourceUrl)}" target="_blank" rel="noopener noreferrer">官方文档 ↗</a>
        </div>
      </article>
    `
    )
    .join('');

  const channelMap = new Map(STATE.tpData.channels.map((c) => [c.id, c]));
  const modelMap = new Map(STATE.apiData.models.map((m) => [m.id, m]));
  const providerMap = new Map(STATE.apiData.providers.map((p) => [p.id, p]));
  const query = STATE.tpSearch.trim().toLowerCase();

  const filtered = STATE.tpData.benchmarks.filter((b) => {
    if (STATE.tpChannel !== 'all' && b.channelId !== STATE.tpChannel) return false;
    if (STATE.tpStatus !== 'all' && b.status !== STATE.tpStatus) return false;
    if (query) {
      const ch = channelMap.get(b.channelId);
      const m = modelMap.get(b.modelId);
      const p = m ? providerMap.get(m.providerId) : null;
      const hay = `${ch?.name || ''} ${m?.name || ''} ${m?.modelId || ''} ${p?.name || ''} ${
        b.effectiveFeeNote || ''
      } ${b.cacheDiffNote || ''}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    const ma = modelMap.get(a.modelId);
    const mb = modelMap.get(b.modelId);
    return getProviderRank(ma?.providerId) - getProviderRank(mb?.providerId);
  });

  document.getElementById(
    'tp-result-summary'
  ).textContent = `显示 ${filtered.length} / ${STATE.tpData.benchmarks.length} 条对比记录`;
  const activeCount = countThirdPartyActiveFilters();
  const resetBtn = document.getElementById('tp-reset-filters');
  resetBtn.classList.toggle('hidden', activeCount === 0);
  if (activeCount > 0) {
    resetBtn.textContent = `重置筛选 (${activeCount})`;
  }

  const tbody = document.getElementById('tp-tbody');
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="padding:28px;text-align:center;">
      <div class="muted" style="margin-bottom:10px;">没有匹配当前筛选条件的渠道对比记录。</div>
      <button type="button" class="btn-reset" data-action="reset-tp-filters">清空全部筛选条件</button>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((b) => {
      const ch = channelMap.get(b.channelId);
      const m = modelMap.get(b.modelId);
      const p = m ? providerMap.get(m.providerId) : null;
      const officialLine = m
        ? `${formatPrice(m.input, m.currency)} / ${formatPrice(m.output, m.currency)} / ${formatPrice(
            m.cacheRead,
            m.currency
          )}`
        : '—';
      const deltaStr =
        b.priceDeltaPct === 0 ? '标价持平 (0%)' : `${b.priceDeltaPct > 0 ? '+' : ''}${b.priceDeltaPct}%`;
      const statusBadge =
        b.status === 'measured'
          ? `<span class="badge badge-green">已实测 (${escapeHtml(b.testedAt || '')})</span>`
          : '<span class="badge badge-warn">待实测</span>';

      return `
        <tr>
          <td><strong>${escapeHtml(ch ? ch.name : b.channelId)}</strong></td>
          <td>
            <div><strong>${escapeHtml(m ? m.name : b.modelId)}</strong></div>
            <div class="muted small">${escapeHtml(p ? p.name : '')}</div>
          </td>
          <td class="num">${escapeHtml(officialLine)}</td>
          <td>
            <div>${escapeHtml(deltaStr)}</div>
            <div class="muted small">${escapeHtml(b.effectiveFeeNote || '')}</div>
          </td>
          <td class="num">${b.tokensPerSec !== null ? `${b.tokensPerSec} tok/s` : '待实测'}</td>
          <td class="num">${b.officialTokensPerSec !== null ? `${b.officialTokensPerSec} tok/s` : '待实测'}</td>
          <td class="num">${b.ttftMs !== null ? `${b.ttftMs} ms` : '待实测'}</td>
          <td class="small">${escapeHtml(b.cacheDiffNote || '—')}</td>
          <td>${statusBadge}</td>
        </tr>
      `;
    })
    .join('');
  syncTableStickyScroll();
}

function bindEvents() {
  window.addEventListener('hashchange', syncTabFromHash);
  window.addEventListener('resize', () => {
    syncTopbarHeight();
    syncTableStickyScroll();
  });

  const topbar = document.querySelector('.topbar');
  const tabsNav = document.querySelector('.tabs-nav');
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      syncTopbarHeight();
    });
    if (topbar) ro.observe(topbar);
    if (tabsNav) ro.observe(tabsNav);
  }

  document.getElementById('api-toggle-advanced').addEventListener('click', (e) => {
    const panel = document.getElementById('api-advanced-filters');
    const open = panel.classList.toggle('is-open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });

  document.getElementById('plan-toggle-estimator').addEventListener('click', (e) => {
    const panel = document.getElementById('plan-estimator-body');
    const open = panel.classList.toggle('is-open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });

  document.getElementById('plan-toggle-advanced').addEventListener('click', (e) => {
    const panel = document.getElementById('plan-advanced-filters');
    const open = panel.classList.toggle('is-open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });

  document.getElementById('api-mobile-sort').addEventListener('change', (e) => {
    const [key, dir] = e.target.value.split(':');
    STATE.sortKey = key || 'default';
    STATE.sortDir = dir || 'asc';
    updateSortIndicators();
    renderApiTable();
  });

  document.querySelectorAll('#api-view-toggle [data-api-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      STATE.mobileApiView = btn.dataset.apiView;
      document.querySelectorAll('#api-view-toggle [data-api-view]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      document.getElementById('panel-api').classList.toggle('mobile-table-mode', STATE.mobileApiView === 'table');
      syncTableStickyScroll();
    });
  });

  document.getElementById('api-open-cache-guide').addEventListener('click', () => {
    const guide = document.getElementById('api-cache-guide');
    if (!guide) return;
    guide.open = true;
    guide.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  document.querySelectorAll('.tab-link').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      setActiveTab(el.dataset.tab, true);
    });
  });

  // Global currency & FX controls
  document.querySelectorAll('.global-controls [data-currency]').forEach((btn) => {
    btn.addEventListener('click', () => {
      STATE.currencyMode = btn.dataset.currency;
      document.querySelectorAll('.global-controls [data-currency]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      syncFilterUnits();
      renderApiTable();
      renderPlans();
      renderThirdParty();
    });
  });

  document.getElementById('fx-rate-input').addEventListener('input', (e) => {
    const val = Number.parseFloat(e.target.value);
    if (Number.isFinite(val) && val > 0) {
      STATE.fxRate = val;
      renderApiTable();
      renderPlans();
      renderThirdParty();
    }
  });

  // Tab 1 API filters
  document.getElementById('api-search').addEventListener('input', (e) => {
    STATE.search = e.target.value;
    renderApiTable();
  });

  document.querySelectorAll('#region-filter [data-region]').forEach((btn) => {
    btn.addEventListener('click', () => {
      STATE.region = btn.dataset.region;
      if (STATE.region !== 'all') {
        const allowed = new Set(
          STATE.apiData.providers.filter((p) => p.region === STATE.region).map((p) => p.id)
        );
        for (const id of Array.from(STATE.providerIds)) {
          if (!allowed.has(id)) STATE.providerIds.delete(id);
        }
      }
      document.querySelectorAll('#region-filter [data-region]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      renderProviderChips();
      renderApiTable();
    });
  });

  document.getElementById('provider-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-provider]');
    if (!btn) return;
    const id = btn.dataset.provider;
    if (id === 'all') {
      STATE.providerIds.clear();
    } else if (STATE.providerIds.has(id)) {
      STATE.providerIds.delete(id);
    } else {
      STATE.providerIds.add(id);
    }
    renderProviderChips();
    renderApiTable();
  });

  document.getElementById('api-tier-filter').addEventListener('change', (e) => {
    STATE.tier = e.target.value;
    renderApiTable();
  });

  document.getElementById('api-ctx-filter').addEventListener('change', (e) => {
    STATE.minContextTokens = Number(e.target.value) || 0;
    renderApiTable();
  });

  document.getElementById('cache-mode-filter').addEventListener('change', (e) => {
    STATE.cacheMode = e.target.value;
    renderApiTable();
  });

  document.getElementById('api-ttl-filter').addEventListener('change', (e) => {
    STATE.ttlFilter = e.target.value;
    renderApiTable();
  });

  document.getElementById('api-max-blended').addEventListener('input', (e) => {
    const raw = e.target.value.trim();
    const num = Number.parseFloat(raw);
    STATE.maxBlended = raw !== '' && Number.isFinite(num) && num >= 0 ? num : null;
    renderApiTable();
  });

  document.getElementById('workload-preset').addEventListener('change', (e) => {
    STATE.workloadPreset = e.target.value;
    renderApiTable();
  });

  document.getElementById('toggle-deepseek-offpeak').addEventListener('change', (e) => {
    STATE.deepseekOffPeak = e.target.checked;
    renderApiTable();
  });

  document.getElementById('toggle-third-party-col').addEventListener('change', (e) => {
    STATE.showThirdPartyCol = e.target.checked;
    renderApiTable();
  });

  document.getElementById('api-reset-filters').addEventListener('click', resetApiFilters);

  // Sorting
  document.querySelectorAll('#api-table th.sortable').forEach((th) => {
    th.addEventListener('click', (e) => {
      if (e.target.closest('.th-help-btn')) return;
      const key = th.dataset.sort;
      if (STATE.sortKey === key) {
        STATE.sortDir = STATE.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        STATE.sortKey = key;
        STATE.sortDir = 'asc';
      }
      updateSortIndicators();
      renderApiTable();
    });
  });

  // Row expand/collapse & empty-state reset delegation
  document.getElementById('api-tbody').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="reset-api-filters"]')) {
      resetApiFilters();
      return;
    }
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr.model-row');
    if (!tr) return;
    const id = tr.dataset.modelId;
    if (STATE.expandedModelIds.has(id)) {
      STATE.expandedModelIds.delete(id);
    } else {
      STATE.expandedModelIds.add(id);
    }
    renderApiTable();
  });

  document.getElementById('api-mobile-cards').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="reset-api-filters"]')) {
      resetApiFilters();
      return;
    }
    if (e.target.closest('a, button')) return;
    const card = e.target.closest('.mcard');
    if (!card) return;
    const id = card.dataset.modelId;
    if (STATE.expandedModelIds.has(id)) {
      STATE.expandedModelIds.delete(id);
    } else {
      STATE.expandedModelIds.add(id);
    }
    renderApiTable();
  });

  // Tab 2 Plans estimator & filter controls
  document.querySelectorAll('#plan-scene-presets [data-scene]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = PLAN_SCENES[btn.dataset.scene];
      if (!preset) return;
      STATE.cacheHitPct = preset.cacheHitPct;
      STATE.outSharePct = preset.outSharePct;
      STATE.tokensPerReqK = preset.tokensPerReqK;

      document.getElementById('slider-cache-hit').value = String(preset.cacheHitPct);
      document.getElementById('slider-out-share').value = String(preset.outSharePct);
      document.getElementById('slider-tokens-per-req').value = String(preset.tokensPerReqK);
      syncSliderLabels();

      document.querySelectorAll('#plan-scene-presets [data-scene]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      renderPlans();
    });
  });

  const onSliderChange = () => {
    STATE.cacheHitPct = Number(document.getElementById('slider-cache-hit').value);
    STATE.outSharePct = Number(document.getElementById('slider-out-share').value);
    STATE.tokensPerReqK = Number(document.getElementById('slider-tokens-per-req').value);
    document.querySelectorAll('#plan-scene-presets [data-scene]').forEach((b) => b.classList.remove('active'));
    syncSliderLabels();
    renderPlans();
  };

  document.getElementById('slider-cache-hit').addEventListener('input', onSliderChange);
  document.getElementById('slider-out-share').addEventListener('input', onSliderChange);
  document.getElementById('slider-tokens-per-req').addEventListener('input', onSliderChange);

  document.getElementById('toggle-zhipu-offpeak').addEventListener('change', (e) => {
    STATE.zhipuOffPeak = e.target.checked;
    syncSliderLabels();
    renderPlans();
  });

  document.getElementById('plan-search').addEventListener('input', (e) => {
    STATE.planSearch = e.target.value;
    renderPlans();
  });

  document.querySelectorAll('#plan-category-filter [data-category]').forEach((btn) => {
    btn.addEventListener('click', () => {
      STATE.planCategory = btn.dataset.category;
      document.querySelectorAll('#plan-category-filter [data-category]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      renderPlans();
    });
  });

  document.querySelectorAll('#plan-region-filter [data-plan-region]').forEach((btn) => {
    btn.addEventListener('click', () => {
      STATE.planRegion = btn.dataset.planRegion;
      if (STATE.planRegion !== 'all') {
        const allowed = new Set(
          STATE.plansData.plans.filter((pl) => pl.region === STATE.planRegion).map((pl) => pl.vendorName)
        );
        for (const v of Array.from(STATE.planVendors)) {
          if (!allowed.has(v)) STATE.planVendors.delete(v);
        }
      }
      document.querySelectorAll('#plan-region-filter [data-plan-region]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      renderPlanVendorChips();
      renderPlans();
    });
  });

  document.getElementById('plan-method-filter').addEventListener('change', (e) => {
    STATE.planMethod = e.target.value;
    renderPlans();
  });

  document.getElementById('plan-max-budget').addEventListener('input', (e) => {
    const raw = e.target.value.trim();
    const num = Number.parseFloat(raw);
    STATE.planMaxBudget = raw !== '' && Number.isFinite(num) && num >= 0 ? num : null;
    renderPlans();
  });

  document.getElementById('plan-only-credits').addEventListener('change', (e) => {
    STATE.planOnlyCredits = e.target.checked;
    renderPlans();
  });

  document.getElementById('plan-sort').addEventListener('change', (e) => {
    STATE.planSort = e.target.value;
    renderPlans();
  });

  document.getElementById('plan-vendor-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-plan-vendor]');
    if (!btn) return;
    const vendor = btn.dataset.planVendor;
    if (vendor === 'all') {
      STATE.planVendors.clear();
    } else if (STATE.planVendors.has(vendor)) {
      STATE.planVendors.delete(vendor);
    } else {
      STATE.planVendors.add(vendor);
    }
    renderPlanVendorChips();
    renderPlans();
  });

  document.getElementById('plan-reset-filters').addEventListener('click', resetPlanFilters);
  document.getElementById('plans-grid').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="reset-plan-filters"]')) {
      resetPlanFilters();
    }
  });

  // Tab 3 Third-party filters & template copy
  document.getElementById('tp-search').addEventListener('input', (e) => {
    STATE.tpSearch = e.target.value;
    renderThirdParty();
  });

  document.getElementById('tp-channel-filter').addEventListener('change', (e) => {
    STATE.tpChannel = e.target.value;
    renderThirdParty();
  });

  document.getElementById('tp-status-filter').addEventListener('change', (e) => {
    STATE.tpStatus = e.target.value;
    renderThirdParty();
  });

  document.getElementById('tp-reset-filters').addEventListener('click', resetThirdPartyFilters);
  document.getElementById('tp-tbody').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="reset-tp-filters"]')) {
      resetThirdPartyFilters();
    }
  });

  document.getElementById('copy-tp-template').addEventListener('click', async () => {
    const code = document.getElementById('tp-template-code').textContent;
    const btn = document.getElementById('copy-tp-template');
    try {
      await navigator.clipboard.writeText(code);
      btn.textContent = '已复制';
      setTimeout(() => {
        btn.textContent = '复制 JSON 模板';
      }, 1500);
    } catch {
      btn.textContent = '请手动复制';
    }
  });

  bindOrderModalEvents();
  bindHeaderHelpPopover();
}

const TH_HELP_DOCS = {
  input: {
    title: '输入 / 1M（标准未命中输入）',
    html: '<p>请求中<strong>未命中缓存</strong>的新增输入 Token 单价（按每 100 万 Tokens 计价）。</p><p class="muted">部分模型（如 OpenAI &gt;272K、xAI ≥200K、MiniMax-M3 &gt;512K）在超长上下文时会自动上调到阶梯高价。</p>',
  },
  output: {
    title: '输出 / 1M（生成补全）',
    html: '<p>模型生成回复内容的 Token 单价（按每 100 万 Tokens 计价）。</p><p class="muted">推理与思考模型（如 Gemini 4、Claude 思考模式、DeepSeek-V4-Pro）内部产出的 Thinking tokens 同样计入输出用量。</p>',
  },
  cacheRead: {
    title: '缓存读 / 1M（Cache Read）',
    html: '<p>当请求开头的固定前缀（System Prompt、工具定义、长文档等）命中服务端已有缓存时，命中部分按此超低折扣价结算，常见仅需标准输入的 <strong>0.02×–0.25×</strong>。</p><p class="muted">未命中的新增输入仍按「输入 / 1M」原价计费。</p>',
    showCacheGuideLink: true,
  },
  cacheWrite: {
    title: '缓存写 / 存储费',
    html: '<p>首次把前缀写入缓存的额外成本，主要分 3 种模式：</p><ul><li><strong>按写入倍率</strong>：首次创建断点加收 <code>1.25×–2.5×</code>（无小时租金，后续命中 1–2 次即回本）。</li><li><strong>按小时存储</strong>：显式缓存按声明时长持续计内存租金（如 <code>$0.50/1M/h</code>），空闲也会扣费。</li><li><strong>免写入/存储费</strong>：首次按标准输入原价计费，系统后台自动建立缓存（含 Gemini 4 <code>Implicit caching only</code>）。</li></ul>',
    showCacheGuideLink: true,
  },
  cacheTtl: {
    title: '缓存时间 (TTL) 与双值含义',
    html: '<p>代表缓存前缀在服务端的保留寿命，常见为什么会有两个值：</p><ul><li><strong>短档 / 长档两级</strong>（如 <code>5m / 1h</code>、<code>30m / 12h</code>）：前一个是默认短缓存（写入倍率低，适合高频连续对话）；后一个是显式延长档（写入倍率更高，适合跨分钟或跨小时复用）。Anthropic、阿里云显式与 Kimi 命中后会自动续期。</li><li><strong>隐式 / 显式并行</strong>（如 <code>隐式自动 / 显式默认 1h 可调</code>）：斜杠前免维护免存储费；斜杠后需调用接口主动创建并计写入/存储费。</li><li><strong>单一模式</strong>：如 Gemini 4、DeepSeek、xAI 仅自动隐式缓存（无固定公开 TTL）；火山方舟最长可设 <code>168h</code>。</li></ul>',
    showCacheGuideLink: true,
  },
  blended: {
    title: '综合估算 / 1M',
    html: '<p>按顶部「综合价场景」预设比例加权计算的折算单价：</p><p><code>75% 输入 × [(1 − 命中率)×标准输入 + 命中率×缓存读] + 25% 输出</code></p><p class="muted">用于快速横向对比不同模型在真实多轮场景的综合成本（不含一次性的缓存写入溢价或小时存储租金）。</p>',
  },
};

let activeHelpBtn = null;

function positionHeaderPopover() {
  const popover = document.getElementById('th-popover');
  if (!popover || popover.classList.contains('hidden') || !activeHelpBtn) return;

  const rect = activeHelpBtn.getBoundingClientRect();
  const tabsNav = document.querySelector('.tabs-nav');
  const stickyBottom = tabsNav ? tabsNav.getBoundingClientRect().bottom : 0;

  // Close if anchor button scrolled out of visible area
  if (rect.bottom < stickyBottom || rect.top > window.innerHeight || rect.width === 0) {
    closeHeaderPopover();
    return;
  }

  const margin = 12;
  const popWidth = popover.offsetWidth || 340;
  const popHeight = popover.offsetHeight || 200;

  let left = rect.left + rect.width / 2 - popWidth / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - popWidth - margin));

  let top = rect.bottom + 8;
  if (top + popHeight > window.innerHeight - margin && rect.top - popHeight - 8 > stickyBottom) {
    top = rect.top - popHeight - 8;
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - popHeight - margin));

  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function closeHeaderPopover() {
  const popover = document.getElementById('th-popover');
  if (popover) popover.classList.add('hidden');
  if (activeHelpBtn) {
    activeHelpBtn.setAttribute('aria-expanded', 'false');
    activeHelpBtn = null;
  }
}

function openHeaderPopover(btn) {
  const key = btn.dataset.help;
  const doc = TH_HELP_DOCS[key];
  if (!doc) return;

  if (activeHelpBtn === btn) {
    closeHeaderPopover();
    return;
  }

  closeHeaderPopover();
  activeHelpBtn = btn;
  btn.setAttribute('aria-expanded', 'true');

  document.getElementById('th-popover-title').textContent = doc.title;
  const linkHtml = doc.showCacheGuideLink
    ? '<button type="button" class="th-popover-link" data-action="goto-cache-guide">查看完整缓存与 Prompt 排版指南 ↓</button>'
    : '';
  document.getElementById('th-popover-body').innerHTML = `${doc.html}${linkHtml}`;

  const popover = document.getElementById('th-popover');
  popover.classList.remove('hidden');
  positionHeaderPopover();
}

function bindHeaderHelpPopover() {
  document.getElementById('th-popover-close').addEventListener('click', closeHeaderPopover);

  document.getElementById('th-popover-body').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="goto-cache-guide"]')) {
      closeHeaderPopover();
      const guide = document.getElementById('api-cache-guide');
      if (guide) {
        guide.open = true;
        guide.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  });

  document.addEventListener('click', (e) => {
    const helpBtn = e.target.closest('.th-help-btn');
    if (helpBtn) {
      e.preventDefault();
      e.stopPropagation();
      openHeaderPopover(helpBtn);
      return;
    }
    const popover = document.getElementById('th-popover');
    if (!popover || popover.classList.contains('hidden')) return;
    if (popover.contains(e.target)) return;
    closeHeaderPopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeHeaderPopover();
  });

  window.addEventListener('scroll', positionHeaderPopover, { passive: true });
  window.addEventListener('resize', positionHeaderPopover, { passive: true });
  document.querySelectorAll('.table-scroll').forEach((el) => {
    el.addEventListener('scroll', positionHeaderPopover, { passive: true });
  });
}

function syncOrderUiIndicators(customStatusText) {
  const custom = isCustomProviderOrder();
  const openBtn = document.getElementById('open-order-modal');
  openBtn.textContent = custom ? '厂商排序 · 自定义' : '厂商排序';
  openBtn.classList.toggle('is-custom', custom);

  const resetBtn = document.getElementById('reset-provider-order');
  resetBtn.disabled = !custom;

  const statusEl = document.getElementById('order-save-status');
  if (customStatusText) {
    statusEl.textContent = customStatusText;
  } else {
    statusEl.textContent = custom ? '已使用本地保存的自定义顺序' : '当前为默认顺序';
  }
}

function renderOrderModalList() {
  const providerMap = new Map(STATE.apiData.providers.map((p) => [p.id, p]));
  const listEl = document.getElementById('order-list');
  const total = STATE.providerOrder.length;

  listEl.innerHTML = STATE.providerOrder
    .map((id, idx) => {
      const p = providerMap.get(id);
      if (!p) return '';
      const regionBadge =
        p.region === 'global'
          ? '<span class="badge badge-neutral">海外</span>'
          : '<span class="badge badge-accent">国内</span>';
      return `
        <li class="order-item" draggable="true" data-provider-id="${escapeHtml(id)}">
          <div class="order-item-left">
            <span class="drag-handle" aria-hidden="true">⋮⋮</span>
            <span class="order-rank">#${idx + 1}</span>
            <span class="order-name">${escapeHtml(p.name)}</span>
            ${regionBadge}
          </div>
          <div class="order-actions">
            <button type="button" class="order-btn" data-move="top" data-provider-id="${escapeHtml(id)}" title="置顶" ${
              idx === 0 ? 'disabled' : ''
            }>⤒</button>
            <button type="button" class="order-btn" data-move="up" data-provider-id="${escapeHtml(id)}" title="上移" ${
              idx === 0 ? 'disabled' : ''
            }>↑</button>
            <button type="button" class="order-btn" data-move="down" data-provider-id="${escapeHtml(id)}" title="下移" ${
              idx === total - 1 ? 'disabled' : ''
            }>↓</button>
          </div>
        </li>
      `;
    })
    .join('');
}

function applyNewProviderOrder(nextOrder, savedMsg) {
  STATE.providerOrder = sanitizeProviderOrder(nextOrder, STATE.apiData.providers);
  const persisted = saveProviderOrder(STATE.providerOrder);

  STATE.sortKey = 'default';
  STATE.sortDir = 'asc';
  STATE.planSort = 'default';
  document.getElementById('plan-sort').value = 'default';

  updateSortIndicators();
  renderOrderModalList();
  syncOrderUiIndicators(persisted ? savedMsg : '顺序已更新（当前浏览器禁用本地存储）');
  renderProviderChips();
  renderApiTable();
  renderProviderSourcesGrid();
  renderPlanVendorChips();
  renderPlans();
  renderThirdParty();
}

function openOrderModal() {
  renderOrderModalList();
  syncOrderUiIndicators();
  document.getElementById('order-modal').classList.remove('hidden');
}

function closeOrderModal() {
  document.getElementById('order-modal').classList.add('hidden');
}

function bindOrderModalEvents() {
  document.getElementById('open-order-modal').addEventListener('click', openOrderModal);
  document.getElementById('api-open-order-btn').addEventListener('click', openOrderModal);
  document.getElementById('close-order-modal').addEventListener('click', closeOrderModal);
  document.getElementById('done-order-modal').addEventListener('click', closeOrderModal);

  const modalEl = document.getElementById('order-modal');
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeOrderModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modalEl.classList.contains('hidden')) {
      closeOrderModal();
    }
  });

  document.getElementById('reset-provider-order').addEventListener('click', () => {
    try {
      localStorage.removeItem(PROVIDER_ORDER_STORAGE_KEY);
    } catch {}
    applyNewProviderOrder(getDefaultProviderOrder(STATE.apiData.providers), '已恢复默认顺序并清除本地保存');
  });

  const listEl = document.getElementById('order-list');
  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-move]');
    if (!btn || btn.disabled) return;
    const id = btn.dataset.providerId;
    const action = btn.dataset.move;
    const idx = STATE.providerOrder.indexOf(id);
    if (idx === -1) return;

    const next = [...STATE.providerOrder];
    if (action === 'top' && idx > 0) {
      next.splice(idx, 1);
      next.unshift(id);
    } else if (action === 'up' && idx > 0) {
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    } else if (action === 'down' && idx < next.length - 1) {
      [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
    } else {
      return;
    }
    applyNewProviderOrder(next, '已保存到本机浏览器');
  });

  let dragSourceId = null;
  listEl.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.order-item');
    if (!item) return;
    dragSourceId = item.dataset.providerId;
    item.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragSourceId);
    }
  });

  listEl.addEventListener('dragover', (e) => {
    if (!dragSourceId) return;
    e.preventDefault();
    const item = e.target.closest('.order-item');
    listEl.querySelectorAll('.order-item.drag-over').forEach((el) => {
      if (el !== item) el.classList.remove('drag-over');
    });
    if (item && item.dataset.providerId !== dragSourceId) {
      item.classList.add('drag-over');
    }
  });

  listEl.addEventListener('dragleave', (e) => {
    const item = e.target.closest('.order-item');
    if (item && !item.contains(e.relatedTarget)) {
      item.classList.remove('drag-over');
    }
  });

  listEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const targetItem = e.target.closest('.order-item');
    listEl.querySelectorAll('.order-item.drag-over').forEach((el) => el.classList.remove('drag-over'));
    if (!dragSourceId || !targetItem) return;
    const targetId = targetItem.dataset.providerId;
    if (!targetId || targetId === dragSourceId) return;

    const next = [...STATE.providerOrder];
    const fromIdx = next.indexOf(dragSourceId);
    const toIdx = next.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, dragSourceId);
    dragSourceId = null;
    applyNewProviderOrder(next, '已保存拖拽顺序到本机浏览器');
  });

  listEl.addEventListener('dragend', () => {
    dragSourceId = null;
    listEl.querySelectorAll('.order-item').forEach((el) => {
      el.classList.remove('dragging', 'drag-over');
    });
  });
}

function syncSliderLabels() {
  document.getElementById('val-cache-hit').textContent = `${STATE.cacheHitPct}%`;
  document.getElementById('val-out-share').textContent = `${STATE.outSharePct}%`;
  document.getElementById('val-tokens-per-req').textContent = `${STATE.tokensPerReqK}K`;
  const summary = document.getElementById('plan-estimator-summary');
  if (summary) {
    summary.textContent = `${STATE.cacheHitPct}% 缓存 · ${STATE.outSharePct}% 输出 · ${STATE.tokensPerReqK}K/次${
      STATE.zhipuOffPeak ? ' · 智谱5折' : ''
    }`;
  }
}

async function bootstrap() {
  initTheme();
  const [apiRes, plansRes, tpRes] = await Promise.all([
    fetch('/data/api-pricing.json'),
    fetch('/data/plans.json'),
    fetch('/data/third-party.json'),
  ]);
  if (!apiRes.ok || !plansRes.ok || !tpRes.ok) {
    throw new Error('加载价格 JSON 数据失败');
  }
  STATE.apiData = await apiRes.json();
  STATE.plansData = await plansRes.json();
  STATE.tpData = await tpRes.json();

  STATE.providerOrder = loadProviderOrder(STATE.apiData.providers);
  STATE.fxRate = STATE.apiData.meta.defaultUsdToCny || 7.2;
  document.getElementById('fx-rate-input').value = STATE.fxRate.toFixed(2);
  document.getElementById('verified-badge').textContent = `数据核对：${STATE.apiData.meta.verifiedAt}`;
  document.getElementById('api-disclaimer').textContent = STATE.apiData.meta.disclaimer;
  document.getElementById('plans-disclaimer').textContent = STATE.plansData.meta.disclaimer;

  document.getElementById('tab-count-api').textContent = String(STATE.apiData.models.length);
  document.getElementById('tab-count-plans').textContent = String(STATE.plansData.plans.length);
  document.getElementById('tab-count-tp').textContent = String(STATE.tpData.benchmarks.length);

  syncFilterUnits();
  syncOrderUiIndicators();
  updateSortIndicators();
  renderProviderChips();
  renderApiTable();
  renderProviderSourcesGrid();
  syncSliderLabels();
  renderPlanVendorChips();
  renderPlans();
  populateThirdPartyChannelFilter();
  renderThirdParty();
  bindEvents();
  syncTabFromHash();
  syncTopbarHeight();
  syncTableStickyScroll();
}

bootstrap().catch((err) => {
  console.error(err);
  const main = document.querySelector('.main-content');
  main.innerHTML = `<div class="card" style="padding:20px;color:#b91c1c;">加载数据出错：${escapeHtml(
    err.message
  )}</div>`;
});
