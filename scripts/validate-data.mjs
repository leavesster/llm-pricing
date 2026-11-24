import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const checkLinks = args.has('--check-links');
const strictExpiry = args.has('--strict-expiry');

const errors = [];
const warnings = [];
const allUrls = new Set();

function assert(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function isValidYmd(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function getDaysDiffFromToday(ymd) {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function checkOfficialUrl(url, context) {
  if (typeof url !== 'string' || url.trim() === '') {
    errors.push(`${context}: URL 为空`);
    return;
  }
  if (!url.startsWith('https://')) {
    errors.push(`${context}: URL 必须以 https:// 开头 (${url})`);
  }
  if (url.includes('vertexaisearch.cloud.google.com')) {
    errors.push(`${context}: 禁止使用重定向代理 URL (${url})`);
  }
  try {
    new URL(url);
    allUrls.add(url);
  } catch {
    errors.push(`${context}: URL 格式无效 (${url})`);
  }
}

function isNonNegFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

async function loadJson(relativePath) {
  const fullPath = resolve(rootDir, relativePath);
  const raw = await readFile(fullPath, 'utf8');
  return JSON.parse(raw);
}

async function runLinkChecks(urls) {
  const queue = [...urls];
  const results = [];
  const workerCount = 5;

  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const url = queue.shift();
      try {
        const res = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(6000),
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; llm-pricing-check/1.0)',
          },
        });
        await res.arrayBuffer().catch(() => {});
        if (res.status >= 200 && res.status < 400) {
          results.push({ url, status: 'ok', code: res.status });
        } else {
          results.push({ url, status: 'http_error', code: res.status });
        }
      } catch (err) {
        results.push({ url, status: 'network_blocked', error: err?.cause?.code || err.message });
      }
    }
  });

  await Promise.all(workers);

  let okCount = 0;
  let blockedCount = 0;
  for (const r of results) {
    if (r.status === 'ok') {
      okCount += 1;
    } else if (r.status === 'http_error') {
      errors.push(`死链检查失败 HTTP ${r.code}: ${r.url}`);
    } else {
      blockedCount += 1;
      warnings.push(`network_blocked (${r.error}): ${r.url}`);
    }
  }
  console.log(`链接检查：共 ${results.length} 条去重 URL，正常 ${okCount} 条，网络/TLS 拦截 ${blockedCount} 条。`);
}

