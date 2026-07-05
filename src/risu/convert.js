import crypto from 'node:crypto';

import { evaluateRisuCbs } from '../../public/scripts/risu-cbs.js';

/**
 * Conversions from RisuAI card data to SillyTavern-native structures.
 */

// SillyTavern regex script placements (public/scripts/extensions/regex/engine.js)
const PLACEMENT_USER_INPUT = 1;
const PLACEMENT_AI_OUTPUT = 2;
const SUPPORTED_RISU_ACTION_FLAGS = new Set(['no_end_nl', 'cbs']);
const UNSUPPORTED_RISU_ACTION_FLAGS = new Set(['inject', 'move_top', 'move_bottom', 'repeat_back']);

/**
 * Maps a RisuAI script mode to SillyTavern regex script placement/flags.
 * RisuAI semantics (src/ts/process/scripts.ts):
 *  - editinput:   modifies the user's input text (destructive)
 *  - editoutput:  modifies the AI's output text before saving (destructive)
 *  - editprocess: modifies chat messages only in the outgoing request
 *  - editdisplay: modifies text only when displaying it in the chat
 * @param {string} type RisuAI script mode
 * @returns {{placement: number[], markdownOnly: boolean, promptOnly: boolean}|null}
 */
function mapRisuScriptType(type) {
    switch (type) {
        case 'editinput':
            return { placement: [PLACEMENT_USER_INPUT], markdownOnly: false, promptOnly: false };
        case 'editoutput':
            return { placement: [PLACEMENT_AI_OUTPUT], markdownOnly: false, promptOnly: false };
        case 'editprocess':
            return { placement: [PLACEMENT_USER_INPUT, PLACEMENT_AI_OUTPUT], markdownOnly: false, promptOnly: true };
        case 'editdisplay':
            return { placement: [PLACEMENT_USER_INPUT, PLACEMENT_AI_OUTPUT], markdownOnly: true, promptOnly: false };
        default:
            return null;
    }
}

/**
 * Parses RisuAI regex flags plus angle-bracket action metadata.
 * @param {object} script RisuAI customscript
 * @returns {{flags: string, actions: string[], order: number, hasUnsupportedAction: boolean}}
 */
function parseRisuScriptFlagMetadata(script) {
    const actions = [];
    let order = 0;
    let hasUnsupportedAction = false;
    let flags = script.ableFlag ? (script.flag || 'g') : 'g';

    flags = flags.replace(/<(.+?)>/g, (_, rawAction) => {
        for (const action of String(rawAction).split(',').map(x => x.trim()).filter(Boolean)) {
            if (action.startsWith('order ')) {
                order = Number.parseInt(action.slice(6), 10) || 0;
                continue;
            }

            actions.push(action);
            if (UNSUPPORTED_RISU_ACTION_FLAGS.has(action) || !SUPPORTED_RISU_ACTION_FLAGS.has(action)) {
                hasUnsupportedAction = true;
            }
        }

        return '';
    });

    flags = flags.trim().replace(/[^dgimsuvy]/g, '');
    flags = [...new Set(flags)].join('');
    return {
        flags: flags || 'u',
        actions,
        order,
        hasUnsupportedAction,
    };
}

function canRegexMatchEmpty(pattern, flags = '') {
    try {
        const safeFlags = flags.replace(/[gy]/g, '');
        const match = new RegExp(pattern, safeFlags).exec('');
        return !!match && match[0] === '';
    } catch {
        return false;
    }
}

function getRisuCbsRegexPattern(source, card, flags) {
    const defaultVariables = card?.data?.extensions?.risuai?.defaultVariables;
    const contexts = [
        { lastMessageId: -1, chatIndex: 0, role: 'char', defaultVariables },
        { lastMessageId: 0, chatIndex: 0, role: 'char', defaultVariables },
    ];
    const variants = [];

    for (const context of contexts) {
        const value = evaluateRisuCbs(source, context).trim();
        if (value && !variants.includes(value)) {
            variants.push(value);
        }
    }

    if (variants.length === 0) {
        return { pattern: '', hasZeroLengthVariant: false };
    }

    if (variants.length === 1) {
        return {
            pattern: variants[0],
            hasZeroLengthVariant: canRegexMatchEmpty(variants[0], flags),
        };
    }

    return {
        pattern: variants.map(value => `(?:${value})`).join('|'),
        hasZeroLengthVariant: variants.some(value => canRegexMatchEmpty(value, flags)),
    };
}

