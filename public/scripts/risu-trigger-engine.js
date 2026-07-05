import { runSandboxedRisuTriggerCode } from './risu-code-sandbox.js';

const MAX_RECURSION_DEPTH = 10;
const MAX_LOOP_ITERATIONS = 10000;
const MAX_WAIT_MS = 60_000;
const RISU_CODE_EFFECT_TYPES = new Set(['triggercode', 'triggerlua']);

export const RISU_TRIGGER_SUPPORTED_EFFECTS = new Set([
    'setvar',
    'runtrigger',
    'stop',
    'cutchat',
    'modifychat',
    'impersonate',
    'command',
    'extractRegex',
    'showAlert',
    'systemprompt',
    'sendAIprompt',
    'triggercode',
    'triggerlua',
    'runImgGen',
    'checkSimilarity',
    'runLLM',
    'runAxLLM',
    'v2Header',
    'v2SetVar',
    'v2If',
    'v2IfAdvanced',
    'v2Else',
    'v2EndIndent',
    'v2Loop',
    'v2LoopNTimes',
    'v2BreakLoop',
    'v2RunTrigger',
    'v2ConsoleLog',
    'v2StopTrigger',
    'v2Comment',
    'v2DeclareLocalVar',
    'v2CutChat',
    'v2ModifyChat',
    'v2SystemPrompt',
    'v2Impersonate',
    'v2Command',
    'v2RunLLM',
    'v2SendAIprompt',
    'v2ImgGen',
    'v2CheckSimilarity',
    'v2ShowAlert',
    'v2ExtractRegex',
    'v2GetLastMessage',
    'v2GetMessageAtIndex',
    'v2GetMessageCount',
    'v2GetLastUserMessage',
    'v2GetLastCharMessage',
    'v2ModifyLorebook',
    'v2GetLorebook',
    'v2GetLorebookCount',
    'v2GetLorebookEntry',
    'v2SetLorebookActivation',
    'v2GetLorebookIndexViaName',
    'v2GetFirstMessage',
    'v2GetAlertInput',
    'v2GetAlertSelect',
    'v2GetDisplayState',
    'v2SetDisplayState',
    'v2UpdateGUI',
    'v2UpdateChatAt',
    'v2Wait',
    'v2GetRequestState',
    'v2SetRequestState',
    'v2GetRequestStateRole',
    'v2SetRequestStateRole',
    'v2GetRequestStateLength',
    'v2QuickSearchChat',
    'v2StopPromptSending',
    'v2RegexTest',
    'v2Random',
    'v2GetCharAt',
    'v2GetCharCount',
    'v2ToLowerCase',
    'v2ToUpperCase',
    'v2SetCharAt',
    'v2SplitString',
    'v2ConcatString',
    'v2Calculate',
    'v2ReplaceString',
    'v2Tokenize',
    'v2MakeArrayVar',
    'v2GetArrayVarLength',
    'v2GetArrayVar',
    'v2SetArrayVar',
    'v2PushArrayVar',
    'v2PopArrayVar',
    'v2ShiftArrayVar',
    'v2UnshiftArrayVar',
    'v2SpliceArrayVar',
    'v2SliceArrayVar',
    'v2GetIndexOfValueInArrayVar',
    'v2RemoveIndexFromArrayVar',
    'v2JoinArrayVar',
    'v2GetCharacterDesc',
    'v2SetCharacterDesc',
    'v2GetPersonaDesc',
    'v2SetPersonaDesc',
    'v2GetReplaceGlobalNote',
    'v2SetReplaceGlobalNote',
    'v2GetAllLorebooks',
    'v2GetLorebookByName',
    'v2GetLorebookByIndex',
    'v2CreateLorebook',
    'v2ModifyLorebookByIndex',
    'v2DeleteLorebookByIndex',
    'v2GetLorebookCountNew',
    'v2SetLorebookAlwaysActive',
    'v2MakeDictVar',
    'v2GetDictVar',
    'v2SetDictVar',
    'v2DeleteDictKey',
    'v2HasDictKey',
    'v2ClearDict',
    'v2GetDictSize',
    'v2GetDictKeys',
    'v2GetDictValues',
    'v2GetAuthorNote',
    'v2SetAuthorNote',
]);

/**
 * @typedef {Object} RisuTriggerRuntime
 * @property {string} [defaultVariables]
 * @property {(name: string) => string|number|undefined|null} [getVariable]
 * @property {(name: string, value: string) => void|Promise<void>} [setVariable]
 * @property {(text: string, meta?: object) => string|Promise<string>} [evaluateText]
 * @property {Array<string|object>} [messages]
 * @property {(message: string) => void} [log]
 * @property {(role: string, text: string) => void|Promise<void>} [addMessage]
 * @property {(index: number, role: string, text: string) => void|Promise<void>} [insertMessage]
 * @property {(index: number, text: string) => void|Promise<void>} [modifyMessage]
 * @property {(index: number, role: string) => void|Promise<void>} [setMessageRole]
 * @property {(index: number) => void|Promise<void>} [deleteMessage]
 * @property {(start: number, end: number) => void|Promise<void>} [cutChat]
 * @property {(type: string, message: string) => void|Promise<void>} [notify]
 * @property {(text: string) => number|Promise<number>} [tokenCount]
 * @property {(location: string, value: string) => void|Promise<void>} [addSystemPrompt]
 * @property {() => string|Promise<string>} [getCharacterName]
 * @property {(value: string) => void|Promise<void>} [setCharacterName]
 * @property {() => string|Promise<string>} [getCharacterDescription]
 * @property {(value: string) => void|Promise<void>} [setCharacterDescription]
 * @property {(value: string) => void|Promise<void>} [setFirstMessage]
 * @property {() => string|Promise<string>} [getPersonaDescription]
 * @property {() => string|Promise<string>} [getPersonaName]
 * @property {(value: string) => void|Promise<void>} [setPersonaDescription]
 * @property {() => string|Promise<string>} [getAuthorNote]
 * @property {(value: string) => void|Promise<void>} [setAuthorNote]
 * @property {() => string|Promise<string>} [getFirstMessage]
 * @property {() => string|Promise<string>} [getReplaceGlobalNote]
 * @property {(value: string) => void|Promise<void>} [setReplaceGlobalNote]
 * @property {() => string|Promise<string>} [getBackgroundEmbedding]
 * @property {(value: string) => void|Promise<void>} [setBackgroundEmbedding]
 * @property {(display: string) => string|null|Promise<string|null>} [promptInput]
 * @property {(options: string[], display: string) => string|null|Promise<string|null>} [promptSelect]
 * @property {() => object[]|Promise<object[]>} [getLorebookEntries]
 * @property {(entries: object[]) => void|Promise<void>} [setLorebookEntries]
 * @property {(command: string, pipe: string) => string|object|false|Promise<string|object|false>} [executeCommand]
 * @property {(prompt: string|object[], options?: object) => string|Promise<string>} [runLLM]
 * @property {(prompt: string, negativePrompt?: string, options?: object) => string|false|Promise<string|false>} [generateImage]
 * @property {(source: string, candidates: string[], options?: object) => string[]|Promise<string[]>} [checkSimilarity]
 * @property {(text: string) => void|Promise<void>} [speak]
 * @property {(url: string) => object|string|Promise<object|string>} [request]
 * @property {boolean} [displayMode]
 * @property {string} [displayData]
 * @property {() => string|Promise<string>} [getDisplayData]
 * @property {(value: string) => void|Promise<void>} [setDisplayData]
 * @property {(milliseconds: number) => void|Promise<void>} [delay]
 */

function toText(value) {
    return value === undefined || value === null ? '' : String(value);
}

function toRisuNull(value) {
    return value === undefined || value === null || String(value) === '' ? 'null' : String(value);
}

function toRisuNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function isRisuNumericLike(value) {
    const text = String(value ?? '').trim();
    return text === '' || text.toLocaleLowerCase() === 'null' || /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text);
}

