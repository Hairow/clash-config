# clash-config Worker

把订阅地址转成 Clash Verge (mihomo) 可直接导入的完整配置。

从 `backend/build-clash-config.js`（`pnpm clash:build`）抽取的最小实现：不依赖 Sub-Store 后端，单个 Cloudflare Worker 完成全部转换。

## 为什么需要

Sub-Store 的 `ClashMeta` / `Mihomo` 产出**只有 `proxies:` 一段**，不含 `proxy-groups` 与 `rules`，Clash Verge 无法当作完整配置导入。这个 Worker 补上策略组与分流规则。

## 用法

```bash
pnpm install
pnpm dev         # 本地 http://localhost:8787
pnpm deploy      # 部署到 Cloudflare
pnpm test        # 单元测试
```

上游地址一律由请求参数带入，**不需要预先配置**。

**把源订阅地址放进 `url` 请求一次，它会返回一个短地址**：

```bash
curl "https://<worker>.workers.dev/?url=<源订阅地址>&key=<ACCESS_KEY>"
# https://<worker>.workers.dev/s?token=qmTDGqA6SeM8
```

把返回的这行填进客户端的订阅框即可。要点：

- 同一个源地址**复用同一个短地址**，客户端反复刷新不会往 KV 里写新记录。
- 短地址里不含源订阅地址，客户端上不会暴露它；换机场时重新请求一次即可。
- 源地址自带 `?` `&` 时必须 URL 编码，否则会被当成 Worker 自己的参数。

| 参数 | 说明 |
| --- | --- |
| `url` | 源订阅地址，**必需**（或命中短地址时由 KV 提供） |
| `key` | 访问密钥，**必需**（与 `ACCESS_KEY` 一致） |

> `SUB_KV` 与 `ACCESS_KEY` 都是**必填**：缺任何一个，所有请求都会返回 `500` 并说明缺了什么，不会降级成"直接出配置"。

## 短地址（KV）

短地址需要先请求一次才能拿到，而且上游是写死在 KV 里的。先创建 namespace：

```bash
pnpm dlx wrangler kv namespace create SUB_KV
# 输出里的 id 填进 wrangler.jsonc 的 kv_namespaces
```

```toml
[[kv_namespaces]]
binding = "SUB_KV"
id = "<上一步输出的 id>"
```

然后 `pnpm deploy`。之后：

```bash
# 存一个上游，换回短地址（带 url 就是保存）
curl "https://<worker>.workers.dev/?key=abc&url=https%3A%2F%2Fexample.com%2Fsub%3Ftoken%3Dxyz"
# https://<worker>.workers.dev/s?token=DgD_UxLNWgdr

# 这个地址直接填进客户端即可；默认 90 天后失效，SUB_TTL=0 可设为不过期
```

几点说明：

- token 是 12 位随机 base64url，**它本身就是凭证**，命中 KV 后不再要求 `ACCESS_KEY`。
- **同一个上游地址复用同一个 token**（按 SHA-256 前 16 位建反查索引）。即使有人把 `/?url=...` 误填进客户端让它反复拉取，也不会一直往 KV 里堆记录。
- **存之前会先抓一次上游探测可用性。** 抓取失败、上游非 2xx、或解析不出任何节点，都会直接返回 `502` / `422` 而不写 KV；成功时响应体里会带上解析到的节点数。
- 短地址的上游以 KV 里存的为准，`?url=` 覆盖不了它——否则它就成了可任意改写的开放代理。
- `SUB_KV` 与 `ACCESS_KEY` 缺一不可：缺了会在入口处直接返回 `500`，不会写 KV、也不会退回"直接出配置"。

## 地址什么时候会失效

| 地址 | 失效条件 |
| --- | --- |
| `/?url=...&key=...` | 换掉 `ACCESS_KEY`、删掉 Worker，或自定义域名/`workers.dev` 子域变了（源订阅地址一直由请求带入，不受本 Worker 配置影响） |
| `/s?token=<短 token>` | **默认 90 天后**（`SUB_TTL` 设定，从写入时刻起算，客户端刷新不会续期） |
| 任意地址 | 上游订阅链接自己过期（机场的锅），表现为 `502` 或 `422` |

