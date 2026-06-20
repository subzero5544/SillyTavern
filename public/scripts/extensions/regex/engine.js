import { characters, saveSettingsDebounced, substituteParams, substituteParamsExtended, this_chid } from '../../../script.js';
import { extension_settings, writeExtensionField } from '../../extensions.js';
import { getPresetManager } from '../../preset-manager.js';
import { regexFromString } from '../../utils.js';
import { lodash } from '../../../lib.js';

/**
 * @readonly
 * @enum {number} Regex scripts types
 */
export const SCRIPT_TYPES = {
    // ORDER MATTERS: defines the regex script priority
    GLOBAL: 0,
    PRESET: 2,
    SCOPED: 1,
};

/**
 * Special type for unknown/invalid script types.
 */
export const SCRIPT_TYPE_UNKNOWN = -1;

/**
 * @typedef {import('../../char-data.js').RegexScriptData} RegexScript
 */

/**
 * @typedef {object} GetRegexScriptsOptions
 * @property {boolean} allowedOnly Only return allowed scripts
 */

/**
 * @type {Readonly<GetRegexScriptsOptions>}
 */
const DEFAULT_GET_REGEX_SCRIPTS_OPTIONS = Object.freeze({ allowedOnly: false });

/**
 * Manages the compiled regex cache with LRU eviction.
 */
export class RegexProvider {
    /** @type {Map<string, RegExp>} */
    #cache = new Map();
    /** @type {number} */
    #maxSize = 1000;

    static instance = new RegexProvider();

    /**
     * Gets a regex instance by its string representation.
     * @param {string} regexString The regex string to retrieve
     * @returns {RegExp?} Compiled regex or null if invalid
     */
    get(regexString) {
        const isCached = this.#cache.has(regexString);
        const regex = isCached
            ? this.#cache.get(regexString)
            : regexFromString(regexString);

        if (!regex) {
            return null;
        }

        if (isCached) {
            // LRU: Move to end by re-inserting
            this.#cache.delete(regexString);
            this.#cache.set(regexString, regex);
        } else {
            // Evict oldest if at capacity
            if (this.#cache.size >= this.#maxSize) {
                const firstKey = this.#cache.keys().next().value;
                this.#cache.delete(firstKey);
            }
            this.#cache.set(regexString, regex);
        }

        // Reset lastIndex for global/sticky regexes
        if (regex.global || regex.sticky) {
            regex.lastIndex = 0;
        }

        return regex;
    }

    /**
     * Clears the entire cache.
     */
    clear() {
        this.#cache.clear();
    }
}

/**
 * Retrieves the list of regex scripts by combining the scripts from the extension settings and the character data
 *
 * @param {GetRegexScriptsOptions} options Options for retrieving the regex scripts
 * @returns {RegexScript[]} An array of regex scripts, where each script is an object containing the necessary information.
 */
export function getRegexScripts(options = DEFAULT_GET_REGEX_SCRIPTS_OPTIONS) {
    return [...Object.values(SCRIPT_TYPES).flatMap(type => getScriptsByType(type, options))];
}

/**
 * Retrieves the regex scripts for a specific type.
 * @param {SCRIPT_TYPES} scriptType The type of regex scripts to retrieve.
 * @param {GetRegexScriptsOptions} options Options for retrieving the regex scripts
 * @returns {RegexScript[]} An array of regex scripts for the specified type.
 */
export function getScriptsByType(scriptType, { allowedOnly } = DEFAULT_GET_REGEX_SCRIPTS_OPTIONS) {
    switch (scriptType) {
        case SCRIPT_TYPE_UNKNOWN:
            return [];
        case SCRIPT_TYPES.GLOBAL:
            return extension_settings.regex ?? [];
        case SCRIPT_TYPES.SCOPED: {
            if (allowedOnly && !extension_settings?.character_allowed_regex?.includes(characters?.[this_chid]?.avatar)) {
                return [];
            }
            const scopedScripts = characters[this_chid]?.data?.extensions?.regex_scripts;
            return Array.isArray(scopedScripts) ? scopedScripts : [];
        }
        case SCRIPT_TYPES.PRESET: {
            if (allowedOnly) {
                const apiId = getCurrentPresetAPI();
                const allowedPresetNames = apiId ? extension_settings?.preset_allowed_regex?.[apiId] : null;
                if (!Array.isArray(allowedPresetNames) || !allowedPresetNames.includes(getCurrentPresetName())) {
                    return [];
                }
            }
            const presetManager = getPresetManager();
            const presetScripts = presetManager?.readPresetExtensionField({ path: 'regex_scripts' });
            return Array.isArray(presetScripts) ? presetScripts : [];
        }
        default:
            console.warn(`getScriptsByType: Invalid script type ${scriptType}`);
            return [];
    }
}

