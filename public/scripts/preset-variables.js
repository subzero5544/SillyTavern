import { POPUP_RESULT, POPUP_TYPE, Popup } from './popup.js';
import { escapeHtml } from './utils.js';

let initialized = false;

function getActivePresetManager() {
    return globalThis.SillyTavern?.getContext?.()?.getPresetManager?.('openai') || null;
}

function getActivePresetName() {
    return getActivePresetManager()?.getSelectedPresetName?.() || '';
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getActivePresetObject() {
    const manager = getActivePresetManager();
    const name = getActivePresetName();
    if (!manager || !name) {
        return null;
    }

    const completionPreset = manager.getCompletionPresetByName?.(name);
    if (completionPreset && isPlainObject(completionPreset)) {
        return completionPreset;
    }

    return manager.getPresetSettings?.(name) || null;
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
    return `vi-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
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
        const prefixMatch = raw.match(/^{{\s*(setvar|setglobalvar|addvar|addglobalvar)\s*::\s*([^}:]+?)\s*::/i)
            || raw.match(/^{{\s*(setvar|setglobalvar|addvar|addglobalvar)\s+([^\s}]+)\s+/i);
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

function getVariableScope(type) {
    return type.includes('global') ? 'global' : 'local';
}

/**
 * Scans active preset prompts for normal variable setters and callers.
 * @returns {{variables: Map<string, {name: string, scope: string, sets: object[], calls: object[]}>, occurrences: Map<string, object>}}
 */
function scanVariableUsage() {
    const preset = getActivePresetObject();
    /** @type {Map<string, {name: string, scope: string, sets: object[], calls: object[]}>} */
    const variables = new Map();
    /** @type {Map<string, object>} */
    const occurrences = new Map();

    const ensureVariable = (name, scope = 'local') => {
        const key = String(name || '').trim();
        if (!key) return null;
        const mapKey = `${scope}:${key}`;
        if (!variables.has(mapKey)) {
            variables.set(mapKey, { name: key, scope, sets: [], calls: [] });
        }
        return variables.get(mapKey);
    };

    const addSet = (prompt, occurrence) => {
        const variable = ensureVariable(occurrence.name, occurrence.scope);
        if (!variable) return;
        occurrence.id = makeOccurrenceId();
        occurrence.prompt = prompt;
        occurrence.promptId = prompt.identifier;
        occurrence.promptName = getPromptLabel(prompt);
        variable.sets.push(occurrence);
        occurrences.set(occurrence.id, occurrence);
    };

    const addCall = (prompt, occurrence) => {
        const variable = ensureVariable(occurrence.name, occurrence.scope);
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
        const scopedSetPattern = /({{\s*([#!?~>\-]*)\s*(setvar|setglobalvar|addvar|addglobalvar)\s*::\s*([^}]+?)\s*}})([\s\S]*?)({{\s*\/\s*\3\s*}})/gi;
        const setterNoValuePattern = /{{\s*(incvar|decvar|deletevar|flushvar|incglobalvar|decglobalvar|deleteglobalvar|flushglobalvar)\s*::\s*([^}]+?)\s*}}/gi;
        const setterNoValueSpacePattern = /{{\s*(incvar|decvar|deletevar|flushvar|incglobalvar|decglobalvar|deleteglobalvar|flushglobalvar)\s+([^}\s]+)\s*}}/gi;
        const callPattern = /{{\s*(getvar|hasvar|varexists|getglobalvar|hasglobalvar|globalvarexists)\s*::\s*([^}]+?)\s*}}/gi;
        const callSpacePattern = /{{\s*(getvar|hasvar|varexists|getglobalvar|hasglobalvar|globalvarexists)\s+([^}\s]+)\s*}}/gi;
        const shorthandPattern = /{{\s*\.([a-zA-Z_][\w.-]*)([\s\S]*?)}}/g;

        for (const match of text.matchAll(scopedSetPattern)) {
            const fullStart = match.index;
            const opener = match[1];
            const rawValue = match[5] ?? '';
            const valueStart = fullStart + opener.length;
            const type = match[3].toLowerCase();
            addSet(prompt, {
                type,
                scope: getVariableScope(type),
                operation: type.startsWith('add') ? 'add' : 'set',
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
                scope: getVariableScope(occurrence.type),
                operation: occurrence.type.startsWith('add') ? 'add' : 'set',
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

        for (const pattern of [setterNoValuePattern, setterNoValueSpacePattern]) {
            for (const match of text.matchAll(pattern)) {
                const type = match[1].toLowerCase();
                addSet(prompt, {
                    type,
                    scope: getVariableScope(type),
                    operation: type.replace(/(?:global)?var$/, ''),
                    name: String(match[2] || '').trim(),
                    value: '',
                    format: 'operator',
                    preserveWhitespace: false,
                    editable: false,
                    fullStart: match.index,
                    fullEnd: match.index + match[0].length,
                });
            }
        }

        for (const pattern of [callPattern, callSpacePattern]) {
            for (const match of text.matchAll(pattern)) {
                const type = match[1].toLowerCase();
                addCall(prompt, {
                    type,
                    scope: getVariableScope(type),
                    operation: 'call',
                    name: String(match[2] || '').trim(),
                    format: 'macro',
                    fullStart: match.index,
                    fullEnd: match.index + match[0].length,
                });
            }
        }

        for (const match of text.matchAll(shorthandPattern)) {
            const tail = String(match[2] || '').trim();
            const isSetter = /^(?:=|\+=|-=|\+\+|--|\|\|=|\?\?=)/.test(tail);
            const occurrence = {
                type: 'shorthand',
                scope: 'local',
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

        if (occurrence.format === 'inline' && ['setvar', 'setglobalvar'].includes(occurrence.type)) {
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

function renderVariableInspector(scan) {
    const wrapper = $('<div class="preset-variable-usage"></div>');
    const variables = [...scan.variables.values()].sort((a, b) => {
        const scopeCompare = a.scope.localeCompare(b.scope);
        return scopeCompare || a.name.localeCompare(b.name);
    });

    if (!variables.length) {
        wrapper.append('<div class="preset-variable-usage-empty">No variable macros found in this preset.</div>');
        return wrapper;
    }

    for (const variable of variables) {
        const card = $('<div class="preset-variable-usage-card"></div>');
        const header = $('<div class="preset-variable-usage-header"></div>');
        header.append($('<strong></strong>').text(variable.name));
        header.append($('<span></span>').text(`${variable.scope} / ${variable.sets.length} set / ${variable.calls.length} call`));
        card.append(header);

        const setBlock = $('<div class="preset-variable-usage-block"></div>');
        setBlock.append('<div class="preset-variable-usage-label">Set or changed in</div>');
        if (variable.sets.length) {
            for (const occurrence of variable.sets) {
                setBlock.append(createSetOccurrenceEditor(occurrence));
            }
        } else {
            setBlock.append('<div class="preset-variable-usage-empty">Not set in prompts</div>');
        }
        card.append(setBlock);

        const callBlock = $('<div class="preset-variable-usage-block"></div>');
        callBlock.append('<div class="preset-variable-usage-label">Read or checked in</div>');
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
                const replacement = `{{#${edit.type}::${escapeMacroName(edit.name)}}}\n${edit.nextValue}\n{{/${edit.type}}}`;
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

async function openVariableInspector() {
    const manager = getActivePresetManager();
    const presetName = getActivePresetName();
    if (!manager || !presetName) {
        toastr.warning('Select a Chat Completion preset first.');
        return;
    }

    const scan = scanVariableUsage();
    const wrapper = $('<div class="preset-variables-editor"></div>');
    wrapper.append('<h3>Variable Inspector</h3>');
    wrapper.append(`<div class="preset-variables-subtitle">Scanning <code>${escapeHtml(presetName)}</code>.</div>`);
    wrapper.append('<div class="preset-variables-note">This only scans and edits normal macro text in the active preset. It does not create extra preset variable storage or WH-only variable metadata.</div>');
    wrapper.append(renderVariableInspector(scan));

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

    const promptEditsSaved = await savePromptUsageEdits(wrapper, scan.occurrences);
    if (promptEditsSaved) {
        toastr.success('Prompt variable edits saved.');
    } else {
        toastr.info('No prompt variable edits to save.');
    }
}

export function initPresetVariables() {
    if (initialized) {
        return;
    }

    initialized = true;
    $(document).on('click', '#manage_preset_variables', openVariableInspector);
}
