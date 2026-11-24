import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const snapshotPath = resolve(rootDir, '.cache/pricing-snapshots.json');

function parseCliArgs(argv) {
  const opts = {
    saveBaseline: false,
    skipRadar: false,
    skipSnapshots: false,
    markdown: false,
    timeoutMs: 8000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--save-baseline') opts.saveBaseline = true;
    else if (arg === '--skip-radar') opts.skipRadar = true;
    else if (arg === '--skip-snapshots') opts.skipSnapshots = true;
    else if (arg === '--markdown') opts.markdown = true;
    else if (arg === '--timeout' && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) opts.timeoutMs = parsed;
      i += 1;
    }
  }
  return opts;
}

function getDaysDiffFromToday(ymd) {
  if (typeof ymd !== 'string') return null;
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

async function loadJson(relPath, fallback = null) {
  try {
    const raw = await readFile(resolve(rootDir, relPath), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (fallback !== null) return fallback;
    throw err;
  }
}

function checkFreshness(apiData, plansData, thirdPartyData) {
  const expiredPromos = [];
  const expiringSoonPromos = [];
  const staleItems = [];

  const metaAge = getDaysDiffFromToday(apiData.meta.verifiedAt);
  if (metaAge !== null && -metaAge > 30) {
    staleItems.push(`api-pricing.json meta.verifiedAt=${apiData.meta.verifiedAt} (已过 ${-metaAge} 天)`);
  }
  const plansAge = getDaysDiffFromToday(plansData.meta.verifiedAt);
  if (plansAge !== null && -plansAge > 30) {
    staleItems.push(`plans.json meta.verifiedAt=${plansData.meta.verifiedAt} (已过 ${-plansAge} 天)`);
  }
  const tpAge = getDaysDiffFromToday(thirdPartyData.meta.verifiedAt);
  if (tpAge !== null && -tpAge > 30) {
    staleItems.push(`third-party.json meta.verifiedAt=${thirdPartyData.meta.verifiedAt} (已过 ${-tpAge} 天)`);
  }

  for (const p of apiData.providers) {
    const age = getDaysDiffFromToday(p.verifiedAt);
    if (age !== null && -age > 30) {
      staleItems.push(`provider ${p.id} (${p.name}) verifiedAt=${p.verifiedAt} (已过 ${-age} 天)`);
    }
  }

  for (const m of apiData.models) {
    if (!m.promoEndsAt) continue;
    const diff = getDaysDiffFromToday(m.promoEndsAt);
    if (diff === null) continue;
    if (diff < 0) {
      expiredPromos.push(`${m.id} (${m.name}): 活动价已于 ${m.promoEndsAt} 到期（${m.promoNote || ''}）`);
    } else if (diff <= 14) {
      expiringSoonPromos.push(`${m.id} (${m.name}): 距 ${m.promoEndsAt} 到期还剩 ${diff} 天`);
    }
  }

  return { expiredPromos, expiringSoonPromos, staleItems };
}

function normalizeModelKey(id) {
  return id.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function fetchJsonSafe(url, timeoutMs) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'llm-pricing-watcher/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function runOpenSourceRadar(apiData, timeoutMs) {
  const fxRate = apiData.meta.defaultUsdToCny || 7.2;
  const localNormIds = new Set(apiData.models.map((m) => normalizeModelKey(m.modelId)));
  const priceDiffs = [];
  const newCandidates = {};
  const unavailable = [];

  const vendorPrefixes = [
    { key: 'openai', prefixes: ['openai/gpt-5', 'openai/gpt-6', 'gpt-5', 'gpt-6'] },
    { key: 'anthropic', prefixes: ['anthropic/claude-', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5', 'claude-fable-5'] },
    { key: 'google', prefixes: ['google/gemini-3', 'google/gemini-4', 'gemini-3', 'gemini-4'] },
    { key: 'deepseek', prefixes: ['deepseek/deepseek-'] },
    { key: 'xai', prefixes: ['x-ai/grok-4', 'grok-4'] },
    { key: 'zhipu', prefixes: ['z-ai/glm-5', 'glm-5'] },
    { key: 'aliyun', prefixes: ['qwen/qwen3', 'qwen/qwen4'] },
    { key: 'kimi', prefixes: ['moonshotai/kimi-k3', 'kimi-k3'] },
    { key: 'minimax', prefixes: ['minimax/minimax-m3'] },
  ];

  // 1. OpenRouter radar
  try {
    const orJson = await fetchJsonSafe('https://openrouter.ai/api/v1/models', timeoutMs);
    const orList = Array.isArray(orJson?.data) ? orJson.data : [];
    const orByNorm = new Map();

    for (const item of orList) {
      if (!item?.id || !item?.pricing) continue;
      const tail = item.id.includes('/') ? item.id.split('/').slice(1).join('/') : item.id;
      const norm = normalizeModelKey(tail);
      const inPer1M = Number.parseFloat(item.pricing.prompt) * 1_000_000;
      const outPer1M = Number.parseFloat(item.pricing.completion) * 1_000_000;
      if (!Number.isFinite(inPer1M) || !Number.isFinite(outPer1M)) continue;
      orByNorm.set(norm, { id: item.id, inPer1M, outPer1M });

      if (!localNormIds.has(norm) && !item.id.endsWith(':free')) {
        for (const vp of vendorPrefixes) {
          if (vp.prefixes.some((pf) => item.id.toLowerCase().startsWith(pf))) {
            newCandidates[vp.key] ||= [];
            if (newCandidates[vp.key].length < 3 && !newCandidates[vp.key].some((x) => x.id === item.id)) {
              newCandidates[vp.key].push({ id: item.id, source: 'OpenRouter', inPer1M, outPer1M });
            }
          }
        }
      }
    }

    for (const m of apiData.models) {
      const match = orByNorm.get(normalizeModelKey(m.modelId));
      if (!match) continue;
      const localInUsd = m.currency === 'USD' ? m.input : m.input / fxRate;
      const localOutUsd = m.currency === 'USD' ? m.output : m.output / fxRate;
      const inRatio = localInUsd > 0 ? Math.abs(match.inPer1M - localInUsd) / localInUsd : 0;
      const outRatio = localOutUsd > 0 ? Math.abs(match.outPer1M - localOutUsd) / localOutUsd : 0;
      if ((inRatio > 0.05 && Math.abs(match.inPer1M - localInUsd) > 0.01) || (outRatio > 0.05 && Math.abs(match.outPer1M - localOutUsd) > 0.01)) {
        priceDiffs.push(
          `[PRICE_DIFF] ${m.id} vs OpenRouter(${match.id}): 本地 $${localInUsd.toFixed(2)}/$${localOutUsd.toFixed(
            2
          )} vs 社区 $${match.inPer1M.toFixed(2)}/$${match.outPer1M.toFixed(2)}`
        );
      }
    }
  } catch (err) {
    unavailable.push(`OpenRouter 哨兵不可达: ${err?.cause?.code || err.message}`);
  }

  // 2. LiteLLM radar
  try {
    const litellm = await fetchJsonSafe(
      'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
      timeoutMs
    );
    const entries = Object.entries(litellm || {});
    const ltByNorm = new Map();
    for (const [key, val] of entries) {
      if (!val || typeof val !== 'object') continue;
      if (typeof val.input_cost_per_token !== 'number' || typeof val.output_cost_per_token !== 'number') continue;
      const tail = key.includes('/') ? key.split('/').slice(1).join('/') : key;
      const norm = normalizeModelKey(tail);
      const inPer1M = val.input_cost_per_token * 1_000_000;
      const outPer1M = val.output_cost_per_token * 1_000_000;
      if (!ltByNorm.has(norm)) ltByNorm.set(norm, { id: key, inPer1M, outPer1M });

      if (!localNormIds.has(norm)) {
        for (const vp of vendorPrefixes) {
          if (vp.prefixes.some((pf) => key.toLowerCase().startsWith(pf))) {
            newCandidates[vp.key] ||= [];
            if (newCandidates[vp.key].length < 3 && !newCandidates[vp.key].some((x) => x.id === key)) {
              newCandidates[vp.key].push({ id: key, source: 'LiteLLM', inPer1M, outPer1M });
            }
          }
        }
      }
    }

    for (const m of apiData.models) {
      const match = ltByNorm.get(normalizeModelKey(m.modelId));
      if (!match) continue;
      const localInUsd = m.currency === 'USD' ? m.input : m.input / fxRate;
      const localOutUsd = m.currency === 'USD' ? m.output : m.output / fxRate;
      const inRatio = localInUsd > 0 ? Math.abs(match.inPer1M - localInUsd) / localInUsd : 0;
      const outRatio = localOutUsd > 0 ? Math.abs(match.outPer1M - localOutUsd) / localOutUsd : 0;
      if ((inRatio > 0.05 && Math.abs(match.inPer1M - localInUsd) > 0.01) || (outRatio > 0.05 && Math.abs(match.outPer1M - localOutUsd) > 0.01)) {
        priceDiffs.push(
          `[PRICE_DIFF] ${m.id} vs LiteLLM(${match.id}): 本地 $${localInUsd.toFixed(2)}/$${localOutUsd.toFixed(
            2
          )} vs 社区 $${match.inPer1M.toFixed(2)}/$${match.outPer1M.toFixed(2)}`
        );
      }
    }
  } catch (err) {
    unavailable.push(`LiteLLM 哨兵不可达: ${err?.cause?.code || err.message}`);
  }

  return { priceDiffs, newCandidates, unavailable };
}

function collectOfficialUrls(apiData, plansData, thirdPartyData) {
  const urls = new Set();
  for (const p of apiData.providers) {
    urls.add(p.pricingUrl);
    for (const ex of p.extraUrls || []) urls.add(ex.url);
  }
  for (const m of apiData.models) urls.add(m.sourceUrl);
  for (const pl of plansData.plans) {
    urls.add(pl.sourceUrl);
    for (const ex of pl.extraUrls || []) urls.add(ex.url);
  }
  for (const ch of thirdPartyData.channels) urls.add(ch.sourceUrl);
  return [...urls];
}

function extractPricingLines(html) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&yen;/gi, '¥');

  const signalRe = /(\$|¥|USD|CNY|RMB|1M|million|百万|token|cache|缓存|元|月|\/M|MTok|TTL)/i;
  const lines = [];
  let prev = '';
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (line.length < 3 || line.length > 320) continue;
    if (!signalRe.test(line)) continue;
    if (line === prev) continue;
    prev = line;
    lines.push(line);
  }
  const bodyText = lines.join('\n');
  const hash = createHash('sha256').update(bodyText).digest('hex');
  return { hash, lines };
}

async function runOfficialSnapshots(urls, timeoutMs, saveBaseline) {
  const prevStore = await loadJson('.cache/pricing-snapshots.json', { updatedAt: null, urls: {} });
  const prevUrls = prevStore.urls || {};
  const nextUrls = { ...prevUrls };
  const hadAnyBaseline = Object.keys(prevUrls).length > 0;

  const queue = [...urls];
  const reports = [];
  const workerCount = 4;

  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const url = queue.shift();
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; llm-pricing-watcher/1.0)' },
        });
        const html = await res.text();
        if (!res.ok) {
          reports.push({ url, status: 'unreachable', reason: `HTTP ${res.status}` });
          continue;
        }
        const { hash, lines } = extractPricingLines(html);
        const prev = prevUrls[url];
        if (!prev) {
          reports.push({ url, status: 'new_baseline', lineCount: lines.length });
        } else if (prev.hash === hash) {
          reports.push({ url, status: 'unchanged', lineCount: lines.length });
        } else {
          const prevSet = new Set(prev.lines || []);
          const curSet = new Set(lines);
          const added = lines.filter((l) => !prevSet.has(l)).slice(0, 3);
          const removed = (prev.lines || []).filter((l) => !curSet.has(l)).slice(0, 2);
          reports.push({ url, status: 'changed', added, removed, lineCount: lines.length });
        }
        if (saveBaseline) {
          nextUrls[url] = {
            hash,
            lineCount: lines.length,
            lines: lines.slice(0, 400),
            fetchedAt: new Date().toISOString(),
          };
        }
      } catch (err) {
        reports.push({ url, status: 'unreachable', reason: err?.cause?.code || err.message });
      }
    }
  });

  await Promise.all(workers);

  if (saveBaseline) {
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(
      snapshotPath,
      JSON.stringify({ updatedAt: new Date().toISOString(), urls: nextUrls }, null, 2),
      'utf8'
    );
  }

  return { reports, hadAnyBaseline, saved: saveBaseline };
}

