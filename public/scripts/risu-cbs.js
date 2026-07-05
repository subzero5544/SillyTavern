/**
 * Display-time evaluator for RisuAI CBS (Curly Brace Syntax) in chat messages.
 *
 * RisuAI cards (and the display regex scripts they ship) embed conditional
 * blocks like {{#if {{equal::{{getvar::cv_theme}}::0}}}}...{{/if}} that RisuAI
 * evaluates at render time. Without evaluation, every branch renders at once
 * and raw macro text leaks into the chat.
 *
 * This implements the display-relevant subset, mirroring RisuAI semantics
 * (src/ts/parser/parser.svelte.ts, src/ts/cbs.ts):
 *  - blocks: {{#if cond}} / {{#if_pure cond}} / {{#when::...}} ... {{:else}} ... {{/if}} or {{/}}
 *    (condition is truthy only when its first token is '1' or 'true')
 *  - raw/display blocks: {{#puredisplay}}, {{#escape}}, {{#each list as slot}}
 *  - comparison/logic: equal, notequal, greater, less, greaterequal, lessequal,
 *    and, or, not, contains, startswith, endswith
 *  - side-effect-free helpers: string, array, JSON object, numeric, Unicode,
 *    and display-formatting helpers that do not mutate chat state
 *  - variables: getvar (chat variable → card defaultVariables → 'null')
 *  - context: role, chatindex, lastmessageid, assetlist, source::char/user
 *  - math: {{? expr}} and {{calc::expr}} with $name chat variable references
 *  - {{// comment}} → removed
 *
 * Unknown macros are left untouched. Trigger-driven interactivity
 * (risu-trigger buttons) is not evaluated here.
 */

// Placeholders protect unknown macros while outer macros evaluate
const PH_OPEN = '';
const PH_CLOSE = '';
const MAX_PASSES = 30;
const PH_RAW_OPEN = '\uE002';
const PH_RAW_CLOSE = '\uE003';
const ST_PROTECT_PREFIX = '\uE100RISU_CBS_';
const ST_PROTECT_SUFFIX = '_END\uE101';
const RISU_ST_MACROS = new Set([
    'getvar', 'getglobalvar',
    'equal', 'notequal', 'greater', 'less', 'greaterequal', 'lessequal',
    'and', 'or', 'not', 'contains', 'startswith', 'endswith',
    'replace', 'split', 'join', 'spread', 'trim', 'length', 'arraylength',
    'lower', 'upper', 'capitalize', 'round', 'floor', 'ceil', 'abs', 'remaind', 'pow', 'tonumber',
    'arrayelement', 'dictelement', 'objectelement', 'objectassert', 'dictassert', 'element', 'ele',
    'arrayshift', 'arraypop', 'arraypush', 'arraysplice', 'arrayassert',
    'makearray', 'array', 'a', 'makedict', 'dict', 'd', 'makeobject', 'object', 'o',
    'all', 'any', 'min', 'max', 'sum', 'average', 'fixnum', 'fixnumber',
    'unicodeencode', 'unicodedecode', 'u', 'unicodedecodefromhex', 'ue', 'fromhex', 'tohex',
    'reverse', 'tex', 'latex', 'katex', 'ruby', 'furigana', 'comment', 'button',
    'triggerid', 'role', 'chatindex', 'lastmessageid', 'lastmessageindex', 'assetlist', 'source', 'calc',
    'raw', 'path', 'img', 'emotion', 'inlay', 'inlayed', 'inlayeddata', 'image', 'video', 'videoimg', 'audio', 'asset', 'bg',
]);

/**
 * @typedef {Object} RisuCbsContext
 * @property {(name: string) => string|undefined} [getVariable] Chat variable getter
 * @property {(name: string) => string|undefined} [getGlobalVariable] Global variable getter
 * @property {string} [defaultVariables] Card default variables ('key=value' lines)
 * @property {number} [chatIndex] Index of the message being rendered
 * @property {number} [lastMessageId] Index of the last message in the chat
 * @property {string} [role] 'char' or 'user'
 * @property {string[]} [assetNames] Additional asset names of the character
 * @property {string} [charAvatarUrl] Character avatar URL
 * @property {string} [userAvatarUrl] User persona avatar URL
 * @property {string} [triggerId] Risu manual trigger element id
 */

/**
 * Resolves a chat variable the way RisuAI does: chat state, then the card's
 * defaultVariables, then the literal string 'null'.
 * @param {string} name Variable name
 * @param {RisuCbsContext} context Evaluation context
 * @returns {string}
 */
