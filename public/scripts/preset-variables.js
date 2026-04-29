import { POPUP_RESULT, POPUP_TYPE, Popup } from './popup.js';
import { escapeHtml } from './utils.js';

export const WULFS_HOLLOW_EXTENSION_KEY = 'wulfs_hollow';
export const PRESET_VARIABLES_KEY = 'preset_variables';
export const PRESET_VARIABLES_EXTENSION_PATH = `${WULFS_HOLLOW_EXTENSION_KEY}.${PRESET_VARIABLES_KEY}`;

const PRESET_VARIABLES_VERSION = 1;
let initialized = false;

/**
 * @typedef {{version: number, variables: Record<string, any>}} PresetVariableState
 */

function getActivePresetManager(apiId = '') {
    return globalThis.SillyTavern?.getContext?.()?.getPresetManager?.(apiId || '') || null;
}

function getActivePresetName(apiId = '') {
    return getActivePresetManager(apiId)?.getSelectedPresetName?.() || '';
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalizes stored preset variable state and supports early direct-object drafts.
 * @param {any} value Stored extension value
 * @returns {PresetVariableState}
 */
export function normalizePresetVariableState(value) {
    if (!isPlainObject(value)) {
        return { version: PRESET_VARIABLES_VERSION, variables: {} };
    }

    const variables = isPlainObject(value.variables)
        ? value.variables
        : Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'version'));
    return {
        version: Number.isFinite(value.version) ? value.version : PRESET_VARIABLES_VERSION,
        variables: Object.fromEntries(Object.entries(variables).filter(([name]) => typeof name === 'string' && name.trim())),
    };
}

/**
 * Gets all preset variables for the active preset.
 * @param {string} [apiId] Optional preset manager API id
 * @returns {Record<string, any>}
 */
export function getPresetVariables(apiId = '') {
    const manager = getActivePresetManager(apiId);
    const state = normalizePresetVariableState(manager?.readPresetExtensionField?.({
        path: PRESET_VARIABLES_EXTENSION_PATH,
    }));
    return state.variables;
}

/**
 * Saves a complete preset variable map to the active preset.
 * @param {Record<string, any>} variables Variable map
 * @param {string} [apiId] Optional preset manager API id
 * @returns {Promise<void>}
 */
export async function savePresetVariables(variables, apiId = '') {
    const manager = getActivePresetManager(apiId);
    if (!manager) {
        return;
    }

    const normalizedVariables = {};
    for (const [name, value] of Object.entries(variables || {})) {
        const key = String(name || '').trim();
        if (!key) continue;
        normalizedVariables[key] = value ?? '';
    }

    await manager.writePresetExtensionField({
        path: PRESET_VARIABLES_EXTENSION_PATH,
        value: {
            version: PRESET_VARIABLES_VERSION,
            variables: normalizedVariables,
        },
    });
}

function resolveIndexedValue(value, args = {}) {
    let resolved = value;
    if (args.index !== undefined) {
        try {
            resolved = JSON.parse(resolved);
            const numericIndex = Number(args.index);
            resolved = Number.isNaN(numericIndex) ? resolved[args.index] : resolved[numericIndex];
            if (typeof resolved === 'object') {
                resolved = JSON.stringify(resolved);
            }
        } catch {
            // Keep the raw value if it is not JSON-indexable.
        }
    }

    return (resolved?.trim?.() === '' || isNaN(Number(resolved))) ? (resolved || '') : Number(resolved);
}

/**
 * Checks if the active preset defines a variable.
 * @param {string} name Variable name
 * @returns {boolean}
 */
export function existsPresetVariable(name) {
    return Object.hasOwn(getPresetVariables(), String(name || '').trim());
}

/**
 * Gets a preset variable from the active preset.
 * @param {string} name Variable name
 * @param {object} [args] Optional index args
 * @returns {string|number}
 */
export function getPresetVariable(name, args = {}) {
    const key = String(args.key ?? name ?? '').trim();
    const variables = getPresetVariables();
    return resolveIndexedValue(variables[key], args);
}

/**
 * Sets a preset variable on the active preset.
 * @param {string} name Variable name
 * @param {any} value Variable value
 * @returns {any}
 */
export function setPresetVariable(name, value) {
    const key = String(name || '').trim();
    if (!key) {
        throw new Error('Preset variable name cannot be empty or undefined.');
    }

    const variables = getPresetVariables();
    variables[key] = value ?? '';
    void savePresetVariables(variables).catch(error => console.warn('Preset variable could not be saved', error));
    return value;
}