async function main() {
  const apiData = await loadJson('public/data/api-pricing.json');
  const plansData = await loadJson('public/data/plans.json');
  const thirdPartyData = await loadJson('public/data/third-party.json');

  // 1. Validate api-pricing.json
  assert(isValidYmd(apiData?.meta?.verifiedAt), 'api-pricing.json: meta.verifiedAt 必须为 YYYY-MM-DD');
  assert(
    typeof apiData?.meta?.defaultUsdToCny === 'number' && apiData.meta.defaultUsdToCny > 0,
    'api-pricing.json: meta.defaultUsdToCny 必须为正数'
  );
  assert(Array.isArray(apiData.providers) && apiData.providers.length > 0, 'api-pricing.json: providers 不能为空');
  assert(Array.isArray(apiData.models) && apiData.models.length > 0, 'api-pricing.json: models 不能为空');

  const providerIds = new Set();
  for (const p of apiData.providers) {
    assert(p.id && typeof p.id === 'string', 'provider 缺少 id');
    assert(!providerIds.has(p.id), `重复 provider id: ${p.id}`);
    providerIds.add(p.id);
    assert(p.region === 'global' || p.region === 'china', `provider ${p.id} region 非法: ${p.region}`);
    assert(p.nativeCurrency === 'USD' || p.nativeCurrency === 'CNY', `provider ${p.id} nativeCurrency 非法`);
    assert(isValidYmd(p.verifiedAt), `provider(${p.id}).verifiedAt 必须为 YYYY-MM-DD`);
    checkOfficialUrl(p.pricingUrl, `provider(${p.id}).pricingUrl`);
    if (Array.isArray(p.extraUrls)) {
      for (const extra of p.extraUrls) {
        assert(extra.label, `provider(${p.id}).extraUrls 缺少 label`);
        checkOfficialUrl(extra.url, `provider(${p.id}).extraUrls[${extra.label}]`);
      }
    }
  }

  const writeFields = ['cacheWrite5m', 'cacheWrite30m', 'cacheWrite1h', 'cacheWrite12h'];
  const modelIds = new Set();
  for (const m of apiData.models) {
    assert(m.id && typeof m.id === 'string', 'model 缺少 id');
    assert(!modelIds.has(m.id), `重复 model id: ${m.id}`);
    modelIds.add(m.id);
    assert(providerIds.has(m.providerId), `model(${m.id}) 引用了未知 providerId: ${m.providerId}`);
    assert(m.currency === 'USD' || m.currency === 'CNY', `model(${m.id}) currency 非法: ${m.currency}`);
    assert(isNonNegFinite(m.input), `model(${m.id}).input 必须为非负有限数字`);
    assert(isNonNegFinite(m.output), `model(${m.id}).output 必须为非负有限数字`);
    assert(isNonNegFinite(m.cacheRead), `model(${m.id}).cacheRead 必须为非负有限数字`);

    // Business invariants
    assert(m.cacheRead <= m.input, `model(${m.id}): cacheRead (${m.cacheRead}) 不可高于 input (${m.input})`);
    assert(
      ['multiplier', 'storage_hourly', 'free_auto'].includes(m.cacheWriteMode),
      `model(${m.id}).cacheWriteMode 非法: ${m.cacheWriteMode}`
    );

    let hasWriteMultiplierField = false;
    for (const wf of writeFields) {
      if (m[wf] !== undefined && m[wf] !== null) {
        hasWriteMultiplierField = true;
        assert(isNonNegFinite(m[wf]), `model(${m.id}).${wf} 必须为非负有限数字`);
        assert(m[wf] >= m.input, `model(${m.id}).${wf} (${m[wf]}) 不可低于 input (${m.input})`);
        assert(
          m.cacheWriteMode === 'multiplier',
          `model(${m.id}) 含有 ${wf}，cacheWriteMode 必须为 multiplier（当前为 ${m.cacheWriteMode}）`
        );
      }
    }
    if (m.cacheWriteMode === 'multiplier') {
      assert(hasWriteMultiplierField, `model(${m.id}).cacheWriteMode 为 multiplier，必须至少包含一个 cacheWrite* 字段`);
    }

    if (m.cacheStoragePerHour !== undefined && m.cacheStoragePerHour !== null) {
      assert(isNonNegFinite(m.cacheStoragePerHour), `model(${m.id}).cacheStoragePerHour 必须为非负有限数字`);
      assert(
        m.cacheWriteMode === 'storage_hourly',
        `model(${m.id}) 含有 cacheStoragePerHour，cacheWriteMode 必须为 storage_hourly`
      );
    } else if (m.cacheWriteMode === 'storage_hourly') {
      errors.push(`model(${m.id}).cacheWriteMode 为 storage_hourly，必须提供 cacheStoragePerHour`);
    }

    if (m.offPeakFactor !== undefined && m.offPeakFactor !== null) {
      assert(isNonNegFinite(m.offPeakFactor), `model(${m.id}).offPeakFactor 必须为非负有限数字`);
    }

    assert(m.cacheTtl && typeof m.cacheTtl === 'string', `model(${m.id}) 缺少 cacheTtl`);
    if (/(未公开固定\s*TTL|仅隐式自动缓存)/.test(m.cacheTtl)) {
      assert(
        !/(5m|30m|1h|12h|168h)/i.test(m.cacheTtl),
        `model(${m.id}).cacheTtl 声明无固定 TTL 或仅隐式缓存，禁止混入显式 TTL 标记: ${m.cacheTtl}`
      );
    }

    if (m.promoEndsAt !== undefined && m.promoEndsAt !== null) {
      assert(isValidYmd(m.promoEndsAt), `model(${m.id}).promoEndsAt 必须为 YYYY-MM-DD（当前为 ${m.promoEndsAt}）`);
      if (isValidYmd(m.promoEndsAt)) {
        const diff = getDaysDiffFromToday(m.promoEndsAt);
        if (diff < 0) {
          const msg = `model(${m.id}) 首发/活动价已于 ${m.promoEndsAt} 到期，请核对最新官方价格`;
          if (strictExpiry) errors.push(msg);
          else warnings.push(`[EXPIRED] ${msg}`);
        } else if (diff <= 14) {
          warnings.push(`[EXPIRING_SOON] model(${m.id}) 活动价将在 ${diff} 天后到期（${m.promoEndsAt}）`);
        }
      }
    }

    checkOfficialUrl(m.sourceUrl, `model(${m.id}).sourceUrl`);
  }

  // 2. Validate plans.json
  assert(isValidYmd(plansData?.meta?.verifiedAt), 'plans.json: meta.verifiedAt 必须为 YYYY-MM-DD');
  assert(Array.isArray(plansData.plans) && plansData.plans.length > 0, 'plans.json: plans 不能为空');

  const planIds = new Set();
  for (const plan of plansData.plans) {
    assert(plan.id && typeof plan.id === 'string', 'plan 缺少 id');
    assert(!planIds.has(plan.id), `重复 plan id: ${plan.id}`);
    planIds.add(plan.id);
    assert(providerIds.has(plan.providerId), `plan(${plan.id}) 引用了未知 providerId: ${plan.providerId}`);
    assert(plan.currency === 'USD' || plan.currency === 'CNY', `plan(${plan.id}) currency 非法`);
    assert(
      (plan.monthlyPrice === null && typeof plan.priceLabel === 'string' && plan.priceLabel.length > 0) ||
        (typeof plan.monthlyPrice === 'number' && Number.isFinite(plan.monthlyPrice) && plan.monthlyPrice >= 0),
      `plan(${plan.id}) monthlyPrice 或 priceLabel 非法`
    );
    assert(Array.isArray(plan.models) && plan.models.length > 0, `plan(${plan.id}).models 不能为空`);
    checkOfficialUrl(plan.sourceUrl, `plan(${plan.id}).sourceUrl`);
    if (Array.isArray(plan.extraUrls)) {
      for (const extra of plan.extraUrls) {
        checkOfficialUrl(extra.url, `plan(${plan.id}).extraUrls[${extra.label}]`);
      }
    }

    const est = plan.estimation;
    assert(est && typeof est === 'object', `plan(${plan.id}) 缺少 estimation`);
    if (est) {
      assert(modelIds.has(est.refModelId), `plan(${plan.id}).estimation.refModelId 引用了未知模型: ${est.refModelId}`);
      if (est.kind === 'formula_points') {
        assert(est.weeklyPoints > 0, `plan(${plan.id}) weeklyPoints 必须 > 0`);
        assert(
          isNonNegFinite(est.inWeight) && isNonNegFinite(est.cacheWeight) && est.outWeight > 0,
          `plan(${plan.id}) 积分权重非法`
        );
        assert(est.divisor > 0, `plan(${plan.id}) divisor 必须 > 0`);
      } else if (est.kind === 'credits_usd') {
        assert(est.includedCreditsUsd > 0, `plan(${plan.id}) includedCreditsUsd 必须 > 0`);
      } else if (est.kind === 'requests_based') {
        assert(est.monthlyRequests > 0, `plan(${plan.id}) monthlyRequests 必须 > 0`);
        const r = est.typicalUtilizationRange;
        assert(
          Array.isArray(r) && r.length === 2 && r[0] > 0 && r[0] <= r[1] && r[1] <= 1,
          `plan(${plan.id}) typicalUtilizationRange 非法`
        );
      } else if (est.kind === 'estimated_pool') {
        const range = est.estimatedApiValueRangeUsd || est.estimatedApiValueRangeCny;
        assert(
          Array.isArray(range) && range.length === 2 && range[0] > 0 && range[0] <= range[1],
          `plan(${plan.id}) 缺少合法 estimatedApiValueRangeUsd/Cny`
        );
      } else {
        errors.push(`plan(${plan.id}).estimation.kind 未知: ${est.kind}`);
      }
    }
  }

  // 3. Validate third-party.json
  assert(isValidYmd(thirdPartyData?.meta?.verifiedAt), 'third-party.json: meta.verifiedAt 必须为 YYYY-MM-DD');
  assert(
    Array.isArray(thirdPartyData.channels) && thirdPartyData.channels.length > 0,
    'third-party.json: channels 不能为空'
  );
  assert(Array.isArray(thirdPartyData.benchmarks), 'third-party.json: benchmarks 必须为数组');

  const channelIds = new Set();
  for (const ch of thirdPartyData.channels) {
    assert(ch.id, 'third-party channel 缺少 id');
    channelIds.add(ch.id);
    checkOfficialUrl(ch.sourceUrl, `channel(${ch.id}).sourceUrl`);
  }

  for (const b of thirdPartyData.benchmarks) {
    assert(channelIds.has(b.channelId), `benchmark 引用未知 channelId: ${b.channelId}`);
    assert(modelIds.has(b.modelId), `benchmark 引用未知 modelId: ${b.modelId}`);
  }

  if (checkLinks && errors.length === 0) {
    await runLinkChecks(allUrls);
  }

  if (warnings.length > 0) {
    console.log('提醒事项：');
    for (const w of warnings) {
      console.log(`  - ${w}`);
    }
  }

  if (errors.length > 0) {
    console.error('数据校验失败：');
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(
    `校验通过：${apiData.providers.length} 家厂商，${apiData.models.length} 个模型，${plansData.plans.length} 个订阅档位，${thirdPartyData.channels.length} 个第三方渠道，${thirdPartyData.benchmarks.length} 条对比记录（核对日期 ${apiData.meta.verifiedAt}）。`
  );
}

main().catch((err) => {
  console.error('执行校验异常:', err);
  process.exit(1);
});
