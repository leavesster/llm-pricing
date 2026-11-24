# 大模型 API 与包月套餐价格对照站

基于零构建纯静态页面（HTML / CSS / 原生 ES Module）+ JSON 数据，通过 **Cloudflare Workers Static Assets** 托管。

## 功能概览

1. **官方 API 价格表（`#api`）**
   - 覆盖 10 家海内外主流厂商（OpenAI、Anthropic Claude、Google Gemini、DeepSeek、xAI Grok、智谱 AI GLM、阿里云百炼 Qwen、Kimi Moonshot、MiniMax、火山方舟 Doubao）。
   - 展示输入、输出、缓存读取、缓存写入/存储费、缓存时间（TTL）、上下文窗口与长文本阶梯规则，**所有厂商与模型均附直连官方原始链接**。
   - 支持原币种 / USD / CNY 全局切换与自定义汇率、关键词搜索、区域与厂商多选对比、档位/上下文下限/缓存机制/TTL/综合价上限过滤、多列排序、DeepSeek 空闲时段 5 折开关，以及可选显示「第三方渠道对比」预留列。
   - 支持通过网页「厂商排序」弹窗拖拽或上下移动调整默认厂商顺序，并自动保存到本机浏览器的 `localStorage`，跨刷新持久生效（可随时一键恢复默认）。

2. **包月套餐 & 估算 Token（`#plans`）**
   - 覆盖海外通用/Agent 订阅（ChatGPT、Claude、Google AI）、海外 IDE（Cursor、GitHub Copilot）及国内 Coding Plan（智谱 GLM、阿里云百炼、火山方舟、Kimi Code、MiniMax M Plan）。
   - 明确区分四类估算模型：**积分公式精算**、**固定额度换算**、**按次折算**、**动态共享池估算**，结合顶部实时可调参数面板计算月度可用 Token 估算区间与等效 API 价值；支持按套餐分类、区域、估算方式、厂商多选、月费预算上限、是否含 API Credits 过滤与多种排序。

3. **第三方渠道对比预留（`#third-party`）**
   - 预留 OpenCode Zen / Console 等第三方聚合渠道与官方的对比矩阵（标价差异、充值网关手续费、`token/s`、首字延迟 TTFT、缓存行为差异），支持按渠道、状态与关键词过滤。后续实测完成后只需更新 JSON 即可生效。

## 目录结构

```text
.
├── wrangler.jsonc              # Cloudflare Workers Static Assets 配置
├── package.json                # 校验与开发脚本
├── scripts/
│   └── validate-data.mjs       # JSON 数据与官方链接完整性校验脚本
└── public/
    ├── index.html
    ├── styles.css
    ├── app.js
    └── data/
        ├── api-pricing.json    # 官方 API 价格、缓存与官方直连 URL
        ├── plans.json          # 包月套餐与 Token 估算规则
        └── third-party.json    # 第三方渠道实测对比预留数据
```

## 数据维护说明

### 1. 更新官方价格与套餐
直接编辑 `public/data/api-pricing.json` 与 `public/data/plans.json`，更新 `meta.verifiedAt` 日期，随后运行校验脚本确保数据格式与官方 URL 均合规：

```bash
npm run check
```

### 2. 补充第三方渠道 `token/s` 实测数据
打开 `public/data/third-party.json`，在 `channels` 中维护渠道信息，并在 `benchmarks` 数组中为对应的 `modelId` 填入实测字段：
- `priceDeltaPct`：相对官方 API 标价差（百分比，如 `0` 表示原价透传，`10` 表示溢价 10%）
- `tokensPerSec` / `officialTokensPerSec`：第三方渠道与官方直连实测生成速度（tok/s）
- `ttftMs`：首字延迟（毫秒）
- `status`：从 `"pending_benchmark"` 改为 `"measured"`，并填入 `testedAt`（如 `"2026-12-01"`）

## 本地预览与部署

```bash
# 校验数据与 JS 语法
npm run check

# 本地启动 Cloudflare Workers 静态资源预览
npm run dev

# 登录并部署到 Cloudflare Workers（需先执行 wrangler login）
npm run deploy
```