探测只发生在请求的那一刻：存下来的短地址之后能不能用，还得看上游订阅自己有没有过期。上游失效时短地址仍会命中 KV，只是在抓取上游时报 `502` / `422`——重新用 `?url=...` 请求一次换个上游即可。

短地址过期后访问会返回 `404`，并提示重新生成：

```
短地址 JbUciJnwxOtU 不存在或已过期。
用 /?key=<ACCESS_KEY>&url=<订阅地址> 请求一次就会生成新的。
```

`SUB_TTL` 是从写入那一刻开始算的，读多少次都不会延长——这是 KV 的 `expirationTtl` 语义。想长期使用就填 `0`（不过期），或到期前用同一个上游重新请求一次换个新地址。另外 KV 的过期在边缘有最长约 60 秒的缓存延迟，所以失效时间不是绝对精确的。

改成 `SUB_TTL = "0"` 后需要注意两点：

- **只对之后新建的短地址生效。** 已经存进 KV 的过期时间在写入时就定死了，改环境变量不会追溯修改它们，老地址只能等它过期后重新请求一次换个新的。
- **改 `[vars]` 要重新 `pnpm deploy`；改 `wrangler secret` 不用。** `ACCESS_KEY` 是 secret，改完立即生效，已发出的地址随之失效。

`SUB_TTL` 解析得比较宽容：不填或填空串按 90 天；`0` 表示不过期；填了负数或 `9O` 这类笔误也按 90 天处理，不会静默变成"永不过期"；小于 1 分钟的值会被抬到 KV 要求的 60 秒下限。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `SUB_KV` | KV namespace 绑定。**必填** |
| `ACCESS_KEY` | 访问密钥。**必填**，否则任何人拿到 URL 都能把这个 Worker 当抓取代理用 |
| `SUB_TTL` | 短地址有效期（天）。可选，不填用默认 90，填 `"0"` 表示不过期 |

```bash
wrangler secret put ACCESS_KEY
```

`wrangler dev` **不会**读取线上 secret，本地开发要单独放一份 `.dev.vars`（已被 `.gitignore` 忽略）：

```
ACCESS_KEY="<你的密钥>"
```

文件名必须是带点的 `.dev.vars`，`dev.vars` 不会被读取。启动时看到 `Using secrets defined in .dev.vars` 即表示生效。改完 `.dev.vars` 要重启 `pnpm dev`；同理，改 `[vars]` 需要重新 `pnpm deploy` 才对线上生效。

## 日志

日志走平台侧，**代码里不写 `console.*`**。`wrangler.jsonc` 已开启 Workers Logs：

```bash
pnpm exec wrangler tail        # 实时看
```

历史日志在 Cloudflare 控制台的 Worker → Logs（Free 保留 3 天，Paid 7 天）；本地 `pnpm dev` 的请求日志直接打在终端上。

排查问题时看平台自带的调用日志（形如 `GET / 403 Forbidden (50ms)`，给出状态码与耗时），具体原因都写在响应体里，不需要看自定义日志：

| 现象 | 响应里会带的信息 |
| --- | --- |
| 上游抓取失败 | `502` + 失败原因，证书类问题会附提示 |
| 上游非 2xx | `502` + 上游状态码与响应前 500 字符 |
| 没解析到节点 | `422` + 上游内容前 500 字符 |
| 短地址失效 | `404` + 重新生成的用法 |
| 密钥不对 | `403 forbidden` |
| 缺 `SUB_KV` / `ACCESS_KEY` | `500` + 缺的是哪一个，以及配置命令 |

想确认某个订阅到底哪些节点被跳过，看响应头：`x-proxy-count` 是成功解析数，`x-skipped-count` 是跳过数，`x-skipped-summary` 是前 5 条跳过原因（URL 编码）。

