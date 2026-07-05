const RUN_TIMEOUT_MS = 120_000;
const WASMOON_SCRIPT_URLS = [
    '/lib/risu/wasmoon.js',
    'https://cdn.jsdelivr.net/npm/wasmoon@1.16.0/dist/index.js',
];
const WASMOON_WASM_URLS = [
    '/lib/risu/glue.wasm',
    'https://cdn.jsdelivr.net/npm/wasmoon@1.16.0/dist/glue.wasm',
];

const RISU_LUA_PRELUDE = `
local json = { encode = function(v) return __jsonEncode(v) end, decode = function(v) return __jsonDecode(v) end }

function getChat(id, index)
    return json.decode(getChatMain(id, index))
end

function getFullChat(id)
    return json.decode(getFullChatMain(id))
end

function setFullChat(id, value)
    setFullChatMain(id, json.encode(value))
end

function log(value)
    logMain(json.encode(value))
end

function getLoreBooks(id, search)
    return json.decode(getLoreBooksMain(id, search))
end

function loadLoreBooks(id)
    return json.decode(loadLoreBooksMain(id):await())
end

function LLM(id, prompt, useMultimodal, options)
    useMultimodal = useMultimodal or false
    options = options or {}
    return json.decode(LLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
end

function axLLM(id, prompt, useMultimodal, options)
    useMultimodal = useMultimodal or false
    options = options or {}
    return json.decode(axLLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
end

function getCharacterImage(id)
    return getCharacterImageMain(id):await()
end

function getPersonaImage(id)
    return getPersonaImageMain(id):await()
end

local editRequestFuncs = {}
local editDisplayFuncs = {}
local editInputFuncs = {}
local editOutputFuncs = {}

function listenEdit(type, func)
    if type == 'editRequest' then
        editRequestFuncs[#editRequestFuncs + 1] = func
        return
    end
    if type == 'editDisplay' then
        editDisplayFuncs[#editDisplayFuncs + 1] = func
        return
    end
    if type == 'editInput' then
        editInputFuncs[#editInputFuncs + 1] = func
        return
    end
    if type == 'editOutput' then
        editOutputFuncs[#editOutputFuncs + 1] = func
        return
    end
    error('Invalid type')
end

function getState(id, name)
    return json.decode(getChatVar(id, "__"..name))
end

function setState(id, name, value)
    setChatVar(id, "__"..name, json.encode(value))
end

function async(callback)
    return function(...)
        local co = coroutine.create(callback)
        local safe, result = coroutine.resume(co, ...)

        return Promise.create(function(resolve, reject)
            local checkresult
            local step = function()
                if coroutine.status(co) == "dead" then
                    local send = safe and resolve or reject
                    return send(result)
                end

                safe, result = coroutine.resume(co)
                checkresult()
            end

            checkresult = function()
                if safe and result == Promise.resolve(result) then
                    result:finally(step)
                else
                    step()
                end
            end

            checkresult()
        end)
    end
end

callListenMain = async(function(type, id, value, meta)
    local realValue = json.decode(value)
    local realMeta = json.decode(meta)

    if type == 'editRequest' then
        for _, func in ipairs(editRequestFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editDisplay' then
        for _, func in ipairs(editDisplayFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editInput' then
        for _, func in ipairs(editInputFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editOutput' then
        for _, func in ipairs(editOutputFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    return json.encode(realValue)
end)
`;

let worker = null;
let pendingRun = null;
let sequence = 0;
let runQueue = Promise.resolve();

function hasWorkerRuntime() {
    return typeof window !== 'undefined'
        && typeof Worker !== 'undefined'
        && typeof Blob !== 'undefined'
        && typeof URL !== 'undefined';
}

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