/**
 * Deletes a preset variable from the active preset.
 * @param {string} name Variable name
 * @returns {string}
 */
export function deletePresetVariable(name) {
    const key = String(name || '').trim();
    const variables = getPresetVariables();
    delete variables[key];
    void savePresetVariables(variables).catch(error => console.warn('Preset variable could not be saved', error));
    return '';
}

/**
 * Adds a value to a preset variable, matching local/global variable add semantics.
 * @param {string} name Variable name
 * @param {any} value Value to add
 * @returns {string|number|any[]}
 */
export function addPresetVariable(name, value) {
    const currentValue = getPresetVariable(name) || 0;
    try {
        const parsedValue = JSON.parse(currentValue);
        if (Array.isArray(parsedValue)) {
            parsedValue.push(value);
            setPresetVariable(name, JSON.stringify(parsedValue));
            return parsedValue;
        }
    } catch {
        // Ignore non-array values.
    }

    const increment = Number(value);
    if (isNaN(increment) || isNaN(Number(currentValue))) {
        const stringValue = String(currentValue || '') + value;
        setPresetVariable(name, stringValue);
        return stringValue;
    }

    const newValue = Number(currentValue) + increment;
    if (isNaN(newValue)) {
        return '';
    }

    setPresetVariable(name, newValue);
    return newValue;
}

export function incrementPresetVariable(name) {
    return addPresetVariable(name, 1);
}

export function decrementPresetVariable(name) {
    return addPresetVariable(name, -1);
}

function getActivePresetObject() {
    const manager = getActivePresetManager();
    const name = getActivePresetName();
    if (!manager || !name) {
        return null;
    }

    return manager.getPresetSettings?.(name) || manager.getCompletionPresetByName?.(name) || null;
}

function getPromptLabel(prompt) {
    return String(prompt?.name || prompt?.identifier || 'Unnamed prompt');
}

function getPromptSources(preset) {
    return Array.isArray(preset?.prompts)
        ? preset.prompts.filter(prompt => prompt && typeof prompt.content === 'string')
        : [];
}