function resolveVariable(name, context) {
    const value = context.getVariable?.(name);
    if (value !== undefined && value !== null && String(value) !== '') {
        return String(value);
    }

    if (typeof context.defaultVariables === 'string' && context.defaultVariables) {
        for (const line of context.defaultVariables.split('\n')) {
            const eq = line.indexOf('=');
            if (eq > 0 && line.slice(0, eq) === name) {
                return line.slice(eq + 1);
            }
        }
    }

    return 'null';
}

function findBalancedMacroEnd(text, openIndex) {
    let depth = 0;
    for (let index = openIndex; index < text.length;) {
        if (text.startsWith('{{', index)) {
            depth++;
            index += 2;
            continue;
        }
        if (text.startsWith('}}', index)) {
            depth--;
            index += 2;
            if (depth === 0) {
                return index;
            }
            continue;
        }
        index++;
    }

    return -1;
}

function isRisuStProtectedMacro(token) {
    const body = token.slice(2, -2).trim();
    if (!body) {
        return false;
    }

    if (body.startsWith('#if') || body.startsWith('#when') || body.startsWith('#each') || body.startsWith('#escape') || body.startsWith('#puredisplay') || body.startsWith('#pure_display')) {
        return true;
    }

    if (body === '/' || body.startsWith('/') || body === ':else' || body.startsWith('? ') || body.startsWith('//')) {
        return true;
    }

    const separatorIndex = body.search(/::|:/);
    const rawName = separatorIndex === -1 ? body : body.slice(0, separatorIndex);
    const name = rawName.trim().toLocaleLowerCase().replace(/[\s_-]/g, '');
    return RISU_ST_MACROS.has(name);
}

/**
 * Protects RisuAI CBS/asset macros from SillyTavern's normal macro engine.
 * This lets {{user}} and similar ST macros resolve while keeping Risu
 * conditionals like {{#if {{equal::{{getvar::mode}}::1}}}} intact for
 * evaluateRisuCbs().
 *
 * @param {string} text
 * @returns {{ text: string, restore: (value: string) => string }}
 */
export function protectRisuCbsMacros(text) {
    if (!text || typeof text !== 'string' || !text.includes('{{')) {
        return { text, restore: value => value };
    }

    const replacements = [];
    let output = '';
    let cursor = 0;

    while (cursor < text.length) {
        const openIndex = text.indexOf('{{', cursor);
        if (openIndex === -1) {
            output += text.slice(cursor);
            break;
        }

        const endIndex = findBalancedMacroEnd(text, openIndex);
        if (endIndex === -1) {
            output += text.slice(cursor);
            break;
        }

        output += text.slice(cursor, openIndex);
        const token = text.slice(openIndex, endIndex);
        if (isRisuStProtectedMacro(token)) {
            const placeholder = `${ST_PROTECT_PREFIX}${replacements.length}${ST_PROTECT_SUFFIX}`;
            replacements.push({ placeholder, token });
            output += placeholder;
        } else {
            output += token;
        }
        cursor = endIndex;
    }

    return {
        text: output,
        restore: value => {
            let restored = String(value ?? '');
            for (const { placeholder, token } of replacements) {
                restored = restored.replaceAll(placeholder, token);
            }
            return restored;
        },
    };
}

/**
 * Evaluates a math expression ({{? ...}} / {{calc::...}}).
 * Supports numbers, $name chat variables, + - * / % ^, comparisons, && ||, parentheses.
 * @param {string} expression Expression text
 * @param {RisuCbsContext} context Evaluation context
 * @returns {string} Result as string ('NaN' on failure, like RisuAI)
 */