/**
 * Saves an array of regex scripts for a specific type.
 * @param {RegexScript[]} scripts An array of regex scripts to save.
 * @param {SCRIPT_TYPES} scriptType The type of regex scripts to save.
 * @returns {Promise<void>}
 */
export async function saveScriptsByType(scripts, scriptType) {
    switch (scriptType) {
        case SCRIPT_TYPES.GLOBAL:
            extension_settings.regex = scripts;
            saveSettingsDebounced();
            break;
        case SCRIPT_TYPES.SCOPED:
            await writeExtensionField(this_chid, 'regex_scripts', scripts);
            break;
        case SCRIPT_TYPES.PRESET: {
            const presetManager = getPresetManager();
            await presetManager.writePresetExtensionField({ path: 'regex_scripts', value: scripts });
            break;
        }
        default:
            console.warn(`saveScriptsByType: Invalid script type ${scriptType}`);
            break;
    }
}

/**
 * Check if character's regexes are allowed to be used; if character is undefined, returns false
 * @param {Character|undefined} character
 * @returns {boolean}
 */
export function isScopedScriptsAllowed(character) {
    return !!extension_settings?.character_allowed_regex?.includes(character?.avatar);
}

/**
 * Allow character's regexes to be used; if character is undefined, do nothing
 * @param {Character|undefined} character
 * @returns {void}
 */
export function allowScopedScripts(character) {
    const avatar = character?.avatar;
    if (!avatar) {
        return;
    }
    if (!Array.isArray(extension_settings?.character_allowed_regex)) {
        extension_settings.character_allowed_regex = [];
    }
    if (!extension_settings.character_allowed_regex.includes(avatar)) {
        extension_settings.character_allowed_regex.push(avatar);
        saveSettingsDebounced();
    }
}

/**
 * Disallow character's regexes to be used; if character is undefined, do nothing
 * @param {Character|undefined} character
 * @returns {void}
 */
export function disallowScopedScripts(character) {
    const avatar = character?.avatar;
    if (!avatar) {
        return;
    }
    if (!Array.isArray(extension_settings?.character_allowed_regex)) {
        return;
    }
    const index = extension_settings.character_allowed_regex.indexOf(avatar);
    if (index !== -1) {
        extension_settings.character_allowed_regex.splice(index, 1);
        saveSettingsDebounced();
    }
}

/**
 * Check if preset's regexes are allowed to be used
 * @param {string} apiId API ID
 * @param {string} presetName Preset name
 * @returns {boolean} True if allowed, false if not
 */
export function isPresetScriptsAllowed(apiId, presetName) {
    if (!apiId || !presetName) {
        return false;
    }
    return !!extension_settings?.preset_allowed_regex?.[apiId]?.includes(presetName);
}

/**
 * Allow preset's regexes to be used
 * @param {string} apiId API ID
 * @param {string} presetName Preset name
 * @returns {void}
 */
export function allowPresetScripts(apiId, presetName) {
    if (!apiId || !presetName) {
        return;
    }
    if (!Array.isArray(extension_settings?.preset_allowed_regex?.[apiId])) {
        lodash.set(extension_settings, ['preset_allowed_regex', apiId], []);
    }
    if (!extension_settings.preset_allowed_regex[apiId].includes(presetName)) {
        extension_settings.preset_allowed_regex[apiId].push(presetName);
        saveSettingsDebounced();
    }
}

/**
 * Disallow preset's regexes to be used
 * @param {string} apiId API ID
 * @param {string} presetName Preset name
 * @returns {void}
 */
export function disallowPresetScripts(apiId, presetName) {
    if (!apiId || !presetName) {
        return;
    }
    if (!Array.isArray(extension_settings?.preset_allowed_regex?.[apiId])) {
        return;
    }
    const index = extension_settings.preset_allowed_regex[apiId].indexOf(presetName);
    if (index !== -1) {
        extension_settings.preset_allowed_regex[apiId].splice(index, 1);
        saveSettingsDebounced();
    }
}

/**
 * Gets the current API ID from the preset manager.
 * @returns {string|null} Current API ID, or null if no preset manager
 */
export function getCurrentPresetAPI() {
    return getPresetManager()?.apiId ?? null;
}

/**
 * Gets the name of the currently selected preset.
 * @returns {string|null} The name of the currently selected preset, or null if no preset manager
 */
export function getCurrentPresetName() {
    return getPresetManager()?.getSelectedPresetName() ?? null;
}