function makeOccurrenceId() {
    return `pv-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function findBalancedMacroEnd(text, start) {
    let depth = 1;
    let cursor = start + 2;

    while (cursor < text.length) {
        const nextOpen = text.indexOf('{{', cursor);
        const nextClose = text.indexOf('}}', cursor);

        if (nextClose === -1) {
            return -1;
        }

        if (nextOpen !== -1 && nextOpen < nextClose) {
            depth++;
            cursor = nextOpen + 2;
            continue;
        }

        depth--;
        cursor = nextClose + 2;
        if (depth === 0) {
            return cursor;
        }
    }

    return -1;
}

function findInlineSetOccurrences(text) {
    const results = [];
    let cursor = 0;

    while (cursor < text.length) {
        const start = text.indexOf('{{', cursor);
        if (start === -1) break;

        const end = findBalancedMacroEnd(text, start);
        if (end === -1) break;

        const raw = text.slice(start, end);
        const prefixMatch = raw.match(/^{{\s*(setpresetvar|setvar)\s*::\s*([^}:]+?)\s*::/i);
        if (prefixMatch) {
            const valueStart = start + prefixMatch[0].length;
            const valueEnd = end - 2;
            results.push({
                type: prefixMatch[1].toLowerCase(),
                name: String(prefixMatch[2] || '').trim(),
                value: text.slice(valueStart, valueEnd),
                fullStart: start,
                fullEnd: end,
                valueStart,
                valueEnd,
            });
        }

        cursor = end;
    }

    return results;
}

/**
 * Scans active preset prompts for variable setters and callers.
 * @returns {{variables: Map<string, {name: string, sets: object[], calls: object[]}>, occurrences: Map<string, object>}}
 */
function scanPresetVariableUsage() {
    const preset = getActivePresetObject();
    /** @type {Map<string, {name: string, sets: object[], calls: object[]}>} */
    const variables = new Map();
    /** @type {Map<string, object>} */
    const occurrences = new Map();

    const ensureVariable = (name) => {
        const key = String(name || '').trim();
        if (!key) return null;
        if (!variables.has(key)) {
            variables.set(key, { name: key, sets: [], calls: [] });
        }
        return variables.get(key);
    };

    const addSet = (prompt, occurrence) => {
        const variable = ensureVariable(occurrence.name);
        if (!variable) return;
        occurrence.id = makeOccurrenceId();
        occurrence.prompt = prompt;
        occurrence.promptId = prompt.identifier;
        occurrence.promptName = getPromptLabel(prompt);
        variable.sets.push(occurrence);
        occurrences.set(occurrence.id, occurrence);
    };

    const addCall = (prompt, occurrence) => {
        const variable = ensureVariable(occurrence.name);
        if (!variable) return;
        occurrence.id = makeOccurrenceId();
        occurrence.prompt = prompt;
        occurrence.promptId = prompt.identifier;
        occurrence.promptName = getPromptLabel(prompt);
        variable.calls.push(occurrence);
        occurrences.set(occurrence.id, occurrence);
    };

    for (const prompt of getPromptSources(preset)) {
        const text = prompt.content || '';
        const scopedSetPattern = /({{\s*([#!?~>\-]*)\s*(setpresetvar|setvar)\s*::\s*([^}]+?)\s*}})([\s\S]*?)({{\s*\/\s*\3\s*}})/gi;
        const setterNoValuePattern = /{{\s*(incpresetvar|decpresetvar|deletepresetvar|flushpresetvar|incvar|decvar|deletevar|flushvar)\s*::\s*([^}]+?)\s*}}/gi;
        const callPattern = /{{\s*(getpresetvar|getvar|haspresetvar|hasvar|presetvarexists|varexists)\s*::\s*([^}]+?)\s*}}/gi;
        const shorthandPattern = /{{\s*\.([a-zA-Z_][\w.-]*)([\s\S]*?)}}/g;

        for (const match of text.matchAll(scopedSetPattern)) {
            const fullStart = match.index;
            const opener = match[1];
            const rawValue = match[5] ?? '';
            const valueStart = fullStart + opener.length;
            addSet(prompt, {
                type: match[3].toLowerCase(),
                operation: 'set',
                name: String(match[4] || '').trim(),
                value: rawValue,
                format: 'scoped',
                preserveWhitespace: String(match[2] || '').includes('#'),
                editable: true,
                fullStart,
                fullEnd: fullStart + match[0].length,
                valueStart,
                valueEnd: valueStart + rawValue.length,
            });
        }

        for (const occurrence of findInlineSetOccurrences(text)) {
            addSet(prompt, {
                type: occurrence.type,
                operation: 'set',
                name: occurrence.name,
                value: occurrence.value,
                format: 'inline',
                preserveWhitespace: false,
                editable: true,
                fullStart: occurrence.fullStart,
                fullEnd: occurrence.fullEnd,
                valueStart: occurrence.valueStart,
                valueEnd: occurrence.valueEnd,
            });
        }

        for (const match of text.matchAll(setterNoValuePattern)) {
            addSet(prompt, {
                type: match[1].toLowerCase(),
                operation: match[1].toLowerCase().replace(/(?:preset)?var$/, ''),
                name: String(match[2] || '').trim(),
                value: '',
                format: 'operator',
                preserveWhitespace: false,
                editable: false,
                fullStart: match.index,
                fullEnd: match.index + match[0].length,
            });
        }

        for (const match of text.matchAll(callPattern)) {
            addCall(prompt, {
                type: match[1].toLowerCase(),
                operation: 'call',
                name: String(match[2] || '').trim(),
                format: 'macro',
                fullStart: match.index,
                fullEnd: match.index + match[0].length,
            });
        }

        for (const match of text.matchAll(shorthandPattern)) {
            const tail = String(match[2] || '').trim();
            const isSetter = /^(?:=|\+=|-=|\+\+|--|\|\|=|\?\?=)/.test(tail);
            const occurrence = {
                type: 'shorthand',
                operation: isSetter ? 'set' : 'call',
                name: String(match[1] || '').trim(),
                value: isSetter ? tail : '',
                format: 'shorthand',
                editable: false,
                fullStart: match.index,
                fullEnd: match.index + match[0].length,
            };
            if (isSetter) {
                addSet(prompt, occurrence);
            } else {
                addCall(prompt, occurrence);
            }
        }
    }

    return { variables, occurrences };
}

function detectVariableNamesFromPreset() {
    return [...scanPresetVariableUsage().variables.keys()].sort((a, b) => a.localeCompare(b));
}

function createPresetVariableRow(name = '', value = '') {
    const row = $('<div class="preset-variable-row"></div>');
    const nameInput = $('<input>', {
        type: 'text',
        class: 'text_pole preset-variable-name',
        placeholder: 'name',
        value: name,
    });
    const valueInput = $('<textarea></textarea>', {
        class: 'text_pole textarea_compact preset-variable-value',
        placeholder: 'value',
        rows: 2,
    }).val(String(value ?? ''));
    const deleteButton = $('<button></button>', {
        type: 'button',
        class: 'menu_button menu_button_icon preset-variable-delete',
        title: 'Delete variable',
        'aria-label': 'Delete variable',
    }).append($('<i class="fa-solid fa-trash-can"></i>'));

    deleteButton.on('click', () => row.remove());
    row.append(nameInput, valueInput, deleteButton);
    return row;
}

function readVariableRows(container) {
    const variables = {};
    container.find('.preset-variable-row').each((_, element) => {
        const row = $(element);
        const name = String(row.find('.preset-variable-name').val() || '').trim();
        if (!name) {
            return;
        }
        variables[name] = String(row.find('.preset-variable-value').val() ?? '');
    });
    return variables;
}

function createUsageSourceList(occurrences) {
    if (!occurrences.length) {
        return $('<div class="preset-variable-usage-empty">None found</div>');
    }

    const uniqueSources = [...new Set(occurrences.map(item => item.promptName))].sort((a, b) => a.localeCompare(b));
    const list = $('<div class="preset-variable-source-list"></div>');
    for (const source of uniqueSources) {
        list.append($('<span class="preset-variable-source-chip"></span>').text(source));
    }
    return list;
}

function createSetOccurrenceEditor(occurrence) {
    const row = $('<div class="preset-variable-set-row"></div>').attr('data-occurrence-id', occurrence.id);
    const meta = $('<div class="preset-variable-set-meta"></div>');
    meta.append($('<strong></strong>').text(occurrence.promptName));
    meta.append($('<small></small>').text(`${occurrence.type} (${occurrence.format})`));

    if (occurrence.editable) {
        const textarea = $('<textarea></textarea>', {
            class: 'text_pole textarea_compact preset-variable-set-value',
            rows: 3,
        }).val(String(occurrence.value ?? ''));
        row.append(meta, textarea);

        if (occurrence.format === 'inline') {
            const convertButton = $('<button type="button" class="menu_button preset-variable-convert-scoped"><i class="fa-solid fa-align-left"></i><span>Multiline</span></button>');
            convertButton.on('click', () => {
                occurrence.convertToScoped = true;
                convertButton.prop('disabled', true).addClass('disabled').find('span').text('Will convert');
                textarea.addClass('preset-variable-convert-pending');
            });
            row.append(convertButton);
        }
    } else {
        row.append(meta, $('<div class="preset-variable-set-readonly"></div>').text(occurrence.value || 'No editable value'));
    }

    return row;
}

function renderPromptUsageInspector(scan) {
    const wrapper = $('<div class="preset-variable-usage"></div>');
    const variables = [...scan.variables.values()].sort((a, b) => a.name.localeCompare(b.name));

    wrapper.append('<h4>Detected in Prompt Manager</h4>');
    wrapper.append('<div class="preset-variables-note">Shows where variables are set and called in the active Chat Completion preset. Simple set values can be edited here.</div>');

    if (!variables.length) {
        wrapper.append('<div class="preset-variable-usage-empty">No variables found in this preset.</div>');
        return wrapper;
    }

    for (const variable of variables) {
        const card = $('<div class="preset-variable-usage-card"></div>');
        const header = $('<div class="preset-variable-usage-header"></div>');
        header.append($('<strong></strong>').text(variable.name));
        header.append($('<span></span>').text(`${variable.sets.length} set / ${variable.calls.length} call`));
        card.append(header);

        const setBlock = $('<div class="preset-variable-usage-block"></div>');
        setBlock.append('<div class="preset-variable-usage-label">Set in</div>');
        if (variable.sets.length) {
            for (const occurrence of variable.sets) {
                setBlock.append(createSetOccurrenceEditor(occurrence));
            }
        } else {
            setBlock.append('<div class="preset-variable-usage-empty">Not set in prompts</div>');
        }
        card.append(setBlock);

        const callBlock = $('<div class="preset-variable-usage-block"></div>');
        callBlock.append('<div class="preset-variable-usage-label">Called in</div>');
        callBlock.append(createUsageSourceList(variable.calls));
        card.append(callBlock);

        wrapper.append(card);
    }

    return wrapper;
}

function escapeMacroName(name) {
    return String(name || '').replace(/[{}]/g, '').trim();
}

async function savePromptUsageEdits(rows, occurrences) {
    const manager = getActivePresetManager();
    const presetName = getActivePresetName();
    const preset = getActivePresetObject();
    if (!manager || !presetName || !preset || !Array.isArray(preset.prompts)) {
        return false;
    }

    /** @type {Map<object, object[]>} */
    const editsByPrompt = new Map();

    rows.find('.preset-variable-set-row[data-occurrence-id]').each((_, element) => {
        const row = $(element);
        const occurrence = occurrences.get(String(row.attr('data-occurrence-id') || ''));
        if (!occurrence?.editable) {
            return;
        }

        const nextValue = String(row.find('.preset-variable-set-value').val() ?? '');
        if (nextValue === occurrence.value && !occurrence.convertToScoped) {
            return;
        }

        if (!editsByPrompt.has(occurrence.prompt)) {
            editsByPrompt.set(occurrence.prompt, []);
        }

        editsByPrompt.get(occurrence.prompt).push({
            ...occurrence,
            nextValue,
        });
    });

    if (!editsByPrompt.size) {
        return false;
    }

    for (const [prompt, edits] of editsByPrompt.entries()) {
        let content = String(prompt.content || '');
        edits.sort((a, b) => b.fullStart - a.fullStart);
        for (const edit of edits) {
            if (edit.convertToScoped) {
                const macroName = edit.type === 'setpresetvar' ? 'setpresetvar' : 'setvar';
                const replacement = `{{#${macroName}::${escapeMacroName(edit.name)}}}\n${edit.nextValue}\n{{/${macroName}}}`;
                content = content.slice(0, edit.fullStart) + replacement + content.slice(edit.fullEnd);
            } else {
                content = content.slice(0, edit.valueStart) + edit.nextValue + content.slice(edit.valueEnd);
            }
        }
        prompt.content = content;
    }

    await manager.savePreset(presetName, preset, { skipUpdate: true });
    globalThis.SillyTavern?.getContext?.()?.saveSettingsDebounced?.();
    return true;
}