function extractVariableKeys(code) {
    const keys = new Set();
    const pattern = /\b(?:getChatVar|getGlobalVar|getState)\s*\(\s*[^,]+,\s*(['"])(.*?)\1/g;
    let match;
    while ((match = pattern.exec(code))) {
        const key = match[2];
        keys.add(key);
        if (match[0].includes('getState')) {
            keys.add(`__${key}`);
        }
    }
    return keys;
}

function unescapeLuaString(value) {
    return value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');
}

function extractLiteralCbsValues(code) {
    const values = new Set();
    const pattern = /\bcbs\s*\(\s*(['"])((?:\\.|(?!\1)[\s\S])*?)\1\s*\)/g;
    let match;
    while ((match = pattern.exec(code))) {
        values.add(unescapeLuaString(match[2]));
    }
    return values;
}

async function buildRunContext(code, api, trigger) {
    const vars = {};
    for (const key of extractVariableKeys(code)) {
        vars[key] = toText(api.getVar(key));
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

const WASMOON_SCRIPT_URLS = ${JSON.stringify(WASMOON_SCRIPT_URLS)};
const WASMOON_WASM_URLS = ${JSON.stringify(WASMOON_WASM_URLS)};
const LUA_PRELUDE = ${JSON.stringify(RISU_LUA_PRELUDE)};
let luaFactory = null;
let loadedWasmoon = false;
const engines = new Map();
let ctx = {};
let hostSeq = 0;
const pendingHost = new Map();
const activeHost = new Set();

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

function normalizeMessage(message) {
    return {
        role: normalizeRole(message && message.role),
        data: String((message && (message.data ?? message.content ?? message.message)) ?? ''),
        time: Number((message && message.time) ?? 0) || 0,
    };
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
    postMessage({ type: 'hostCall', callId, name, args });
    return promise;
}

async function waitForHostCalls() {
    while (activeHost.size > 0) {
        await Promise.allSettled(Array.from(activeHost));
    }
}

function loadWasmoonScript() {
    if (loadedWasmoon) {
        return;
    }
    let lastError = null;
    for (const url of WASMOON_SCRIPT_URLS) {
        try {
            importScripts(url);
            loadedWasmoon = true;
            return;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error('wasmoon script could not be loaded');
}

async function ensureLuaFactory() {
    if (luaFactory) {
        return luaFactory;
    }
    loadWasmoonScript();
    const bundle = self.wasmoon || self.Wasmoon;
    if (!bundle || typeof bundle.LuaFactory !== 'function') {
        throw new Error('wasmoon LuaFactory is unavailable');
    }

    let lastError = null;
    for (const wasmUrl of WASMOON_WASM_URLS) {
        try {
            const factory = new bundle.LuaFactory(wasmUrl);
            const testEngine = await factory.createEngine({ injectObjects: true });
            testEngine.global.close();
            luaFactory = factory;
            return luaFactory;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error('wasmoon wasm could not be loaded');
}

function encodeJson(value) {
    return JSON.stringify(value ?? null);
}

function decodeJson(value) {
    return parseJson(value, null);
}

function renderCbs(value) {
    const text = String(value ?? '');
    if (Object.prototype.hasOwnProperty.call(ctx.cbsCache || {}, text)) {
        return String(ctx.cbsCache[text] ?? '');
    }
    return text
        .replaceAll('{{char}}', String(ctx.char?.name ?? ''))
        .replaceAll('{{user}}', String(ctx.persona?.name ?? ''))
        .replaceAll('{{triggerid}}', String(ctx.trigger ?? ''));
}

function bindLuaHost(lua) {
    const set = (name, fn) => lua.global.set(name, fn);
    set('__jsonEncode', encodeJson);
    set('__jsonDecode', decodeJson);
    set('getChatVar', (_id, key) => {
        const normalizedKey = String(key);
        return Object.prototype.hasOwnProperty.call(ctx.vars || {}, normalizedKey) ? String(ctx.vars[normalizedKey]) : 'null';
    });
    set('setChatVar', (_id, key, value) => {
        const normalizedKey = String(key);
        const normalizedValue = String(value ?? '');
        ctx.vars[normalizedKey] = normalizedValue;
        return callHost('setChatVar', [normalizedKey, normalizedValue]);
    });
    set('getGlobalVar', (_id, key) => {
        const normalizedKey = String(key);
        return Object.prototype.hasOwnProperty.call(ctx.globals || {}, normalizedKey) ? String(ctx.globals[normalizedKey]) : 'null';
    });
    set('stopChat', () => {
        ctx.stopSending = true;
    });
    set('alertError', (_id, value) => callHost('alert', ['error', String(value ?? '')]));
    set('alertNormal', (_id, value) => callHost('alert', ['normal', String(value ?? '')]));
    set('alertInput', (_id, value) => callHost('alert', ['input', String(value ?? '')]));
    set('alertSelect', (_id, value) => callHost('alert', ['select', value]));
    set('alertConfirm', (_id, value) => callHost('alert', ['confirm', String(value ?? '')]));
    set('getChatMain', (_id, index) => JSON.stringify(ctx.chat.at(Number(index)) ?? null));
    set('getFullChatMain', () => JSON.stringify(ctx.chat));
    set('setFullChatMain', (_id, value) => {
        const parsed = parseJson(value, []);
        if (Array.isArray(parsed)) {
            ctx.chat = parsed.map(normalizeMessage);
            return callHost('setFullChat', [ctx.chat]);
        }
        return null;
    });
    set('setChat', (_id, index, value) => {
        const target = Number(index);
        if (ctx.chat[target]) {
            ctx.chat[target].data = String(value ?? '');
        }
        return callHost('setChat', [target, String(value ?? '')]);
    });
    set('setChatRole', (_id, index, role) => {
        const target = Number(index);
        if (ctx.chat[target]) {
            ctx.chat[target].role = normalizeRole(role);
        }
        return callHost('setChatRole', [target, normalizeRole(role)]);
    });
    set('cutChat', (_id, start, end) => {
        const startIndex = Number(start) || 0;
        const endIndex = Number.isFinite(Number(end)) ? Number(end) : ctx.chat.length;
        ctx.chat = ctx.chat.slice(startIndex, endIndex);
        return callHost('cutChat', [startIndex, endIndex]);
    });
    set('removeChat', (_id, index) => {
        const target = Number(index);
        ctx.chat.splice(target, 1);
        return callHost('removeChat', [target]);
    });
    set('addChat', (_id, role, value) => {
        const message = { role: normalizeRole(role), data: String(value ?? ''), time: 0 };
        ctx.chat.push(message);
        return callHost('addChat', [message.role, message.data]);
    });
    set('insertChat', (_id, index, role, value) => {
        const target = Number(index);
        const message = { role: normalizeRole(role), data: String(value ?? ''), time: 0 };
        ctx.chat.splice(target, 0, message);
        return callHost('insertChat', [target, message.role, message.data]);
    });
    set('getChatLength', () => ctx.chat.length);
    set('sleep', (_id, time) => new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(Number(time) || 0, 60000)))));
    set('cbs', value => renderCbs(value));
    set('logMain', value => callHost('log', [String(value ?? '')]));
    set('reloadDisplay', () => callHost('reloadDisplay', []));
    set('reloadChat', (_id, index) => callHost('reloadChat', [Number(index)]));
    set('getTokens', (_id, value) => callHost('getTokens', [String(value ?? '')]));
    set('hash', (_id, value) => callHost('hash', [String(value ?? '')]));
    set('similarity', (_id, source, values) => callHost('similarity', [String(source ?? ''), values]));
    set('getName', () => String(ctx.char?.name ?? ''));
    set('setName', (_id, value) => {
        ctx.char.name = String(value ?? '');
        return callHost('setName', [ctx.char.name]);
    });
    set('getDescription', () => String(ctx.char?.description ?? ''));
    set('setDescription', (_id, value) => {
        ctx.char.description = String(value ?? '');
        return callHost('setDescription', [ctx.char.description]);
    });
    set('getCharacterFirstMessage', () => String(ctx.char?.first_mes ?? ''));
    set('setCharacterFirstMessage', (_id, value) => {
        ctx.char.first_mes = String(value ?? '');
        return callHost('setCharacterFirstMessage', [ctx.char.first_mes]);
    });
    set('getCharacterLastMessage', () => {
        for (let index = ctx.chat.length - 1; index >= 0; index--) {
            if (ctx.chat[index]?.role !== 'user') return ctx.chat[index].data ?? '';
        }
        return String(ctx.char?.first_mes ?? '');
    });
    set('getUserLastMessage', () => {
        for (let index = ctx.chat.length - 1; index >= 0; index--) {
            if (ctx.chat[index]?.role === 'user') return ctx.chat[index].data ?? '';
        }
        return '';
    });
    set('getPersonaName', () => String(ctx.persona?.name ?? ''));
    set('getPersonaDescription', () => String(ctx.persona?.description ?? ''));
    set('getAuthorsNote', () => String(ctx.authorsNote ?? ''));
    set('getBackgroundEmbedding', () => String(ctx.backgroundEmbedding ?? ''));
    set('setBackgroundEmbedding', (_id, value) => {
        ctx.backgroundEmbedding = String(value ?? '');
        return callHost('setBackgroundEmbedding', [ctx.backgroundEmbedding]);
    });
    set('getLoreBooksMain', (_id, search) => {
        const needle = String(search || '').toLowerCase();
        const books = (ctx.loreBooks || []).filter(book => {
            if (!needle) return true;
            return String(book.comment || '').toLowerCase().includes(needle)
                || (Array.isArray(book.key) && book.key.some(key => String(key).toLowerCase().includes(needle)));
        });
        return JSON.stringify(books);
    });
    set('loadLoreBooksMain', () => callHost('loadLoreBooks', []).then(result => JSON.stringify(result ?? [])));
    set('upsertLocalLoreBook', (_id, name, content, options) => callHost('upsertLocalLoreBook', [String(name ?? ''), String(content ?? ''), options || {}]));
    set('LLMMain', (_id, prompt, useMultimodal, options) => callHost('LLM', [parseJson(prompt, prompt), Boolean(useMultimodal), parseJson(options, {})]).then(result => JSON.stringify(result ?? { success: false, result: '' })));
    set('axLLMMain', (_id, prompt, useMultimodal, options) => callHost('axLLM', [parseJson(prompt, prompt), Boolean(useMultimodal), parseJson(options, {})]).then(result => JSON.stringify(result ?? { success: false, result: '' })));
    set('simpleLLM', (_id, prompt) => callHost('simpleLLM', [String(prompt ?? '')]));
    set('generateImage', (_id, value, negative) => callHost('generateImage', [String(value ?? ''), String(negative ?? '')]));
    set('request', (_id, url) => callHost('request', [String(url ?? '')]).then(result => JSON.stringify(result ?? { status: 0, data: '' })));
    set('getCharacterImageMain', () => callHost('getCharacterImage', []));
    set('getPersonaImageMain', () => callHost('getPersonaImage', []));
}

async function getEngine(key, code) {
    if (engines.has(key)) {
        return engines.get(key);
    }
    const factory = await ensureLuaFactory();
    const lua = await factory.createEngine({ injectObjects: true });
    bindLuaHost(lua);
    await lua.doString(LUA_PRELUDE + '\\n' + code);
    engines.set(key, lua);
    return lua;
}

async function runMode(data) {
    ctx = data.ctx || {};
    ctx.vars ||= {};
    ctx.globals ||= {};
    ctx.chat = Array.isArray(ctx.chat) ? ctx.chat.map(normalizeMessage) : [];
    ctx.char ||= {};
    ctx.persona ||= {};
    ctx.stopSending = false;
    const key = 'mode:' + String(data.mode || '') + '\\u0000' + data.code;
    const lua = await getEngine(key, data.code);
    let handled = false;
    let returned = null;
    if (data.mode) {
        const fn = lua.global.get(String(data.mode));
        if (typeof fn === 'function') {
            handled = true;
            returned = await fn('id');
        }
    }
    await waitForHostCalls();
    return { handled, stopSending: ctx.stopSending || returned === false };
}

async function runButton(data) {
    ctx = data.ctx || {};
    ctx.vars ||= {};
    ctx.globals ||= {};
    ctx.chat = Array.isArray(ctx.chat) ? ctx.chat.map(normalizeMessage) : [];
    ctx.char ||= {};
    ctx.persona ||= {};
    ctx.stopSending = false;
    const key = 'button:' + data.code;
    const lua = await getEngine(key, data.code);
    let handled = false;
    let returned = null;
    const onButtonClick = lua.global.get('onButtonClick');
    if (typeof onButtonClick === 'function') {
        handled = true;
        returned = await onButtonClick('id', String(data.buttonName || ''));
    } else {
        const direct = lua.global.get(String(data.buttonName || ''));
        if (typeof direct === 'function') {
            handled = true;
            returned = await direct('id');
        }
    }
    await waitForHostCalls();
    return { handled, stopSending: ctx.stopSending || returned === false };
}

self.onmessage = async event => {
    const data = event.data || {};
    if (data.type === 'hostReply') {
        const resolve = pendingHost.get(data.callId);
        if (resolve) {
            pendingHost.delete(data.callId);
            resolve(data.result);
        }
        return;
    }
    if (data.type !== 'run') {
        return;
    }
    try {
        const result = data.button ? await runButton(data) : await runMode(data);
        postMessage({ type: 'done', id: data.id, ...result });
    } catch (error) {
        postMessage({ type: 'done', id: data.id, error: String((error && error.message) || error) });
    }
};
`;
}

function resetWorker() {
    if (worker) {
        worker.terminate();
        worker = null;
    }
    if (pendingRun) {
        pendingRun.resolve({ skipped: true, error: 'worker-reset' });
        pendingRun = null;
    }
}

function ensureWorker() {
    if (!hasWorkerRuntime()) {
        return null;
    }
    if (worker) {
        return worker;
    }

    const blob = new Blob([buildWorkerSource()], { type: 'text/javascript' });
    worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = event => {
        const data = event.data || {};
        if (data.type === 'hostCall') {
            void handleHostCall(data);
            return;
        }
        if (data.type === 'done' && pendingRun && data.id === pendingRun.id) {
            clearTimeout(pendingRun.timer);
            const resolve = pendingRun.resolve;
            pendingRun = null;
            resolve(data);
        }
    };
    worker.onerror = event => {
        const message = event.message || 'Lua worker error';
        if (pendingRun) {
            clearTimeout(pendingRun.timer);
            pendingRun.resolve({ error: message });
            pendingRun = null;
        }
        resetWorker();
    };
    return worker;
}

async function handleHostCall(data) {
    if (!pendingRun) {
        return;
    }

    let result = null;
    try {
        result = await dispatchHostCall(pendingRun.api, data.name, data.args || []);
    } catch (error) {
        console.warn('[RisuAI trigger] Lua host call failed.', data.name, error);
    }
    worker?.postMessage({ type: 'hostReply', callId: data.callId, result });
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
        case 'alert': return await hostApi.alert(args[0], args[1]);
        case 'reloadDisplay': return hostApi.reloadDisplay();
        case 'reloadChat': return hostApi.reloadChat(args[0]);
        case 'getTokens': return await hostApi.getTokens(args[0]);
        case 'hash': return hostApi.hash(args[0]);
        case 'similarity': return await hostApi.similarity(args[0], args[1]);
        case 'setName': return await hostApi.setName(args[0]);
        case 'setDescription': return await hostApi.setDescription(args[0]);
        case 'setCharacterFirstMessage': return await hostApi.setCharacterFirstMessage(args[0]);
        case 'setBackgroundEmbedding': return await hostApi.setBackgroundEmbedding(args[0]);
        case 'loadLoreBooks': return await hostApi.loadLoreBooks();
        case 'upsertLocalLoreBook': return await hostApi.upsertLocalLoreBook(args[0], args[1], args[2]);
        case 'LLM': {
            const response = await hostApi.LLM(args[0], args[2] || {});
            return { success: response !== null, result: toText(response) };
        }
        case 'axLLM': {
            const response = await hostApi.LLM(args[0], { ...(args[2] || {}), alternate: true });
            return { success: response !== null, result: toText(response) };
        }
        case 'simpleLLM': {
            const response = await hostApi.LLM(args[0], {});
            return { success: response !== null, result: toText(response) };
        }
        case 'generateImage': return await hostApi.generateImage(args[0], args[1]);
        case 'request': return await hostApi.request(args[0]);
        case 'getCharacterImage': return await hostApi.getCharacterImage();
        case 'getPersonaImage': return await hostApi.getPersonaImage();
        default: return null;
    }
}

function enqueueRun(task) {
    const run = runQueue.then(task, task);
    runQueue = run.catch(() => {});
    return run;
}

async function runWorker(message, api) {
    if (!hasWorkerRuntime()) {
        return { skipped: true, error: 'browser-worker-unavailable' };
    }

    return enqueueRun(() => new Promise(resolve => {
        const activeWorker = ensureWorker();
        if (!activeWorker) {
            resolve({ skipped: true, error: 'browser-worker-unavailable' });
            return;
        }

        const id = ++sequence;
        const timer = setTimeout(() => {
            const run = pendingRun;
            pendingRun = null;
            resetWorker();
            run?.resolve({ error: 'timeout' });
        }, RUN_TIMEOUT_MS);

        pendingRun = { id, api, resolve, timer };
        activeWorker.postMessage({ ...message, type: 'run', id });
    }));
}

export async function runRisuLuaScript({ code, mode, api, trigger }) {
    if (!code || !api) {
        return { skipped: true };
    }

    const ctx = await buildRunContext(code, api, trigger);
    return await runWorker({ code, mode, ctx }, api);
}

export async function runRisuLuaButton({ code, buttonName, api, trigger }) {
    if (!code || !api) {
        return { skipped: true };
    }

    const ctx = await buildRunContext(code, api, trigger || buttonName);
    return await runWorker({ code, buttonName, ctx, button: true }, api);
}