/**
 * @readonly
 * @enum {number} Where the regex script should be applied
 */
export const regex_placement = {
    /**
     * @deprecated MD Display is deprecated. Do not use.
     */
    MD_DISPLAY: 0,
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    SLASH_COMMAND: 3,
    // 4 - sendAs (legacy)
    WORLD_INFO: 5,
    REASONING: 6,
};

/**
 * @readonly
 * @enum {number} How to substitute parameters in the find regex
 */
export const substitute_find_regex = {
    NONE: 0,
    RAW: 1,
    ESCAPED: 2,
};

export const REGEX_REPLACE_MODE = {
    TEXT: 'text',
    JAVASCRIPT: 'javascript',
};

const regexJavaScriptReplacementCache = new Map();
const regexLiteralPrefilterCache = new Map();

const REGEX_LITERAL_PREFILTER_MIN_LENGTH = 1;

function getEscapedRegexLiteralCharacter(char) {
    switch (char) {
        case 'n':
            return '\n';
        case 'r':
            return '\r';
        case 't':
            return '\t';
        case 'v':
            return '\v';
        case 'f':
            return '\f';
        default:
            return 'sSdDwWbBAZpPuUxXc0'.includes(char) ? null : char;
    }
}

function hasUnsafeRegexLiteralPrefilterPattern(source) {
    let escaped = false;
    let inCharacterClass = false;

    for (let i = 0; i < source.length; i++) {
        const char = source[i];

        if (escaped) {
            escaped = false;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            continue;
        }

        if (char === '[') {
            inCharacterClass = true;
            continue;
        }

        if (char === ']' && inCharacterClass) {
            inCharacterClass = false;
            continue;
        }

        if (inCharacterClass) {
            continue;
        }

        if (char === '|') {
            return true;
        }

        if (char === '(' && source[i + 1] === '?') {
            return true;
        }

        if (char === ')' && ['?', '*'].includes(source[i + 1])) {
            return true;
        }

        if (char === ')' && source[i + 1] === '{' && source.slice(i + 2).startsWith('0')) {
            return true;
        }
    }

    return false;
}

function getLongestRequiredRegexLiteral(source) {
    if (hasUnsafeRegexLiteralPrefilterPattern(source)) {
        return '';
    }

    const literalRuns = [];
    let currentRun = '';
    let escaped = false;
    let inCharacterClass = false;

    const flushRun = () => {
        if (currentRun.length > 0) {
            literalRuns.push(currentRun);
            currentRun = '';
        }
    };

    const removeLastLiteralCharacter = () => {
        if (currentRun.length > 0) {
            currentRun = currentRun.slice(0, -1);
        }
    };

    for (let i = 0; i < source.length; i++) {
        const char = source[i];

        if (escaped) {
            const literalChar = getEscapedRegexLiteralCharacter(char);
            if (literalChar === null) {
                flushRun();
            } else {
                currentRun += literalChar;
            }
            escaped = false;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            continue;
        }

        if (char === '[') {
            flushRun();
            inCharacterClass = true;
            continue;
        }

        if (char === ']' && inCharacterClass) {
            inCharacterClass = false;
            continue;
        }

        if (inCharacterClass) {
            continue;
        }

        if (char === '?' || char === '*') {
            removeLastLiteralCharacter();
            flushRun();
            continue;
        }

        if (char === '{' && source.slice(i + 1).startsWith('0')) {
            removeLastLiteralCharacter();
            flushRun();
            continue;
        }

        if ('^$.*+{}()'.includes(char)) {
            flushRun();
            continue;
        }

        currentRun += char;
    }

    flushRun();

    return literalRuns.reduce((longest, literal) => literal.length > longest.length ? literal : longest, '');
}

function getRegexLiteralPrefilter(regexString, regex) {
    const cacheKey = `${regexString}\x00${regex.flags}`;
    if (regexLiteralPrefilterCache.has(cacheKey)) {
        return regexLiteralPrefilterCache.get(cacheKey);
    }

    const literal = getLongestRequiredRegexLiteral(regex.source);
    const ignoreCase = regex.ignoreCase && literal.toLowerCase() !== literal.toUpperCase();
    const prefilter = literal.length >= REGEX_LITERAL_PREFILTER_MIN_LENGTH
        ? { literal: ignoreCase ? literal.toLowerCase() : literal, ignoreCase }
        : null;

    regexLiteralPrefilterCache.set(cacheKey, prefilter);
    return prefilter;
}