function formatRegexScriptSource(pattern, flags) {
    return `/${String(pattern).replaceAll('/', '\\/')}/${flags}`;
}

/**
 * Converts SillyTavern regex scripts back to RisuAI customscript format
 * (used when exporting a character as .charx).
 * @param {object[]} regexScripts ST regex scripts (data.extensions.regex_scripts)
 * @returns {object[]} RisuAI customscript array
 */
export function convertRegexScriptsToRisu(regexScripts) {
    if (!Array.isArray(regexScripts)) {
        return [];
    }

    const converted = [];

    for (const script of regexScripts) {
        if (!script || script.disabled || !script.findRegex) {
            continue;
        }

        let type;
        const placement = Array.isArray(script.placement) ? script.placement : [];
        if (script.markdownOnly) {
            type = 'editdisplay';
        } else if (script.promptOnly) {
            type = 'editprocess';
        } else if (placement.includes(PLACEMENT_AI_OUTPUT)) {
            type = 'editoutput';
        } else if (placement.includes(PLACEMENT_USER_INPUT)) {
            type = 'editinput';
        } else {
            continue;
        }

        // ST stores '/pattern/flags' or a plain pattern
        const findRegex = String(script.findRegex);
        const regexParts = findRegex.match(/^\/(.+)\/([a-z]*)$/s);
        const pattern = regexParts ? regexParts[1] : findRegex;
        const flags = regexParts?.[2] || 'g';

        converted.push({
            comment: script.scriptName || '',
            in: pattern,
            // '$$&' emits a literal '$&' (whole-match reference in RisuAI output)
            out: String(script.replaceString ?? '').replaceAll(/{{match}}/gi, '$$&'),
            type: type,
            flag: flags,
            ableFlag: true,
        });
    }

    return converted;
}

/**
 * Records imported RisuAI assets in the card data as a name → URL map
 * (data.extensions.risuai.assetMap) so the client can render RisuAI asset
 * macros like {{img::name}} and {{emotion::name}} in chat messages.
 * Lookup keys are lowercased, mirroring RisuAI's asset resolution.
 * @param {object} card Card data (CCv2/CCv3, mutated in place)
 * @param {import('../charx.js').PersistedCharXAsset[]} files Persisted asset files
 * @returns {void}
 */
export function applyRisuAssetMap(card, files) {
    try {
        if (!Array.isArray(files) || files.length === 0 || !card?.data || typeof card.data !== 'object') {
            return;
        }

        card.data.extensions = card.data.extensions ?? {};
        card.data.extensions.risuai = card.data.extensions.risuai ?? {};
        const assetMap = card.data.extensions.risuai.assetMap ?? { assets: {}, emotions: {} };
        assetMap.assets = assetMap.assets ?? {};
        assetMap.emotions = assetMap.emotions ?? {};

        for (const file of files) {
            if (!file?.name || !file?.url) {
                continue;
            }
            // Keep the original casing: RisuAI's {{assetlist}} macro and card
            // scripts compare against original names; lookups normalize client-side
            const key = String(file.name).trim();
            if (!key) {
                continue;
            }
            // Sprites double as RisuAI emotions; everything else is a generic asset
            const target = file.category === 'sprite' ? assetMap.emotions : assetMap.assets;
            if (!(key in target)) {
                target[key] = file.url;
            }
        }

        if (Array.isArray(card.data.assets)) {
            for (const file of files) {
                if (!file?.url || !Number.isInteger(file.order)) {
                    continue;
                }

                const asset = card.data.assets[file.order];
                if (asset && typeof asset === 'object') {
                    asset.uri = file.url;
                }
            }
        }

        card.data.extensions.risuai.assetMap = assetMap;
    } catch (error) {
        console.warn('RisuAI: Failed to build asset map:', error);
    }
}

