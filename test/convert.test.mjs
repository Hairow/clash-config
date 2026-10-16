import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import YAML from 'yaml';

import {
    buildConfig,
    parseSubscription,
    toYaml,
} from '../src/convert.js';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

const VLESS =
    'vless://11051870-c9c5-4301-9377-70e6c426d8b3@1.2.3.4:443' +
    '?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=PUBKEY123' +
    '&security=reality&sid=d6473a1112&sni=www.amzn.com&type=tcp#测试节点';

const TROJAN =
    'trojan://pass%40word@1.2.3.4:443' +
    '?sni=example.com&type=ws&path=%2Fws&host=example.com#trojan-node';

const SS_SIP002 = `ss://${b64('aes-128-gcm:password')}@1.2.3.4:8388#ss-node`;

const SS_LEGACY = `ss://${b64('aes-128-gcm:password@1.2.3.4:8388')}#ss-legacy`;

const VMESS = `vmess://${b64(
    JSON.stringify({
        v: '2',
        ps: 'vmess-node',
        add: '1.2.3.4',
        port: '443',
        id: '11111111-2222-3333-4444-555555555555',
        aid: '0',
        scy: 'auto',
        net: 'ws',
        type: 'none',
        host: 'example.com',
        path: '/ws',
        tls: 'tls',
        sni: 'example.com',
    }),
)}`;

describe('parseSubscription', () => {
    it('解析 vless + reality 的全部关键字段', () => {
        const { proxies, skipped } = parseSubscription(VLESS);
        assert.equal(skipped.length, 0);
        assert.equal(proxies.length, 1);

        const proxy = proxies[0];
        assert.equal(proxy.name, '测试节点');
        assert.equal(proxy.type, 'vless');
        assert.equal(proxy.server, '1.2.3.4');
        assert.equal(proxy.port, 443);
        assert.equal(proxy.uuid, '11051870-c9c5-4301-9377-70e6c426d8b3');
        assert.equal(proxy.tls, true);
        assert.equal(proxy.network, 'tcp');
        assert.equal(proxy.udp, true);
        assert.equal(proxy.flow, 'xtls-rprx-vision');
        assert.equal(proxy.servername, 'www.amzn.com');
        assert.equal(proxy['client-fingerprint'], 'chrome');
        assert.deepEqual(proxy['reality-opts'], {
            'public-key': 'PUBKEY123',
            'short-id': 'd6473a1112',
        });
        // 与 Sub-Store 一致：这两个默认值显式写出
        assert.equal(proxy.encryption, 'none');
        assert.equal(proxy['packet-encoding'], 'xudp');
    });

    it('vless 的 packetEncoding / encryption 参数可以覆盖默认值', () => {
        const proxy = parseSubscription(
            'vless://uuid@1.2.3.4:443?security=tls&sni=a.com' +
                '&encryption=mlkem768x25519plus&packetEncoding=packet#n',
        ).proxies[0];
        assert.equal(proxy.encryption, 'mlkem768x25519plus');
        assert.equal(proxy['packet-encoding'], 'packet');
    });

    it('ss 支持 SIP002 与旧格式两种写法', () => {
        const sip002 = parseSubscription(SS_SIP002).proxies[0];
        assert.equal(sip002.type, 'ss');
        assert.equal(sip002.cipher, 'aes-128-gcm');
        assert.equal(sip002.password, 'password');
        assert.equal(sip002.port, 8388);

        const legacy = parseSubscription(SS_LEGACY).proxies[0];
        assert.equal(legacy.name, 'ss-legacy');
        assert.equal(legacy.cipher, 'aes-128-gcm');
        assert.equal(legacy.password, 'password');
        assert.equal(legacy.server, '1.2.3.4');
    });

    it('trojan 的密码会解码，ws 传输层带 Host 头', () => {
        const proxy = parseSubscription(TROJAN).proxies[0];
        assert.equal(proxy.type, 'trojan');
        assert.equal(proxy.password, 'pass@word');
        assert.equal(proxy.sni, 'example.com');
        assert.equal(proxy.network, 'ws');
        assert.deepEqual(proxy['ws-opts'], {
            path: '/ws',
            headers: { Host: 'example.com' },
        });
    });

    it('vmess 读取 base64 JSON 并映射字段', () => {
        const proxy = parseSubscription(VMESS).proxies[0];
        assert.equal(proxy.name, 'vmess-node');
        assert.equal(proxy.type, 'vmess');
        assert.equal(proxy.uuid, '11111111-2222-3333-4444-555555555555');
        assert.equal(proxy.alterId, 0);
        assert.equal(proxy.cipher, 'auto');
        assert.equal(proxy.tls, true);
        assert.equal(proxy.servername, 'example.com');
        assert.equal(proxy['ws-opts'].path, '/ws');
    });

    it('整段 base64 的订阅会被解码后再逐行解析', () => {
        const packed = b64([VLESS, SS_SIP002, TROJAN, VMESS].join('\n'));
        const { proxies, skipped } = parseSubscription(packed);
        assert.equal(skipped.length, 0);
        assert.deepEqual(
            proxies.map((proxy) => proxy.type),
            ['vless', 'ss', 'trojan', 'vmess'],
        );
    });

    it('无法识别的协议记入 skipped 而不是中断整批', () => {
        const { proxies, skipped } = parseSubscription(
            ['hysteria2://x@1.2.3.4:443#h2', VLESS].join('\n'),
        );
        assert.equal(proxies.length, 1);
        assert.equal(skipped.length, 1);
        assert.match(skipped[0], /暂不支持的协议 hysteria2/);
    });

    it('reality 缺少 pbk 时报错并计入 skipped', () => {
        const broken =
            'vless://uuid@1.2.3.4:443?security=reality&sni=a.com#broken';
        const { proxies, skipped } = parseSubscription(broken);
        assert.equal(proxies.length, 0);
        assert.match(skipped[0], /reality 缺少 pbk/);
    });

    it('空订阅不抛错', () => {
        assert.deepEqual(parseSubscription(''), { proxies: [], skipped: [] });
        assert.deepEqual(parseSubscription(null), { proxies: [], skipped: [] });
    });
});

