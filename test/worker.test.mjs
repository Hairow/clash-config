/*
 * Worker 入口的回归测试：路由、必填配置、KV 写入、探测失败不落库
 *
 * 用内存 KV + 可替换的 globalThis.fetch 跑，不需要 Workers 运行时或额外依赖：
 *   pnpm test
 *
 * 这些用例会临时顶掉 globalThis.fetch，结束时还原。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import worker from '../src/index.js';
import { upstreamHash } from '../src/utils.js';

const UPSTREAM = [
    'vless://uuid-1@1.2.3.4:443?security=tls&type=tcp&sni=a.com#n1',
    'trojan://pw@5.6.7.8:443?sni=b.com#n2',
].join('\n');

const UPSTREAM_URL = 'https://up.example/sub';
const STORE_PATH = `/?key=secret&url=${encodeURIComponent(UPSTREAM_URL)}`;

// 内存版 SUB_KV，只实现本 Worker 用到的三个方法
function memoryKV() {
    const store = new Map();
    return {
        store,
        async get(key) {
            return store.has(key) ? store.get(key) : null;
        },
        async put(key, value) {
            store.set(key, value);
        },
        async delete(key) {
            store.delete(key);
        },
    };
}

const call = (env, path, init) =>
    worker.fetch(new Request(`https://worker.dev${path}`, init), env);

// 装一个可控的上游，用例结束后还原 globalThis.fetch
async function withUpstream(options, run) {
    const { body = UPSTREAM, status = 200, fail = false } = options;
    const kv = memoryKV();
    const env = { SUB_KV: kv, ACCESS_KEY: 'secret' };
    const calls = { upstream: 0 };
    const original = globalThis.fetch;

    globalThis.fetch = async () => {
        calls.upstream += 1;
        if (fail) throw new Error('network down');
        return new Response(body, { status });
    };

    try {
        return await run({ kv, env, calls });
    } finally {
        globalThis.fetch = original;
    }
}

// 从响应体里抠出短地址里的 token
function tokenOf(body) {
    return /\/s\?token=([A-Za-z0-9_-]{12})/.exec(body)?.[1];
}

describe('入口校验', () => {
    it('缺 ACCESS_KEY / SUB_KV 时返回 500', async () => {
        await withUpstream({}, async ({ kv }) => {
            const noKey = await call({ SUB_KV: kv }, '/');
            assert.equal(noKey.status, 500);
            assert.match(await noKey.text(), /ACCESS_KEY/);

            const noKv = await call({ ACCESS_KEY: 'secret' }, '/');
            assert.equal(noKv.status, 500);
            assert.match(await noKv.text(), /SUB_KV/);
        });
    });

    it('非 GET / HEAD 返回 405，既不写 KV 也不抓上游', async () => {
        await withUpstream({}, async ({ kv, env, calls }) => {
            for (const method of ['POST', 'PUT', 'DELETE']) {
                const res = await call(env, STORE_PATH, { method });
                assert.equal(res.status, 405, `${method} 应为 405`);
                assert.equal(res.headers.get('allow'), 'GET, HEAD');
            }
            assert.equal(kv.store.size, 0);
            assert.equal(calls.upstream, 0);
        });
    });

    it('未知路径 404；密钥不对 403', async () => {
        await withUpstream({}, async ({ kv, env, calls }) => {
            assert.equal((await call(env, '/foo')).status, 404);
            assert.equal((await call(env, '/s/abc')).status, 404);

            const stored = await call(env, STORE_PATH);
            assert.equal(stored.status, 200);
            const token = tokenOf(await stored.text());

            const badKey = await call(
                env,
                `/?key=wrong&url=${encodeURIComponent(UPSTREAM_URL)}`,
            );
            assert.equal(badKey.status, 403);
            assert.equal((await call(env, '/?key=wrong')).status, 403);

            // /s 分支只认 token，不校验 key
            assert.equal((await call(env, `/s?token=${token}&key=wrong`)).status, 200);
            assert.equal(kv.store.size, 2);
        });
    });

    it('根路径没带 url 时返回用法', async () => {
        await withUpstream({}, async ({ env, calls }) => {
            const res = await call(env, '/?key=secret');
            assert.equal(res.status, 400);
            assert.match(await res.text(), /用法/);
            assert.equal(calls.upstream, 0);
        });
    });
});

describe('分支一 /s?token=', () => {
    it('缺 token 400，token 不存在 404', async () => {
        await withUpstream({}, async ({ env, calls }) => {
            const missing = await call(env, '/s');
            assert.equal(missing.status, 400);
            assert.match(await missing.text(), /缺少 token/);

            assert.equal((await call(env, '/s?token=notexist')).status, 404);
            assert.equal(calls.upstream, 0, 'KV 没命中时不该抓上游');
        });
    });

    it('命中 KV 时返回 YAML，并带上节点数', async () => {
        await withUpstream({}, async ({ env }) => {
            const token = tokenOf(await (await call(env, STORE_PATH)).text());

            const res = await call(env, `/s?token=${token}`);
            assert.equal(res.status, 200);
            assert.match(res.headers.get('content-type'), /yaml/);
            assert.equal(res.headers.get('cache-control'), 'no-store');
            assert.equal(res.headers.get('x-proxy-count'), '2');
            assert.equal(res.headers.get('x-skipped-count'), '0');

            const yaml = await res.text();
            assert.match(yaml, /proxy-groups:/);
            assert.match(yaml, /n1/);
        });
    });
});

describe('分支二 /?url=', () => {
    it('探测上游后写 KV，同上游复用同一 token', async () => {
        await withUpstream({}, async ({ kv, env, calls }) => {
            const first = await call(env, STORE_PATH);
            assert.equal(first.status, 200);
            const body = await first.text();
            const token = tokenOf(body);

            assert.ok(token, `应返回 /s?token=xxx，实际：${body}`);
            assert.match(body, /2 个节点/);
            assert.equal(kv.store.size, 2, 'u: 与 sub: 各一条');
            assert.equal(await kv.get(`sub:${token}`), UPSTREAM_URL);
            assert.equal(await kv.get(`u:${await upstreamHash(UPSTREAM_URL)}`), token);

            const again = await call(env, STORE_PATH);
            assert.match(await again.text(), new RegExp(token));
            assert.equal(kv.store.size, 2, '不该重复写入');
        });
    });

    it('反查索引悬空时重新分配 token', async () => {
        await withUpstream({}, async ({ kv, env }) => {
            const token = tokenOf(await (await call(env, STORE_PATH)).text());

            // 模拟两次 put 只成功一次：u: 还在，sub: 已经没了
            await kv.delete(`sub:${token}`);

            const next = tokenOf(await (await call(env, STORE_PATH)).text());
            assert.ok(next);
            assert.notEqual(next, token, '悬空索引不该被沿用');
            assert.equal((await call(env, `/s?token=${next}`)).status, 200);
        });
    });

    it('探测失败时不写 KV', async () => {
        await withUpstream({ status: 502, body: 'bad gateway' }, async ({ kv, env }) => {
            const res = await call(env, STORE_PATH);
            assert.equal(res.status, 502);
            assert.match(await res.text(), /上游返回 502/);
            assert.equal(kv.store.size, 0);
        });

        await withUpstream({ body: '不是订阅内容' }, async ({ kv, env }) => {
            const res = await call(env, STORE_PATH);
            assert.equal(res.status, 422);
            assert.match(await res.text(), /没有解析到节点/);
            assert.equal(kv.store.size, 0);
        });

        await withUpstream({ fail: true }, async ({ kv, env }) => {
            const res = await call(env, STORE_PATH);
            assert.equal(res.status, 502);
            assert.match(await res.text(), /拉取上游失败/);
            assert.equal(kv.store.size, 0);
        });
    });
});
