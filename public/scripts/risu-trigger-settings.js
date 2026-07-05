import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from './popup.js';
import { accountStorage } from './util/AccountStorage.js';

const STORAGE_PREFIX = 'RisuCardFeatures:';
const DEFAULT_SETTINGS = Object.freeze({
    triggers: true,
    code: false,
    network: false,
});

function toText(value) {
    return value === undefined || value === null ? '' : String(value);
}

function getRisuExtension(character) {
    return character?.data?.extensions?.risuai
        || character?.extensions?.risuai
        || {};
}

function getStorageKey(character) {
    const avatar = toText(character?.avatar || character?.data?.avatar || character?.name).trim();
    return avatar ? `${STORAGE_PREFIX}${avatar}` : '';
}

function readStoredSettings(character) {
    const key = getStorageKey(character);
    if (!key) {
        return null;
    }

    try {
        const value = accountStorage.getItem(key);
        return value ? JSON.parse(value) : null;
    } catch {
        return null;
    }
}

function normalizeSettings(settings = {}) {
    const code = Boolean(settings.code);
    return {
        triggers: settings.triggers === undefined ? DEFAULT_SETTINGS.triggers : Boolean(settings.triggers),
        code,
        network: code && Boolean(settings.network),
    };
}

export function getRisuCardFeatureSettings(character) {
    return normalizeSettings(readStoredSettings(character) || DEFAULT_SETTINGS);
}

export function setRisuCardFeatureSettings(character, settings) {
    const key = getStorageKey(character);
    if (!key) {
        return;
    }

    accountStorage.setItem(key, JSON.stringify(normalizeSettings(settings)));
}

export function isRisuDeclarativeTriggersEnabled(character) {
    return getRisuCardFeatureSettings(character).triggers;
}

export function isRisuCodeSandboxEnabled(character) {
    return getRisuCardFeatureSettings(character).code;
}

export function isRisuCodeNetworkEnabled(character) {
    return getRisuCardFeatureSettings(character).network;
}

export function getRisuCardTriggerSummary(character) {
    const triggers = Array.isArray(getRisuExtension(character).triggerscript)
        ? getRisuExtension(character).triggerscript
        : [];
    let declarativeCount = 0;
    let codeCount = 0;
    let luaCount = 0;
    let jsCount = 0;

    for (const trigger of triggers) {
        const effects = Array.isArray(trigger?.effect) ? trigger.effect : [];
        let hasDeclarativeEffect = false;

        for (const effect of effects) {
            if (!effect || typeof effect !== 'object') {
                continue;
            }

            if (effect.type === 'triggercode' && typeof effect.code === 'string' && effect.code.trim()) {
                codeCount++;
                jsCount++;
                continue;
            }

            if (effect.type === 'triggerlua' && typeof effect.code === 'string' && effect.code.trim()) {
                codeCount++;
                luaCount++;
                continue;
            }

            if (typeof effect.type === 'string' && effect.type !== 'v2Comment') {
                hasDeclarativeEffect = true;
            }
        }

        if (hasDeclarativeEffect) {
            declarativeCount++;
        }
    }

    return {
        triggerCount: triggers.length,
        declarativeCount,
        codeCount,
        jsCount,
        luaCount,
        hasDeclarative: declarativeCount > 0,
        hasCode: codeCount > 0,
        hasLua: luaCount > 0,
        hasFeatures: declarativeCount > 0 || codeCount > 0,
    };
}

function plural(count, noun) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function createCheckboxRow({ title, description, checked, disabled = false }) {
    const label = document.createElement('label');
    label.classList.add('checkbox_label', 'flexWrap', 'alignItemsBaseline');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(checked);
    checkbox.disabled = Boolean(disabled);

    const text = document.createElement('div');
    text.classList.add('flex1');

    const heading = document.createElement('div');
    heading.textContent = title;

    const details = document.createElement('small');
    details.textContent = description;

    text.append(heading, details);
    label.append(checkbox, text);
    return { row: label, checkbox };
}

export async function showRisuCardFeaturePopup(character, { importPrompt = false } = {}) {
    const summary = getRisuCardTriggerSummary(character);
    if (!summary.hasFeatures) {
        return { shown: false, saved: false, settings: getRisuCardFeatureSettings(character) };
    }

    const current = getRisuCardFeatureSettings(character);
    const initial = importPrompt
        ? { triggers: summary.hasDeclarative, code: summary.hasCode, network: false }
        : current;
    const content = document.createElement('div');
    content.classList.add('flex-container', 'flexFlowColumn', 'wide100p');

    const title = document.createElement('h3');
    title.textContent = importPrompt
        ? `${character?.name || 'This card'} ships RisuAI interactive features`
        : `RisuAI card features for ${character?.name || 'this card'}`;

    const note = document.createElement('p');
    note.textContent = 'Choose which imported card features are allowed to run for this character.';

    const rows = document.createElement('div');
    rows.classList.add('flex-container', 'flexFlowColumn', 'wide100p');

    let triggersCheckbox = null;
    let codeCheckbox = null;
    let networkCheckbox = null;

    if (summary.hasDeclarative) {
        const created = createCheckboxRow({
            title: 'Enable triggers',
            description: `${plural(summary.declarativeCount, 'trigger script')} for variables, conditionals, chat edits, and prompt changes.`,
            checked: initial.triggers,
        });
        triggersCheckbox = created.checkbox;
        rows.append(created.row);
    }

    if (summary.hasCode) {
        const language = summary.hasLua && summary.jsCount > 0 ? 'JavaScript/Lua' : summary.hasLua ? 'Lua' : 'JavaScript';
        const codeRow = createCheckboxRow({
            title: `Run ${language} code`,
            description: `${plural(summary.codeCount, 'code script')} through the restricted card-code runtime. Enable only for cards you trust.`,
            checked: initial.code,
        });
        codeCheckbox = codeRow.checkbox;
        rows.append(codeRow.row);

        const networkRow = createCheckboxRow({
            title: 'Allow network / LLM access',
            description: 'Allows card code and low-level trigger effects to call LLMs, image generation, vector search, or proxied requests. Off by default.',
            checked: initial.network,
            disabled: !initial.code,
        });
        networkCheckbox = networkRow.checkbox;
        rows.append(networkRow.row);

        codeCheckbox.addEventListener('change', () => {
            networkCheckbox.disabled = !codeCheckbox.checked;
            if (!codeCheckbox.checked) {
                networkCheckbox.checked = false;
            }
        });
    }

    content.append(title, note, rows);

    const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', {
        okButton: importPrompt ? 'Enable selected' : 'Save',
        cancelButton: importPrompt ? 'Skip' : 'Cancel',
        wider: true,
        leftAlign: true,
    });

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        if (importPrompt) {
            const skipped = { triggers: false, code: false, network: false };
            setRisuCardFeatureSettings(character, skipped);
            return { shown: true, saved: true, settings: skipped };
        }
        return { shown: true, saved: false, settings: current };
    }

    const settings = {
        triggers: triggersCheckbox ? triggersCheckbox.checked : current.triggers,
        code: codeCheckbox ? codeCheckbox.checked : current.code,
        network: networkCheckbox ? networkCheckbox.checked : false,
    };
    setRisuCardFeatureSettings(character, settings);
    return { shown: true, saved: true, settings: normalizeSettings(settings) };
}