function formatReport(opts, freshness, radar, snapshots) {
  const out = [];
  const h = (title) => out.push(opts.markdown ? `\n### ${title}` : `\n=== ${title} ===`);

  h('1. 到期与陈旧度巡检');
  if (!freshness.expiredPromos.length && !freshness.expiringSoonPromos.length && !freshness.staleItems.length) {
    out.push('- 全部模型核对日期正常，无已过期或 14 天内到期的促销价格。');
  } else {
    for (const x of freshness.expiredPromos) out.push(`- [EXPIRED] ${x}`);
    for (const x of freshness.expiringSoonPromos) out.push(`- [EXPIRING_SOON] ${x}`);
    for (const x of freshness.staleItems) out.push(`- [STALE] ${x}`);
  }

  if (radar) {
    h('2. 开源价格哨兵（LiteLLM & OpenRouter）');
    for (const u of radar.unavailable) out.push(`- [RADAR_UNAVAILABLE] ${u}`);
    if (radar.priceDiffs.length === 0) {
      out.push('- 已匹配模型输入/输出价格与社区基准差异均在 5% 以内。');
    } else {
      for (const d of radar.priceDiffs.slice(0, 20)) out.push(`- ${d}`);
    }
    const candKeys = Object.keys(radar.newCandidates);
    if (candKeys.length > 0) {
      out.push('- 疑似未收录新模型候选（每厂商最多 3 条）：');
      for (const k of candKeys) {
        const list = radar.newCandidates[k]
          .map((c) => `${c.id} (${c.source}: $${c.inPer1M.toFixed(2)}/$${c.outPer1M.toFixed(2)})`)
          .join(' | ');
        out.push(`  - [NEW_CANDIDATE] ${k}: ${list}`);
      }
    }
  }

  if (snapshots) {
    h('3. 官网价格段落快照 Diff');
    const changed = snapshots.reports.filter((r) => r.status === 'changed');
    const unchanged = snapshots.reports.filter((r) => r.status === 'unchanged');
    const newBase = snapshots.reports.filter((r) => r.status === 'new_baseline');
    const unreachable = snapshots.reports.filter((r) => r.status === 'unreachable');

    out.push(
      `- 总计 ${snapshots.reports.length} 个官方 URL：变更 ${changed.length}、未变 ${unchanged.length}、新建基线 ${newBase.length}、不可达 ${unreachable.length}`
    );
    for (const c of changed) {
      out.push(`- [CHANGED] ${c.url}`);
      for (const line of c.added) out.push(`  + ${line}`);
      for (const line of c.removed) out.push(`  - ${line}`);
    }
    for (const u of unreachable) {
      out.push(`- [UNREACHABLE] ${u.url} (${u.reason})`);
    }
    if (snapshots.saved) {
      out.push(`- 已保存最新快照基线到 .cache/pricing-snapshots.json`);
    } else if (!snapshots.hadAnyBaseline) {
      out.push(`- 提示：本地尚无快照基线，可先运行 \`npm run watch:save\` 建立首次基线。`);
    }
  }

  return out.join('\n');
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const [apiData, plansData, thirdPartyData] = await Promise.all([
    loadJson('public/data/api-pricing.json'),
    loadJson('public/data/plans.json'),
    loadJson('public/data/third-party.json'),
  ]);

  const freshness = checkFreshness(apiData, plansData, thirdPartyData);
  const radar = opts.skipRadar ? null : await runOpenSourceRadar(apiData, opts.timeoutMs);
  const urls = collectOfficialUrls(apiData, plansData, thirdPartyData);
  const snapshots = opts.skipSnapshots
    ? null
    : await runOfficialSnapshots(urls, opts.timeoutMs, opts.saveBaseline);

  console.log(formatReport(opts, freshness, radar, snapshots));
}

main().catch((err) => {
  console.error('巡检执行异常:', err);
  process.exit(1);
});
