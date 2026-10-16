/*
 * Cloudflare Worker：把订阅地址转成 Clash Verge (mihomo) 可用的完整配置
 *
 * 上游地址一律由请求参数 url 带入，不需要预先配置：
 *   https://<worker>.workers.dev/?url=<上游订阅地址>&key=<ACCESS_KEY>
 *        → 存进 KV，返回一个短地址（同一个上游复用同一个地址）
 *   https://<worker>.workers.dev/s/<短 token>
 *        → 用存下来的上游出配置
 *   https://<worker>.workers.dev/?url=<上游订阅地址>&key=xxx&raw=1
 *        → 不保存，直接返回完整配置
 *   https://<worker>.workers.dev/?list=1&key=xxx / ?drop=<短 token>&key=xxx
 *
 * 环境变量：
 *   ACCESS_KEY  设置后必须带 ?key= 才能访问（避免变成公开的抓取代理）
 *   SUB_TTL     短地址有效期（天），默认 90，填 0 表示不过期
 *   绑定 SUB_KV 后才启用短地址功能
 */

import { buildConfig, parseSubscription, toYaml } from './convert.js';

const HELP = `Cloudflare Worker: 订阅 → Clash Verge (mihomo) 配置

用法:
  GET /?url=<上游订阅地址>&key=<ACCESS_KEY>   存进 KV，返回一个短地址
  GET /s/<短 token>                           用存下来的上游出配置

管理:
  GET /?list=1&key=<ACCESS_KEY>               列出已存的短地址
  GET /?drop=<短 token>&key=<ACCESS_KEY>      删除

可选参数:
  raw=1     不保存，直接返回配置
  ua        请求上游时使用的 User-Agent，默认 clash-verge/v1.7.7
  debug=1   不输出配置，改为列出哪些节点被跳过及原因

说明:
  - 上游返回 base64 或明文均可，支持 vless / trojan / ss / vmess
  - 输出为完整配置，含 14 个策略组与 32 条分流规则
  - 短地址填进客户端即可，源订阅地址不会暴露在客户端里
`;

// 短 token 用 base64url，12 个字符，碰撞概率可以忽略
function makeToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(9));
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

const DEFAULT_TTL_DAYS = 90;

// SUB_TTL 是"天"：0 表示不过期；没填用 90 天；负数或乱填也按 90 天算，
// 免得把 9O / -1 这种笔误静默当成"永不过期"
function tokenTtl(env) {
    const raw = env.SUB_TTL;
    if (raw === undefined || raw === '') return DEFAULT_TTL_DAYS * 86400;

    const days = Number(raw);
    if (!Number.isFinite(days) || days < 0) {
        return DEFAULT_TTL_DAYS * 86400;
    }
    if (days === 0) return null;

    // KV 的 expirationTtl 最小 60 秒
    return Math.max(60, Math.floor(days * 86400));
}

// 同一个上游地址要复用同一个 token，否则客户端每次刷新都会写一条新记录
async function upstreamHash(target) {
    const bytes = new TextEncoder().encode(target);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 16);
}

// 把上游地址存进 KV，换一个短地址出来
async function saveUpstream(env, origin, params) {
    const target = params.get('url');
    if (!target) return text('缺少 url 参数。用法：/?url=<上游订阅地址>', 400);

    const hash = await upstreamHash(target);
    const existing = await env.SUB_KV.get(`u:${hash}`);
    if (existing && (await env.SUB_KV.get(`sub:${existing}`))) {
        return text(
            `${origin}/s/${existing}\n\n` +
                '这个上游地址之前存过，沿用同一个短地址，没有重复写入。',
        );
    }

    const ttl = tokenTtl(env);
    const token = makeToken();
    const options = {
        ...(ttl ? { expirationTtl: ttl } : {}),
        metadata: { url: target, createdAt: new Date().toISOString() },
    };
    const entry = JSON.stringify({
        url: target,
        ua: params.get('ua') || null,
        hash,
    });
    await env.SUB_KV.put(`sub:${token}`, entry, options);
    // 反查索引，用来去重
    await env.SUB_KV.put(`u:${hash}`, token, options);

    return text(
        `${origin}/s/${token}\n\n` +
            `已存入 KV${ttl ? `，${ttl / 86400} 天后失效` : '，不会自动失效'}。\n` +
            '把它填进 Clash Verge 的订阅框即可；' +
            `删除用 /?drop=${token}&key=<ACCESS_KEY>。`,
    );
}

// 只有 /s/<token> 这种写法才带路径参数，其余路径一律当普通请求
function pathToken(pathname) {
    const segments = pathname.split('/').filter(Boolean);
    return segments.length === 2 && segments[0] === 's' ? segments[1] : '';
}

const YAML_HEADERS = {
    'content-type': 'text/yaml; charset=utf-8',
    'cache-control': 'no-store',
};

