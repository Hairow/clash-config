/*
 * Cloudflare Worker：把订阅地址转成 Clash Verge (mihomo) 可用的完整配置
 *
 *   /?url=<上游订阅地址>&key=<ACCESS_KEY>  存进 KV，返回一个短地址
 *   /s/<短 token>                          用存下来的上游出配置
 *
 * 环境变量：
 *   ACCESS_KEY  设置后必须带 ?key= 才能访问（避免变成公开的抓取代理）
 *   SUB_TTL     短地址有效期（天），默认 90，填 0 表示不过期
 *   绑定 SUB_KV 后才启用短地址功能
 */

import { buildConfig, parseSubscription, toYaml } from './convert.js';

const HELP = `用法:
  GET /?url=<上游订阅地址>&key=<ACCESS_KEY>   存进 KV，返回一个短地址
  GET /s/<短 token>                           用存下来的上游出配置`;

const USER_AGENT = 'clash-verge/v1.7.7';

// 短 token 用 base64url，12 个字符，碰撞概率可以忽略
function makeToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(9));
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

// SUB_TTL 是"天"：不填用 90，0 表示不过期；负数或 9O 这类笔误也按 90 算，
// 免得静默变成"永不过期"
function tokenTtl(env) {
    const raw = env.SUB_TTL;
    const days = raw === undefined || raw === '' ? 90 : Number(raw);
    if (!Number.isFinite(days) || days < 0) return 90 * 86400;
    // KV 的 expirationTtl 最小 60 秒
    return days === 0 ? null : Math.max(60, Math.floor(days * 86400));
}

// 同一个上游地址要复用同一个 token，否则客户端每次刷新都会写一条新记录
async function upstreamHash(target) {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(target),
    );
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 16);
}

// 把上游地址存进 KV，换一个短地址出来
async function saveUpstream(env, origin, target) {
    const hash = await upstreamHash(target);
    const existing = await env.SUB_KV.get(`u:${hash}`);
    if (existing) {
        return text(
            `${origin}/s/${existing}\n\n` +
                '这个上游地址之前存过，沿用同一个短地址，没有重复写入。',
        );
    }

    const ttl = tokenTtl(env);
    const token = makeToken();
    const options = ttl ? { expirationTtl: ttl } : {};
    // 先写反查索引：它要比 sub: 先过期，否则会留下指向已失效短地址的死链
    await env.SUB_KV.put(`u:${hash}`, token, options);
    await env.SUB_KV.put(`sub:${token}`, target, options);

    return text(
        `${origin}/s/${token}\n\n` +
            `已存入 KV${ttl ? `，${ttl / 86400} 天后失效` : '，不会自动失效'}。\n` +
            '把它填进 Clash Verge 的订阅框即可。',
    );
}

// 只有 /s/<token> 这种写法才带路径参数，其余路径一律当普通请求
function pathToken(pathname) {
    const segments = pathname.split('/').filter(Boolean);
    return segments.length === 2 && segments[0] === 's' ? segments[1] : '';
}

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
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return text('Method Not Allowed', 405);
        }

        const url = new URL(request.url);
        const params = url.searchParams;

        // 短 token 只可能出现在 /s/<token> 里；它本身就是凭证，命中后不再要求 ACCESS_KEY
        const token = pathToken(url.pathname);
        const stored =
            env.SUB_KV && token ? await env.SUB_KV.get(`sub:${token}`) : null;
        if (token && !stored) {
            return text(
                `短地址 ${token} 不存在或已过期。\n` +
                    '用 /?key=<ACCESS_KEY>&url=<订阅地址> 请求一次就会生成新的。',
                404,
            );
        }

        // 其余请求都要带密钥
        if (!stored && env.ACCESS_KEY && params.get('key') !== env.ACCESS_KEY) {
            return text('forbidden', 403);
        }

        // 短地址命中的话以 KV 里存的为准，避免它被当成开放代理随意改上游
        const source = stored || params.get('url');
        if (!source) {
            return text(HELP, 400);
        }

        // 带 url 的请求就是"存下来换个短地址"。没绑 KV 或没设密钥时无法安全保存，
        // 静默降级为直接出配置，不写 KV
        if (!stored && env.SUB_KV && env.ACCESS_KEY) {
            return await saveUpstream(env, url.origin, source);
        }

        let upstream;
        try {
            upstream = await fetch(source, {
                headers: {
                    'User-Agent': USER_AGENT,
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
            return text(`上游返回 ${upstream.status}\n${raw.slice(0, 500)}`, 502);
        }

        const { proxies, skipped } = parseSubscription(raw);
        if (!proxies.length) {
            return text(
                `没有解析到节点。上游内容前 500 字符：\n${raw.slice(0, 500)}`,
                422,
            );
        }

        return new Response(toYaml(buildConfig(proxies)), {
            headers: {
                'content-type': 'text/yaml; charset=utf-8',
                'cache-control': 'no-store',
                'x-proxy-count': String(proxies.length),
                // 跳过的节点只放摘要，避免响应头过长
                'x-skipped-count': String(skipped.length),
                'x-skipped-summary': encodeURIComponent(
                    skipped.slice(0, 5).join(' | '),
                ),
            },
        });
    },
};
