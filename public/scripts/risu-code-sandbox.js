const RUN_TIMEOUT_MS = 60_000;
const MAX_LOG_LENGTH = 4000;

const PARAMETER_NAMES = [
    'api',
    'scylla',
    'risu',
    'getChatVar',
    'setChatVar',
    'getGlobalVar',
    'stopChat',
    'getChatMain',
    'getFullChatMain',
    'setFullChatMain',
    'getChatLength',
    'setChat',
    'setChatRole',
    'insertChat',
    'removeChat',
    'cutChat',
    'addChat',
    'logMain',
    'cbs',
    'hash',
    'getTokens',
    'sleep',
    'LLMMain',
    'simpleLLM',
    'generateImage',
    'similarity',
    'request',
    'getCharacterLastMessage',
    'getUserLastMessage',
    'getName',
    'setName',
    'getDescription',
    'setDescription',
    'getCharacterFirstMessage',
    'setCharacterFirstMessage',
    'getPersonaName',
    'getPersonaDescription',
    'getAuthorsNote',
    'getBackgroundEmbedding',
    'setBackgroundEmbedding',
    'alertNormal',
    'alertError',
    'alertInput',
    'alertSelect',
    'alertConfirm',
    'reloadDisplay',
    'reloadChat',
    'getLoreBooksMain',
    'loadLoreBooksMain',
    'upsertLocalLoreBook',
    'getCharacterImageMain',
    'getPersonaImageMain',
];

const BLOCKED_GLOBALS = [
    'window',
    'document',
    'globalThis',
    'self',
    'postMessage',
    'importScripts',
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'Worker',
    'SharedWorker',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'navigator',
    'location',
    'caches',
    'BroadcastChannel',
    'MessageChannel',
    'MessagePort',
    'URL',
    'Blob',
    'File',
    'FileReader',
    'eval',
    'Function',
];

function toText(value) {
    return value === undefined || value === null ? '' : String(value);
}

function parseJson(value, fallback = null) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function unescapeStringLiteral(value) {
    try {
        return JSON.parse(`"${String(value).replace(/"/g, '\\"')}"`);
    } catch {
        return String(value);
    }
}

