/*
 * 从 `pnpm clash:build` 抽取的最小转换实现
 *
 * 只做三件事：
 *   1. 解析订阅内容（base64 或明文）里的节点 URI
 *   2. 把节点转成 mihomo 的 proxies 结构
 *   3. 套上固定的策略组与规则，序列化成 YAML
 *
 * 与 backend/build-clash-config.js 的区别：不依赖 Sub-Store 后端、不读本地
 * geosite.dat、不跑内核校验、不做自动探测。策略组与规则是硬编码的常量。
 *
 * 从 utils.js 引入 URI 拆分与解码等基础工具
 *
 * 支持的协议：vless / trojan / ss / vmess
 */

import YAML from 'yaml';

import {
    decodeBase64,
    isTrue,
    parseUserHost,
    safeDecode,
    splitHostPort,
    splitUri,
    stripScheme,
} from './utils.js';

/* ================================================================== */
/* 传输层参数                                                          */
/* ================================================================== */

function applyTransport(proxy, network, params, defaultHost) {
    if (network === 'ws') {
        const wsOpts = { path: params.path || '/' };
        const host = params.host || params.hostname || defaultHost;
        if (host) wsOpts.headers = { Host: host };
        proxy['ws-opts'] = wsOpts;
        return;
    }
    if (network === 'grpc') {
        proxy['grpc-opts'] = {
            'grpc-service-name': params.serviceName || '',
        };
        return;
    }
    if (network === 'http' || network === 'h2') {
        proxy.network = 'h2';
        const h2Opts = { path: params.path || '/' };
        if (params.host) h2Opts.host = [params.host];
        proxy['h2-opts'] = h2Opts;
    }
}

/* ================================================================== */
/* 各协议解析                                                          */
/* ================================================================== */

function parseVless(uri) {
    const { body, params, name } = splitUri(uri);
    const [userInfo, hostPort] = parseUserHost(stripScheme(body, 'vless'));
    const [server, port] = splitHostPort(hostPort);

    const security = String(params.security || 'none').toLowerCase();
    const network = String(params.type || 'tcp').toLowerCase();
    const servername = params.sni || params.host || params.peer;

    const proxy = {
        name: name || `${server}:${port}`,
        type: 'vless',
        server,
        port,
        uuid: safeDecode(userInfo),
        udp: true,
        tls: ['tls', 'reality', 'xtls'].includes(security),
        network,
    };

    // Sub-Store 会把这两个默认值显式写出，这里保持一致
    proxy.encryption = params.encryption || 'none';
    proxy['packet-encoding'] = params.packetEncoding || 'xudp';
    if (params.flow) proxy.flow = params.flow;
    if (servername) proxy.servername = servername;
    if (params.fp) proxy['client-fingerprint'] = params.fp;
    if (isTrue(params.allowInsecure) || isTrue(params.insecure)) {
        proxy['skip-cert-verify'] = true;
    }
    if (params.alpn) {
        proxy.alpn = params.alpn.split(',').filter(Boolean);
    }
    if (security === 'reality') {
        if (!params.pbk) throw new Error('reality 缺少 pbk 参数');
        proxy['reality-opts'] = { 'public-key': params.pbk };
        if (params.sid) proxy['reality-opts']['short-id'] = params.sid;
    }

    applyTransport(proxy, network, params, servername);
    return proxy;
}

function parseTrojan(uri) {
    const { body, params, name } = splitUri(uri);
    const [userInfo, hostPort] = parseUserHost(stripScheme(body, 'trojan'));
    const [server, port] = splitHostPort(hostPort);

    const network = String(params.type || 'tcp').toLowerCase();
    const servername = params.sni || params.peer || params.host;

    const proxy = {
        name: name || `${server}:${port}`,
        type: 'trojan',
        server,
        port,
        password: safeDecode(userInfo),
        udp: true,
        network,
    };

    if (servername) proxy.sni = servername;
    if (params.fp) proxy['client-fingerprint'] = params.fp;
    if (isTrue(params.allowInsecure) || isTrue(params.insecure)) {
        proxy['skip-cert-verify'] = true;
    }
    if (params.alpn) {
        proxy.alpn = params.alpn.split(',').filter(Boolean);
    }

    applyTransport(proxy, network, params, servername);
    return proxy;
}

function decodeSSUserInfo(raw) {
    const text = safeDecode(raw);
    if (text.includes(':')) {
        const index = text.indexOf(':');
        return [text.slice(0, index), text.slice(index + 1)];
    }
    const decoded = decodeBase64(raw);
    const index = decoded.indexOf(':');
    if (index < 0) throw new Error('无法解析 ss 的加密方式');
    return [decoded.slice(0, index), decoded.slice(index + 1)];
}