describe('buildConfig', () => {
    const proxies = parseSubscription(
        [VLESS, SS_SIP002, TROJAN, VMESS].join('\n'),
    ).proxies;

    it('产出 14 个策略组与 32 条规则', () => {
        const config = buildConfig(proxies);
        assert.equal(config['proxy-groups'].length, 14);
        assert.equal(config.rules.length, 32);
        assert.equal(config.mode, 'rule');
        assert.equal(config['mixed-port'], 7897);
    });

    it('url-test / fallback 的测速参数在策略组顶层，而不是嵌套对象', () => {
        const config = buildConfig(proxies);
        for (const group of config['proxy-groups']) {
            if (group.type === 'url-test' || group.type === 'fallback') {
                assert.equal(group.url, 'http://www.gstatic.com/generate_204');
                assert.equal(group.interval, 300);
                assert.equal(group.extra, undefined);
            }
        }
    });

    it('所有规则的目标都是已定义的策略组', () => {
        const config = buildConfig(proxies);
        const names = new Set(config['proxy-groups'].map((group) => group.name));
        for (const rule of config.rules) {
            const parts = rule.split(',');
            let index = parts.length - 1;
            while (['no-resolve', 'src'].includes(parts[index].trim())) index--;
            const target = parts[index].trim();
            assert.ok(
                names.has(target) || ['DIRECT', 'REJECT'].includes(target),
                `规则目标不存在: ${rule}`,
            );
        }
    });

    it('节点重名会自动补序号', () => {
        const duplicated = [{ name: 'dup', type: 'ss' }, { name: 'dup', type: 'ss' }];
        const config = buildConfig(duplicated);
        assert.deepEqual(
            config.proxies.map((proxy) => proxy.name),
            ['dup', 'dup 2'],
        );
        // ♻️ 自动选择、🔯 故障转移、dup、dup 2、DIRECT
        assert.equal(new Set(config['proxy-groups'][0].proxies).size, 5);
    });

    it('序列化后的 YAML 能被重新解析，且不产生锚点', () => {
        const yaml = toYaml(buildConfig(proxies));
        assert.doesNotMatch(yaml, /&[a-z]+\d*\s*$/m);
        assert.doesNotMatch(yaml, /\*[a-z]+\d*\s*$/m);

        const parsed = YAML.parse(yaml);
        assert.equal(parsed.proxies.length, 4);
        assert.equal(parsed['proxy-groups'].length, 14);
        assert.equal(parsed.rules.length, 32);
        assert.equal(parsed.proxies[0].name, '测试节点');
    });
});