function compareRisuEqual(left, right) {
    if (isRisuNumericLike(left) && isRisuNumericLike(right)) {
        return toRisuNumber(left) === toRisuNumber(right);
    }

    return String(left ?? '') === String(right ?? '');
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getLowLevelAccessReason(trigger, runtime) {
    if (!trigger.lowLevelAccess) {
        return 'low-level-access-required';
    }
    if (!runtime.codeNetworkEnabled) {
        return 'network-access-disabled';
    }
    return '';
}

function shouldSkipEffectForPermissions(effect, trigger, runtime, result) {
    if (!effect?.type) {
        return false;
    }

    if (RISU_CODE_EFFECT_TYPES.has(effect.type)) {
        if (!runtime.codeSandboxEnabled) {
            result.unsupported.push({ type: effect.type, reason: 'code-sandbox-disabled', trigger: trigger.comment });
            return true;
        }
        return false;
    }

    if (runtime.declarativeTriggersEnabled === false) {
        result.unsupported.push({ type: effect.type, reason: 'triggers-disabled', trigger: trigger.comment });
        return true;
    }

    return false;
}

function compareValues(left, operator, right) {
    switch (operator) {
        case 'true':
            return left === 'true' || left === '1';
        case '=':
            return compareRisuEqual(left, right);
        case '!=':
            return !compareRisuEqual(left, right);
        case '>':
            return toRisuNumber(left) > toRisuNumber(right);
        case '<':
            return toRisuNumber(left) < toRisuNumber(right);
        case '>=':
            return toRisuNumber(left) >= toRisuNumber(right);
        case '<=':
            return toRisuNumber(left) <= toRisuNumber(right);
        case 'null':
            return left === 'null';
        default:
            return false;
    }
}

function compareAdvanced(left, operator, right) {
    switch (operator) {
        case '=':
            if (isRisuNumericLike(left) && isRisuNumericLike(right)) {
                return toRisuNumber(left) === toRisuNumber(right);
            }
            return left === right;
        case '!=':
            if (isRisuNumericLike(left) && isRisuNumericLike(right)) {
                return toRisuNumber(left) !== toRisuNumber(right);
            }
            return left !== right;
        case '\u2208':
            return parseJsonArray(right).includes(left);
        case '\u220b':
            return parseJsonArray(left).includes(right);
        case '\u2209':
            return !parseJsonArray(right).includes(left);
        case '\u220c':
            return !parseJsonArray(left).includes(right);
        case '\u2252': {
            if (!isRisuNumericLike(left) || !isRisuNumericLike(right)) {
                return left.toLocaleLowerCase().replace(/ /g, '') === right.toLocaleLowerCase().replace(/ /g, '');
            }
            const leftNumber = toRisuNumber(left);
            const rightNumber = toRisuNumber(right);
            return Math.abs(leftNumber - rightNumber) < 0.0001;
        }
        case '\u2261':
            if (right === 'true') {
                return left === 'true' || left === '1';
            }
            if (right === 'false') {
                return !(left === 'true' || left === '1');
            }
            return left === right;
        default:
            return compareValues(left, operator, right);
    }
}

function parseJsonArray(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function normaliseMessage(message) {
    if (typeof message === 'string') {
        return message;
    }
    if (!message || typeof message !== 'object') {
        return '';
    }
    return toText(message.mes ?? message.data ?? message.text ?? message.content);
}

function getMessages(runtime) {
    return Array.isArray(runtime.messages) ? runtime.messages.map(normaliseMessage) : [];
}

function getMessageRecords(runtime) {
    return Array.isArray(runtime.messages) ? runtime.messages : [];
}

function getMessageRole(message) {
    if (!message || typeof message !== 'object') {
        return '';
    }
    if (message.role === 'user' || message.role === 'char') {
        return message.role;
    }
    if (message.role === 'assistant') {
        return 'char';
    }
    if (message.is_user) {
        return 'user';
    }
    if (message.is_system) {
        return 'system';
    }
    return 'char';
}

function normaliseIndex(index, length) {
    const numeric = Number(index);
    if (!Number.isFinite(numeric)) {
        return -1;
    }
    return numeric < 0 ? length + numeric : numeric;
}

function parseJsonArrayValue(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function parseJsonObjectValue(value) {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

export function parseRisuDefaultVariables(defaultVariables) {
    const variables = new Map();
    if (typeof defaultVariables !== 'string' || !defaultVariables) {
        return variables;
    }

    for (const line of defaultVariables.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) {
            variables.set(line.slice(0, eq), line.slice(eq + 1));
        }
    }

    return variables;
}

export function resolveRisuTriggerVariable(name, runtime = {}) {
    const value = runtime.getVariable?.(name);
    if (value !== undefined && value !== null && String(value) !== '') {
        return String(value);
    }

    return parseRisuDefaultVariables(runtime.defaultVariables).get(name) ?? 'null';
}

function findLuaBlockEnd(code, startIndex) {
    const tokenPattern = /\b(function|if|for|while|end)\b/g;
    tokenPattern.lastIndex = startIndex;
    let depth = 1;
    let match;

    while ((match = tokenPattern.exec(code))) {
        if (match[1] === 'end') {
            depth--;
            if (depth === 0) {
                return match.index;
            }
        } else {
            depth++;
        }
    }

    return -1;
}

export function extractRisuLuaFunctions(code) {
    const functions = new Map();
    if (typeof code !== 'string' || !code.trim()) {
        return functions;
    }

    const functionPattern = /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)/g;
    let match;
    while ((match = functionPattern.exec(code))) {
        const bodyStart = functionPattern.lastIndex;
        const bodyEnd = findLuaBlockEnd(code, bodyStart);
        if (bodyEnd === -1) {
            continue;
        }

        functions.set(match[1], code.slice(bodyStart, bodyEnd).trim());
        functionPattern.lastIndex = bodyEnd + 3;
    }

    return functions;
}

function extractRisuLuaFunctionSpans(code) {
    const spans = [];
    if (typeof code !== 'string' || !code.trim()) {
        return spans;
    }

    const functionPattern = /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)/g;
    let match;
    while ((match = functionPattern.exec(code))) {
        const bodyStart = functionPattern.lastIndex;
        const bodyEnd = findLuaBlockEnd(code, bodyStart);
        if (bodyEnd === -1) {
            continue;
        }

        spans.push({
            name: match[1],
            start: match.index,
            end: bodyEnd + 3,
        });
        functionPattern.lastIndex = bodyEnd + 3;
    }

    return spans;
}

async function evaluateText(text, runtime, meta) {
    return toText(await runtime.evaluateText?.(toText(text), meta) ?? text);
}

async function resolveValue(value, valueType, runtime, meta) {
    const parsedValue = await evaluateText(value, runtime, meta);
    return valueType === 'var' ? resolveRisuTriggerVariable(parsedValue, runtime) : parsedValue;
}

async function resolveConditionValue(condition, runtime) {
    if (condition.type === 'var') {
        const key = await evaluateText(condition.var, runtime, { source: 'condition-var' });
        return resolveRisuTriggerVariable(key, runtime);
    }
    if (condition.type === 'chatindex') {
        return String(getMessages(runtime).length);
    }
    return await evaluateText(condition.var, runtime, { source: 'condition-value' });
}

export async function evaluateRisuTriggerCondition(condition, runtime = {}) {
    if (!condition || typeof condition !== 'object') {
        return true;
    }

    if (condition.type === 'exists') {
        const value = await evaluateText(condition.value, runtime, { source: 'condition-exists' });
        const depth = Math.max(0, Number(condition.depth) || 0);
        const haystack = getMessages(runtime).slice(depth ? -depth : undefined).join(' ');

        if (condition.type2 === 'strict') {
            return haystack.split(' ').includes(value);
        }
        if (condition.type2 === 'regex') {
            try {
                return new RegExp(value).test(haystack);
            } catch {
                return false;
            }
        }

        return haystack.toLowerCase().includes(value.toLowerCase());
    }

    const left = toRisuNull(await resolveConditionValue(condition, runtime));
    const right = toRisuNull(await evaluateText(condition.value, runtime, { source: 'condition-target' }));
    return compareValues(left, condition.operator, right);
}

async function evaluateConditions(trigger, runtime) {
    const conditions = Array.isArray(trigger.conditions) ? trigger.conditions : [];
    for (const condition of conditions) {
        if (!await evaluateRisuTriggerCondition(condition, runtime)) {
            return false;
        }
    }
    return true;
}

function applyAssignment(operator, originalValue, effectValue) {
    const originalNumber = Number(originalValue);
    const safeOriginal = Number.isNaN(originalNumber) ? 0 : originalNumber;

    switch (operator) {
        case '=':
            return effectValue;
        case '+=':
            return String(safeOriginal + Number(effectValue));
        case '-=':
            return String(safeOriginal - Number(effectValue));
        case '*=':
            return String(safeOriginal * Number(effectValue));
        case '/=':
            return String(safeOriginal / Number(effectValue));
        case '%=':
            return String(safeOriginal % Number(effectValue));
        default:
            return effectValue;
    }
}

function matchingEndIndex(effects, startIndex, indent) {
    for (let index = startIndex; index < effects.length; index++) {
        const effect = effects[index];
        if (effect?.type === 'v2EndIndent' && effect.indent === indent) {
            return index;
        }
    }
    return effects.length;
}

function skipFailedIfIndex(effects, startIndex, effect) {
    const childIndent = Number(effect.indent ?? 0) + 1;
    const endIndex = matchingEndIndex(effects, startIndex + 1, childIndent);
    const possibleElse = effects[endIndex + 1];

    if (possibleElse?.type === 'v2Else' && possibleElse.indent === effect.indent) {
        return endIndex + 1;
    }

    return endIndex;
}

function skipElseIndex(effects, startIndex, effect) {
    return matchingEndIndex(effects, startIndex + 1, Number(effect.indent ?? 0) + 1);
}

function matchingLoopEndIndex(effects, startIndex) {
    for (let index = startIndex; index < effects.length; index++) {
        const effect = effects[index];
        if (effect?.type === 'v2EndIndent' && effect.endOfLoop) {
            return index;
        }
    }
    return effects.length;
}

function findLoopStartIndex(effects, endIndex, indent) {
    for (let index = endIndex - 1; index >= 0; index--) {
        const effect = effects[index];
        if ((effect?.type === 'v2Loop' || effect?.type === 'v2LoopNTimes') && Number(effect.indent ?? 0) === indent) {
            return index;
        }
    }
    return -1;
}

async function getLoopCountTarget(loopEffect, runtime) {
    if (loopEffect?.type !== 'v2LoopNTimes') {
        return Infinity;
    }

    const value = await resolveValue(loopEffect.value, loopEffect.valueType, runtime, { source: 'effect-loop-count' });
    const count = Number(value);
    return Number.isFinite(count) ? Math.max(0, count) : 0;
}

async function setRisuVariable(name, value, runtime, result) {
    if (!name) {
        result.unsupported.push({ type: 'setvar', reason: 'empty-variable-name' });
        return;
    }

    const localVariable = runtime.getLocalVariable?.(name);
    if (localVariable) {
        localVariable.value = value;
        return;
    }

    await runtime.setVariable?.(name, value);
    result.changed = true;
}

function toRisuChatRecord(message) {
    return {
        role: getMessageRole(message) === 'user' ? 'user' : 'char',
        data: normaliseMessage(message),
        time: message?.send_date ?? message?.time ?? 0,
    };
}

function parseRisuJson(value, fallback = null) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function createRisuScriptApi(effect, trigger, runtime, result) {
    const triggerId = toText(trigger.comment || trigger.type || 'trigger');
    const scriptType = effect?.type === 'triggerlua' ? 'triggerlua' : 'triggercode';
    const getChat = () => getMessageRecords(runtime).map(toRisuChatRecord);
    const setChanged = () => {
        result.changed = true;
    };
    const setChatChanged = () => {
        result.chatChanged = true;
        result.refresh = true;
    };
    const ensureWritable = () => !runtime.displayMode;
    const setVar = async (key, value) => {
        if (!ensureWritable()) {
            return null;
        }
        await setRisuVariable(toText(key), toText(value), runtime, result);
        return null;
    };
    const addChat = async (role, value) => {
        if (!ensureWritable()) {
            return null;
        }
        await addTriggerMessage(role === 'user' ? 'user' : 'char', toText(value), runtime, result);
        return null;
    };
    const insertChat = async (index, role, value) => {
        if (!ensureWritable()) {
            return null;
        }
        await insertTriggerMessage(index, role === 'user' ? 'user' : 'char', toText(value), runtime, result);
        return null;
    };
    const setChatAt = async (index, value) => {
        if (!ensureWritable()) {
            return null;
        }
        await modifyTriggerMessage(index, toText(value), runtime, result);
        return null;
    };
    const setChatRoleAt = async (index, role) => {
        if (!ensureWritable()) {
            return null;
        }
        await setTriggerMessageRole(index, role === 'user' ? 'user' : 'char', runtime, result);
        return null;
    };
    const removeChatAt = async (index) => {
        if (!ensureWritable()) {
            return null;
        }
        const targetIndex = normaliseIndex(index, getMessageRecords(runtime).length);
        if (targetIndex < 0) {
            return null;
        }
        if (typeof runtime.deleteMessage === 'function') {
            await runtime.deleteMessage(targetIndex);
        } else if (Array.isArray(runtime.messages)) {
            runtime.messages.splice(targetIndex, 1);
        }
        setChatChanged();
        return null;
    };
    const setFullChat = async (value) => {
        if (!ensureWritable()) {
            return null;
        }
        const parsed = typeof value === 'string' ? parseRisuJson(value, []) : value;
        if (!Array.isArray(parsed)) {
            return null;
        }
        if (typeof runtime.cutChat === 'function') {
            await runtime.cutChat(0, 0);
        } else if (Array.isArray(runtime.messages)) {
            runtime.messages.splice(0, runtime.messages.length);
        }
        for (const message of parsed) {
            await addChat(message?.role, message?.data ?? message?.content ?? message?.message ?? '');
        }
        setChatChanged();
        return null;
    };
    const getLastMessageByRole = (role) => {
        const chat = getChat();
        for (let index = chat.length - 1; index >= 0; index--) {
            if (chat[index]?.role === role) {
                return chat[index].data ?? '';
            }
        }
        return '';
    };
    const setCharacterChanged = () => {
        result.characterChanged = true;
        result.refresh = true;
    };
    const setDisplayChanged = () => {
        result.displayChanged = true;
        result.refresh = true;
    };
    const getLoreBooks = async (search = '') => {
        const needle = toText(search).toLowerCase();
        const entries = await getLorebookEntries(runtime);
        return entries
            .filter(entry => {
                if (!needle) {
                    return true;
                }
                const haystack = [getLorebookName(entry), getLorebookKeyText(entry)].join('\n').toLowerCase();
                return haystack.includes(needle);
            })
            .map(entry => ({
                key: splitLorebookKeys(getLorebookKeyText(entry)),
                content: getLorebookContent(entry),
                comment: getLorebookName(entry),
            }));
    };
    const upsertLoreBook = async (name, content, options = {}) => {
        if (!ensureWritable()) {
            return null;
        }
        const entries = await getLorebookEntries(runtime);
        const entryName = toText(name);
        const existingIndex = entries.findIndex(entry => getLorebookName(entry) === entryName);
        const entry = existingIndex >= 0 ? entries[existingIndex] : createLorebookEntry(entryName, options?.key ?? entryName, content, options?.insertOrder ?? 100);
        setLorebookName(entry, entryName);
        setLorebookContent(entry, toText(content));
        if (options && typeof options === 'object') {
            if ('key' in options) setLorebookKeys(entry, options.key);
            if ('insertOrder' in options) setLorebookOrder(entry, options.insertOrder);
            if ('alwaysActive' in options) setLorebookAlwaysActive(entry, options.alwaysActive);
            if ('regex' in options && !Array.isArray(entry)) entry.useRegex = Boolean(options.regex);
            if ('secondKey' in options && !Array.isArray(entry)) {
                entry.keysecondary = splitLorebookKeys(options.secondKey);
                entry.selective = entry.keysecondary.length > 0;
            }
        }
        if (existingIndex < 0) {
            entries.push(entry);
        }
        await setLorebookEntries(entries, runtime, result);
        return null;
    };
    const lowLevelAllowed = () => !getLowLevelAccessReason(trigger, runtime);
    const lowLevelUnavailable = (type, reason) => {
        result.unsupported.push({ type, reason, trigger: trigger.comment });
        return null;
    };
    const api = {
        id: triggerId,
        trigger: trigger.comment ?? trigger.type ?? '',
        getVar: (key) => resolveRisuTriggerVariable(toText(key), runtime),
        setVar,
        getChat: () => getChat(),
        getFullChat: () => getChat(),
        getLastMessage: () => {
            const chat = getChat();
            return chat.at(-1) ?? null;
        },
        addChat,
        insertChat,
        setChat: setChatAt,
        setChatRole: setChatRoleAt,
        removeChat: removeChatAt,
        setFullChat,
        cutChat: async (start, end) => {
            if (!ensureWritable()) {
                return null;
            }
            await cutTriggerChat(start, end, runtime, result);
            return null;
        },
        stop: () => {
            result.stopSending = true;
            result.stopped = true;
        },
        log: (message) => runtime.log?.(toText(message)),
        cbs: (value) => evaluateText(value, runtime, { source: 'triggercode-cbs' }),
        getTokens: (value) => runtime.tokenCount?.(toText(value)) ?? Math.ceil(toText(value).length / 4),
        hash: (value) => {
            let hash = 0;
            const text = toText(value);
            for (let index = 0; index < text.length; index++) {
                hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
            }
            return String(Math.abs(hash));
        },
        sleep: async (milliseconds) => {
            const waitMs = Math.max(0, Math.min(Number(milliseconds) || 0, MAX_WAIT_MS));
            if (typeof runtime.delay === 'function') {
                await runtime.delay(waitMs);
            } else {
                await sleep(waitMs);
            }
        },
        LLM: async (prompt, options = {}) => {
            if (!lowLevelAllowed()) {
                return lowLevelUnavailable(scriptType, getLowLevelAccessReason(trigger, runtime));
            }
            if (typeof runtime.runLLM !== 'function') {
                return lowLevelUnavailable(scriptType, 'llm-runtime-unavailable');
            }
            return await runtime.runLLM(prompt, { ...options, trigger: trigger.comment });
        },
        request: async (url) => {
            if (!lowLevelAllowed()) {
                return lowLevelUnavailable(scriptType, getLowLevelAccessReason(trigger, runtime));
            }
            if (typeof runtime.request !== 'function') {
                return lowLevelUnavailable(scriptType, 'request-runtime-unavailable');
            }
            return await runtime.request(toText(url), { trigger: trigger.comment });
        },
        generateImage: async (prompt, negativePrompt = '') => {
            if (!lowLevelAllowed()) {
                return lowLevelUnavailable(scriptType, getLowLevelAccessReason(trigger, runtime));
            }
            if (typeof runtime.generateImage !== 'function') {
                return lowLevelUnavailable(scriptType, 'image-runtime-unavailable');
            }
            return await runtime.generateImage(toText(prompt), toText(negativePrompt), { trigger: trigger.comment });
        },
        similarity: async (source, values) => {
            if (!lowLevelAllowed()) {
                return lowLevelUnavailable(scriptType, getLowLevelAccessReason(trigger, runtime));
            }
            const candidates = Array.isArray(values) ? values.map(toText) : splitRisuSectionList(values);
            if (typeof runtime.checkSimilarity === 'function') {
                return await runtime.checkSimilarity(toText(source), candidates, { trigger: trigger.comment });
            }
            return rankSimilarityCandidates(toText(source), candidates);
        },
        getCharacterLastMessage: () => getLastMessageByRole('char'),
        getUserLastMessage: () => getLastMessageByRole('user'),
        getName: async () => toText(await runtime.getCharacterName?.() ?? ''),
        setName: async (value) => {
            if (!ensureWritable()) {
                return null;
            }
            await runtime.setCharacterName?.(toText(value));
            setCharacterChanged();
            return null;
        },
        getDescription: async () => toText(await runtime.getCharacterDescription?.() ?? ''),
        setDescription: async (value) => {
            if (!ensureWritable()) {
                return null;
            }
            await runtime.setCharacterDescription?.(toText(value));
            setCharacterChanged();
            return null;
        },
        getCharacterFirstMessage: async () => toText(await runtime.getFirstMessage?.() ?? ''),
        setCharacterFirstMessage: async (value) => {
            if (!ensureWritable()) {
                return null;
            }
            await runtime.setFirstMessage?.(toText(value));
            setCharacterChanged();
            return null;
        },
        getPersonaName: async () => toText(await runtime.getPersonaName?.() ?? ''),
        getPersonaDescription: async () => toText(await runtime.getPersonaDescription?.() ?? ''),
        getAuthorsNote: async () => toText(await runtime.getAuthorNote?.() ?? ''),
        getBackgroundEmbedding: async () => toText(await runtime.getBackgroundEmbedding?.() ?? ''),
        setBackgroundEmbedding: async (value) => {
            if (!ensureWritable()) {
                return null;
            }
            await runtime.setBackgroundEmbedding?.(toText(value));
            setDisplayChanged();
            return null;
        },
        alert: async (kind, value) => {
            const alertKind = kind === 'error' ? 'error' : 'info';
            if (kind === 'input') {
                return await runtime.promptInput?.(toText(value)) ?? '';
            }
            if (kind === 'select') {
                const options = Array.isArray(value) ? value : splitRisuSectionList(value);
                return await runtime.promptSelect?.(options, 'Select an option') ?? options[0] ?? '';
            }
            await runtime.notify?.(alertKind, toText(value));
            return null;
        },
        reloadDisplay: () => {
            result.refresh = true;
            result.displayChanged = true;
        },
        reloadChat: (index) => {
            result.refresh = true;
            const targetIndex = normaliseIndex(index, getMessageRecords(runtime).length);
            if (targetIndex >= 0) {
                result.chatRefreshIndexes.push(targetIndex);
            }
        },
        getLoreBooks,
        loadLoreBooks: () => getLoreBooks(''),
        upsertLocalLoreBook: upsertLoreBook,
        getCharacterImage: () => '',
        getPersonaImage: () => '',
    };

    return {
        ...api,
        scylla: api,
        risu: api,
        getChatVar: (_id, key) => api.getVar(key),
        setChatVar: (_id, key, value) => api.setVar(key, value),
        getGlobalVar: (_id, key) => api.getVar(key),
        stopChat: () => api.stop(),
        getChatMain: (_id, index) => JSON.stringify(getChat()[normaliseIndex(index, getChat().length)] ?? null),
        getFullChatMain: () => JSON.stringify(getChat()),
        setFullChatMain: (_id, value) => api.setFullChat(value),
        getChatLength: () => getChat().length,
        setChat: (_id, index, value) => api.setChat(index, value),
        setChatRole: (_id, index, role) => api.setChatRole(index, role),
        insertChat: (_id, index, role, value) => api.insertChat(index, role, value),
        removeChat: (_id, index) => api.removeChat(index),
        cutChat: (_id, start, end) => api.cutChat(start, end),
        addChat: (_id, role, value) => api.addChat(role, value),
        logMain: (value) => api.log(parseRisuJson(value, value)),
        cbs: (value) => api.cbs(value),
        hash: (_id, value) => api.hash(value),
        getTokens: (_id, value) => api.getTokens(value),
        sleep: (_id, value) => api.sleep(value),
        LLMMain: async (_id, prompt, _useMultimodal = false, options = '') => {
            const response = await api.LLM(parseRisuJson(prompt, prompt), parseRisuJson(options, {}));
            return JSON.stringify({ success: response !== null, result: toText(response) });
        },
        simpleLLM: (_id, prompt) => api.LLM(toText(prompt)),
        generateImage: (_id, prompt, negativePrompt = '') => api.generateImage(prompt, negativePrompt),
        similarity: (_id, source, values) => api.similarity(source, values),
        request: (_id, url) => api.request(url),
        getCharacterLastMessage: (_id) => api.getCharacterLastMessage(),
        getUserLastMessage: (_id) => api.getUserLastMessage(),
        getName: (_id) => api.getName(),
        setName: (_id, value) => api.setName(value),
        getDescription: (_id) => api.getDescription(),
        setDescription: (_id, value) => api.setDescription(value),
        getCharacterFirstMessage: (_id) => api.getCharacterFirstMessage(),
        setCharacterFirstMessage: (_id, value) => api.setCharacterFirstMessage(value),
        getPersonaName: (_id) => api.getPersonaName(),
        getPersonaDescription: (_id) => api.getPersonaDescription(),
        getAuthorsNote: (_id) => api.getAuthorsNote(),
        getBackgroundEmbedding: (_id) => api.getBackgroundEmbedding(),
        setBackgroundEmbedding: (_id, value) => api.setBackgroundEmbedding(value),
        alertNormal: (_id, value) => api.alert('normal', value),
        alertError: (_id, value) => api.alert('error', value),
        alertInput: (_id, value) => api.alert('input', value),
        alertSelect: (_id, value) => api.alert('select', value),
        alertConfirm: (_id, value) => api.alert('confirm', value),
        reloadDisplay: () => api.reloadDisplay(),
        reloadChat: (_id, index) => api.reloadChat(index),
        getLoreBooksMain: async (_id, search) => JSON.stringify(await api.getLoreBooks(search)),
        loadLoreBooksMain: async () => JSON.stringify(await api.loadLoreBooks()),
        upsertLocalLoreBook: (_id, name, content, options = {}) => api.upsertLocalLoreBook(name, content, options),
        getCharacterImageMain: (_id) => api.getCharacterImage(),
        getPersonaImageMain: (_id) => api.getPersonaImage(),
    };
}

async function runRisuTriggerCode(effect, trigger, runtime, result) {
    const code = toText(effect.code);
    if (!code.trim()) {
        return;
    }

    if (!runtime.codeSandboxEnabled) {
        result.unsupported.push({ type: 'triggercode', reason: 'code-sandbox-disabled', trigger: trigger.comment });
        return;
    }

    const api = createRisuScriptApi(effect, trigger, runtime, result);
    try {
        const outcome = await runSandboxedRisuTriggerCode({ code, api, trigger: trigger.comment });
        if (outcome?.error) {
            result.unsupported.push({ type: 'triggercode', reason: 'script-error', message: outcome.error, trigger: trigger.comment });
        }
        if (outcome?.stopSending) {
            result.stopSending = true;
            result.stopped = true;
        }
    } catch (error) {
        result.unsupported.push({ type: 'triggercode', reason: 'script-error', message: error?.message ?? String(error), trigger: trigger.comment });
    }
}

async function loadRisuLuaRuntime() {
    if (typeof window === 'undefined' || typeof Worker === 'undefined' || typeof Blob === 'undefined') {
        return null;
    }

    try {
        return await import('./risu-script-runtime.js');
    } catch (error) {
        console.warn('[RisuAI trigger] Lua runtime module could not be loaded.', error);
        return null;
    }
}

function getRisuLuaTriggerMode(trigger) {
    return trigger?.type === 'manual' ? toText(trigger.comment) : toText(trigger?.type || trigger?.comment || 'manual');
}

async function runRisuLuaFunctionShim(code, functionName, runtime, result) {
    const functions = extractRisuLuaFunctions(code);
    if (!functions.has(functionName)) {
        return false;
    }

    await executeRisuLuaFunctionBody(functions.get(functionName), runtime, result, functions);
    return true;
}

async function runRisuTriggerLua(effect, trigger, runtime, result) {
    const code = toText(effect.code);
    if (!code.trim()) {
        return;
    }

    if (!runtime.codeSandboxEnabled) {
        result.unsupported.push({ type: 'triggerlua', reason: 'code-sandbox-disabled', trigger: trigger.comment });
        return;
    }

    const mode = getRisuLuaTriggerMode(trigger);
    const luaRuntime = await loadRisuLuaRuntime();
    if (luaRuntime?.runRisuLuaScript) {
        const api = createRisuScriptApi(effect, trigger, runtime, result);
        const outcome = await luaRuntime.runRisuLuaScript({ code, mode, api, trigger: trigger.comment });
        if (outcome?.error) {
            result.unsupported.push({ type: 'triggerlua', reason: 'script-error', message: outcome.error, trigger: trigger.comment });
        }
        if (outcome && !outcome.skipped) {
            if (outcome.stopSending) {
                result.stopSending = true;
                result.stopped = true;
            }
            return;
        }
    }

    if (await runRisuLuaFunctionShim(code, mode, runtime, result)) {
        return;
    }

    if (!isLuaFunctionLibraryOnly(code)) {
        result.unsupported.push({ type: 'triggerlua', reason: 'runtime-lua-not-supported', trigger: trigger.comment });
    }
}

async function runRisuLuaButtonRuntime(triggers, functionName, runtime, result) {
    if (!runtime.codeSandboxEnabled) {
        result.unsupported.push({ type: 'triggerlua', reason: 'code-sandbox-disabled', trigger: functionName });
        return false;
    }

    const luaRuntime = await loadRisuLuaRuntime();
    if (!luaRuntime?.runRisuLuaButton) {
        return false;
    }

    for (const trigger of triggers) {
        const effects = Array.isArray(trigger?.effect) ? trigger.effect : [];
        for (const effect of effects) {
            if (effect?.type !== 'triggerlua' || typeof effect.code !== 'string') {
                continue;
            }

            const api = createRisuScriptApi(effect, { ...trigger, comment: functionName }, runtime, result);
            const outcome = await luaRuntime.runRisuLuaButton({ code: effect.code, buttonName: functionName, api, trigger: trigger.comment });
            if (outcome?.error) {
                result.unsupported.push({ type: 'triggerlua', reason: 'script-error', message: outcome.error, trigger: trigger.comment });
                return true;
            }
            if (outcome?.handled) {
                if (outcome.stopSending) {
                    result.stopSending = true;
                    result.stopped = true;
                }
                result.ran = true;
                return true;
            }
        }
    }

    return false;
}

function clearLocalVariablesAtIndent(state, indent) {
    for (const [name, variable] of state.localVariables) {
        if (variable.indent >= indent) {
            state.localVariables.delete(name);
        }
    }
}

async function resolveOutputVar(effect, runtime) {
    return await evaluateText(effect.outputVar, runtime, { source: 'effect-output-var' });
}

function applyRegexReplacement(format, regexResult) {
    const source = toText(format);
    if (!regexResult) {
        return source.replace(/\$[0-9]+/g, '').replace(/\$&/g, '').replace(/\$\$/g, '$');
    }

    return source
        .replace(/\$[0-9]+/g, (match) => regexResult[Number(match.slice(1))] || '')
        .replace(/\$&/g, regexResult[0] || '')
        .replace(/\$\$/g, '$');
}

function safeRegex(pattern, flags = '') {
    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
}

function evaluateSafeMath(expression, runtime) {
    const source = toText(expression).replace(/\$([a-zA-Z0-9_]+)/g, (_, name) => {
        const parsed = parseFloat(resolveRisuTriggerVariable(name, runtime));
        return Number.isNaN(parsed) ? '0' : String(parsed);
    });

    if (!/^[\d\s+\-*/%^()<>=!&|.]*$/.test(source)) {
        return '0';
    }

    try {
        // Whitelisted numeric expression only.
        const result = Function(`"use strict"; return (${source.replace(/\^/g, '**') || 0})`)();
        return Number.isFinite(Number(result)) || typeof result === 'boolean' ? String(result) : '0';
    } catch {
        return '0';
    }
}

async function setOutputVariable(effect, value, runtime, result) {
    await setRisuVariable(await resolveOutputVar(effect, runtime), toText(value), runtime, result);
}

async function addTriggerMessage(role, value, runtime, result) {
    const normalizedRole = role === 'user' ? 'user' : 'char';
    if (typeof runtime.addMessage === 'function') {
        await runtime.addMessage(normalizedRole, value);
    } else if (Array.isArray(runtime.messages)) {
        runtime.messages.push({ role: normalizedRole, data: value, mes: value, is_user: normalizedRole === 'user' });
    }
    result.chatChanged = true;
}

async function insertTriggerMessage(index, role, value, runtime, result) {
    const records = getMessageRecords(runtime);
    const normalizedRole = role === 'user' ? 'user' : 'char';
    const numericIndex = Number(index);
    const targetIndex = Number.isFinite(numericIndex)
        ? Math.max(0, Math.min(records.length, numericIndex < 0 ? records.length + numericIndex : numericIndex))
        : records.length;

    if (typeof runtime.insertMessage === 'function') {
        await runtime.insertMessage(targetIndex, normalizedRole, value);
    } else if (Array.isArray(runtime.messages)) {
        runtime.messages.splice(targetIndex, 0, { role: normalizedRole, data: value, mes: value, is_user: normalizedRole === 'user' });
    } else {
        await addTriggerMessage(normalizedRole, value, runtime, result);
        return;
    }
    result.chatChanged = true;
}

async function modifyTriggerMessage(index, value, runtime, result) {
    const records = getMessageRecords(runtime);
    const targetIndex = normaliseIndex(index, records.length);
    if (targetIndex < 0 || targetIndex >= records.length) {
        return;
    }

    if (normaliseMessage(records[targetIndex]) === toText(value)) {
        result.displayChanged = true;
        result.refresh = true;
        return;
    }

    if (typeof runtime.modifyMessage === 'function') {
        await runtime.modifyMessage(targetIndex, value);
    } else {
        const target = records[targetIndex];
        if (target && typeof target === 'object') {
            if ('mes' in target) target.mes = value;
            if ('data' in target) target.data = value;
            if ('message' in target) target.message = value;
            if ('content' in target) target.content = value;
        } else {
            records[targetIndex] = value;
        }
    }
    result.chatChanged = true;
}

async function setTriggerMessageRole(index, role, runtime, result) {
    const records = getMessageRecords(runtime);
    const targetIndex = normaliseIndex(index, records.length);
    if (targetIndex < 0 || targetIndex >= records.length) {
        return;
    }

    const normalizedRole = role === 'user' ? 'user' : 'char';
    if (typeof runtime.setMessageRole === 'function') {
        await runtime.setMessageRole(targetIndex, normalizedRole);
    } else {
        const target = records[targetIndex];
        if (target && typeof target === 'object') {
            target.role = normalizedRole;
            target.is_user = normalizedRole === 'user';
            if ('is_system' in target) target.is_system = false;
        }
    }
    result.chatChanged = true;
}

async function cutTriggerChat(start, end, runtime, result) {
    const records = getMessageRecords(runtime);
    const fallbackEnd = records.length;
    const startIndex = Number.isFinite(Number(start)) ? Math.max(0, Number(start)) : 0;
    const endIndex = Number.isFinite(Number(end)) ? Math.max(startIndex, Number(end)) : fallbackEnd;

    if (typeof runtime.cutChat === 'function') {
        await runtime.cutChat(startIndex, endIndex);
    } else if (Array.isArray(runtime.messages)) {
        runtime.messages.splice(0, runtime.messages.length, ...runtime.messages.slice(startIndex, endIndex));
    }
    result.chatChanged = true;
}

async function quickSearchChat(effect, runtime, result) {
    const value = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
    const depthValue = await resolveValue(effect.depth, effect.depthType, runtime, { source: 'effect-depth' });
    const depth = Math.max(0, Number(depthValue) || 0);
    const haystack = getMessages(runtime).slice(depth ? -depth : undefined).join(' ');
    let pass = false;

    if (effect.condition === 'strict') {
        pass = haystack.split(' ').includes(value);
    } else if (effect.condition === 'regex') {
        pass = Boolean(safeRegex(value)?.test(haystack));
    } else {
        pass = haystack.toLowerCase().includes(value.toLowerCase());
    }

    await setOutputVariable(effect, pass ? '1' : '0', runtime, result);
}

async function tokenCount(value, runtime) {
    if (typeof runtime.tokenCount === 'function') {
        return String(await runtime.tokenCount(value));
    }
    return String(Math.ceil(toText(value).length / 4));
}

function normalizeSystemPromptLocation(location) {
    return ['start', 'historyend', 'promptend'].includes(location) ? location : 'promptend';
}

async function addSystemPrompt(location, value, runtime, result) {
    const promptLocation = normalizeSystemPromptLocation(location);
    const promptValue = toText(value);
    result.systemPrompt[promptLocation] += `${promptValue}\n\n`;
    result.promptChanged = true;
    await runtime.addSystemPrompt?.(promptLocation, promptValue);
}

async function getFirstMessage(runtime) {
    if (typeof runtime.getFirstMessage === 'function') {
        return toText(await runtime.getFirstMessage());
    }

    const messages = getMessageRecords(runtime);
    const firstCharMessage = messages.find(message => getMessageRole(message) === 'char');
    return firstCharMessage ? normaliseMessage(firstCharMessage) : 'null';
}

function hasDisplayData(runtime) {
    return runtime.displayMode || runtime.displayData !== undefined || typeof runtime.getDisplayData === 'function' || typeof runtime.setDisplayData === 'function';
}

async function getDisplayData(runtime) {
    if (!hasDisplayData(runtime)) {
        return null;
    }

    if (typeof runtime.getDisplayData === 'function') {
        return toText(await runtime.getDisplayData());
    }

    return toText(runtime.displayData);
}

async function setDisplayData(value, runtime, result) {
    const text = toText(value);
    runtime.displayData = text;
    result.displayData = text;
    result.displayChanged = true;
    await runtime.setDisplayData?.(text);
}

async function getRequestState(runtime) {
    const displayData = await getDisplayData(runtime);
    if (displayData === null) {
        return null;
    }

    try {
        const parsed = JSON.parse(displayData);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

async function setRequestState(items, runtime, result) {
    if (!Array.isArray(items)) {
        return;
    }
    await setDisplayData(JSON.stringify(items), runtime, result);
}

async function getLorebookEntries(runtime) {
    if (typeof runtime.getLorebookEntries !== 'function') {
        return [];
    }

    const entries = await runtime.getLorebookEntries();
    return Array.isArray(entries) ? entries : [];
}

async function setLorebookEntries(entries, runtime, result) {
    if (!Array.isArray(entries)) {
        return;
    }

    await runtime.setLorebookEntries?.(entries);
    result.characterChanged = true;
    result.refresh = true;
}

function splitLorebookKeys(value) {
    if (Array.isArray(value)) {
        return value.map(item => toText(item).trim()).filter(Boolean);
    }
    return toText(value).split(',').map(item => item.trim()).filter(Boolean);
}

function getLorebookName(entry) {
    if (Array.isArray(entry)) {
        return toText(entry[0]);
    }
    return toText(entry?.name ?? entry?.comment ?? entry?.extensions?.display_name);
}

function getLorebookKeyText(entry) {
    if (Array.isArray(entry)) {
        return toText(entry[0]);
    }
    const key = entry?.key ?? entry?.keys;
    return Array.isArray(key) ? key.join(',') : toText(key);
}

function getLorebookContent(entry) {
    if (Array.isArray(entry)) {
        return toText(entry[1]);
    }
    return toText(entry?.content);
}

function setLorebookContent(entry, value) {
    if (Array.isArray(entry)) {
        entry[1] = value;
        return;
    }
    entry.content = value;
}

function setLorebookActivation(entry, value) {
    const enabled = Boolean(value);
    if (Array.isArray(entry)) {
        entry[2] = enabled;
        return;
    }
    entry.enabled = enabled;
}

function setLorebookAlwaysActive(entry, value) {
    const constant = Boolean(value);
    if (Array.isArray(entry)) {
        entry[3] = constant;
        return;
    }
    entry.constant = constant;
    entry.alwaysActive = constant;
}

function setLorebookName(entry, value) {
    if (Array.isArray(entry)) {
        entry[0] = value;
        return;
    }
    entry.name = value;
    entry.comment = value;
}

function setLorebookKeys(entry, value) {
    if (Array.isArray(entry)) {
        entry[0] = value;
        return;
    }
    entry.keys = splitLorebookKeys(value);
    delete entry.key;
}

function setLorebookOrder(entry, value) {
    const order = Number(value);
    if (!Number.isFinite(order)) {
        return;
    }

    if (Array.isArray(entry)) {
        entry[4] = order;
        return;
    }
    entry.insertion_order = order;
    entry.insertorder = order;
}

function findLorebookIndex(entries, target) {
    const needle = toText(target);
    return entries.findIndex(entry => getLorebookName(entry) === needle || getLorebookKeyText(entry) === needle);
}

function createLorebookEntry(name, key, content, insertOrder) {
    const order = Number(insertOrder);
    return {
        keys: splitLorebookKeys(key),
        content: toText(content),
        enabled: true,
        constant: false,
        selective: false,
        insertion_order: Number.isFinite(order) ? order : 100,
        name: toText(name),
        comment: toText(name),
        mode: 'normal',
        extensions: {},
    };
}

function replaceLorebookSlot(value, currentValue) {
    return toText(value).replaceAll('{{slot}}', toText(currentValue));
}

function splitRisuCommandPipeline(command) {
    const parts = [];
    let start = 0;
    let quote = '';

    for (let index = 0; index < command.length; index++) {
        const char = command[index];
        if (quote) {
            if (char === quote && command[index - 1] !== '\\') {
                quote = '';
            }
            continue;
        }
        if (char === '"' || char === '\'') {
            quote = char;
            continue;
        }
        if (char === '|') {
            parts.push(command.slice(start, index));
            start = index + 1;
        }
    }

    parts.push(command.slice(start));
    return parts;
}

function tokenizeRisuCommand(command) {
    const tokens = [];
    let token = '';
    let quote = '';

    for (let index = 0; index < command.length; index++) {
        const char = command[index];
        if (quote) {
            if (char === quote && command[index - 1] !== '\\') {
                quote = '';
                continue;
            }
            token += char;
            continue;
        }

        if (char === '"' || char === '\'') {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (token) {
                tokens.push(token);
                token = '';
            }
            continue;
        }

        token += char;
    }

    if (token) {
        tokens.push(token);
    }

    return tokens;
}

async function parseRisuCommand(command, pipe, runtime) {
    const source = command.trim().replace(/^\//, '');
    const tokens = tokenizeRisuCommand(source);
    const commandName = toText(tokens.shift()).trim();
    const argParts = [];
    const namedArg = {};

    for (const token of tokens) {
        const equalsIndex = token.indexOf('=');
        if (equalsIndex > 0) {
            namedArg[token.slice(0, equalsIndex)] = token.slice(equalsIndex + 1);
        } else {
            argParts.push(token);
        }
    }

    let arg = argParts.join(' ');
    if (!arg) {
        arg = pipe;
    }
    arg = arg.replaceAll('{{pipe}}', pipe).replaceAll('{{slot}}', pipe);
    arg = await evaluateText(arg, runtime, { source: 'command-arg', command: commandName });

    for (const key of Object.keys(namedArg)) {
        namedArg[key] = await evaluateText(namedArg[key], runtime, { source: 'command-named-arg', command: commandName });
    }

    return { commandName, arg, namedArg };
}

function parseRisuCommandOptions(value) {
    const text = toText(value);
    if (!text) {
        return [];
    }

    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
            return parsed.map(option => toText(option));
        }
    } catch {
        // Fall through to delimiter parsing.
    }

    return text.split(text.includes('\u00a7') ? '\u00a7' : '|').map(option => option.trim()).filter(Boolean);
}

function parseRisuChatML(value) {
    const starter = '<|im_start|>';
    const separator = '<|im_sep|>';
    const ender = '<|im_end|>';
    const text = toText(value).trim();

    if (!text.startsWith(starter)) {
        return null;
    }

    return text
        .split(starter)
        .filter(Boolean)
        .map((segment) => {
            let role = 'user';
            let content = segment;

            for (const knownRole of ['user', 'system', 'assistant']) {
                if (content.startsWith(`${knownRole}${separator}`)) {
                    role = knownRole;
                    content = content.slice(knownRole.length + separator.length);
                    break;
                }
                if (content.startsWith(`${knownRole} `) || content.startsWith(`${knownRole}\n`)) {
                    role = knownRole;
                    content = content.slice(knownRole.length + 1);
                    break;
                }
            }

            content = content.trim();
            if (content.endsWith(ender)) {
                content = content.slice(0, -ender.length);
            }

            content = content.replace(/<Thoughts>[\s\S]+<\/Thoughts>/g, '');
            return { role, content };
        });
}

function splitRisuSectionList(value) {
    return toText(value)
        .split(/\u00c2?\u00a7/g)
        .map(item => item.trim())
        .filter(Boolean);
}

function tokenizeSimilarityText(value) {
    return toText(value).toLocaleLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
}

function termVector(tokens) {
    const vector = new Map();
    for (const token of tokens) {
        vector.set(token, (vector.get(token) ?? 0) + 1);
    }
    return vector;
}

function lexicalSimilarityScore(source, candidate) {
    const sourceText = toText(source).toLocaleLowerCase();
    const candidateText = toText(candidate).toLocaleLowerCase();
    if (!sourceText || !candidateText) {
        return sourceText === candidateText ? 1 : 0;
    }

    const sourceVector = termVector(tokenizeSimilarityText(sourceText));
    const candidateVector = termVector(tokenizeSimilarityText(candidateText));
    let dot = 0;
    let sourceMagnitude = 0;
    let candidateMagnitude = 0;

    for (const count of sourceVector.values()) {
        sourceMagnitude += count * count;
    }

    for (const [token, count] of candidateVector) {
        candidateMagnitude += count * count;
        dot += count * (sourceVector.get(token) ?? 0);
    }

    const cosine = sourceMagnitude && candidateMagnitude
        ? dot / (Math.sqrt(sourceMagnitude) * Math.sqrt(candidateMagnitude))
        : 0;
    const substringBonus = sourceText.includes(candidateText) || candidateText.includes(sourceText) ? 0.15 : 0;

    return cosine + substringBonus;
}

function rankSimilarityCandidates(source, candidates) {
    return candidates
        .map((candidate, index) => ({
            candidate,
            index,
            score: lexicalSimilarityScore(source, candidate),
        }))
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map(item => item.candidate);
}

async function removeTriggerMessage(index, runtime, result) {
    const records = getMessageRecords(runtime);
    if (!Number.isInteger(index) || index < 0 || index >= records.length) {
        return;
    }

    if (typeof runtime.deleteMessage === 'function') {
        await runtime.deleteMessage(index);
    } else if (Array.isArray(runtime.messages)) {
        runtime.messages.splice(index, 1);
    }
    result.chatChanged = true;
}

async function executeRisuCommandFallback(command, pipe, runtime, result, trigger) {
    if (typeof runtime.executeCommand !== 'function') {
        result.unsupported.push({ type: 'command', reason: 'unknown-command', command, trigger: trigger.comment });
        return false;
    }

    const fallbackResult = await runtime.executeCommand(command, pipe);
    if (fallbackResult === false) {
        result.unsupported.push({ type: 'command', reason: 'external-command-failed', command, trigger: trigger.comment });
        return false;
    }
    if (typeof fallbackResult === 'string') {
        return fallbackResult;
    }
    if (fallbackResult && typeof fallbackResult === 'object') {
        result.changed = result.changed || Boolean(fallbackResult.changed);
        result.chatChanged = result.chatChanged || Boolean(fallbackResult.chatChanged);
        result.refresh = result.refresh || Boolean(fallbackResult.refresh);
        return toText(fallbackResult.pipe ?? pipe);
    }

    return pipe;
}

async function processRisuCommand(command, pipe, trigger, triggers, runtime, state, result) {
    const parsed = await parseRisuCommand(command, pipe, runtime);
    const { commandName, arg, namedArg } = parsed;

    switch (commandName) {
        case '':
            return pipe;
        case 'input':
            return toText(await runtime.promptInput?.(arg) ?? '');
        case 'echo':
        case 'popup':
            await runtime.notify?.('info', arg);
            return pipe;
        case 'pass':
            return arg;
        case 'buttons': {
            const options = parseRisuCommandOptions(namedArg.labels ?? arg);
            const selected = await runtime.promptSelect?.(options, namedArg.display ?? '');
            return selected ?? pipe;
        }
        case 'speak':
            if (runtime.speak) {
                await runtime.speak(arg);
                return pipe;
            }
            result.unsupported.push({ type: 'command', reason: 'speak-not-supported', trigger: trigger.comment });
            return pipe;
        case 'send':
            await addTriggerMessage('user', arg, runtime, result);
            return pipe;
        case 'sendas':
            await addTriggerMessage('char', arg, runtime, result);
            return pipe;
        case 'comment': {
            const records = getMessageRecords(runtime);
            const index = records.length - 1;
            const original = index >= 0 ? normaliseMessage(records[index]) : '';
            if (index >= 0) {
                await modifyTriggerMessage(index, `${original}<Comment>\n${arg}\n</Comment>`, runtime, result);
            }
            return pipe;
        }
        case 'cut': {
            if (/^-?\d+\s*-\s*-?\d+$/.test(arg)) {
                const [start, end] = arg.split('-').map(value => Number(value.trim()));
                await cutTriggerChat(start, end, runtime, result);
                return pipe;
            }
            const index = Number(arg);
            if (Number.isInteger(index)) {
                await removeTriggerMessage(index, runtime, result);
            }
            return pipe;
        }
        case 'del': {
            const size = Number(arg);
            const records = getMessageRecords(runtime);
            if (Number.isInteger(size) && size >= 0) {
                await cutTriggerChat(Math.max(0, records.length - size), records.length, runtime, result);
            }
            return pipe;
        }
        case 'len': {
            try {
                const parsed = JSON.parse(arg);
                return Array.isArray(parsed) ? String(parsed.length) : pipe;
            } catch {
                return arg ? String(parseRisuCommandOptions(arg).length) : pipe;
            }
        }
        case 'multisend': {
            const messages = arg.split('|||');
            const clearMode = messages[0]?.trim() === 'clear';
            if (clearMode) {
                messages.shift();
                await cutTriggerChat(0, 0, runtime, result);
            }
            for (const message of messages) {
                await addTriggerMessage('user', message, runtime, result);
            }
            return '';
        }
        case 'setvar':
            await setRisuVariable(namedArg.key, arg, runtime, result);
            return '';
        case 'addvar': {
            const key = namedArg.key;
            const next = (Number(resolveRisuTriggerVariable(key, runtime)) || 0) + (Number(arg) || 0);
            await setRisuVariable(key, String(next), runtime, result);
            return '';
        }
        case 'getvar':
            return toRisuNull(resolveRisuTriggerVariable(namedArg.key, runtime));
        case 'trigger':
            await runMatchingTriggers(triggers, arg, runtime, {
                ...state,
                recursiveCount: state.recursiveCount + 1,
            }, result);
            return pipe;
        case '?':
            await runtime.notify?.('info', 'Risu command help is available in RisuAI. Common commands are /input, /buttons, /send, /sendas, /setvar, /getvar, and /trigger.');
            return 'help';
        default:
            return await executeRisuCommandFallback(command.trim(), pipe, runtime, result, trigger);
    }
}

async function processRisuCommandPipeline(command, trigger, triggers, runtime, state, result) {
    let pipe = '';
    for (const part of splitRisuCommandPipeline(toText(command))) {
        const nextPipe = await processRisuCommand(part.trim(), pipe, trigger, triggers, runtime, state, result);
        if (nextPipe === false) {
            return false;
        }
        pipe = toText(nextPipe);
    }
    return pipe;
}

function splitStringByDelimiter(source, delimiter, delimiterType) {
    if (delimiterType !== 'regex') {
        return toText(source).split(toText(delimiter));
    }

    try {
        const regexMatch = toText(delimiter).match(/^\/(.+)\/([gimsuy]*)$/);
        const regex = regexMatch ? new RegExp(regexMatch[1], regexMatch[2]) : new RegExp(toText(delimiter));
        return toText(source).split(regex);
    } catch {
        return [toText(source)];
    }
}

function stripLuaComments(body) {
    return body
        .split('\n')
        .map(line => line.replace(/--.*$/, ''))
        .join('\n');
}

function splitLuaArguments(argText, env) {
    const args = [];
    let current = '';
    let quote = '';

    for (let index = 0; index < argText.length; index++) {
        const char = argText[index];
        if (quote) {
            current += char;
            if (char === quote && argText[index - 1] !== '\\') {
                quote = '';
            }
            continue;
        }

        if (char === '"' || char === '\'') {
            quote = char;
            current += char;
            continue;
        }

        if (char === ',') {
            args.push(resolveLuaValue(current, env));
            current = '';
            continue;
        }

        current += char;
    }

    if (current.trim() || argText.trim().endsWith(',')) {
        args.push(resolveLuaValue(current, env));
    }

    return args;
}

function resolveLuaValue(value, env) {
    const trimmed = value.trim();
    const quoted = trimmed.match(/^(['"])([\s\S]*)\1$/);
    if (quoted) {
        return quoted[2].replace(/\\(["'\\])/g, '$1');
    }

    if (env.has(trimmed)) {
        return env.get(trimmed);
    }

    return trimmed;
}

async function applyLuaVariableSet(name, value, runtime, result, changedOnly) {
    if (!name) {
        return;
    }

    if (changedOnly && resolveRisuTriggerVariable(name, runtime) === value) {
        return;
    }

    await runtime.setVariable?.(name, value);
    result.changed = true;
}

async function executeRisuLuaCalls(body, runtime, result, functions, env, depth) {
    const callPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)\)/g;
    let match;

    while ((match = callPattern.exec(body))) {
        const callName = match[1];
        const args = splitLuaArguments(match[2], env);

        if (callName === 'setVarIfChanged') {
            await applyLuaVariableSet(args[1], args[2] ?? '', runtime, result, true);
            continue;
        }

        if (callName === 'setChatVar') {
            await applyLuaVariableSet(args[1], args[2] ?? '', runtime, result, false);
            continue;
        }

        if (callName === 'refreshScreen') {
            result.refresh = true;
            continue;
        }

        if (functions.has(callName) && depth < 5) {
            await executeRisuLuaFunctionBody(functions.get(callName), runtime, result, functions, new Map(env), depth + 1);
        }
    }
}

async function executeRisuLuaFunctionBody(body, runtime, result, functions, env = new Map(), depth = 0) {
    const source = stripLuaComments(body);
    const localGetPattern = /\blocal\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*getChatVar\s*\([^,]+,\s*(['"])(.*?)\2\s*\)/g;
    let localMatch;
    while ((localMatch = localGetPattern.exec(source))) {
        env.set(localMatch[1], resolveRisuTriggerVariable(localMatch[3], runtime));
    }

    let cursor = 0;
    const ifPattern = /\bif\s+([A-Za-z_][A-Za-z0-9_]*)\s*(==|~=)\s*(['"])(.*?)\3\s*then/g;
    let ifMatch;
    while ((ifMatch = ifPattern.exec(source))) {
        await executeRisuLuaCalls(source.slice(cursor, ifMatch.index), runtime, result, functions, env, depth);

        const endIndex = findLuaBlockEnd(source, ifPattern.lastIndex);
        if (endIndex === -1) {
            result.unsupported.push({ type: 'triggerlua', reason: 'unmatched-if' });
            cursor = ifPattern.lastIndex;
            continue;
        }

        const block = source.slice(ifPattern.lastIndex, endIndex);
        const elseMatch = block.match(/\belse\b/);
        const left = env.get(ifMatch[1]) ?? '';
        const right = ifMatch[4];
        const passes = ifMatch[2] === '==' ? left === right : left !== right;
        const trueBody = elseMatch ? block.slice(0, elseMatch.index) : block;
        const falseBody = elseMatch ? block.slice(elseMatch.index + elseMatch[0].length) : '';

        await executeRisuLuaFunctionBody(passes ? trueBody : falseBody, runtime, result, functions, new Map(env), depth + 1);
        cursor = endIndex + 3;
        ifPattern.lastIndex = cursor;
    }

    await executeRisuLuaCalls(source.slice(cursor), runtime, result, functions, env, depth);
}

async function runRisuLuaButtonShim(triggers, functionName, runtime, result) {
    if (!runtime.codeSandboxEnabled) {
        result.unsupported.push({ type: 'triggerlua', reason: 'code-sandbox-disabled', trigger: functionName });
        return false;
    }

    for (const trigger of triggers) {
        const effects = Array.isArray(trigger?.effect) ? trigger.effect : [];
        for (const effect of effects) {
            if (effect?.type !== 'triggerlua' || typeof effect.code !== 'string') {
                continue;
            }

            const functions = extractRisuLuaFunctions(effect.code);
            if (!functions.has(functionName)) {
                continue;
            }

            result.ran = true;
            await executeRisuLuaFunctionBody(functions.get(functionName), runtime, result, functions);
            return result;
        }
    }

    return result;
}

function isLuaFunctionLibraryOnly(code) {
    if (typeof code !== 'string') {
        return false;
    }

    let source = stripLuaComments(code).trim();
    const spans = extractRisuLuaFunctionSpans(source);
    if (!spans.length) {
        return false;
    }

    for (const span of spans.sort((a, b) => b.start - a.start)) {
        source = `${source.slice(0, span.start)}${source.slice(span.end)}`.trim();
    }

    return source === '';
}

async function applyEffect(effect, trigger, triggers, runtime, result, state) {
    if (shouldSkipEffectForPermissions(effect, trigger, runtime, result)) {
        return;
    }

    switch (effect.type) {
        case 'setvar': {
            const varKey = await evaluateText(effect.var, runtime, { source: 'effect-var' });
            const effectValue = await evaluateText(effect.value, runtime, { source: 'effect-value' });
            const originalValue = resolveRisuTriggerVariable(varKey, runtime);
            await setRisuVariable(varKey, applyAssignment(effect.operator, originalValue, effectValue), runtime, result);
            return;
        }
        case 'v2SetVar': {
            const varKey = await evaluateText(effect.var, runtime, { source: 'effect-var' });
            const effectValue = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            const originalValue = resolveRisuTriggerVariable(varKey, runtime);
            await setRisuVariable(varKey, applyAssignment(effect.operator, originalValue, effectValue), runtime, result);
            return;
        }
        case 'systemprompt':
        case 'v2SystemPrompt': {
            const value = effect.type === 'systemprompt'
                ? await evaluateText(effect.value, runtime, { source: 'effect-value' })
                : await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            await addSystemPrompt(effect.location, value, runtime, result);
            return;
        }
        case 'impersonate':
        case 'v2Impersonate': {
            const value = effect.type === 'impersonate'
                ? await evaluateText(effect.value, runtime, { source: 'effect-value' })
                : await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            await addTriggerMessage(effect.role, value, runtime, result);
            return;
        }
        case 'command':
        case 'v2Command': {
            const value = effect.type === 'command'
                ? toText(effect.value)
                : effect.valueType === 'var'
                    ? await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' })
                    : toText(effect.value);
            const commandPipe = await processRisuCommandPipeline(value, trigger, triggers, runtime, state, result);
            if (commandPipe !== false) {
                result.commandPipe = commandPipe;
            }
            return;
        }
        case 'runImgGen':
        case 'v2ImgGen': {
            const setOutput = async (value) => {
                if (effect.type === 'runImgGen') {
                    await setRisuVariable(await evaluateText(effect.inputVar, runtime, { source: 'effect-output-var' }), value, runtime, result);
                } else {
                    await setOutputVariable(effect, value, runtime, result);
                }
            };

            const lowLevelReason = getLowLevelAccessReason(trigger, runtime);
            if (lowLevelReason) {
                result.unsupported.push({ type: effect.type, reason: lowLevelReason, trigger: trigger.comment });
                if (effect.type === 'v2ImgGen') {
                    await setOutput('null');
                }
                return;
            }

            if (typeof runtime.generateImage !== 'function') {
                result.unsupported.push({ type: effect.type, reason: 'image-runtime-unavailable', trigger: trigger.comment });
                await setOutput(effect.type === 'runImgGen' ? 'Error: Image generation runtime unavailable' : 'null');
                return;
            }

            const value = effect.type === 'runImgGen'
                ? await evaluateText(effect.value, runtime, { source: 'effect-value' })
                : await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            const negativeValue = effect.type === 'runImgGen'
                ? await evaluateText(effect.negValue, runtime, { source: 'effect-negative-value' })
                : await resolveValue(effect.negValue, effect.negValueType, runtime, { source: 'effect-negative-value' });

            try {
                const imageUrl = await runtime.generateImage(value, negativeValue, { trigger: trigger.comment });
                if (!imageUrl) {
                    await setOutput(effect.type === 'runImgGen' ? 'Error: Image generation failed' : 'null');
                    return;
                }
                await setOutput(`{{inlay::${imageUrl}}}`);
                result.refresh = true;
            } catch (error) {
                result.unsupported.push({ type: effect.type, reason: 'image-request-failed', message: error?.message, trigger: trigger.comment });
                await setOutput(effect.type === 'runImgGen' ? `Error: ${error?.message ?? 'Image generation failed'}` : 'null');
            }
            return;
        }
        case 'checkSimilarity':
        case 'v2CheckSimilarity': {
            const setOutput = async (value) => {
                if (effect.type === 'checkSimilarity') {
                    await setRisuVariable(await evaluateText(effect.inputVar, runtime, { source: 'effect-output-var' }), value, runtime, result);
                } else {
                    await setOutputVariable(effect, value, runtime, result);
                }
            };

            const lowLevelReason = getLowLevelAccessReason(trigger, runtime);
            if (lowLevelReason) {
                result.unsupported.push({ type: effect.type, reason: lowLevelReason, trigger: trigger.comment });
                if (effect.type === 'v2CheckSimilarity') {
                    await setOutput('null');
                }
                return;
            }

            const source = effect.type === 'checkSimilarity'
                ? await evaluateText(effect.source, runtime, { source: 'effect-source' })
                : await resolveValue(effect.source, effect.sourceType, runtime, { source: 'effect-source' });
            const value = effect.type === 'checkSimilarity'
                ? await evaluateText(effect.value, runtime, { source: 'effect-value' })
                : await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            const candidates = splitRisuSectionList(value);

            try {
                const ranked = typeof runtime.checkSimilarity === 'function'
                    ? await runtime.checkSimilarity(source, candidates, { trigger: trigger.comment })
                    : rankSimilarityCandidates(source, candidates);
                const rankedCandidates = Array.isArray(ranked) ? ranked : splitRisuSectionList(ranked);
                await setOutput(rankedCandidates.map(toText).join('\u00a7'));
            } catch (error) {
                runtime.log?.(`Vector similarity unavailable; using lexical fallback. ${error?.message ?? error}`);
                await setOutput(rankSimilarityCandidates(source, candidates).map(toText).join('\u00a7'));
            }
            return;
        }
        case 'runLLM':
        case 'runAxLLM':
        case 'v2RunLLM': {
            const outputVar = effect.type === 'v2RunLLM' ? effect.outputVar : effect.inputVar;
            const setOutput = async (value) => {
                if (effect.type === 'runLLM' || effect.type === 'runAxLLM') {
                    await setRisuVariable(await evaluateText(outputVar, runtime, { source: 'effect-output-var' }), value, runtime, result);
                } else {
                    await setOutputVariable(effect, value, runtime, result);
                }
            };

            const lowLevelReason = getLowLevelAccessReason(trigger, runtime);
            if (lowLevelReason) {
                result.unsupported.push({ type: effect.type, reason: lowLevelReason, trigger: trigger.comment });
                if (effect.type === 'v2RunLLM') {
                    await setOutput('null');
                }
                return;
            }

            if (typeof runtime.runLLM !== 'function') {
                result.unsupported.push({ type: effect.type, reason: 'llm-runtime-unavailable', trigger: trigger.comment });
                await setOutput(effect.type === 'v2RunLLM' ? 'null' : 'Error: LLM runtime unavailable');
                return;
            }

            const value = effect.type === 'v2RunLLM'
                ? await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' })
                : await evaluateText(effect.value, runtime, { source: 'effect-value' });
            const prompt = parseRisuChatML(value) ?? value;

            try {
                const generated = await runtime.runLLM(prompt, {
                    model: effect.type === 'runAxLLM' ? 'otherAx' : effect.model ?? 'model',
                    streaming: Boolean(effect.streaming),
                    trigger: trigger.comment,
                });
                await setOutput(toText(generated));
            } catch (error) {
                result.unsupported.push({ type: effect.type, reason: 'llm-request-failed', message: error?.message, trigger: trigger.comment });
                await setOutput(effect.type === 'v2RunLLM' ? 'null' : `Error: ${error?.message ?? 'LLM request failed'}`);
            }
            return;
        }
        case 'cutchat':
        case 'v2CutChat': {
            const start = effect.type === 'cutchat'
                ? await evaluateText(effect.start, runtime, { source: 'effect-start' })
                : await resolveValue(effect.start, effect.startType, runtime, { source: 'effect-start' });
            const end = effect.type === 'cutchat'
                ? await evaluateText(effect.end, runtime, { source: 'effect-end' })
                : await resolveValue(effect.end, effect.endType, runtime, { source: 'effect-end' });
            await cutTriggerChat(Number(start), Number(end), runtime, result);
            return;
        }
        case 'modifychat':
        case 'v2ModifyChat': {
            const index = effect.type === 'modifychat'
                ? await evaluateText(effect.index, runtime, { source: 'effect-index' })
                : await resolveValue(effect.index, effect.indexType, runtime, { source: 'effect-index' });
            const value = effect.type === 'modifychat'
                ? await evaluateText(effect.value, runtime, { source: 'effect-value' })
                : await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            await modifyTriggerMessage(Number(index), value, runtime, result);
            return;
        }
        case 'extractRegex':
        case 'v2ExtractRegex': {
            const value = effect.type === 'extractRegex'
                ? await evaluateText(effect.value, runtime, { source: 'effect-value' })
                : await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            const pattern = effect.type === 'extractRegex'
                ? await evaluateText(effect.regex, runtime, { source: 'effect-regex' })
                : await resolveValue(effect.regex, effect.regexType, runtime, { source: 'effect-regex' });
            const flags = effect.type === 'extractRegex'
                ? await evaluateText(effect.flags, runtime, { source: 'effect-flags' })
                : await resolveValue(effect.flags, effect.flagsType, runtime, { source: 'effect-flags' });
            const format = effect.type === 'extractRegex'
                ? await evaluateText(effect.result, runtime, { source: 'effect-result' })
                : await resolveValue(effect.result, effect.resultType, runtime, { source: 'effect-result' });
            const regex = safeRegex(pattern, flags);
            const extracted = applyRegexReplacement(format, regex?.exec(value) ?? null);
            if (effect.type === 'extractRegex') {
                await setRisuVariable(await evaluateText(effect.inputVar, runtime, { source: 'effect-output-var' }), extracted, runtime, result);
            } else {
                await setOutputVariable(effect, extracted, runtime, result);
            }
            return;
        }
        case 'showAlert':
        case 'v2ShowAlert': {
            const value = effect.type === 'showAlert'
                ? await evaluateText(effect.value, runtime, { source: 'effect-value' })
                : await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            const alertType = effect.alertType === 'error' ? 'error' : 'info';
            await runtime.notify?.(alertType, value);
            if (effect.type === 'showAlert' && (effect.alertType === 'input' || effect.alertType === 'select')) {
                result.unsupported.push({ type: effect.type, reason: `${effect.alertType}-requires-user-input`, trigger: trigger.comment });
            }
            return;
        }
        case 'v2DeclareLocalVar': {
            const varKey = await evaluateText(effect.var, runtime, { source: 'effect-var' });
            const effectValue = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            state.localVariables.set(varKey, {
                value: effectValue || 'null',
                indent: Number(effect.indent ?? state.currentIndent) || 0,
            });
            return;
        }
        case 'runtrigger':
        case 'v2RunTrigger': {
            if (state.recursiveCount >= MAX_RECURSION_DEPTH && !trigger.lowLevelAccess) {
                result.unsupported.push({ type: effect.type, reason: 'recursion-limit', target: effect.value ?? effect.target });
                return;
            }

            await runMatchingTriggers(triggers, effect.value ?? effect.target, runtime, {
                ...state,
                recursiveCount: state.recursiveCount + 1,
            }, result);
            return;
        }
        case 'v2ConsoleLog': {
            const source = await resolveValue(effect.source, effect.sourceType, runtime, { source: 'effect-source' });
            runtime.log?.(source);
            return;
        }
        case 'v2GetLastMessage':
            await setOutputVariable(effect, getMessages(runtime).at(-1) ?? 'null', runtime, result);
            return;
        case 'v2GetMessageAtIndex': {
            const index = Number(await resolveValue(effect.index, effect.indexType, runtime, { source: 'effect-index' }));
            await setOutputVariable(effect, getMessages(runtime)[normaliseIndex(index, getMessages(runtime).length)] ?? 'null', runtime, result);
            return;
        }
        case 'v2GetMessageCount':
            await setOutputVariable(effect, String(getMessages(runtime).length), runtime, result);
            return;
        case 'v2GetLastUserMessage': {
            const messages = getMessageRecords(runtime);
            const message = [...messages].reverse().find(item => getMessageRole(item) === 'user');
            await setOutputVariable(effect, message ? normaliseMessage(message) : 'null', runtime, result);
            return;
        }
        case 'v2GetLastCharMessage': {
            const messages = getMessageRecords(runtime);
            const message = [...messages].reverse().find(item => getMessageRole(item) === 'char');
            await setOutputVariable(effect, message ? normaliseMessage(message) : 'null', runtime, result);
            return;
        }
        case 'v2ModifyLorebook': {
            const entries = await getLorebookEntries(runtime);
            const target = await resolveValue(effect.target, effect.targetType, runtime, { source: 'effect-target' });
            const value = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            const entry = entries[findLorebookIndex(entries, target)];
            if (entry) {
                setLorebookContent(entry, value);
                await setLorebookEntries(entries, runtime, result);
            }
            return;
        }
        case 'v2GetLorebook': {
            const entries = await getLorebookEntries(runtime);
            const target = await resolveValue(effect.target, effect.targetType, runtime, { source: 'effect-target' });
            const entry = entries[findLorebookIndex(entries, target)];
            await setOutputVariable(effect, entry ? getLorebookContent(entry) : 'null', runtime, result);
            return;
        }
        case 'v2GetLorebookCount':
        case 'v2GetLorebookCountNew': {
            const entries = await getLorebookEntries(runtime);
            await setOutputVariable(effect, String(entries.length), runtime, result);
            return;
        }
        case 'v2GetLorebookEntry':
        case 'v2GetLorebookByIndex': {
            const entries = await getLorebookEntries(runtime);
            const index = Number(await resolveValue(effect.index, effect.indexType, runtime, { source: 'effect-index' }));
            const entry = Number.isInteger(index) && index >= 0 ? entries[index] : null;
            await setOutputVariable(effect, entry ? getLorebookContent(entry) : 'null', runtime, result);
            return;
        }
        case 'v2SetLorebookActivation': {
            const entries = await getLorebookEntries(runtime);
            const index = Number(await resolveValue(effect.index, effect.indexType, runtime, { source: 'effect-index' }));
            const entry = Number.isInteger(index) && index >= 0 ? entries[index] : null;
            if (entry) {
                setLorebookActivation(entry, effect.value);
                await setLorebookEntries(entries, runtime, result);
            }
            return;
        }
        case 'v2GetLorebookIndexViaName': {
            const entries = await getLorebookEntries(runtime);
            const name = await resolveValue(effect.name, effect.nameType, runtime, { source: 'effect-name' });
            await setOutputVariable(effect, String(findLorebookIndex(entries, name)), runtime, result);
            return;
        }
        case 'v2GetAllLorebooks': {
            const entries = await getLorebookEntries(runtime);
            await setOutputVariable(effect, JSON.stringify(entries.map(getLorebookContent)), runtime, result);
            return;
        }
        case 'v2GetLorebookByName': {
            const entries = await getLorebookEntries(runtime);
            const name = await resolveValue(effect.name, effect.nameType, runtime, { source: 'effect-name' });
            const regex = safeRegex(name, 'i');
            const matches = entries
                .map((entry, index) => ({ entry, index }))
                .filter(({ entry }) => regex ? regex.test(getLorebookName(entry)) : getLorebookName(entry).toLowerCase().includes(toText(name).toLowerCase()))
                .map(({ index }) => index);
            await setOutputVariable(effect, JSON.stringify(matches), runtime, result);
            return;
        }
        case 'v2CreateLorebook': {
            const entries = await getLorebookEntries(runtime);
            const name = await resolveValue(effect.name, effect.nameType, runtime, { source: 'effect-name' });
            const key = await resolveValue(effect.key, effect.keyType, runtime, { source: 'effect-key' });
            const content = await resolveValue(effect.content, effect.contentType, runtime, { source: 'effect-content' });
            const insertOrder = await resolveValue(effect.insertOrder, effect.insertOrderType, runtime, { source: 'effect-insert-order' });
            entries.push(createLorebookEntry(name, key, content, insertOrder));
            await setLorebookEntries(entries, runtime, result);
            return;
        }
        case 'v2ModifyLorebookByIndex': {
            const entries = await getLorebookEntries(runtime);
            const index = Number(await resolveValue(effect.index, effect.indexType, runtime, { source: 'effect-index' }));
            const entry = Number.isInteger(index) && index >= 0 ? entries[index] : null;
            if (!entry) {
                return;
            }

            const name = await resolveValue(effect.name, effect.nameType, runtime, { source: 'effect-name' });
            const key = await resolveValue(effect.key, effect.keyType, runtime, { source: 'effect-key' });
            const content = await resolveValue(effect.content, effect.contentType, runtime, { source: 'effect-content' });
            const insertOrder = await resolveValue(effect.insertOrder, effect.insertOrderType, runtime, { source: 'effect-insert-order' });

            setLorebookName(entry, replaceLorebookSlot(name, getLorebookName(entry)));
            setLorebookKeys(entry, replaceLorebookSlot(key, getLorebookKeyText(entry)));
            setLorebookContent(entry, replaceLorebookSlot(content, getLorebookContent(entry)));
            setLorebookOrder(entry, replaceLorebookSlot(insertOrder, entry?.insertion_order ?? entry?.insertorder ?? 100));
            await setLorebookEntries(entries, runtime, result);
            return;
        }
        case 'v2DeleteLorebookByIndex': {
            const entries = await getLorebookEntries(runtime);
            const index = Number(await resolveValue(effect.index, effect.indexType, runtime, { source: 'effect-index' }));
            if (Number.isInteger(index) && index >= 0 && index < entries.length) {
                entries.splice(index, 1);
                await setLorebookEntries(entries, runtime, result);
            }
            return;
        }
        case 'v2SetLorebookAlwaysActive': {
            const entries = await getLorebookEntries(runtime);
            const index = Number(await resolveValue(effect.index, effect.indexType, runtime, { source: 'effect-index' }));
            const entry = Number.isInteger(index) && index >= 0 ? entries[index] : null;
            if (entry) {
                setLorebookAlwaysActive(entry, effect.value);
                await setLorebookEntries(entries, runtime, result);
            }
            return;
        }
        case 'v2GetFirstMessage':
            await setOutputVariable(effect, await getFirstMessage(runtime), runtime, result);
            return;
        case 'v2GetAlertInput': {
            if (runtime.displayMode) {
                return;
            }
            const display = await resolveValue(effect.display, effect.displayType, runtime, { source: 'effect-display' });
            const value = await runtime.promptInput?.(display);
            await setOutputVariable(effect, value ?? 'null', runtime, result);
            return;
        }
        case 'v2GetAlertSelect': {
            if (runtime.displayMode) {
                return;
            }
            const display = await resolveValue(effect.display, effect.displayType, runtime, { source: 'effect-display' });
            const value = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            const options = toText(value).split('|');
            const selected = await runtime.promptSelect?.(options, display);
            await setOutputVariable(effect, selected ?? 'null', runtime, result);
            return;
        }
        case 'v2GetDisplayState': {
            const displayData = await getDisplayData(runtime);
            if (displayData !== null) {
                await setOutputVariable(effect, displayData || 'null', runtime, result);
            }
            return;
        }
        case 'v2SetDisplayState': {
            if (!hasDisplayData(runtime)) {
                return;
            }
            const value = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            await setDisplayData(value, runtime, result);
            return;
        }
        case 'v2UpdateGUI':
            result.refresh = true;
            return;
        case 'v2UpdateChatAt': {
            const index = Number(await evaluateText(effect.index, runtime, { source: 'effect-index' }));
            if (Number.isInteger(index)) {
                result.chatRefreshIndexes.push(index);
            }
            result.refresh = true;
            return;
        }
        case 'v2Wait': {
            const value = Number(await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-wait' }));
            if (!Number.isFinite(value) || value <= 0) {
                return;
            }

            const milliseconds = Math.min(value * 1000, MAX_WAIT_MS);
            if (milliseconds < value * 1000) {
                result.unsupported.push({ type: effect.type, reason: 'wait-clamped', trigger: trigger.comment });
            }

            if (runtime.delay) {
                await runtime.delay(milliseconds);
            } else {
                await sleep(milliseconds);
            }
            return;
        }
        case 'v2GetRequestState': {
            const requestState = await getRequestState(runtime);
            if (!requestState) {
                return;
            }
            const index = Number(await resolveValue(effect.index, effect.indexType, runtime, { source: 'effect-index' }));
            await setOutputVariable(effect, requestState[index]?.content ?? 'null', runtime, result);
            return;
        }
        case 'v2SetRequestState': {
            const requestState = await getRequestState(runtime);
            if (!requestState) {
                return;
            }
            const index = Number(await resolveValue(effect.index, effect.indexType, runtime, { source: 'effect-index' }));
            const value = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            if (requestState[index] && typeof requestState[index] === 'object') {
                requestState[index].content = value;
                await setRequestState(requestState, runtime, result);
            }
            return;
        }
        case 'v2GetRequestStateRole': {
            const requestState = await getRequestState(runtime);
            if (!requestState) {
                return;
            }
            const index = Number(await resolveValue(effect.index, effect.indexType, runtime, { source: 'effect-index' }));
            await setOutputVariable(effect, requestState[index]?.role ?? 'null', runtime, result);
            return;
        }
        case 'v2SetRequestStateRole': {
            const requestState = await getRequestState(runtime);
            if (!requestState) {
                return;
            }
            const index = Number(await resolveValue(effect.index, effect.indexType, runtime, { source: 'effect-index' }));
            const value = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            if (requestState[index] && typeof requestState[index] === 'object' && ['user', 'assistant', 'system'].includes(value)) {
                requestState[index].role = value;
                await setRequestState(requestState, runtime, result);
            }
            return;
        }
        case 'v2GetRequestStateLength': {
            const requestState = await getRequestState(runtime);
            if (requestState) {
                await setOutputVariable(effect, String(requestState.length), runtime, result);
            }
            return;
        }
        case 'v2QuickSearchChat':
            await quickSearchChat(effect, runtime, result);
            return;
        case 'v2RegexTest': {
            const value = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            const pattern = await resolveValue(effect.regex, effect.regexType, runtime, { source: 'effect-regex' });
            const flags = await resolveValue(effect.flags, effect.flagsType, runtime, { source: 'effect-flags' });
            await setOutputVariable(effect, safeRegex(pattern, flags)?.test(value) ? '1' : '0', runtime, result);
            return;
        }
        case 'v2Random': {
            const min = Number(await resolveValue(effect.min, effect.minType, runtime, { source: 'effect-min' }));
            const max = Number(await resolveValue(effect.max, effect.maxType, runtime, { source: 'effect-max' }));
            const safeMin = Number.isFinite(min) ? min : 0;
            const safeMax = Number.isFinite(max) ? max : safeMin;
            await setOutputVariable(effect, String(Math.floor(Math.random() * (safeMax - safeMin + 1) + safeMin)), runtime, result);
            return;
        }
        case 'v2GetCharAt': {
            const source = await resolveValue(effect.source, effect.sourceType, runtime, { source: 'effect-source' });
            const index = Number(await resolveValue(effect.index, effect.indexType, runtime, { source: 'effect-index' }));
            await setOutputVariable(effect, toText(source)[index] ?? 'null', runtime, result);
            return;
        }
        case 'v2GetCharCount': {
            const source = await resolveValue(effect.source, effect.sourceType, runtime, { source: 'effect-source' });
            await setOutputVariable(effect, String(toText(source).length), runtime, result);
            return;
        }
        case 'v2ToLowerCase': {
            const source = await resolveValue(effect.source, effect.sourceType, runtime, { source: 'effect-source' });
            await setOutputVariable(effect, toText(source).toLowerCase(), runtime, result);
            return;
        }
        case 'v2ToUpperCase': {
            const source = await resolveValue(effect.source, effect.sourceType, runtime, { source: 'effect-source' });
            await setOutputVariable(effect, toText(source).toUpperCase(), runtime, result);
            return;
        }
        case 'v2SetCharAt': {
            const source = [...await resolveValue(effect.source, effect.sourceType, runtime, { source: 'effect-source' })];
            const index = Number(await resolveValue(effect.index, effect.indexType, runtime, { source: 'effect-index' }));
            const value = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            source[index] = value;
            await setOutputVariable(effect, source.join(''), runtime, result);
            return;
        }
        case 'v2SplitString': {
            const source = await resolveValue(effect.source, effect.sourceType, runtime, { source: 'effect-source' });
            const delimiter = effect.delimiterType === 'regex'
                ? await evaluateText(effect.delimiter, runtime, { source: 'effect-delimiter' })
                : await resolveValue(effect.delimiter, effect.delimiterType, runtime, { source: 'effect-delimiter' });
            await setOutputVariable(effect, JSON.stringify(splitStringByDelimiter(source, delimiter, effect.delimiterType)), runtime, result);
            return;
        }
        case 'v2ConcatString': {
            const source1 = await resolveValue(effect.source1, effect.source1Type, runtime, { source: 'effect-source1' });
            const source2 = await resolveValue(effect.source2, effect.source2Type, runtime, { source: 'effect-source2' });
            await setOutputVariable(effect, source1 + source2, runtime, result);
            return;
        }
        case 'v2Calculate': {
            const expression = await resolveValue(effect.expression, effect.expressionType, runtime, { source: 'effect-expression' });
            await setOutputVariable(effect, evaluateSafeMath(expression, runtime), runtime, result);
            return;
        }
        case 'v2ReplaceString': {
            try {
                const source = await resolveValue(effect.source, effect.sourceType, runtime, { source: 'effect-source' });
                const pattern = await resolveValue(effect.regex, effect.regexType, runtime, { source: 'effect-regex' });
                const flags = await resolveValue(effect.flags, effect.flagsType, runtime, { source: 'effect-flags' });
                const resultFormat = await resolveValue(effect.result, effect.resultType, runtime, { source: 'effect-result' });
                const replacement = await resolveValue(effect.replacement, effect.replacementType, runtime, { source: 'effect-replacement' });
                const regex = safeRegex(pattern, flags);
                const replaced = regex
                    ? source.replace(regex, (...args) => {
                        const match = args[0];
                        const groups = args.slice(1, -2);
                        const targetGroupMatch = resultFormat.match(/^\$(\d+)$/);
                        if (targetGroupMatch) {
                            const targetIndex = Number(targetGroupMatch[1]);
                            if (targetIndex === 0) return replacement;
                            const targetGroup = groups[targetIndex - 1];
                            return targetGroup ? match.replace(targetGroup, replacement) : match;
                        }
                        return applyRegexReplacement(resultFormat, [match, ...groups]);
                    })
                    : source;
                await setOutputVariable(effect, replaced, runtime, result);
            } catch {
                await setOutputVariable(effect, await resolveValue(effect.source, effect.sourceType, runtime, { source: 'effect-source' }), runtime, result);
            }
            return;
        }
        case 'v2Tokenize': {
            const value = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            await setOutputVariable(effect, await tokenCount(value, runtime), runtime, result);
            return;
        }
        case 'v2MakeArrayVar':
            if (!String(effect.var).startsWith('[')) await setRisuVariable(await evaluateText(effect.var, runtime, { source: 'effect-var' }), '[]', runtime, result);
            return;
        case 'v2GetArrayVarLength': {
            const arr = parseJsonArrayValue(resolveRisuTriggerVariable(await evaluateText(effect.var, runtime, { source: 'effect-var' }), runtime));
            await setOutputVariable(effect, String(arr.length), runtime, result);
            return;
        }
        case 'v2GetArrayVar': {
            const arr = parseJsonArrayValue(resolveRisuTriggerVariable(await evaluateText(effect.var, runtime, { source: 'effect-var' }), runtime));
            const index = Number(await resolveValue(effect.index, effect.indexType, runtime, { source: 'effect-index' }));
            await setOutputVariable(effect, arr[index] ?? 'null', runtime, result);
            return;
        }
        case 'v2SetArrayVar': {
            const varKey = await evaluateText(effect.var, runtime, { source: 'effect-var' });
            const arr = parseJsonArrayValue(resolveRisuTriggerVariable(varKey, runtime));
            const index = Number(await resolveValue(effect.index, effect.indexType, runtime, { source: 'effect-index' }));
            if (!Number.isNaN(index)) {
                arr[index] = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
                await setRisuVariable(varKey, JSON.stringify(arr), runtime, result);
            }
            return;
        }
        case 'v2PushArrayVar':
        case 'v2UnshiftArrayVar': {
            const varKey = await evaluateText(effect.var, runtime, { source: 'effect-var' });
            const arr = parseJsonArrayValue(resolveRisuTriggerVariable(varKey, runtime));
            const value = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            effect.type === 'v2PushArrayVar' ? arr.push(value) : arr.unshift(value);
            await setRisuVariable(varKey, JSON.stringify(arr), runtime, result);
            return;
        }
        case 'v2PopArrayVar':
        case 'v2ShiftArrayVar': {
            const varKey = await evaluateText(effect.var, runtime, { source: 'effect-var' });
            const arr = parseJsonArrayValue(resolveRisuTriggerVariable(varKey, runtime));
            const value = effect.type === 'v2PopArrayVar' ? arr.pop() : arr.shift();
            await setOutputVariable(effect, value ?? 'null', runtime, result);
            await setRisuVariable(varKey, JSON.stringify(arr), runtime, result);
            return;
        }
        case 'v2SpliceArrayVar': {
            const varKey = await evaluateText(effect.var, runtime, { source: 'effect-var' });
            const arr = parseJsonArrayValue(resolveRisuTriggerVariable(varKey, runtime));
            const start = Number(await resolveValue(effect.start, effect.startType, runtime, { source: 'effect-start' }));
            const value = await resolveValue(effect.item, effect.itemType, runtime, { source: 'effect-item' });
            arr.splice(Number.isNaN(start) ? 0 : start, 0, value);
            await setRisuVariable(varKey, JSON.stringify(arr), runtime, result);
            return;
        }
        case 'v2SliceArrayVar': {
            const arr = parseJsonArrayValue(resolveRisuTriggerVariable(await evaluateText(effect.var, runtime, { source: 'effect-var' }), runtime));
            const start = Number(await resolveValue(effect.start, effect.startType, runtime, { source: 'effect-start' }));
            const end = Number(await resolveValue(effect.end, effect.endType, runtime, { source: 'effect-end' }));
            await setOutputVariable(effect, JSON.stringify(arr.slice(Number.isNaN(start) ? 0 : start, Number.isNaN(end) ? undefined : end)), runtime, result);
            return;
        }
        case 'v2GetIndexOfValueInArrayVar': {
            const arr = parseJsonArrayValue(resolveRisuTriggerVariable(await evaluateText(effect.var, runtime, { source: 'effect-var' }), runtime));
            const value = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            await setOutputVariable(effect, String(arr.indexOf(value)), runtime, result);
            return;
        }
        case 'v2RemoveIndexFromArrayVar': {
            const varKey = await evaluateText(effect.var, runtime, { source: 'effect-var' });
            const arr = parseJsonArrayValue(resolveRisuTriggerVariable(varKey, runtime));
            const index = Number(await resolveValue(effect.index, effect.indexType, runtime, { source: 'effect-index' }));
            arr.splice(Number.isNaN(index) ? 0 : index, 1);
            await setRisuVariable(varKey, JSON.stringify(arr), runtime, result);
            return;
        }
        case 'v2JoinArrayVar': {
            const arr = parseJsonArrayValue(await resolveValue(effect.var, effect.varType, runtime, { source: 'effect-var' }));
            const delimiter = await resolveValue(effect.delimiter, effect.delimiterType, runtime, { source: 'effect-delimiter' });
            await setOutputVariable(effect, arr.join(delimiter), runtime, result);
            return;
        }
        case 'v2GetCharacterDesc':
            await setOutputVariable(effect, await runtime.getCharacterDescription?.() ?? '', runtime, result);
            return;
        case 'v2SetCharacterDesc': {
            const value = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            await runtime.setCharacterDescription?.(value);
            result.characterChanged = true;
            result.refresh = true;
            return;
        }
        case 'v2GetPersonaDesc':
            await setOutputVariable(effect, await runtime.getPersonaDescription?.() ?? '', runtime, result);
            return;
        case 'v2SetPersonaDesc': {
            const value = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            await runtime.setPersonaDescription?.(value);
            result.settingsChanged = true;
            result.refresh = true;
            return;
        }
        case 'v2GetReplaceGlobalNote':
            await setOutputVariable(effect, await runtime.getReplaceGlobalNote?.() ?? '', runtime, result);
            return;
        case 'v2SetReplaceGlobalNote': {
            const value = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            await runtime.setReplaceGlobalNote?.(value);
            result.characterChanged = true;
            result.refresh = true;
            return;
        }
        case 'v2MakeDictVar':
            if (!String(effect.var).startsWith('{')) await setRisuVariable(await evaluateText(effect.var, runtime, { source: 'effect-var' }), '{}', runtime, result);
            return;
        case 'v2GetDictVar': {
            const dict = parseJsonObjectValue(await resolveValue(effect.var, effect.varType, runtime, { source: 'effect-var' }));
            const key = await resolveValue(effect.key, effect.keyType, runtime, { source: 'effect-key' });
            await setOutputVariable(effect, dict[key] ?? 'null', runtime, result);
            return;
        }
        case 'v2SetDictVar': {
            if (effect.varType === 'value') return;
            const varKey = await evaluateText(effect.var, runtime, { source: 'effect-var' });
            const dict = parseJsonObjectValue(resolveRisuTriggerVariable(varKey, runtime));
            const key = await resolveValue(effect.key, effect.keyType, runtime, { source: 'effect-key' });
            dict[key] = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            await setRisuVariable(varKey, JSON.stringify(dict), runtime, result);
            return;
        }
        case 'v2DeleteDictKey': {
            if (effect.varType === 'value') return;
            const varKey = await evaluateText(effect.var, runtime, { source: 'effect-var' });
            const dict = parseJsonObjectValue(resolveRisuTriggerVariable(varKey, runtime));
            const key = await resolveValue(effect.key, effect.keyType, runtime, { source: 'effect-key' });
            delete dict[key];
            await setRisuVariable(varKey, JSON.stringify(dict), runtime, result);
            return;
        }
        case 'v2HasDictKey': {
            const dict = parseJsonObjectValue(await resolveValue(effect.var, effect.varType, runtime, { source: 'effect-var' }));
            const key = await resolveValue(effect.key, effect.keyType, runtime, { source: 'effect-key' });
            await setOutputVariable(effect, Object.hasOwn(dict, key) ? '1' : '0', runtime, result);
            return;
        }
        case 'v2ClearDict': {
            const varKey = await evaluateText(effect.var, runtime, { source: 'effect-var' });
            await setRisuVariable(varKey, '{}', runtime, result);
            return;
        }
        case 'v2GetDictSize':
        case 'v2GetDictKeys':
        case 'v2GetDictValues': {
            const dict = parseJsonObjectValue(await resolveValue(effect.var, effect.varType, runtime, { source: 'effect-var' }));
            const value = effect.type === 'v2GetDictSize'
                ? String(Object.keys(dict).length)
                : JSON.stringify(effect.type === 'v2GetDictKeys' ? Object.keys(dict) : Object.values(dict));
            await setOutputVariable(effect, value, runtime, result);
            return;
        }
        case 'v2GetAuthorNote':
            await setOutputVariable(effect, await runtime.getAuthorNote?.() ?? '', runtime, result);
            return;
        case 'v2SetAuthorNote': {
            const value = await resolveValue(effect.value, effect.valueType, runtime, { source: 'effect-value' });
            await runtime.setAuthorNote?.(value);
            result.metadataChanged = true;
            return;
        }
        case 'stop':
        case 'v2StopTrigger':
            result.stopped = true;
            return;
        case 'v2StopPromptSending':
            result.stopSending = true;
            return;
        case 'sendAIprompt':
        case 'v2SendAIprompt': {
            const lowLevelReason = getLowLevelAccessReason(trigger, runtime);
            if (lowLevelReason) {
                result.unsupported.push({ type: effect.type, reason: lowLevelReason, trigger: trigger.comment });
                return;
            }
            result.sendAIprompt = true;
            return;
        }
        case 'triggerlua':
            await runRisuTriggerLua(effect, trigger, runtime, result);
            return;
        case 'triggercode':
            await runRisuTriggerCode(effect, trigger, runtime, result);
            return;
        case 'v2Header':
        case 'v2EndIndent':
            clearLocalVariablesAtIndent(state, Number(effect.indent) || 0);
            return;
        case 'v2Else':
        case 'v2Comment':
            return;
        default:
            result.unsupported.push({ type: effect.type || 'unknown', trigger: trigger.comment });
    }
}

function createRisuTriggerResult() {
    return {
        ran: false,
        changed: false,
        chatChanged: false,
        promptChanged: false,
        characterChanged: false,
        settingsChanged: false,
        metadataChanged: false,
        displayChanged: false,
        displayData: undefined,
        chatRefreshIndexes: [],
        commandPipe: '',
        refresh: false,
        stopped: false,
        stopSending: false,
        sendAIprompt: false,
        systemPrompt: {
            start: '',
            historyend: '',
            promptend: '',
        },
        unsupported: [],
    };
}

function createRisuTriggerState(options) {
    return {
        recursiveCount: Number(options.recursiveCount) || 0,
        localVariables: new Map(),
        loopCounts: new Map(),
        loopIterations: 0,
        currentIndent: 0,
    };
}

function createLocalRuntime(runtime, state) {
    return {
        ...runtime,
        getVariable: (name) => state.localVariables.has(name)
            ? state.localVariables.get(name).value
            : runtime.getVariable?.(name),
        getLocalVariable: (name) => state.localVariables.get(name),
    };
}

async function resolveIfValues(effect, runtime) {
    const sourceType = effect.type === 'v2If' ? 'var' : effect.sourceType;
    const sourceValue = await resolveValue(effect.source, sourceType, runtime, { source: 'if-source' });
    const targetValue = await resolveValue(effect.target, effect.targetType, runtime, { source: 'if-target' });
    return { sourceValue, targetValue };
}

async function runTriggerEffects(trigger, triggers, runtime, state, result) {
    const effects = Array.isArray(trigger.effect) ? trigger.effect : [];

    for (let index = 0; index < effects.length; index++) {
        const effect = effects[index];
        if (!effect || typeof effect !== 'object') {
            continue;
        }

        if (typeof effect.indent === 'number' && effect.indent >= 0) {
            state.currentIndent = effect.indent;
        } else if (!('indent' in effect)) {
            state.currentIndent = 0;
        }

        if (effect.type === 'v2If' || effect.type === 'v2IfAdvanced') {
            const { sourceValue, targetValue } = await resolveIfValues(effect, runtime);
            if (!compareAdvanced(toRisuNull(sourceValue), effect.condition, toRisuNull(targetValue))) {
                index = skipFailedIfIndex(effects, index, effect);
            }
            continue;
        }

        if (effect.type === 'v2Else') {
            index = skipElseIndex(effects, index, effect);
            continue;
        }

        if (effect.type === 'v2Loop' || effect.type === 'v2LoopNTimes') {
            continue;
        }

        if (effect.type === 'v2BreakLoop') {
            index = matchingLoopEndIndex(effects, index + 1);
            continue;
        }

        if (effect.type === 'v2EndIndent' && effect.endOfLoop) {
            clearLocalVariablesAtIndent(state, Number(effect.indent) || 0);
            const loopIndent = Number(effect.indent ?? 0) - 1;
            const loopStart = findLoopStartIndex(effects, index, loopIndent);
            const loopEffect = loopStart >= 0 ? effects[loopStart] : null;
            const target = await getLoopCountTarget(loopEffect, runtime);
            const currentCount = (state.loopCounts.get(loopStart) ?? 0) + 1;
            state.loopCounts.set(loopStart, currentCount);
            state.loopIterations++;

            if (state.loopIterations > MAX_LOOP_ITERATIONS) {
                result.unsupported.push({ type: loopEffect?.type ?? 'v2Loop', reason: 'loop-iteration-limit', trigger: trigger.comment });
                continue;
            }

            if (loopStart >= 0 && currentCount < target) {
                index = loopStart;
                continue;
            }

            state.loopCounts.delete(loopStart);
            continue;
        }

        await applyEffect(effect, trigger, triggers, runtime, result, state);
        if (result.stopped) {
            break;
        }
    }
}

async function runMatchingTriggers(triggers, manualName, runtime, state, result) {
    for (const trigger of triggers) {
        if (!trigger || trigger.comment !== manualName) {
            continue;
        }

        if (!await evaluateConditions(trigger, runtime)) {
            continue;
        }

        result.ran = true;
        await runTriggerEffects(trigger, triggers, runtime, state, result);
        if (result.stopped) {
            break;
        }
    }

    return result;
}

async function runModeTriggers(triggers, mode, runtime, state, result) {
    for (const trigger of triggers) {
        if (!trigger || trigger.type !== mode) {
            continue;
        }

        if (!await evaluateConditions(trigger, runtime)) {
            continue;
        }

        result.ran = true;
        await runTriggerEffects(trigger, triggers, runtime, state, result);
        if (result.stopped) {
            break;
        }
    }

    return result;
}

export async function runRisuManualTrigger(character, manualName, runtime = {}, options = {}) {
    const triggers = character?.data?.extensions?.risuai?.triggerscript;
    const result = createRisuTriggerResult();

    if (!manualName || !Array.isArray(triggers)) {
        return result;
    }

    const state = createRisuTriggerState(options);
    const localRuntime = createLocalRuntime(runtime, state);

    await runMatchingTriggers(triggers, manualName, localRuntime, state, result);

    if (!result.ran) {
        if (!await runRisuLuaButtonRuntime(triggers, manualName, localRuntime, result)) {
            await runRisuLuaButtonShim(triggers, manualName, localRuntime, result);
        }
    }

    return result;
}

export async function runRisuTriggerMode(character, mode, runtime = {}, options = {}) {
    const triggers = character?.data?.extensions?.risuai?.triggerscript;
    const result = createRisuTriggerResult();

    if (!mode || !Array.isArray(triggers)) {
        return result;
    }

    const state = createRisuTriggerState(options);
    const localRuntime = createLocalRuntime(runtime, state);

    await runModeTriggers(triggers, mode, localRuntime, state, result);

    return result;
}