function parseSS(uri) {
    const { body, params, name } = splitUri(uri);
    const rest = stripScheme(body, 'ss');

    let cipher;
    let password;
    let server;
    let port;

    const at = rest.lastIndexOf('@');
    if (at >= 0) {
        // SIP002：ss://base64(method:password)@host:port
        [cipher, password] = decodeSSUserInfo(rest.slice(0, at));
        [server, port] = splitHostPort(rest.slice(at + 1));
    } else {
        // 旧格式：ss://base64(method:password@host:port)
        const decoded = decodeBase64(rest);
        const decodedAt = decoded.lastIndexOf('@');
        if (decodedAt < 0) throw new Error('无法解析 ss 链接');
        [cipher, password] = decodeSSUserInfo(decoded.slice(0, decodedAt));
        [server, port] = splitHostPort(decoded.slice(decodedAt + 1));
    }

    if (params.plugin) {
        // 插件（obfs / v2ray-plugin）暂不支持，跳过而不是产出错误节点
        throw new Error(`ss 插件暂不支持: ${params.plugin}`);
    }

    return {
        name: name || `${server}:${port}`,
        type: 'ss',
        server,
        port,
        cipher,
        password,
        udp: true,
    };
}

function parseVmess(uri) {
    const raw = uri.slice('vmess://'.length);
    const hashIndex = raw.indexOf('#');
    const name = hashIndex < 0 ? '' : safeDecode(raw.slice(hashIndex + 1));
    const payload = hashIndex < 0 ? raw : raw.slice(0, hashIndex);

    let data;
    try {
        data = JSON.parse(decodeBase64(payload));
    } catch (error) {
        throw new Error('vmess 内容不是合法的 base64 JSON');
    }
    if (!data.add || !data.port || !data.id) {
        throw new Error('vmess 缺少 add / port / id');
    }

    const network = String(data.net || 'tcp').toLowerCase();
    const tls = String(data.tls || '').toLowerCase() === 'tls';
    const servername = data.sni || data.host;

    const proxy = {
        name: data.ps || name || `${data.add}:${data.port}`,
        type: 'vmess',
        server: data.add,
        port: Number(data.port),
        uuid: data.id,
        alterId: Number(data.aid || 0),
        cipher: data.scy || 'auto',
        udp: true,
        tls,
        network,
    };

    if (tls && servername) proxy.servername = servername;
    if (data.fp) proxy['client-fingerprint'] = data.fp;
    if (isTrue(data.allowInsecure) || data.verify_cert === false) {
        proxy['skip-cert-verify'] = true;
    }

    applyTransport(
        proxy,
        network,
        {
            path: data.path,
            host: data.host,
            // vmess 的 grpc serviceName 复用 path 字段
            serviceName: data.path,
        },
        servername,
    );
    return proxy;
}

const PARSERS = {
    vless: parseVless,
    trojan: parseTrojan,
    ss: parseSS,
    vmess: parseVmess,
};

/* ================================================================== */
/* 订阅解析                                                            */
/* ================================================================== */

/**
 * @returns {{ proxies: object[], skipped: string[] }}
 */
export function parseSubscription(input) {
    let text = String(input || '').trim();
    const proxies = [];
    const skipped = [];
    if (!text) return { proxies, skipped };

    // 整段 base64 的订阅：解码后应出现 ://
    if (!text.includes('://')) {
        try {
            const decoded = decodeBase64(text);
            if (decoded.includes('://')) text = decoded;
        } catch (error) {
            /* 不是 base64，按明文继续 */
        }
    }

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const schemeIndex = line.indexOf('://');
        if (schemeIndex < 0) {
            skipped.push(`无法识别: ${line.slice(0, 40)}`);
            continue;
        }
        const scheme = line.slice(0, schemeIndex).toLowerCase();
        const parser = PARSERS[scheme];
        if (!parser) {
            skipped.push(`暂不支持的协议 ${scheme}: ${line.slice(0, 40)}`);
            continue;
        }
        try {
            proxies.push(parser(line));
        } catch (error) {
            skipped.push(`${scheme} 解析失败 (${error.message})`);
        }
    }

    return { proxies, skipped };
}

/* ================================================================== */
/* 策略组与规则（与 backend/build-clash-config.js 保持一致）            */
/* ================================================================== */

const NODE_SELECT = '🚀 节点选择';
const AUTO = '♻️ 自动选择';
const FALLBACK = '🔯 故障转移';
const DIRECT = '🎯 全球直连';
const BLOCK = '🛑 广告拦截';
const FOREIGN = '🌍 国外媒体';
const DOMESTIC = '📺 国内媒体';
const TELEGRAM = '📲 电报消息';
const AI = '🤖 人工智能';
const MICROSOFT = 'Ⓜ️ 微软服务';
const APPLE = '🍎 苹果服务';
const GAME = '🎮 游戏平台';
const NETEASE = '🎵 网易云音乐';
const FINAL = '🐟 漏网之鱼';

const HEALTH_CHECK = {
    url: 'http://www.gstatic.com/generate_204',
    interval: 300,
};