function text(body, status) {
    return new Response(body, {
        status: status || 200,
        headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
        },
    });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return text('Method Not Allowed', 405);
        }

        const params = url.searchParams;

        // 短 token 只可能出现在 /s/<token> 里，命中它就不再要求 ACCESS_KEY
        const token = pathToken(url.pathname);
        const stored =
            env.SUB_KV && token
                ? await env.SUB_KV.get(`sub:${token}`, 'json')
                : null;

        // /s/xxx 查不到就是短地址过期或写错了，明确报 404
        if (token && !stored) {
            return text(
                `短地址 ${token} 不存在或已过期。\n` +
                    '用 /?key=<ACCESS_KEY>&url=<订阅地址> 请求一次就会生成新的。',
                404,
            );
        }

        // 只有命中 KV 的短地址才自带凭证，其余请求都要带密钥
        const isManage =
            params.get('save') === '1' ||
            params.get('list') === '1' ||
            params.has('drop');
        const authorized =
            !env.ACCESS_KEY || params.get('key') === env.ACCESS_KEY;
        if ((isManage || !stored) && !authorized) {
            return text('forbidden', 403);
        }

        // 带 url 的请求默认就是"存下来换个短地址"，不需要写 save=1。
        // 想直接拿配置用 raw=1；想先看解析结果用 debug=1。
        const explicitSave = params.get('save') === '1';
        const autoSave =
            !stored &&
            Boolean(params.get('url')) &&
            params.get('raw') !== '1' &&
            params.get('debug') !== '1';

        if (explicitSave && !env.SUB_KV) {
            return text(
                '没有绑定 SUB_KV，短地址功能不可用。见 README 的「短地址」一节。',
                501,
            );
        }
        if (explicitSave && !env.ACCESS_KEY) {
            // 没密钥的话任何人拿到地址都能往 KV 里写，所以这里强制要求
            return text(
                '保存上游地址前请先设置 ACCESS_KEY：\n' +
                    '  wrangler secret put ACCESS_KEY\n' +
                    '否则任何人都能往 KV 里写数据。',
                400,
            );
        }

        // 没绑 KV 或没设密钥时无法安全保存，自动保存静默降级为直接出配置
        const canAutoSave =
            autoSave && Boolean(env.SUB_KV) && Boolean(env.ACCESS_KEY);
        if (explicitSave || canAutoSave) {
            return await saveUpstream(env, url.origin, params);
        }

        if (params.get('list') === '1') {
            if (!env.SUB_KV) return text('没有绑定 SUB_KV。', 501);
            const lines = [];
            let cursor;
            do {
                const page = await env.SUB_KV.list({ prefix: 'sub:', cursor });
                for (const item of page.keys) {
                    lines.push(
                        `${url.origin}/s/${item.name.slice(4)} -> ` +
                            `${item.metadata?.url || '(无)'}`,
                    );
                }
                cursor = page.list_complete ? undefined : page.cursor;
            } while (cursor);
            return text(lines.length ? lines.join('\n') : '（KV 里还没有短地址）');
        }

        if (params.has('drop')) {
            if (!env.SUB_KV) return text('没有绑定 SUB_KV。', 501);
            const token = params.get('drop');
            const entry = await env.SUB_KV.get(`sub:${token}`, 'json');
            if (!entry) {
                return text(`KV 里没有 ${token}`, 404);
            }
            await env.SUB_KV.delete(`sub:${token}`);
            // 反查索引要一起删，否则同一个上游再次存进来会指向已删除的 token
            if (entry.hash) {
                await env.SUB_KV.delete(`u:${entry.hash}`);
            }
            return text(`已删除 ${url.origin}/s/${token}`);
        }

        // 短地址命中的话以 KV 里存的为准，避免它被当成开放代理随意改上游
        const source = stored?.url || params.get('url');
        if (!source) {
            return text(HELP, 400);
        }

        const userAgent =
            params.get('ua') || stored?.ua || 'clash-verge/v1.7.7';

        let upstream;
        try {
            upstream = await fetch(source, {
                headers: {
                    'User-Agent': userAgent,
                    Accept: '*/*',
                },
                // 尽力跳过 TLS 校验；注意 Cloudflare 可能忽略该项，自签证书仍需证书有效
                cf: { insecureSkipVerify: true },
                redirect: 'follow',
            });
        } catch (error) {
            const message = String(error.message || error);
            const hint = /internal error|tls|ssl|certificate|handshake/i.test(
                message,
            )
                ? '\n\n提示：上游证书为自签或已过期时 Cloudflare 无法跳过校验。' +
                  '请改用证书有效的地址，或让 Sub-Store 作为上游（它的 #insecure 能绕过）。'
                : '';
            return text(`拉取上游失败: ${message}${hint}`, 502);
        }

        const raw = await upstream.text();
        if (!upstream.ok) {
            return text(
                `上游返回 ${upstream.status}\n${raw.slice(0, 500)}`,
                502,
            );
        }

        const { proxies, skipped } = parseSubscription(raw);
        if (!proxies.length) {
            return text(
                `没有解析到节点。上游内容前 500 字符：\n${raw.slice(0, 500)}`,
                422,
            );
        }

        if (url.searchParams.get('debug') === '1') {
            return text(
                `解析成功: ${proxies.length} 个节点\n` +
                    `跳过: ${skipped.length}\n\n` +
                    skipped.map((item) => `- ${item}`).join('\n'),
            );
        }

        const yaml = toYaml(buildConfig(proxies));
        return new Response(yaml, {
            headers: {
                ...YAML_HEADERS,
                'x-proxy-count': String(proxies.length),
                'x-skipped-count': String(skipped.length),
                // 响应头只放摘要，完整信息用 ?debug=1 看
                'x-skipped-summary': encodeURIComponent(
                    skipped.slice(0, 5).join(' | '),
                ),
            },
        });
    },
};