## 转换能力

**支持的协议**：`vless`（含 Reality / XTLS / Vision）、`trojan`、`ss`、`vmess`

**传输层**：`tcp`、`ws`、`grpc`、`http`/`h2`

**订阅格式**：整段 base64、或明文 URI 列表

解析失败的节点会被跳过而不是中断整批，原因见响应头的 `x-skipped-summary`。暂不支持 `hysteria2` / `tuic` / `ss` 的 `plugin` 参数。

## 产出内容

14 个策略组：

| 策略组 | 类型 | 默认走向 |
| --- | --- | --- |
| 🚀 节点选择 | select | ♻️ 自动选择 |
| ♻️ 自动选择 | url-test | 全部节点 |
| 🔯 故障转移 | fallback | 全部节点 |
| 🎯 全球直连 | select | DIRECT |
| 🛑 广告拦截 | select | REJECT |
| 🌍 国外媒体 | select | 🚀 节点选择 |
| 📺 国内媒体 | select | DIRECT |
| 📲 电报消息 | select | 🚀 节点选择 |
| 🤖 人工智能 | select | 🚀 节点选择 |
| Ⓜ️ 微软服务 | select | 🎯 全球直连 |
| 🍎 苹果服务 | select | DIRECT |
| 🎮 游戏平台 | select | DIRECT |
| 🎵 网易云音乐 | select | DIRECT |
| 🐟 漏网之鱼 | select | 🚀 节点选择 |

32 条分流规则：广告拦截 → 内网直连 → 国内 → 通讯社交 → 流媒体 → 开发/AI → 厂商服务 → 游戏 → 兜底 `MATCH`。均为 `GEOSITE` / `GEOIP` / `IP-CIDR`，不依赖外部 `rule-providers`。

规则里的 geosite 分类名已针对 mihomo 校验过。若你的 geo 数据库缺少某个分类，mihomo 会报 `list xxx not found in geosite.dat`，删掉对应那条规则即可。

## 已知限制

**上游证书必须是有效证书。** Cloudflare 的 `fetch` 始终校验证书，`cf.insecureSkipVerify` 不保证生效（本地 `wrangler dev` 下实测无效）。上游是自签或过期证书时，Worker 无法直接抓取，会返回 `502` 并附带提示。这种情况可以让 Sub-Store 作为上游——它的 `#insecure` 参数能绕过证书校验：

```
https://<worker>.workers.dev/?url=http://<sub-store>/download/<订阅名>/URI
```

用 `URI` 平台是因为 Worker 消费的是 URI 列表；`ClashMeta` 返回的 YAML 片段它不认。

**上游轮换参数会导致节点失效。** 部分机场每次请求都更换节点的 `sid` / `sni`。用 Worker 就没这个问题——每次客户端刷新都会重新抓取。

## 与 `pnpm clash:build` 的差异

| | `pnpm clash:build` | 本 Worker |
| --- | --- | --- |
| 运行位置 | 本地 Node | Cloudflare 边缘 |
| 上游来源 | Sub-Store 的 `/download/*` | 直接抓订阅地址 |
| 协议支持 | Sub-Store 全部 | vless / trojan / ss / vmess |
| geosite 过滤 | 读本地 `geosite.dat` 过滤 | 硬编码，不校验 |
| 内核校验 | 跑 `mihomo -t` | 无 |
| 输出 | 本地文件 | HTTP 响应 |

策略组与规则的常量在两边各有一份（`src/convert.js` 与 `backend/build-clash-config.js`），改动时需要同步。

## 目录

```
src/index.js      Worker 入口：读取参数、抓取上游、返回 YAML
src/convert.js    纯函数：URI 解析、配置拼装、YAML 序列化
src/utils.js      纯函数：URI 拆分与解码、短 token、纯文本响应（被上面两个文件引用）
test/             单元测试（node:test）
```