/**
 * Converts RisuAI customScripts (data.extensions.risuai.customScripts) into
 * SillyTavern regex scripts (data.extensions.regex_scripts) so they actually
 * run in SillyTavern. The original customScripts are left in place for
 * round-trip export fidelity.
 *
 * Scripts using RisuAI-only features ('@@' output commands and runtime-only
 * action flags) are skipped: they have no SillyTavern equivalent and
 * converting them would inject broken replacements.
 * @param {object} card Card data (CCv2/CCv3, mutated in place)
 * @returns {void}
 */
export function convertRisuCustomScripts(card) {
    try {
        const customScripts = card?.data?.extensions?.risuai?.customScripts;
        if (!Array.isArray(customScripts) || customScripts.length === 0) {
            return;
        }

        // Already has ST regex scripts (either authored or from a previous conversion)
        if (Array.isArray(card.data.extensions.regex_scripts) && card.data.extensions.regex_scripts.length > 0) {
            return;
        }

        const converted = [];
        let skipped = 0;

        for (const script of customScripts) {
            if (!script || typeof script.in !== 'string' || script.in === '' || typeof script.out !== 'string') {
                skipped++;
                continue;
            }

            const typeMapping = mapRisuScriptType(script.type);
            if (!typeMapping) {
                skipped++;
                continue;
            }

            const flagMetadata = parseRisuScriptFlagMetadata(script);
            const cbsPattern = flagMetadata.actions.includes('cbs')
                ? getRisuCbsRegexPattern(script.in, card, flagMetadata.flags)
                : null;
            const findPattern = cbsPattern?.pattern ?? script.in;
            const flags = cbsPattern?.hasZeroLengthVariant
                ? (flagMetadata.flags.replace('g', '') || 'u')
                : flagMetadata.flags;

            if (!findPattern) {
                skipped++;
                continue;
            }

            try {
                new RegExp(findPattern, flags);
            } catch {
                skipped++;
                continue;
            }

            // '$n' is RisuAI shorthand for a newline in the output
            let replaceString = script.out.replaceAll('$n', '\n').replaceAll(/{{data}}/g, '{{match}}');

            // '@@' outputs are RisuAI runtime actions (@@emo, @@inject, @@move_top, ...);
            // most '<action>' tokens in the flag field (e.g. '<cbs>', '<inject>') likewise.
            // Non-runtime metadata such as '<order n>' and '<no_end_nl>' is safe to map.
            if (replaceString.startsWith('@@') || flagMetadata.hasUnsupportedAction) {
                skipped++;
                continue;
            }

            // RisuAI appends a newline after outputs ending with an HTML tag
            if (replaceString.endsWith('>') && !flagMetadata.actions.includes('no_end_nl')) {
                replaceString += '\n';
            }

            converted.push({
                risuOrder: flagMetadata.order,
                id: crypto.randomUUID(),
                scriptName: script.comment || `RisuAI script ${converted.length + 1}`,
                findRegex: formatRegexScriptSource(findPattern, flags),
                replaceString: replaceString,
                trimStrings: [],
                placement: typeMapping.placement,
                disabled: false,
                markdownOnly: typeMapping.markdownOnly,
                promptOnly: typeMapping.promptOnly,
                runOnEdit: typeMapping.markdownOnly,
                substituteRegex: 0,
                minDepth: null,
                maxDepth: null,
            });
        }

        if (converted.length > 0) {
            card.data.extensions.regex_scripts = converted
                .sort((a, b) => (b.risuOrder ?? 0) - (a.risuOrder ?? 0))
                .map(({ risuOrder, ...script }) => script);
            console.info(`RisuAI: Converted ${converted.length} custom script(s) to regex scripts${skipped ? `, ${skipped} skipped (RisuAI-only features)` : ''}`);
        } else if (skipped > 0) {
            console.info(`RisuAI: Skipped all ${skipped} custom script(s) (RisuAI-only features)`);
        }
    } catch (error) {
        console.warn('RisuAI: Failed to convert custom scripts:', error);
    }
}
