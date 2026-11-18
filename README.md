# dsh-plugin-index

一份自建的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件市场索引，**格式 1**，直接从公开的 npm registry 元数据生成，GitHub Actions 每 6 小时重建一次。

**索引地址**

```
https://cdn.jsdelivr.net/gh/xfish987/dsh-plugin-index@main/dist/index.json   ← 推荐
https://xfish987.github.io/dsh-plugin-index/index.json                      ← 备用（GitHub Pages）
```

jsDelivr 从 CDN 边缘节点直接吐缓存（实测 1–5 秒）；GitHub Pages 在部分网络下首次请求会慢到几十秒。两份内容相同，谁快用谁。

## 在 DSH 里怎么用

1. 打开 **Plugins → Discover → Index sources**（需要 `dsh 0.2.1+`，并启用可选的 experimental plugin market bundle）。
2. 填入上面的地址，保存。
3. Discover 页和 `plugin_market` 工具会同时搜索这个源。

DSH 给每个索引源 15 秒的抓取预算（`fetchTimeoutMs`），所以本索引做了瘦身：每个插件最多保留 8 个版本、不内嵌图标、JSON 紧凑成一行一个插件（约 12 MB，gzip 后约 2.5 MB）。每次刷新做完，workflow 会顺手预热这两个地址，让下一次读取命中缓存；万一遇到超时，重新打开 Discover 再试一次即可（第二次通常命中 CDN 缓存）。

## 数据是怎么来的

```
npm 搜索切片 ─┐
公开索引种子 ─┼─> 包名集合 ─> 逐个拉 packument ─> 只留声明了 dsh.bundle 的版本 ─> format 1 ─> 校验 ─> dist/index.json
上一次构建   ─┘
```

- **发现包名**：三路合并去重
  - `keywords:dsh-plugin`（npm 搜索，最多 5,250 条 —— 接口在 `from > 5000` 后会绕回第一页）
  - `keywords:dsh-plugin published:>最近 90 天`（按发布时间排序的切片，把新包顶到前面）
  - `keywords:dsh-bundle`
  - 种子：上一版索引 + 两个公开索引（[REALOIYO 的冻结索引](https://github.com/REALOIYO/dsh-plugin-market) 与 [awesome-dsh-plugin 的目录](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)）里的包名
- **过滤**：只保留 `package.json` 里声明了 `dsh.bundle` 的**版本**。没有这个字段的包装进 profile 也不会被装配，因此不进索引。
- **`engines.dsh`**：优先用版本自己声明的 `engines.dsh`；没有就取该版本 `@deepseek-ai/dsh*` 这些 peer 依赖范围的交集（交集算不出紧凑写法时留空，DSH 会退回安装时再做判定的路径）。
- **`metadata.sortKeys`**：`updated`（最近一次发布时间）对所有插件都有；`downloads` 是尽力而为的 npm 周下载量（`api.npmjs.org`），带 1k / 5k / 10k / 50k / 100k 的 `labels`。npm 的下载量接口限流很凶，所以只有一部分插件带这个指标，workflow 用 Actions cache 把它逐次攒起来。

## 自动刷新

`.github/workflows/refresh.yml`：

- 每 6 小时（UTC 0/6/12/18 的 :17）跑一次，也可手动 `workflow_dispatch`；
- 构建后先跑格式校验，再提交 `dist/index.json`（内容没变就不产生提交），最后部署 GitHub Pages；
- 校验不通过时整个 job 失败，线上不会出现坏索引。

## 本地开发

```bash
npm ci
npm run build      # 生成 dist/index.json（.cache/ 里有 packument 缓存，重跑很快）
npm run validate   # 用官方 format 1 校验器验证
npm run serve      # http://127.0.0.1:8788/index.json，给本地 DSH 用
```

常用参数（`node build-index.mjs --help` 没有，直接看文件头）：

| 参数 | 说明 |
|---|---|
| `--no-cache` | 忽略 `.cache/`，全部重新拉 |
| `--no-downloads` | 跳过周下载量（更快，产出没有 sortKeys/labels） |
| `--limit <n>` | 只处理前 n 个候选包（调试用） |
| `--max-versions <n>` | 每个插件保留的版本数，默认 8 |
| `--out <file>` | 输出路径，默认 `dist/index.json` |

## 已知限制

- **只能看到 npm 上的包**。GitHub 托管、没发布到 npm 的插件不会出现。
- **发现不全**：npm 搜索接口翻页到 5,250 条就绕回，靠时间切片和公开索引种子补；完全新且搜索排名靠后的包可能漏掉。
- **星数缺失**：GitHub API 会按仓库逐条限流，暂未收录 stars，只按周下载量排序和打标签。
- **描述是英文原文**：没有做机器翻译（`title`/`description` 也允许纯字符串，不是双语对象）。
- **版本上限 8**：更老的版本不会列出，`engines` 不兼容最新版时可能找不到可装的旧版本。
- **下载量指标不完整**：npm 的下载量接口会对批量请求限流（Cloudflare 1015），所以只有一部分插件带 `sortKeys.downloads`；`sortKeys.updated` 是全量的，排序建议用它。
- **jsDelivr 的 `@main` 有缓存**：新提交后 CDN 可能要几分钟才刷新，重建周期是 6 小时，通常感知不到。

## 许可

构建脚本与索引数据：MIT。索引条目本身来自 npm registry 的公开元数据，版权归各包作者。
