/*
 * 基础工具：不读 env、不碰 KV 的通用小函数
 *
 * 两组：
 *   1. URI 拆分与解码 —— convert.js 解析节点 URI 时用
 *   2. 短 token 与 HTTP 响应 —— index.js 用
 *
 * 只依赖全局的 atob / TextDecoder / crypto / Response，Node 与 Workers 下都能跑。
 *
 * 注意 parseQuery 是手写的，没有用 URLSearchParams：后者按表单语义会把 `+`
 * 解码成空格，而 URI 查询串里的 `+` 通常是字面量（Reality 的 pbk 等）。
 */

export function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch (error) {
        return value;
    }
}

export function decodeBase64(input) {
    let base64 = String(input)
        .trim()
        .replace(/\s+/g, '')
        .replace(/-/g, '+')
        .replace(/_/g, '/');
    base64 += '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

export function isTrue(value) {
    return value === true || value === '1' || value === 'true';
}

// 手工解析查询串：不用 URLSearchParams，避免它把 pbk 这类 base64 值里的 `+` 当成空格
export function parseQuery(query) {
    const params = {};
    if (!query) return params;
    for (const pair of String(query).split('&')) {
        if (!pair) continue;
        const index = pair.indexOf('=');
        const key = index < 0 ? pair : pair.slice(0, index);
        const value = index < 0 ? '' : pair.slice(index + 1);
        params[safeDecode(key)] = safeDecode(value);
    }
    return params;
}

// 拆出主体、查询参数与 # 后的节点名
export function splitUri(uri) {
    const hashIndex = uri.indexOf('#');
    const name = hashIndex < 0 ? '' : safeDecode(uri.slice(hashIndex + 1));
    const noFragment = hashIndex < 0 ? uri : uri.slice(0, hashIndex);
    const queryIndex = noFragment.indexOf('?');
    return {
        body:
            queryIndex < 0 ? noFragment : noFragment.slice(0, queryIndex),
        params: parseQuery(
            queryIndex < 0 ? '' : noFragment.slice(queryIndex + 1),
        ),
        name,
    };
}

export function stripScheme(body, scheme) {
    return body.slice(`${scheme}://`.length);
}

// 取最后一个 @ 作为分隔符，密码里的 @ 应已被百分号编码
export function parseUserHost(body) {
    const at = body.lastIndexOf('@');
    if (at < 0) throw new Error('缺少 @ 分隔符');
    return [body.slice(0, at), body.slice(at + 1)];
}

// 兼容 IPv6 字面量 [::1]:443。端口必须是 1-65535 的整数，否则抛错让调用方把整条
// 节点计入 skipped —— NaN / 0 这类值写进配置要等客户端导入时才报错，很难查
export function splitHostPort(value) {
    const hostPort = String(value).trim();
    let host;
    let portText;
    if (hostPort.startsWith('[')) {
        const end = hostPort.indexOf(']');
        if (end < 0) throw new Error('IPv6 地址缺少 ]');
        host = hostPort.slice(1, end);
        portText = hostPort.slice(end + 2);
    } else {
        const index = hostPort.lastIndexOf(':');
        if (index < 0) throw new Error('缺少端口');
        host = hostPort.slice(0, index);
        portText = hostPort.slice(index + 1);
    }

    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`端口无效: ${hostPort}`);
    }
    return [host, port];
}

// 短 token 用 base64url，12 个字符，碰撞概率可以忽略
export function makeToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(9));
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

// 同一个上游地址要复用同一个 token，否则客户端每次刷新都会写一条新记录
export async function upstreamHash(target) {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(target),
    );
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 16);
}

// 纯文本响应：错误提示、短地址、用法说明都走这里
export function text(body, status, headers) {
    return new Response(body, {
        status: status || 200,
        headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            ...headers,
        },
    });
}