async function openPresetVariablesEditor() {
    const manager = getActivePresetManager();
    const presetName = getActivePresetName();
    if (!manager || !presetName) {
        toastr.warning('Select a completion preset first.');
        return;
    }

    const variables = getPresetVariables();
    const scan = scanPresetVariableUsage();
    const wrapper = $('<div class="preset-variables-editor"></div>');
    wrapper.append(`<h3>Preset Variables</h3>`);
    wrapper.append(`<div class="preset-variables-subtitle">Saved to <code>${escapeHtml(presetName)}</code>.</div>`);
    wrapper.append('<div class="preset-variables-note">Use <code>{{getpresetvar::name}}</code> to read saved preset variables directly. <code>{{getvar::name}}</code> also uses them when no chat variable with that name exists.</div>');

    const rows = $('<div class="preset-variable-rows"></div>');
    for (const [name, value] of Object.entries(variables).sort(([a], [b]) => a.localeCompare(b))) {
        rows.append(createPresetVariableRow(name, value));
    }

    if (!Object.keys(variables).length) {
        rows.append(createPresetVariableRow());
    }

    const actions = $('<div class="preset-variable-actions"></div>');
    const addButton = $('<button type="button" class="menu_button"><i class="fa-solid fa-plus"></i><span>Add variable</span></button>');
    const detectButton = $('<button type="button" class="menu_button"><i class="fa-solid fa-wand-magic-sparkles"></i><span>Detect from preset</span></button>');
    addButton.on('click', () => rows.append(createPresetVariableRow()));
    detectButton.on('click', () => {
        const current = readVariableRows(rows);
        const detectedNames = detectVariableNamesFromPreset();
        let added = 0;
        for (const name of detectedNames) {
            if (Object.hasOwn(current, name)) continue;
            rows.append(createPresetVariableRow(name, ''));
            current[name] = '';
            added++;
        }
        toastr.info(added ? `Added ${added} detected variable${added === 1 ? '' : 's'}.` : 'No new preset variables found.');
    });
    actions.append(addButton, detectButton);

    wrapper.append(actions, rows, renderPromptUsageInspector(scan));

    const popup = new Popup(wrapper, POPUP_TYPE.TEXT, '', {
        okButton: 'Save',
        cancelButton: 'Cancel',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    await savePresetVariables(readVariableRows(rows));
    const promptEditsSaved = await savePromptUsageEdits(wrapper, scan.occurrences);
    toastr.success(promptEditsSaved ? 'Preset variables and prompt edits saved.' : 'Preset variables saved.');
}

export function initPresetVariables() {
    if (initialized) {
        return;
    }

    initialized = true;
    $(document).on('click', '#manage_preset_variables', openPresetVariablesEditor);
}