function buildGroups(nodeNames) {
    return [
        {
            name: NODE_SELECT,
            type: 'select',
            proxies: [AUTO, FALLBACK, ...nodeNames, 'DIRECT'],
        },
        {
            name: AUTO,
            type: 'url-test',
            ...HEALTH_CHECK,
            tolerance: 50,
            proxies: nodeNames,
        },
        {
            name: FALLBACK,
            type: 'fallback',
            ...HEALTH_CHECK,
            proxies: nodeNames,
        },
        { name: DIRECT, type: 'select', proxies: ['DIRECT', NODE_SELECT] },
        { name: BLOCK, type: 'select', proxies: ['REJECT', 'DIRECT'] },
        { name: FOREIGN, type: 'select', proxies: [NODE_SELECT, AUTO, DIRECT] },
        { name: DOMESTIC, type: 'select', proxies: ['DIRECT', NODE_SELECT] },
        { name: TELEGRAM, type: 'select', proxies: [NODE_SELECT, AUTO, DIRECT] },
        {
            name: AI,
            type: 'select',
            proxies: [NODE_SELECT, AUTO, FOREIGN, DIRECT],
        },
        { name: MICROSOFT, type: 'select', proxies: [DIRECT, NODE_SELECT, AUTO] },
        { name: APPLE, type: 'select', proxies: ['DIRECT', NODE_SELECT, AUTO] },
        { name: GAME, type: 'select', proxies: ['DIRECT', NODE_SELECT, AUTO] },
        { name: NETEASE, type: 'select', proxies: ['DIRECT', NODE_SELECT] },
        { name: FINAL, type: 'select', proxies: [NODE_SELECT, DIRECT] },
    ];
}

function buildRules() {
    return [
        `GEOSITE,category-ads-all,${BLOCK}`,

        'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
        'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
        'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
        'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
        'IP-CIDR,100.64.0.0/10,DIRECT,no-resolve',
        'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
        'IP-CIDR6,fe80::/10,DIRECT,no-resolve',
        `GEOSITE,private,${DIRECT}`,

        `GEOSITE,netease,${NETEASE}`,
        `GEOSITE,bilibili,${DOMESTIC}`,
        'GEOIP,CN,DIRECT',
        `GEOSITE,cn,${DOMESTIC}`,

        `GEOSITE,telegram,${TELEGRAM}`,
        `GEOSITE,twitter,${NODE_SELECT}`,
        `GEOSITE,facebook,${NODE_SELECT}`,
        `GEOSITE,instagram,${NODE_SELECT}`,

        `GEOSITE,youtube,${FOREIGN}`,
        `GEOSITE,netflix,${FOREIGN}`,
        `GEOSITE,disney,${FOREIGN}`,
        `GEOSITE,spotify,${FOREIGN}`,
        `GEOSITE,geolocation-!cn,${FOREIGN}`,

        `GEOSITE,github,${NODE_SELECT}`,
        `GEOSITE,category-ai-chat-!cn,${AI}`,
        `GEOSITE,openai,${AI}`,

        `GEOSITE,onedrive,${MICROSOFT}`,
        `GEOSITE,microsoft,${MICROSOFT}`,
        `GEOSITE,apple,${APPLE}`,

        `GEOSITE,category-games-cn,${DIRECT}`,
        `GEOSITE,category-games-!cn,${GAME}`,
        `GEOSITE,steam,${GAME}`,

        `MATCH,${FINAL}`,
    ];
}

/* ================================================================== */
/* 拼装配置                                                            */
/* ================================================================== */

// 重名节点会让 mihomo 直接报错，这里补序号
function ensureUniqueNames(proxies) {
    const used = new Map();
    return proxies.map((proxy) => {
        const base = proxy.name || 'node';
        const count = used.get(base) || 0;
        used.set(base, count + 1);
        return count === 0 ? proxy : { ...proxy, name: `${base} ${count + 1}` };
    });
}

export function buildConfig(inputProxies) {
    const proxies = ensureUniqueNames(inputProxies);
    const nodeNames = proxies.map((proxy) => proxy.name);
    return {
        'mixed-port': 7897,
        'allow-lan': false,
        mode: 'rule',
        'log-level': 'info',
        ipv6: false,
        'unified-delay': true,
        'tcp-concurrent': true,
        'find-process-mode': 'strict',
        profile: { 'store-selected': true, 'store-fake-ip': true },
        dns: {
            enable: true,
            ipv6: false,
            'enhanced-mode': 'fake-ip',
            'fake-ip-range': '198.18.0.1/16',
            'use-hosts': true,
            nameserver: [
                'https://223.5.5.5/dns-query',
                'https://1.1.1.1/dns-query',
            ],
            fallback: ['https://8.8.8.8/dns-query'],
        },
        proxies,
        'proxy-groups': buildGroups(nodeNames),
        rules: buildRules(),
    };
}

export function toYaml(config) {
    return YAML.stringify(config, {
        lineWidth: 0,
        aliasDuplicateObjects: false,
    });
}
