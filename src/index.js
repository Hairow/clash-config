/*
 * Cloudflare Worker：把订阅地址转成 Clash Verge (mihomo) 可用的完整配置
 *
 * 按路径分成两个入口，其余路径一律 404：
 *   /s?token=<短 token>        → serveShort()：用 KV 里存的上游出配置
 *   /?url=<上游订阅地址>&key=  → handleRoot()：存进 KV，返回一个短地址
 *
 * 两条分支都会先抓一次上游探测可用性，失败直接返回 502 / 422，不写 KV
 *
 * 必需配置（缺任何一个都返回 500，不做降级）：
 *   SUB_KV       KV namespace 绑定
 *   ACCESS_KEY   访问密钥，请求必须带 ?key=
 *
 * 可选配置：
 *   SUB_TTL      短地址有效期（天），默认 90，填 0 表示不过期
 */

import { buildConfig, parseSubscription, toYaml } from './convert.js';
import { makeToken, text, upstreamHash } from './utils.js';

const HELP = `用法:
  GET /?url=<上游订阅地址>&key=<ACCESS_KEY>   存进 KV，返回一个短地址
  GET /s?token=<短 token>                     用存下来的上游出配置`;

const USER_AGENT = 'clash-verge/v1.7.7';

// SUB_TTL 是"天"：不填用 90，0 表示不过期；负数或 9O 这类笔误也按 90 算，
// 免得静默变成"永不过期"
function tokenTtl(env) {
    const raw = env.SUB_TTL;
    const days = raw === undefined || raw === '' ? 90 : Number(raw);
    if (!Number.isFinite(days) || days < 0) return 90 * 86400;
    // KV 的 expirationTtl 最小 60 秒
    return days === 0 ? null : Math.max(60, Math.floor(days * 86400));
}

// 抓取上游并解析。失败时返回 { error } —— 一个可以直接回给客户端的响应
async function loadUpstream(source) {
    let response;
    try {
        response = await fetch(source, {
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
        const hint = /internal error|tls|ssl|certificate|handshake/i.test(message)
            ? '\n\n提示：上游证书为自签或已过期时 Cloudflare 无法跳过校验。' +
            '请改用证书有效的地址，或让 Sub-Store 作为上游（它的 #insecure 能绕过）。'
            : '';
        return { error: text(`拉取上游失败: ${message}${hint}`, 502) };
    }

    const raw = await response.text();
    if (!response.ok) {
        return {
            error: text(`上游返回 ${response.status}\n${raw.slice(0, 500)}`, 502),
        };
    }

    const { proxies, skipped } = parseSubscription(raw);
    if (!proxies.length) {
        return {
            error: text(
                `没有解析到节点。上游内容前 500 字符：\n${raw.slice(0, 500)}`,
                422,
            ),
        };
    }

    return { proxies, skipped };
}

// 把上游地址存进 KV，换一个短地址出来。调用前已探测过上游，nodeCount 是解析到的节点数
async function saveUpstream(env, origin, target, nodeCount) {
    const hash = await upstreamHash(target);
    const existing = await env.SUB_KV.get(`u:${hash}`);
    // 除反查索引外还要确认真身还在：下面两次 put 只成功一次的话会留下悬空的 u:
    if (existing && (await env.SUB_KV.get(`sub:${existing}`))) {
        return text(
            `${origin}/s?token=${existing}\n\n` +
            `上游探测可用（${nodeCount} 个节点），` +
            '这个地址之前存过，沿用同一个短地址，没有重复写入。',
        );
    }

    const ttl = tokenTtl(env);
    const token = makeToken();
    const options = ttl ? { expirationTtl: ttl } : {};
    // 先写反查索引：它要比 sub: 先过期，否则会留下指向已失效短地址的死链
    await env.SUB_KV.put(`u:${hash}`, token, options);
    await env.SUB_KV.put(`sub:${token}`, target, options);

    return text(
        `${origin}/s?token=${token}\n\n` +
        `上游探测可用（${nodeCount} 个节点）。\n` +
        `已存入 KV${ttl ? `，${ttl / 86400} 天后失效` : '，不会自动失效'}。\n` +
        '把它填进 Clash Verge 的订阅框即可。',
    );
}

// 把探测好的节点套上策略组与规则，返回 YAML
function configResponse({ proxies, skipped }) {
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
}

// 分支一 /s?token=<短 token>：token 本身就是凭证，不用再带 key
async function serveShort(env, url) {
    const token = url.searchParams.get('token');
    if (!token) {
        return text('缺少 token 参数。用法：/s?token=<短 token>', 400);
    }

    const source = await env.SUB_KV.get(`sub:${token}`);
    if (!source) {
        return text(
            `短地址 ${token} 不存在或已过期。\n` +
            '用 /?key=<ACCESS_KEY>&url=<订阅地址> 请求一次就会生成新的。',
            404,
        );
    }

    const loaded = await loadUpstream(source);
    return loaded.error || configResponse(loaded);
}

// 分支二 /?url=...：带 url 就是"存下来换个短地址"
async function handleRoot(env, url) {
    const params = url.searchParams;
    if (params.get('key') !== env.ACCESS_KEY) {
        return text('forbidden', 403);
    }

    const source = params.get('url');
    if (!source) {
        return text(HELP, 400);
    }

    // 存之前先探测一次上游：地址失效时直接报错，不会把死链写进 KV
    const loaded = await loadUpstream(source);
    if (loaded.error) {
        return loaded.error;
    }

    return await saveUpstream(env, url.origin, source, loaded.proxies.length);
}

export default {
    async fetch(request, env) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return text('Method Not Allowed', 405, { allow: 'GET, HEAD' });
        }

        if (!env.ACCESS_KEY) {
            return text('需要配置 ACCESS_KEY', 500);
        }
        if (!env.SUB_KV) {
            return text('需要配置 SUB_KV', 500);
        }

        const url = new URL(request.url);

        // 只处理这两个路径，其余一律 404：/ 存短地址，/s?token= 出配置
        if (url.pathname === '/') return await handleRoot(env, url);
        if (url.pathname === '/s') return await serveShort(env, url);

        return text('Not Found', 404);
    },
};