function canSkipRegexByLiteralPrefilter(regexString, regex, rawString, getLowercaseRawString) {
    const prefilter = getRegexLiteralPrefilter(regexString, regex);
    if (!prefilter) {
        return false;
    }

    const text = prefilter.ignoreCase
        ? (typeof getLowercaseRawString === 'function' ? getLowercaseRawString() : rawString.toLowerCase())
        : rawString;

    return !text.includes(prefilter.literal);
}

function sanitizeRegexMacro(x) {
    return (x && typeof x === 'string') ?
        x.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, function (s) {
            switch (s) {
                case '\n':
                    return '\\n';
                case '\r':
                    return '\\r';
                case '\t':
                    return '\\t';
                case '\v':
                    return '\\v';
                case '\f':
                    return '\\f';
                case '\0':
                    return '\\0';
                default:
                    return '\\' + s;
            }
        }) : x;
}

/**
 * Parent function to fetch a regexed version of a raw string
 * @param {string} rawString The raw string to be regexed
 * @param {regex_placement} placement The placement of the string
 * @param {RegexParams} params The parameters to use for the regex script
 * @returns {string} The regexed string
 * @typedef {{characterOverride?: string, isMarkdown?: boolean, isPrompt?: boolean, isEdit?: boolean, depth?: number, scripts?: RegexScript[] }} RegexParams The parameters to use for the regex script
 */
export function getRegexedString(rawString, placement, { characterOverride, isMarkdown, isPrompt, isEdit, depth, scripts } = {}) {
    // WTF have you passed me?
    if (typeof rawString !== 'string') {
        console.warn('getRegexedString: rawString is not a string. Returning empty string.');
        return '';
    }

    let finalString = rawString;
    if (extension_settings.disabledExtensions.includes('regex') || !rawString || placement === undefined) {
        return finalString;
    }

    const allRegex = Array.isArray(scripts) ? scripts : getRegexScripts({ allowedOnly: true });
    let lowercaseFinalString;

    allRegex.forEach((script) => {
        if (!script.placement.includes(placement)) {
            return;
        }

        if (
            // Script applies to Markdown and input is Markdown
            (script.markdownOnly && isMarkdown) ||
            // Script applies to Generate and input is Generate
            (script.promptOnly && isPrompt) ||
            // Script applies to all cases when neither "only"s are true, but there's no need to do it when `isMarkdown`, the as source (chat history) should already be changed beforehand
            (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt)
        ) {
            if (isEdit && !script.runOnEdit) {
                return;
            }

            // Check if the depth is within the min/max depth
            if (typeof depth === 'number') {
                if (!isNaN(script.minDepth) && script.minDepth !== null && script.minDepth >= -1 && depth < script.minDepth) {
                    return;
                }

                if (!isNaN(script.maxDepth) && script.maxDepth !== null && script.maxDepth >= 0 && depth > script.maxDepth) {
                    return;
                }
            }

            const beforeRegex = finalString;
            finalString = runRegexScript(script, finalString, {
                characterOverride,
                getLowercaseRawString: () => lowercaseFinalString ??= finalString.toLowerCase(),
            });

            if (finalString !== beforeRegex) {
                lowercaseFinalString = undefined;
            }
        }
    });

    return finalString;
}

function getRegexReplacementMode(regexScript) {
    return Object.values(REGEX_REPLACE_MODE).includes(regexScript.replaceMode)
        ? regexScript.replaceMode
        : REGEX_REPLACE_MODE.TEXT;
}

function normalizeRegexJavaScriptReplacement(value) {
    if (value === null || value === undefined) {
        return '';
    }

    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }

    return String(value);
}

function getRegexReplacementContext(match, args, regexScript, params) {
    const lastArg = args[args.length - 1];
    const hasGroups = lastArg && typeof lastArg === 'object';
    const groups = hasGroups ? lastArg : {};
    const offset = hasGroups ? args[args.length - 3] : args[args.length - 2];
    const input = hasGroups ? args[args.length - 2] : lastArg;
    const captures = [match, ...args.slice(0, hasGroups ? -3 : -2)];

    return {
        match,
        captures,
        groups,
        offset,
        input,
        script: {
            id: regexScript.id,
            scriptName: regexScript.scriptName,
        },
        params,
    };
}

function createRegexJavaScriptReplacementFunction(regexScript) {
    const cacheKey = `${regexScript.id ?? regexScript.scriptName ?? ''}\x00${regexScript.replaceString ?? ''}`;
    if (regexJavaScriptReplacementCache.has(cacheKey)) {
        return regexJavaScriptReplacementCache.get(cacheKey);
    }

    try {
        const fn = new Function(
            'match',
            'captures',
            'groups',
            'offset',
            'input',
            'script',
            'params',
            '"use strict";\n' + (regexScript.replaceString ?? ''),
        );
        regexJavaScriptReplacementCache.set(cacheKey, fn);
        return fn;
    } catch (error) {
        console.warn(`Regex JavaScript replacement failed to compile for script "${regexScript.scriptName || regexScript.id}":`, error);
        regexJavaScriptReplacementCache.set(cacheKey, null);
        return null;
    }
}