function evaluateMath(expression, context) {
    const source = expression.replace(/\$([a-zA-Z0-9_]+)/g, (_, name) => {
        const parsed = parseFloat(resolveVariable(name, context));
        return isNaN(parsed) ? '0' : String(parsed);
    });

    // Whitelist check: nothing but numbers, operators, and whitespace
    if (!/^[\d\s+\-*/%^()<>=!&|.]*$/.test(source)) {
        return 'NaN';
    }

    const tokens = source.match(/\d+\.?\d*|>=|<=|==|!=|&&|\|\||[+\-*/%^()<>]/g);
    if (!tokens) {
        return 'NaN';
    }

    // Shunting-yard to RPN
    const precedence = { '||': 1, '&&': 2, '==': 3, '!=': 3, '>': 4, '<': 4, '>=': 4, '<=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '^': 7 };
    const output = [];
    const operators = [];
    let expectOperand = true;

    for (const token of tokens) {
        if (/^\d/.test(token)) {
            output.push(parseFloat(token));
            expectOperand = false;
        } else if (token === '(') {
            operators.push(token);
            expectOperand = true;
        } else if (token === ')') {
            while (operators.length && operators[operators.length - 1] !== '(') {
                output.push(operators.pop());
            }
            operators.pop();
            expectOperand = false;
        } else {
            // Unary minus
            if (token === '-' && expectOperand) {
                output.push(0);
            }
            while (operators.length && precedence[operators[operators.length - 1]] >= precedence[token]) {
                output.push(operators.pop());
            }
            operators.push(token);
            expectOperand = true;
        }
    }
    while (operators.length) {
        output.push(operators.pop());
    }

    // Evaluate RPN
    const stack = [];
    for (const token of output) {
        if (typeof token === 'number') {
            stack.push(token);
            continue;
        }
        const b = stack.pop();
        const a = stack.pop();
        if (a === undefined || b === undefined) {
            return 'NaN';
        }
        switch (token) {
            case '+': stack.push(a + b); break;
            case '-': stack.push(a - b); break;
            case '*': stack.push(a * b); break;
            case '/': stack.push(a / b); break;
            case '%': stack.push(a % b); break;
            case '^': stack.push(Math.pow(a, b)); break;
            case '>': stack.push(a > b ? 1 : 0); break;
            case '<': stack.push(a < b ? 1 : 0); break;
            case '>=': stack.push(a >= b ? 1 : 0); break;
            case '<=': stack.push(a <= b ? 1 : 0); break;
            case '==': stack.push(a === b ? 1 : 0); break;
            case '!=': stack.push(a !== b ? 1 : 0); break;
            case '&&': stack.push(a && b ? 1 : 0); break;
            case '||': stack.push(a || b ? 1 : 0); break;
            default: return 'NaN';
        }
    }

    return stack.length === 1 ? String(stack[0]) : 'NaN';
}

function parseArray(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function parseRisuLoopArray(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : String(value ?? '').split('\u00A7');
    } catch {
        return String(value ?? '').split('\u00A7');
    }
}

function parseDict(value) {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function parseJsonValue(value) {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function stringifyValue(value) {
    return value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? 'null');
}

function getListArgs(args) {
    return args.length > 1 ? args : parseArray(args[0]);
}

function toNumber(value) {
    const number = Number(value);
    return isNaN(number) ? 0 : number;
}

function isTruthy(value) {
    return value === '1' || value === 'true';
}

function resolveGlobalVariable(name, context) {
    const value = context.getGlobalVariable?.(name);
    return (value === undefined || value === null || String(value) === '') ? 'null' : String(value);
}

function evaluateWhenRest(rest, context) {
    const trimmed = String(rest ?? '').trim();
    if (!trimmed) {
        return { truthy: false, mode: 'normal' };
    }

    if (!trimmed.startsWith('::')) {
        const token = trimmed.split(/\s+/)[0];
        return { truthy: isTruthy(token), mode: 'normal' };
    }

    const statement = trimmed.slice(2).split('::');
    if (statement.length === 1) {
        return { truthy: isTruthy(statement[0]), mode: 'normal' };
    }

    let mode = 'normal';
    while (statement.length > 1) {
        const condition = statement.pop();
        const operator = statement.pop();
        switch (operator) {
            case 'not':
                statement.push(isTruthy(condition) ? '0' : '1');
                break;
            case 'keep':
                mode = 'keep';
                statement.push(condition);
                break;
            case 'legacy':
                mode = 'legacy';
                statement.push(condition);
                break;
            case 'and': {
                const condition2 = statement.pop();
                statement.push(isTruthy(condition) && isTruthy(condition2) ? '1' : '0');
                break;
            }
            case 'or': {
                const condition2 = statement.pop();
                statement.push(isTruthy(condition) || isTruthy(condition2) ? '1' : '0');
                break;
            }
            case 'is': {
                const condition2 = statement.pop();
                statement.push(condition === condition2 ? '1' : '0');
                break;
            }
            case 'isnot': {
                const condition2 = statement.pop();
                statement.push(condition !== condition2 ? '1' : '0');
                break;
            }
            case 'var':
                statement.push(isTruthy(resolveVariable(condition, context)) ? '1' : '0');
                break;
            case 'toggle':
                statement.push(isTruthy(resolveGlobalVariable(`toggle_${condition}`, context)) ? '1' : '0');
                break;
            case 'vis': {
                const key = statement.pop();
                statement.push(resolveVariable(key, context) === condition ? '1' : '0');
                break;
            }
            case 'visnot': {
                const key = statement.pop();
                statement.push(resolveVariable(key, context) !== condition ? '1' : '0');
                break;
            }
            case 'tis': {
                const key = statement.pop();
                statement.push(resolveGlobalVariable(`toggle_${key}`, context) === condition ? '1' : '0');
                break;
            }
            case 'tisnot': {
                const key = statement.pop();
                statement.push(resolveGlobalVariable(`toggle_${key}`, context) !== condition ? '1' : '0');
                break;
            }
            case '>': {
                const condition2 = statement.pop();
                statement.push(parseFloat(condition2) > parseFloat(condition) ? '1' : '0');
                break;
            }
            case '<': {
                const condition2 = statement.pop();
                statement.push(parseFloat(condition2) < parseFloat(condition) ? '1' : '0');
                break;
            }
            case '>=': {
                const condition2 = statement.pop();
                statement.push(parseFloat(condition2) >= parseFloat(condition) ? '1' : '0');
                break;
            }
            case '<=': {
                const condition2 = statement.pop();
                statement.push(parseFloat(condition2) <= parseFloat(condition) ? '1' : '0');
                break;
            }
            default:
                statement.push(isTruthy(condition) ? '1' : '0');
                break;
        }
    }

    return { truthy: isTruthy(statement[0]), mode };
}

function selectWhenContent(content, truthy, mode) {
    if (mode === 'legacy') {
        const [truthyContent, falsyContent = ''] = content.split('{{:else}}');
        return truthy ? truthyContent : falsyContent;
    }

    const lines = content.split('\n');
    if (lines.length === 1) {
        const elseIndex = content.indexOf('{{:else}}');
        if (elseIndex !== -1) {
            return truthy ? content.slice(0, elseIndex) : content.slice(elseIndex + 9);
        }
        return truthy ? content : '';
    }

    const elseLine = lines.findIndex(line => line.trim() === '{{:else}}');
    if (elseLine !== -1) {
        if (truthy) {
            lines.splice(elseLine);
        } else {
            lines.splice(0, elseLine + 1);
        }
    } else if (!truthy) {
        return '';
    }

    if (mode !== 'keep') {
        while (lines.length > 0 && lines[0].trim() === '') {
            lines.shift();
        }
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
            lines.pop();
        }
    }

    return lines.join('\n');
}

function trimRisuBlockContent(content) {
    return String(content ?? '').split('\n').map(line => line.trimStart()).join('\n').trim();
}

function escapeRisuBlockContent(content) {
    return String(content ?? '').replace(/[{}()]/g, value => {
        switch (value) {
            case '{': return '\uE9B8';
            case '}': return '\uE9B9';
            case '(': return '\uE9BA';
            case ')': return '\uE9BB';
            default: return value;
        }
    });
}

function unescapeRisuBlockContent(content) {
    return String(content ?? '').replace(/[\uE9B8-\uE9BB]/g, value => {
        switch (value) {
            case '\uE9B8': return '{';
            case '\uE9B9': return '}';
            case '\uE9BA': return '(';
            case '\uE9BB': return ')';
            default: return value;
        }
    });
}

function protectRawContent(content) {
    return `${PH_RAW_OPEN}${content}${PH_RAW_CLOSE}`;
}

function restoreProtectedRawContent(text) {
    return String(text ?? '').replace(new RegExp(`${PH_RAW_OPEN}([\\s\\S]*?)${PH_RAW_CLOSE}`, 'g'), (_, content) => {
        return unescapeRisuBlockContent(content).replaceAll('\\{{', '{{').replaceAll('\\}}', '}}');
    });
}

function selectEachData(statement) {
    const asIndex = statement.lastIndexOf(' as ');
    if (asIndex !== -1) {
        return {
            source: statement.slice(0, asIndex),
            slot: statement.slice(asIndex + 4).trim(),
        };
    }

    const fallbackIndex = statement.lastIndexOf(' ');
    if (fallbackIndex === -1) {
        return null;
    }

    return {
        source: statement.slice(0, fallbackIndex),
        slot: statement.slice(fallbackIndex + 1).trim(),
    };
}

function stringifySlotValue(value) {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function evaluateEachBlock(rest, content) {
    let statement = String(rest ?? '').trim();
    let keepWhitespace = false;

    if (statement.startsWith('::keep ')) {
        keepWhitespace = true;
        statement = statement.slice(7).trim();
    }
    if (statement.startsWith('as ')) {
        statement = statement.slice(3).trim();
    }

    const data = selectEachData(statement);
    if (!data?.slot) {
        return '';
    }

    const body = keepWhitespace ? content : trimRisuBlockContent(content);
    const values = parseRisuLoopArray(data.source);
    const repeated = values.map(value => body.replaceAll(`{{slot::${data.slot}}}`, stringifySlotValue(value))).join('');
    return keepWhitespace ? repeated : repeated.trim();
}

function evaluateRawBlock(type, rest, content) {
    switch (type) {
        case 'puredisplay':
        case 'pure_display':
            return protectRawContent(escapeRisuBlockContent(trimRisuBlockContent(content)));
        case 'escape': {
            const mode = String(rest ?? '').trim() === '::keep' ? 'keep' : '';
            const value = mode === 'keep' ? content : String(content ?? '').trim();
            return protectRawContent(escapeRisuBlockContent(value));
        }
        case 'each':
            return evaluateEachBlock(rest, content);
        default:
            return null;
    }
}

function parseMacroToken(text, openIndex) {
    if (!text.startsWith('{{', openIndex)) {
        return null;
    }

    let depth = 1;
    for (let i = openIndex + 2; i < text.length - 1; i++) {
        if (text.startsWith('{{', i)) {
            depth++;
            i++;
            continue;
        }
        if (text.startsWith('}}', i)) {
            depth--;
            if (depth === 0) {
                return { body: text.slice(openIndex + 2, i), end: i + 2 };
            }
            i++;
        }
    }

    return null;
}

function parseRawBlockStart(body) {
    const trimmed = String(body ?? '').trim();
    if (trimmed === '#puredisplay' || trimmed === '#pure_display') {
        return { type: trimmed.slice(1), rest: '' };
    }
    if (trimmed.startsWith('#escape')) {
        return { type: 'escape', rest: trimmed.slice(7) };
    }
    if (trimmed.startsWith('#each')) {
        return { type: 'each', rest: trimmed.slice(5) };
    }

    return null;
}

function isBlockStartBody(body) {
    const trimmed = String(body ?? '').trim();
    return trimmed.startsWith('#if')
        || trimmed.startsWith('#if_pure')
        || trimmed.startsWith('#when')
        || Boolean(parseRawBlockStart(trimmed));
}

function isBlockEndBody(body) {
    const trimmed = String(body ?? '').trim();
    return trimmed === '/'
        || trimmed === '/if'
        || trimmed === '/if_pure'
        || trimmed === '/pure'
        || trimmed === '/when'
        || trimmed === '/each'
        || trimmed === '/escape'
        || trimmed === '/puredisplay'
        || trimmed === '/pure_display';
}

function findMatchingBlockClose(text, fromIndex) {
    let depth = 1;
    let cursor = fromIndex;

    while (cursor < text.length) {
        const openIndex = text.indexOf('{{', cursor);
        if (openIndex === -1) {
            return null;
        }

        const token = parseMacroToken(text, openIndex);
        if (!token) {
            return null;
        }

        if (isBlockStartBody(token.body)) {
            depth++;
        } else if (isBlockEndBody(token.body)) {
            depth--;
            if (depth === 0) {
                return { start: openIndex, end: token.end };
            }
        }

        cursor = token.end;
    }

    return null;
}

function findFirstRawBlock(text) {
    let cursor = 0;

    while (cursor < text.length) {
        const openIndex = text.indexOf('{{', cursor);
        if (openIndex === -1) {
            return null;
        }

        const token = parseMacroToken(text, openIndex);
        if (!token) {
            return null;
        }

        const rawStart = parseRawBlockStart(token.body);
        if (!rawStart) {
            cursor = token.end;
            continue;
        }

        const close = findMatchingBlockClose(text, token.end);
        if (!close) {
            return null;
        }

        return {
            start: openIndex,
            end: close.end,
            type: rawStart.type,
            rest: rawStart.rest,
            content: text.slice(token.end, close.start),
        };
    }

    return null;
}

function evaluateSimpleMacrosOnce(text, context) {
    return text.replace(/{{((?:(?!{{|}})[\s\S])*)}}/g, (full, body) => {
        // Block syntax ({{#if ...}}, {{#when...}}, {{/}}, {{/if}}, {{/when}}, {{:else}}) is handled elsewhere.
        if (body.startsWith('#') || body === '/' || body === '/if' || body === '/if_pure' || body === '/pure' || body === '/when' || body === '/each' || body === '/escape' || body === '/puredisplay' || body === '/pure_display' || body.startsWith(':')) {
            return full;
        }
        const value = evaluateMacro(body, context);
        return value === null ? PH_OPEN + body + PH_CLOSE : value;
    });
}

function evaluateInlineMacros(text, context) {
    let result = text;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const next = evaluateSimpleMacrosOnce(result, context);
        if (next === result) {
            break;
        }
        result = next;
    }
    return result;
}

function evaluateRawBlocks(text, context) {
    let result = text;

    for (let i = 0; i < 100; i++) {
        const block = findFirstRawBlock(result);
        if (!block) {
            break;
        }

        const rest = evaluateInlineMacros(block.rest, context);
        const replacement = evaluateRawBlock(block.type, rest, block.content);
        if (replacement === null) {
            break;
        }

        result = result.slice(0, block.start) + replacement + result.slice(block.end);
    }

    return result;
}

/**
 * Evaluates a single brace-free macro body.
 * @param {string} body Macro body (text between {{ and }})
 * @param {RisuCbsContext} context Evaluation context
 * @returns {string|null} Result, or null if the macro is not supported here
 */
function evaluateMacro(body, context) {
    if (body.startsWith('? ')) {
        return evaluateMath(body.slice(2), context);
    }
    if (body.startsWith('//')) {
        return '';
    }

    // RisuAI supports both '::' and legacy ':' separators
    const separator = body.includes('::') ? '::' : ':';
    const parts = body.split(separator);
    // RisuAI normalizes macro names: lowercase, strip spaces/underscores/dashes
    const name = parts[0].trim().toLocaleLowerCase().replace(/[\s_-]/g, '');
    const args = parts.slice(1);

    switch (name) {
        case 'getvar':
            return resolveVariable(args[0] ?? '', context);
        case 'getglobalvar': {
            const value = context.getGlobalVariable?.(args[0] ?? '');
            return (value === undefined || value === null || String(value) === '') ? 'null' : String(value);
        }
        case 'equal':
            return args[0] === args[1] ? '1' : '0';
        case 'notequal':
            return args[0] !== args[1] ? '1' : '0';
        case 'greater':
            return Number(args[0]) > Number(args[1]) ? '1' : '0';
        case 'less':
            return Number(args[0]) < Number(args[1]) ? '1' : '0';
        case 'greaterequal':
            return Number(args[0]) >= Number(args[1]) ? '1' : '0';
        case 'lessequal':
            return Number(args[0]) <= Number(args[1]) ? '1' : '0';
        case 'and':
            return args[0] === '1' && args[1] === '1' ? '1' : '0';
        case 'or':
            return args[0] === '1' || args[1] === '1' ? '1' : '0';
        case 'not':
            return args[0] === '1' ? '0' : '1';
        case 'contains':
            return String(args[0] ?? '').includes(String(args[1] ?? '')) ? '1' : '0';
        case 'startswith':
            return String(args[0] ?? '').startsWith(String(args[1] ?? '')) ? '1' : '0';
        case 'endswith':
            return String(args[0] ?? '').endsWith(String(args[1] ?? '')) ? '1' : '0';
        case 'replace':
            return String(args[0] ?? '').replaceAll(String(args[1] ?? ''), String(args[2] ?? ''));
        case 'split':
            return JSON.stringify(String(args[0] ?? '').split(String(args[1] ?? '')));
        case 'join':
            return parseArray(args[0]).join(args[1] ?? '');
        case 'spread':
            return parseArray(args[0]).join('::');
        case 'trim':
            return String(args[0] ?? '').trim();
        case 'length':
            return String(args[0] ?? '').length.toString();
        case 'arraylength':
            return parseArray(args[0]).length.toString();
        case 'lower':
            return String(args[0] ?? '').toLocaleLowerCase();
        case 'upper':
            return String(args[0] ?? '').toLocaleUpperCase();
        case 'capitalize': {
            const value = String(args[0] ?? '');
            return value.charAt(0).toUpperCase() + value.slice(1);
        }
        case 'round':
            return Math.round(Number(args[0])).toString();
        case 'floor':
            return Math.floor(Number(args[0])).toString();
        case 'ceil':
            return Math.ceil(Number(args[0])).toString();
        case 'abs':
            return Math.abs(Number(args[0])).toString();
        case 'remaind':
            return (Number(args[0]) % Number(args[1])).toString();
        case 'pow':
            return Math.pow(Number(args[0]), Number(args[1])).toString();
        case 'tonumber':
            return [...String(args[0] ?? '')].filter(char => !isNaN(Number(char)) || char === '.').join('');
        case 'arrayelement':
            return stringifyValue(parseArray(args[0]).at(Number(args[1])) ?? 'null');
        case 'dictelement':
        case 'objectelement':
            return stringifyValue(parseDict(args[0])[args[1]] ?? 'null');
        case 'objectassert':
        case 'dictassert': {
            const dict = parseDict(args[0]);
            if (!dict[args[1]]) {
                dict[args[1]] = args[2];
            }
            return JSON.stringify(dict);
        }
        case 'element':
        case 'ele': {
            let current = parseJsonValue(args[0]);
            for (const key of args.slice(1)) {
                if (current === null || (typeof current !== 'object' && !Array.isArray(current))) {
                    return 'null';
                }
                current = current[key];
                if (!current) {
                    return 'null';
                }
            }
            return stringifyValue(current);
        }
        case 'arrayshift': {
            const array = parseArray(args[0]);
            array.shift();
            return JSON.stringify(array);
        }
        case 'arraypop': {
            const array = parseArray(args[0]);
            array.pop();
            return JSON.stringify(array);
        }
        case 'arraypush': {
            const array = parseArray(args[0]);
            array.push(args[1]);
            return JSON.stringify(array);
        }
        case 'arraysplice': {
            const array = parseArray(args[0]);
            array.splice(Number(args[1]), Number(args[2]), args[3]);
            return JSON.stringify(array);
        }
        case 'arrayassert': {
            const array = parseArray(args[0]);
            const index = Number(args[1]);
            if (index >= array.length) {
                array[index] = args[2];
            }
            return JSON.stringify(array);
        }
        case 'makearray':
        case 'array':
        case 'a':
            return JSON.stringify(args);
        case 'makedict':
        case 'dict':
        case 'd':
        case 'makeobject':
        case 'object':
        case 'o': {
            const dict = {};
            for (const arg of args) {
                const eq = String(arg).indexOf('=');
                if (eq === -1) {
                    continue;
                }
                dict[String(arg).slice(0, eq)] = String(arg).slice(eq + 1) ?? 'null';
            }
            return JSON.stringify(dict);
        }
        case 'all': {
            const values = getListArgs(args);
            return values.every(value => value === '1') ? '1' : '0';
        }
        case 'any': {
            const values = getListArgs(args);
            return values.some(value => value === '1') ? '1' : '0';
        }
        case 'min':
            return Math.min(...getListArgs(args).map(toNumber)).toString();
        case 'max':
            return Math.max(...getListArgs(args).map(toNumber)).toString();
        case 'sum':
            return getListArgs(args).map(toNumber).reduce((a, b) => a + b, 0).toString();
        case 'average': {
            const values = getListArgs(args).map(toNumber);
            return (values.reduce((a, b) => a + b, 0) / values.length).toString();
        }
        case 'fixnum':
        case 'fixnumber':
            return Number(args[0]).toFixed(Number(args[1]));
        case 'unicodeencode':
            return String(args[0] ?? '').charCodeAt(args[1] ? Number(args[1]) : 0).toString();
        case 'unicodedecode':
            return String.fromCharCode(Number(args[0]));
        case 'u':
        case 'unicodedecodefromhex':
            return String.fromCharCode(parseInt(args[0], 16));
        case 'ue':
            return String.fromCodePoint(parseInt(args[0], 16));
        case 'fromhex':
            return parseInt(args[0], 16).toString();
        case 'tohex':
            return Number(args[0]).toString(16);
        case 'reverse':
            return [...String(args[0] ?? '')].reverse().join('');
        case 'tex':
        case 'latex':
        case 'katex':
            return `$$${args[0] ?? ''}$$`;
        case 'ruby':
        case 'furigana':
            return `<ruby>${args[0] ?? ''}<rp> (</rp><rt>${args[1] ?? ''}</rt><rp>) </rp></ruby>`;
        case 'comment':
            return `<div class="risu-comment">${args[0] ?? ''}</div>`;
        case 'button':
            return `<button class="button-default" risu-trigger="${args[1] ?? ''}">${args[0] ?? ''}</button>`;
        case 'triggerid':
            return context.triggerId ?? 'null';
        case 'role':
            return context.role ?? 'null';
        case 'chatindex':
            return context.chatIndex !== undefined ? String(context.chatIndex) : 'null';
        case 'lastmessageid':
        case 'lastmessageindex':
            return context.lastMessageId !== undefined ? String(context.lastMessageId) : '';
        case 'assetlist':
            return JSON.stringify(context.assetNames ?? []);
        case 'source': {
            if (args[0] === 'char') return context.charAvatarUrl ?? '';
            if (args[0] === 'user') return context.userAvatarUrl ?? '';
            return null;
        }
        case 'calc':
            return evaluateMath(args.join(separator), context);
        default:
            return null;
    }
}

function parseIfBlockStart(body) {
    const trimmed = String(body ?? '').trim();
    if (trimmed.startsWith('#if_pure')) {
        return { type: 'if_pure', rest: trimmed.slice(8).trim() };
    }
    if (trimmed.startsWith('#if')) {
        return { type: 'if', rest: trimmed.slice(3).trim() };
    }
    if (trimmed.startsWith('#when')) {
        return { type: 'when', rest: trimmed.slice(5).trim() };
    }
    if (trimmed.startsWith('#pure')) {
        return { type: 'pure', rest: trimmed.slice(5).trim() };
    }
    return null;
}

function createBlockFrame(type = 'root', rest = '') {
    return {
        type,
        rest,
        parts: [{ branch: 'then', text: '' }],
    };
}

function appendToBlockFrame(frame, value) {
    frame.parts[frame.parts.length - 1].text += value;
}

function renderStackBlockFrame(frame, context) {
    if (frame.type === 'pure') {
        return frame.parts.map(part => part.text).join('');
    }

    const thenText = frame.parts.filter(part => part.branch === 'then').map(part => part.text).join('');
    const elseText = frame.parts.filter(part => part.branch === 'else').map(part => part.text).join('');
    if (frame.type === 'when') {
        const result = evaluateWhenRest(frame.rest, context);
        const content = elseText ? `${thenText}{{:else}}${elseText}` : thenText;
        return selectWhenContent(content, result.truthy, result.mode);
    }

    const conditionToken = String(frame.rest ?? '').trim().split(/\s+/)[0];
    return isTruthy(conditionToken) ? thenText : elseText;
}

function evaluateBlockMacros(text, context) {
    if (!text.includes('{{#')) {
        return text;
    }

    const root = createBlockFrame();
    const stack = [root];
    let cursor = 0;

    while (cursor < text.length) {
        const openIndex = text.indexOf('{{', cursor);
        if (openIndex === -1) {
            appendToBlockFrame(stack.at(-1), text.slice(cursor));
            break;
        }

        const token = parseMacroToken(text, openIndex);
        if (!token) {
            appendToBlockFrame(stack.at(-1), text.slice(cursor));
            break;
        }

        appendToBlockFrame(stack.at(-1), text.slice(cursor, openIndex));
        const trimmed = String(token.body ?? '').trim();
        const start = parseIfBlockStart(trimmed);
        if (start) {
            stack.push(createBlockFrame(start.type, start.rest));
        } else if (trimmed === ':else') {
            if (stack.length > 1) {
                stack.at(-1).parts.push({ branch: 'else', text: '' });
            } else {
                appendToBlockFrame(stack.at(-1), text.slice(openIndex, token.end));
            }
        } else if (isBlockEndBody(trimmed)) {
            if (stack.length > 1) {
                const frame = stack.pop();
                appendToBlockFrame(stack.at(-1), renderStackBlockFrame(frame, context));
            }
        } else {
            appendToBlockFrame(stack.at(-1), text.slice(openIndex, token.end));
        }

        cursor = token.end;
    }

    while (stack.length > 1) {
        const frame = stack.pop();
        appendToBlockFrame(stack.at(-1), renderStackBlockFrame(frame, context));
    }

    return root.parts.map(part => part.text).join('');
}

/**
 * Runs one evaluation pass: innermost simple macros, then innermost blocks.
 * @param {string} text Input text
 * @param {RisuCbsContext} context Evaluation context
 * @returns {string}
 */
function evaluatePass(text, context) {
    // Risu raw blocks suppress inner CBS until they close; #each then re-injects the body for later parsing.
    text = evaluateRawBlocks(text, context);

    // Resolve nested inline macros before block conditions are tested.
    text = evaluateInlineMacros(text, context);

    text = evaluateBlockMacros(text, context);

    return text;
}

/**
 * Evaluates RisuAI CBS conditionals and value macros in message text.
 * Unknown macros are preserved as-is.
 * @param {string} text Message text
 * @param {RisuCbsContext} context Evaluation context
 * @returns {string}
 */
export function evaluateRisuCbs(text, context = {}) {
    if (!text || typeof text !== 'string' || !text.includes('{{')) {
        return text;
    }

    let result = text;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const next = evaluatePass(result, context);
        if (next === result) {
            break;
        }
        result = next;
    }

    // Cosmetic cleanup: orphaned block markers can't render anything meaningful
    result = result.replaceAll('{{/}}', '').replaceAll('{{/if}}', '').replaceAll('{{/if_pure}}', '').replaceAll('{{/pure}}', '').replaceAll('{{/when}}', '').replaceAll('{{/each}}', '').replaceAll('{{/escape}}', '').replaceAll('{{/puredisplay}}', '').replaceAll('{{/pure_display}}', '').replaceAll('{{:else}}', '');

    // Restore unevaluated macros
    return restoreProtectedRawContent(result).replaceAll(PH_OPEN, '{{').replaceAll(PH_CLOSE, '}}');
}