function extractVariableKeys(code) {
    const keys = new Set();
    const oneArgPattern = /\bgetVar\s*\(\s*(['"])((?:\\.|(?!\1)[\s\S])*?)\1/g;
    const idKeyPattern = /\b(?:getChatVar|getGlobalVar|getState)\s*\(\s*[^,]+,\s*(['"])((?:\\.|(?!\1)[\s\S])*?)\1/g;
    let match;

    while ((match = oneArgPattern.exec(code))) {
        keys.add(unescapeStringLiteral(match[2]));
    }
    while ((match = idKeyPattern.exec(code))) {
        const key = unescapeStringLiteral(match[2]);
        keys.add(key);
        if (match[0].includes('getState')) {
            keys.add(`__${key}`);
        }
    }

    return keys;
}

function extractLiteralCbsValues(code) {
    const values = new Set();
    const pattern = /\bcbs\s*\(\s*(['"])((?:\\.|(?!\1)[\s\S])*?)\1\s*\)/g;
    let match;
    while ((match = pattern.exec(code))) {
        values.add(unescapeStringLiteral(match[2]));
    }
    return values;
}

async function buildRunContext(code, api, trigger) {
    const vars = {};
    for (const key of extractVariableKeys(code)) {
        vars[key] = api.getVar?.(key);
    }

    const cbsCache = {};
    for (const value of extractLiteralCbsValues(code)) {
        cbsCache[value] = toText(await api.cbs?.(value));
    }

    const chat = Array.isArray(api.getFullChat?.()) ? api.getFullChat() : [];
    return {
        trigger: toText(trigger || api.trigger || ''),
        vars,
        globals: {},
        chat,
        char: {
            name: toText(await api.getName?.()),
            description: toText(await api.getDescription?.()),
            first_mes: toText(await api.getCharacterFirstMessage?.()),
        },
        persona: {
            name: toText(await api.getPersonaName?.()),
            description: toText(await api.getPersonaDescription?.()),
        },
        authorsNote: toText(await api.getAuthorsNote?.()),
        backgroundEmbedding: toText(await api.getBackgroundEmbedding?.()),
        loreBooks: Array.isArray(await api.getLoreBooks?.('')) ? await api.getLoreBooks('') : [],
        cbsCache,
    };
}

function buildWorkerSource() {
    return `
'use strict';

const PARAMETER_NAMES = ${JSON.stringify(PARAMETER_NAMES)};
const BLOCKED_GLOBALS = ${JSON.stringify(BLOCKED_GLOBALS)};
const MAX_LOG_LENGTH = ${MAX_LOG_LENGTH};
let ctx = {};
let hostSeq = 0;
const pendingHost = new Map();
const activeHost = new Set();

function toText(value) {
    return value === undefined || value === null ? '' : String(value);
}

function parseJson(value, fallback = null) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function normalizeRole(role) {
    return role === 'user' ? 'user' : 'char';
}

function normalizeIndex(index, length) {
    const value = Number(index);
    if (!Number.isInteger(value)) {
        return -1;
    }
    return value < 0 ? length + value : value;
}

function normalizeMessage(message) {
    return {
        role: normalizeRole(message && message.role),
        data: toText(message && (message.data ?? message.content ?? message.message)),
        time: Number((message && message.time) ?? 0) || 0,
    };
}

function clone(value) {
    try {
        return structuredClone(value);
    } catch {
        return parseJson(JSON.stringify(value), value);
    }
}

function callHost(name, args) {
    const callId = ++hostSeq;
    let resolve;
    const promise = new Promise(res => {
        resolve = res;
    });
    pendingHost.set(callId, resolve);
    activeHost.add(promise);
    promise.finally(() => activeHost.delete(promise));
    postMessage({ __risuHostCall: true, callId, name, args });
    return promise;
}

async function waitForHostCalls() {
    while (activeHost.size > 0) {
        await Promise.allSettled(Array.from(activeHost));
    }
}

function getChat() {
    return Array.isArray(ctx.chat) ? ctx.chat.map(clone) : [];
}

function getLastMessageByRole(role) {
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    for (let index = chat.length - 1; index >= 0; index--) {
        if (chat[index]?.role === role) {
            return chat[index].data ?? '';
        }
    }
    return '';
}

function filterLoreBooks(search = '') {
    const needle = toText(search).toLowerCase();
    return (Array.isArray(ctx.loreBooks) ? ctx.loreBooks : []).filter(entry => {
        if (!needle) {
            return true;
        }
        return [entry?.comment, entry?.content, ...(Array.isArray(entry?.key) ? entry.key : [])]
            .map(toText)
            .join('\\n')
            .toLowerCase()
            .includes(needle);
    }).map(clone);
}

function makeApi() {
    const api = {
        id: toText(ctx.trigger || 'trigger'),
        trigger: toText(ctx.trigger || ''),
        getVar: (key) => {
            const normalizedKey = toText(key);
            return Object.prototype.hasOwnProperty.call(ctx.vars || {}, normalizedKey) ? ctx.vars[normalizedKey] : '';
        },
        setVar: (key, value) => {
            const normalizedKey = toText(key);
            const normalizedValue = toText(value);
            ctx.vars[normalizedKey] = normalizedValue;
            return callHost('setChatVar', [normalizedKey, normalizedValue]);
        },
        getChat,
        getFullChat: getChat,
        getLastMessage: () => getChat().at(-1) ?? null,
        addChat: (role, value) => {
            const message = normalizeMessage({ role, data: value });
            ctx.chat.push(message);
            return callHost('addChat', [message.role, message.data]);
        },
        insertChat: (index, role, value) => {
            const target = Math.max(0, Math.min(ctx.chat.length, Number(index) || 0));
            const message = normalizeMessage({ role, data: value });
            ctx.chat.splice(target, 0, message);
            return callHost('insertChat', [target, message.role, message.data]);
        },
        setChat: (index, value) => {
            const target = normalizeIndex(index, ctx.chat.length);
            if (ctx.chat[target]) {
                ctx.chat[target].data = toText(value);
            }
            return callHost('setChat', [target, toText(value)]);
        },
        setChatRole: (index, role) => {
            const target = normalizeIndex(index, ctx.chat.length);
            if (ctx.chat[target]) {
                ctx.chat[target].role = normalizeRole(role);
            }
            return callHost('setChatRole', [target, normalizeRole(role)]);
        },
        removeChat: (index) => {
            const target = normalizeIndex(index, ctx.chat.length);
            if (target >= 0) {
                ctx.chat.splice(target, 1);
            }
            return callHost('removeChat', [target]);
        },
        setFullChat: (value) => {
            const parsed = typeof value === 'string' ? parseJson(value, []) : value;
            if (Array.isArray(parsed)) {
                ctx.chat = parsed.map(normalizeMessage);
                return callHost('setFullChat', [ctx.chat]);
            }
            return null;
        },
        cutChat: (start, end) => {
            const normalizedStart = Number(start) || 0;
            const endNumber = Number(end);
            const normalizedEnd = Number.isFinite(endNumber) ? endNumber : undefined;
            ctx.chat = ctx.chat.slice(normalizedStart, normalizedEnd);
            return callHost('cutChat', [normalizedStart, normalizedEnd]);
        },
        stop: () => {
            ctx.stopSending = true;
        },
        log: (message) => callHost('log', [toText(message).slice(0, MAX_LOG_LENGTH)]),
        cbs: (value) => {
            const text = toText(value);
            if (Object.prototype.hasOwnProperty.call(ctx.cbsCache || {}, text)) {
                return ctx.cbsCache[text] ?? '';
            }
            return callHost('cbs', [text]);
        },
        getTokens: (value) => Math.ceil(toText(value).length / 4),
        hash: (value) => {
            let hash = 0;
            const text = toText(value);
            for (let index = 0; index < text.length; index++) {
                hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
            }
            return String(Math.abs(hash));
        },
        sleep: (milliseconds) => new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(Number(milliseconds) || 0, 60000)))),
        LLM: (prompt, options = {}) => callHost('LLM', [prompt, options || {}]),
        request: (url) => callHost('request', [toText(url)]),
        generateImage: (prompt, negativePrompt = '') => callHost('generateImage', [toText(prompt), toText(negativePrompt)]),
        similarity: (source, values) => callHost('similarity', [toText(source), values]),
        getCharacterLastMessage: () => getLastMessageByRole('char'),
        getUserLastMessage: () => getLastMessageByRole('user'),
        getName: () => toText(ctx.char?.name),
        setName: (value) => {
            ctx.char = { ...(ctx.char || {}), name: toText(value) };
            return callHost('setName', [toText(value)]);
        },
        getDescription: () => toText(ctx.char?.description),
        setDescription: (value) => {
            ctx.char = { ...(ctx.char || {}), description: toText(value) };
            return callHost('setDescription', [toText(value)]);
        },
        getCharacterFirstMessage: () => toText(ctx.char?.first_mes),
        setCharacterFirstMessage: (value) => {
            ctx.char = { ...(ctx.char || {}), first_mes: toText(value) };
            return callHost('setCharacterFirstMessage', [toText(value)]);
        },
        getPersonaName: () => toText(ctx.persona?.name),
        getPersonaDescription: () => toText(ctx.persona?.description),
        getAuthorsNote: () => toText(ctx.authorsNote),
        getBackgroundEmbedding: () => toText(ctx.backgroundEmbedding),
        setBackgroundEmbedding: (value) => {
            ctx.backgroundEmbedding = toText(value);
            return callHost('setBackgroundEmbedding', [toText(value)]);
        },
        alert: (kind, value) => callHost('alert', [kind, value]),
        reloadDisplay: () => callHost('reloadDisplay', []),
        reloadChat: (index) => callHost('reloadChat', [index]),
        getLoreBooks: filterLoreBooks,
        loadLoreBooks: () => callHost('loadLoreBooks', []),
        upsertLocalLoreBook: (name, content, options = {}) => {
            ctx.loreBooks = Array.isArray(ctx.loreBooks) ? ctx.loreBooks : [];
            ctx.loreBooks.push({ key: [toText(name)], content: toText(content), comment: toText(name) });
            return callHost('upsertLocalLoreBook', [toText(name), toText(content), options || {}]);
        },
        getCharacterImage: () => '',
        getPersonaImage: () => '',
    };

    Object.assign(api, {
        scylla: api,
        risu: api,
        getChatVar: (_id, key) => api.getVar(key),
        setChatVar: (_id, key, value) => api.setVar(key, value),
        getGlobalVar: (_id, key) => api.getVar(key),
        stopChat: () => api.stop(),
        getChatMain: (_id, index) => JSON.stringify(ctx.chat[normalizeIndex(index, ctx.chat.length)] ?? null),
        getFullChatMain: () => JSON.stringify(ctx.chat),
        setFullChatMain: (_id, value) => api.setFullChat(value),
        getChatLength: () => ctx.chat.length,
        logMain: (value) => api.log(parseJson(value, value)),
        hashMain: (_id, value) => api.hash(value),
        getTokensMain: (_id, value) => api.getTokens(value),
        sleepMain: (_id, value) => api.sleep(value),
        LLMMain: async (_id, prompt, _useMultimodal = false, options = '') => {
            const response = await api.LLM(parseJson(prompt, prompt), parseJson(options, {}));
            return JSON.stringify({ success: response !== null && response !== undefined, result: toText(response) });
        },
        simpleLLM: (_id, prompt) => api.LLM(toText(prompt)),
        alertNormal: (_id, value) => api.alert('normal', toText(value)),
        alertError: (_id, value) => api.alert('error', toText(value)),
        alertInput: (_id, value) => api.alert('input', toText(value)),
        alertSelect: (_id, value) => api.alert('select', value),
        alertConfirm: (_id, value) => api.alert('confirm', toText(value)),
        getLoreBooksMain: (_id, search) => JSON.stringify(api.getLoreBooks(search)),
        loadLoreBooksMain: async () => JSON.stringify(await api.loadLoreBooks()),
        getCharacterImageMain: () => api.getCharacterImage(),
        getPersonaImageMain: () => api.getPersonaImage(),
    });

    return api;
}

async function runCode(code) {
    ctx.chat = Array.isArray(ctx.chat) ? ctx.chat.map(normalizeMessage) : [];
    ctx.vars = ctx.vars && typeof ctx.vars === 'object' ? ctx.vars : {};
    ctx.stopSending = false;
    const api = makeApi();
    const legacy = {
        setChat: (_id, index, value) => api.setChat(index, value),
        setChatRole: (_id, index, role) => api.setChatRole(index, role),
        insertChat: (_id, index, role, value) => api.insertChat(index, role, value),
        removeChat: (_id, index) => api.removeChat(index),
        cutChat: (_id, start, end) => api.cutChat(start, end),
        addChat: (_id, role, value) => api.addChat(role, value),
        hash: (_id, value) => api.hash(value),
        getTokens: (_id, value) => api.getTokens(value),
        sleep: (_id, value) => api.sleep(value),
        generateImage: (_id, prompt, negativePrompt = '') => api.generateImage(prompt, negativePrompt),
        similarity: (_id, source, values) => api.similarity(source, values),
        request: (_id, url) => api.request(url),
        getCharacterLastMessage: () => api.getCharacterLastMessage(),
        getUserLastMessage: () => api.getUserLastMessage(),
        getName: () => api.getName(),
        setName: (_id, value) => api.setName(value),
        getDescription: () => api.getDescription(),
        setDescription: (_id, value) => api.setDescription(value),
        getCharacterFirstMessage: () => api.getCharacterFirstMessage(),
        setCharacterFirstMessage: (_id, value) => api.setCharacterFirstMessage(value),
        getPersonaName: () => api.getPersonaName(),
        getPersonaDescription: () => api.getPersonaDescription(),
        getAuthorsNote: () => api.getAuthorsNote(),
        getBackgroundEmbedding: () => api.getBackgroundEmbedding(),
        setBackgroundEmbedding: (_id, value) => api.setBackgroundEmbedding(value),
    };
    const runner = new Function(
        ...PARAMETER_NAMES,
        ...BLOCKED_GLOBALS,
        '"use strict"; return (async () => {\\n' + code + '\\n})()',
    );
    await runner(
        api,
        api.scylla,
        api.risu,
        api.getChatVar,
        api.setChatVar,
        api.getGlobalVar,
        api.stopChat,
        api.getChatMain,
        api.getFullChatMain,
        api.setFullChatMain,
        api.getChatLength,
        legacy.setChat,
        legacy.setChatRole,
        legacy.insertChat,
        legacy.removeChat,
        legacy.cutChat,
        legacy.addChat,
        api.logMain,
        api.cbs,
        legacy.hash,
        legacy.getTokens,
        legacy.sleep,
        api.LLMMain,
        api.simpleLLM,
        legacy.generateImage,
        legacy.similarity,
        legacy.request,
        legacy.getCharacterLastMessage,
        legacy.getUserLastMessage,
        legacy.getName,
        legacy.setName,
        legacy.getDescription,
        legacy.setDescription,
        legacy.getCharacterFirstMessage,
        legacy.setCharacterFirstMessage,
        legacy.getPersonaName,
        legacy.getPersonaDescription,
        legacy.getAuthorsNote,
        legacy.getBackgroundEmbedding,
        legacy.setBackgroundEmbedding,
        api.alertNormal,
        api.alertError,
        api.alertInput,
        api.alertSelect,
        api.alertConfirm,
        api.reloadDisplay,
        api.reloadChat,
        api.getLoreBooksMain,
        api.loadLoreBooksMain,
        api.upsertLocalLoreBook,
        api.getCharacterImageMain,
        api.getPersonaImageMain,
        ...BLOCKED_GLOBALS.map(() => undefined),
    );
    await waitForHostCalls();
}

onmessage = async (event) => {
    const data = event.data || {};
    if (data.__risuHostReply) {
        const resolve = pendingHost.get(data.callId);
        if (resolve) {
            pendingHost.delete(data.callId);
            resolve(data.result);
        }
        return;
    }

    if (!data.__runRisuCode) {
        return;
    }

    ctx = data.ctx || {};
    try {
        await runCode(String(data.code || ''));
        postMessage({ __risuDone: true, stopSending: !!ctx.stopSending });
    } catch (error) {
        postMessage({ __risuDone: true, error: String((error && error.message) || error), stopSending: !!ctx.stopSending });
    }
};
`;
}

function buildFrameSrcdoc() {
    const workerSource = buildWorkerSource();
    const script = `
const workerSource = ${JSON.stringify(workerSource)};
const blob = new Blob([workerSource], { type: 'text/javascript' });
const worker = new Worker(URL.createObjectURL(blob));
let watchdog = null;

worker.onmessage = (event) => {
    const data = event.data || {};
    if (data.__risuHostCall) {
        parent.postMessage({ __risuSandboxHostCall: true, callId: data.callId, name: data.name, args: data.args }, '*');
        return;
    }
    if (data.__risuDone) {
        if (watchdog) {
            clearTimeout(watchdog);
            watchdog = null;
        }
        parent.postMessage({ __risuSandboxDone: true, error: data.error || null, stopSending: !!data.stopSending }, '*');
    }
};

window.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.__runRisuCode) {
        if (watchdog) {
            clearTimeout(watchdog);
        }
        watchdog = setTimeout(() => {
            worker.terminate();
            parent.postMessage({ __risuSandboxDone: true, error: 'timeout' }, '*');
        }, ${RUN_TIMEOUT_MS});
        worker.postMessage(data);
        return;
    }
    if (data.__risuHostReply) {
        worker.postMessage(data);
    }
});

parent.postMessage({ __risuSandboxReady: true }, '*');
`;

    return '<!doctype html><meta charset="utf-8">'
        + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data:; worker-src blob: data:; connect-src data:">`
        + `<script>${script.replace(/<\/script/gi, '<\\/script')}<\/script>`;
}

async function dispatchHostCall(api, name, args) {
    const hostApi = api.scylla || api;
    switch (name) {
        case 'setChatVar': return await hostApi.setVar(args[0], args[1]);
        case 'setFullChat': return await hostApi.setFullChat(args[0]);
        case 'setChat': return await hostApi.setChat(args[0], args[1]);
        case 'setChatRole': return await hostApi.setChatRole(args[0], args[1]);
        case 'insertChat': return await hostApi.insertChat(args[0], args[1], args[2]);
        case 'removeChat': return await hostApi.removeChat(args[0]);
        case 'cutChat': return await hostApi.cutChat(args[0], args[1]);
        case 'addChat': return await hostApi.addChat(args[0], args[1]);
        case 'log': return await hostApi.log(parseJson(args[0], args[0]));
        case 'cbs': return await hostApi.cbs(args[0]);
        case 'alert': return await hostApi.alert(args[0], args[1]);
        case 'reloadDisplay': return await hostApi.reloadDisplay();
        case 'reloadChat': return await hostApi.reloadChat(args[0]);
        case 'getTokens': return await hostApi.getTokens(args[0]);
        case 'hash': return hostApi.hash(args[0]);
        case 'similarity': return await hostApi.similarity(args[0], args[1]);
        case 'setName': return await hostApi.setName(args[0]);
        case 'setDescription': return await hostApi.setDescription(args[0]);
        case 'setCharacterFirstMessage': return await hostApi.setCharacterFirstMessage(args[0]);
        case 'setBackgroundEmbedding': return await hostApi.setBackgroundEmbedding(args[0]);
        case 'loadLoreBooks': return await hostApi.loadLoreBooks();
        case 'upsertLocalLoreBook': return await hostApi.upsertLocalLoreBook(args[0], args[1], args[2]);
        case 'LLM': return await hostApi.LLM(args[0], args[1] || {});
        case 'generateImage': return await hostApi.generateImage(args[0], args[1]);
        case 'request': return await hostApi.request(args[0]);
        case 'getCharacterImage': return await hostApi.getCharacterImage();
        case 'getPersonaImage': return await hostApi.getPersonaImage();
        default: return null;
    }
}

function cloneForMessage(value) {
    if (value === undefined) {
        return null;
    }

    try {
        structuredClone(value);
        return value;
    } catch {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return toText(value);
        }
    }
}

export async function runSandboxedRisuTriggerCode({ code, api, trigger }) {
    if (typeof document === 'undefined' || typeof Worker === 'undefined' || typeof Blob === 'undefined') {
        return { skipped: true, error: 'browser-sandbox-unavailable' };
    }

    const ctx = await buildRunContext(code, api, trigger);

    return await new Promise(resolve => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.style.display = 'none';

        let completed = false;
        let postedRun = false;
        const parentTimer = setTimeout(() => finish({ error: 'timeout' }), RUN_TIMEOUT_MS + 1000);
        const cleanup = () => {
            completed = true;
            clearTimeout(parentTimer);
            window.removeEventListener('message', onMessage);
            frame.remove();
        };
        const finish = (outcome) => {
            if (completed) {
                return;
            }
            cleanup();
            resolve(outcome);
        };
        const postRun = () => {
            if (postedRun || !frame.contentWindow) {
                return;
            }
            postedRun = true;
            frame.contentWindow.postMessage({ __runRisuCode: true, code, ctx }, '*');
        };
        const onMessage = async (event) => {
            if (event.source !== frame.contentWindow) {
                return;
            }

            const data = event.data || {};
            if (data.__risuSandboxReady) {
                postRun();
                return;
            }

            if (data.__risuSandboxHostCall) {
                let result = null;
                try {
                    result = await dispatchHostCall(api, data.name, data.args || []);
                } catch (error) {
                    console.warn('[RisuAI trigger] Sandboxed host call failed.', data.name, error);
                }
                frame.contentWindow?.postMessage({
                    __risuHostReply: true,
                    callId: data.callId,
                    result: cloneForMessage(result),
                }, '*');
                return;
            }

            if (data.__risuSandboxDone) {
                finish({ error: data.error || null, stopSending: !!data.stopSending });
            }
        };

        window.addEventListener('message', onMessage);
        frame.addEventListener('load', () => setTimeout(postRun, 0), { once: true });
        frame.srcdoc = buildFrameSrcdoc();
        document.body.append(frame);
    });
}