function runRegexJavaScriptReplacement(regexScript, fn, context) {
    if (!fn) {
        return context.match;
    }

    try {
        const result = fn(
            context.match,
            context.captures,
            context.groups,
            context.offset,
            context.input,
            context.script,
            context.params,
        );
        return normalizeRegexJavaScriptReplacement(result);
    } catch (error) {
        console.warn(`Regex JavaScript replacement failed for script "${regexScript.scriptName || regexScript.id}":`, error);
        return context.match;
    }
}

/**
 * Runs the provided regex script on the given string
 * @param {RegexScript} regexScript The regex script to run
 * @param {string} rawString The string to run the regex script on
 * @param {RegexScriptParams} params The parameters to use for the regex script
 * @returns {string} The new string
 * @typedef {{characterOverride?: string, getLowercaseRawString?: () => string}} RegexScriptParams The parameters to use for the regex script
 */
export function runRegexScript(regexScript, rawString, { characterOverride, getLowercaseRawString } = {}) {
    let newString = rawString;
    if (!regexScript || !!(regexScript.disabled) || !regexScript?.findRegex || !rawString) {
        return newString;
    }

    const getRegexString = () => {
        switch (Number(regexScript.substituteRegex)) {
            case substitute_find_regex.NONE:
                return regexScript.findRegex;
            case substitute_find_regex.RAW:
                return substituteParamsExtended(regexScript.findRegex);
            case substitute_find_regex.ESCAPED:
                return substituteParamsExtended(regexScript.findRegex, {}, sanitizeRegexMacro);
            default:
                console.warn(`runRegexScript: Unknown substituteRegex value ${regexScript.substituteRegex}. Using raw regex.`);
                return regexScript.findRegex;
        }
    };
    const regexString = getRegexString();
    const findRegex = RegexProvider.instance.get(regexString);

    // The user skill issued. Return with nothing.
    if (!findRegex) {
        return newString;
    }

    if (canSkipRegexByLiteralPrefilter(regexString, findRegex, rawString, getLowercaseRawString)) {
        return newString;
    }

    const replaceMode = getRegexReplacementMode(regexScript);
    const replacementFunction = replaceMode === REGEX_REPLACE_MODE.JAVASCRIPT
        ? createRegexJavaScriptReplacementFunction(regexScript)
        : null;

    // Run replacement. Currently does not support the Overlay strategy
    newString = rawString.replace(findRegex, function (match) {
        const args = [...arguments].slice(1);

        if (replaceMode === REGEX_REPLACE_MODE.JAVASCRIPT) {
            return runRegexJavaScriptReplacement(
                regexScript,
                replacementFunction,
                getRegexReplacementContext(match, args, regexScript, { characterOverride }),
            );
        }

        const replaceString = String(regexScript.replaceString ?? '').replace(/{{match}}/gi, '$0');
        const trimStrings = Array.isArray(regexScript.trimStrings) ? regexScript.trimStrings : [];
        const replaceWithGroups = replaceString.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_, num, groupName) => {
            let matchedValue;
            if (num) {
                // Handle numbered capture groups ($1, $2, etc.)
                matchedValue = Number(num) === 0 ? match : args[Number(num) - 1];
            } else if (groupName) {
                // Handle named capture groups ($<name>)
                const groups = args[args.length - 1];
                matchedValue = groups && typeof groups === 'object' && groups[groupName];
            }

            // No match found - return the empty string
            if (!matchedValue) {
                return '';
            }

            // Remove trim strings from the match
            const filteredMatch = filterString(matchedValue, trimStrings, { characterOverride });

            return filteredMatch;
        });

        // Substitute at the end
        return substituteParams(replaceWithGroups);
    });

    return newString;
}

/**
 * Filters anything to trim from the regex match
 * @param {string} rawString The raw string to filter
 * @param {string[]} trimStrings The strings to trim
 * @param {RegexScriptParams} params The parameters to use for the regex filter
 * @returns {string} The filtered string
 */
function filterString(rawString, trimStrings, { characterOverride } = {}) {
    let finalString = rawString;
    trimStrings.forEach((trimString) => {
        const subTrimString = substituteParams(trimString, { name2Override: characterOverride });
        finalString = finalString.replaceAll(subTrimString, '');
    });

    return finalString;
}
