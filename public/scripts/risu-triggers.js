import {
    characters,
    chat,
    chat_metadata,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    Generate,
    generateRaw,
    getCurrentChatId,
    getRequestHeaders,
    getRisuCbsContext,
    name1,
    name2,
    printMessages,
    refreshRisuBackgroundHtml,
    saveChatConditional,
    saveSettingsDebounced,
    setCharacterName,
    setCurrentRisuTriggerId,
    setExtensionPrompt,
    this_chid,
} from '../script.js';
import { power_user } from './power-user.js';
import { user_avatar } from './personas.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from './popup.js';
import { evaluateRisuCbs } from './risu-cbs.js';
import { getMessageTimeStamp } from './RossAscends-mods.js';
import { executeSlashCommandsWithOptions } from './slash-commands.js';
import { getTokenCount } from './tokenizers.js';
import { getLocalVariable, setLocalVariable } from './variables.js';
import { runRisuManualTrigger, runRisuTriggerMode } from './risu-trigger-engine.js';

let initialized = false;
let isRunningTrigger = false;
let lastStartTriggerKey = '';
const modeTriggerKeys = new Set();
const RISU_TRIGGER_PROMPT_KEYS = {
    start: 'risuai-trigger-start',
    historyend: 'risuai-trigger-historyend',
    promptend: 'risuai-trigger-promptend',
};

function getActiveRisuCharacter() {
    if (this_chid === undefined) {
        return null;
    }

    const character = characters[this_chid];
    return character?.data?.extensions?.risuai ? character : null;
}

function appendRisuTriggerMessage(role, text) {
    const isUser = role === 'user';
    chat.push({
        name: isUser ? name1 : name2,
        is_user: isUser,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: text,
        extra: {},
    });
    chat_metadata.tainted = true;
}

function insertRisuTriggerMessage(index, role, text) {
    const isUser = role === 'user';
    const targetIndex = Number.isInteger(index) ? Math.max(0, Math.min(chat.length, index)) : chat.length;
    chat.splice(targetIndex, 0, {
        name: isUser ? name1 : name2,
        is_user: isUser,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: text,
        extra: {},
    });
    chat_metadata.tainted = true;
}

function modifyRisuTriggerMessage(index, text) {
    const message = chat[index];
    if (!message) {
        return;
    }

    message.mes = text;
    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id) && message.swipes[message.swipe_id] !== undefined) {
        message.swipes[message.swipe_id] = text;
    }
    chat_metadata.tainted = true;
}

function setRisuTriggerMessageRole(index, role) {
    const message = chat[index];
    if (!message) {
        return;
    }

    const isUser = role === 'user';
    message.is_user = isUser;
    message.is_system = false;
    message.name = isUser ? name1 : name2;
    chat_metadata.tainted = true;
}

function deleteRisuTriggerMessage(index) {
    if (!Number.isInteger(index) || index < 0 || index >= chat.length) {
        return;
    }

    chat.splice(index, 1);
    chat_metadata.tainted = true;
}

function cutRisuTriggerChat(start, end) {
    chat.splice(0, chat.length, ...chat.slice(start, end));
    chat_metadata.tainted = true;
}

function notifyRisuTrigger(type, message) {
    const toastType = type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info';
    globalThis.toastr?.[toastType]?.(message);
}

async function executeRisuFallbackCommand(command, pipe) {
    const source = String(command || '').trim();
    if (!source) {
        return { pipe };
    }

    const result = await executeSlashCommandsWithOptions(source.startsWith('/') ? source : `/${source}`, {
        handleParserErrors: true,
        handleExecutionErrors: true,
        source: 'RisuAI trigger command',
    });

    if (result?.isError || result?.isAborted) {
        return false;
    }

    return {
        pipe: result?.pipe ?? pipe,
        refresh: true,
    };
}

async function runRisuLLM(prompt) {
    return await generateRaw({
        prompt,
        trimNames: false,
    });
}

function quoteSlashCommandValue(value) {
    return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

async function runRisuImageGeneration(prompt, negativePrompt = '') {
    const command = [
        '/imagine',
        'quiet=true',
        'gallery=true',
        String(negativePrompt || '').trim() ? `negative=${quoteSlashCommandValue(negativePrompt)}` : '',
        quoteSlashCommandValue(prompt),
    ].filter(Boolean).join(' ');

    const result = await executeSlashCommandsWithOptions(command, {
        handleParserErrors: true,
        handleExecutionErrors: true,
        source: 'RisuAI trigger image generation',
    });

    if (result?.isError || result?.isAborted) {
        return false;
    }

    return result?.pipe || false;
}

async function runRisuVectorSimilarity(source, candidates) {
    const { rankTextsByVectorSimilarity } = await import('./extensions/vectors/index.js');
    return await rankTextsByVectorSimilarity(source, candidates);
}

async function runRisuScriptRequest(url) {
    const requestUrl = String(url || '');
    const deniedResponse = (status, data) => ({ status, data });

    if (requestUrl.length > 120) {
        return deniedResponse(413, 'URL too large. max is 120 characters');
    }

    if (!requestUrl.startsWith('https://')) {
        return deniedResponse(400, 'Only https requests are allowed');
    }

    const bannedUrls = [
        'https://realm.risuai.net',
        'https://risuai.net',
        'https://risuai.xyz',
    ];
    if (bannedUrls.some(prefix => requestUrl.startsWith(prefix))) {
        return deniedResponse(400, `request to ${requestUrl} is not allowed`);
    }

    try {
        const response = await fetch(requestUrl, { method: 'GET' });
        return {
            status: response.status,
            data: await response.text(),
        };
    } catch {
        return deniedResponse(400, 'internal error');
    }
}

function getRisuCharacterDescription(character) {
    return character?.data?.description ?? character?.description ?? '';
}

async function persistRisuCharacterAttribute(character, field, value) {
    if (!character.avatar) {
        return;
    }

    const response = await fetch('/api/characters/edit-attribute', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ch_name: character.name || character.data?.name || name2,
            avatar_url: character.avatar,
            field,
            value,
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to save Risu character ${field}: ${response.statusText}`);
    }
}

async function setRisuCharacterDescription(character, value) {
    const text = String(value ?? '');
    character.description = text;
    character.data ??= {};
    character.data.description = text;

    $('#description_textarea').val(text);

    await persistRisuCharacterAttribute(character, 'description', text);
}

async function setRisuCharacterName(character, value) {
    const text = String(value ?? '');
    character.name = text;
    character.data ??= {};
    character.data.name = text;

    setCharacterName(text);
    $('#character_name_pole').val(text);
    $('#rm_button_selected_ch').children('h2').text(text);

    await persistRisuCharacterAttribute(character, 'name', text);
}

function getRisuFirstMessage(character) {
    const firstChatMessage = chat.find(message => message && !message.is_user && !message.is_system);
    if (firstChatMessage) {
        if (Array.isArray(firstChatMessage.swipes) && Number.isInteger(firstChatMessage.swipe_id)) {
            return firstChatMessage.swipes[firstChatMessage.swipe_id] ?? firstChatMessage.mes ?? '';
        }
        return firstChatMessage.mes ?? '';
    }

    return character?.data?.first_mes ?? character?.first_mes ?? '';
}

async function setRisuFirstMessage(character, value) {
    const text = String(value ?? '');
    character.first_mes = text;
    character.data ??= {};
    character.data.first_mes = text;

    $('#firstmessage_textarea').val(text);

    await persistRisuCharacterAttribute(character, 'first_mes', text);
}

function getRisuReplaceGlobalNote(character) {
    return character?.data?.post_history_instructions ?? character?.post_history_instructions ?? '';
}

async function setRisuReplaceGlobalNote(character, value) {
    const text = String(value ?? '');
    character.post_history_instructions = text;
    character.data ??= {};
    character.data.post_history_instructions = text;

    $('#post_history_instructions_textarea').val(text);

    await persistRisuCharacterAttribute(character, 'post_history_instructions', text);
}

function getRisuBackgroundEmbedding(character) {
    return character?.data?.extensions?.risuai?.backgroundHTML ?? '';
}

async function setRisuBackgroundEmbedding(character, value) {
    const text = String(value ?? '');
    character.data ??= {};
    character.data.extensions ??= {};
    character.data.extensions.risuai ??= {};
    character.data.extensions.risuai.backgroundHTML = text;

    if (character.avatar) {
        const response = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                avatar: character.avatar,
                data: {
                    extensions: {
                        risuai: {
                            backgroundHTML: text,
                        },
                    },
                },
            }),
        });

        if (!response.ok) {
            throw new Error(`Failed to save Risu background embedding: ${response.statusText}`);
        }
    }

    refreshRisuBackgroundHtml();
}

function getRisuLorebookEntries(character) {
    character.data ??= {};
    character.data.character_book ??= {};
    if (!Array.isArray(character.data.character_book.entries)) {
        character.data.character_book.entries = [];
    }
    return character.data.character_book.entries;
}

async function setRisuLorebookEntries(character, entries) {
    character.data ??= {};
    character.data.character_book ??= {};
    character.data.character_book.entries = Array.isArray(entries) ? entries : [];

    if (!character.avatar) {
        return;
    }

    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            avatar: character.avatar,
            data: {
                character_book: character.data.character_book,
            },
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to save Risu lorebook: ${response.statusText}`);
    }
}

function getRisuPersonaDescription() {
    return power_user.persona_description
        || (user_avatar ? power_user.persona_descriptions?.[user_avatar]?.description : '')
        || '';
}

function setRisuPersonaDescription(value) {
    const text = String(value ?? '');
    power_user.persona_description = text;
    power_user.persona_descriptions ??= {};

    if (user_avatar) {
        const descriptor = power_user.persona_descriptions[user_avatar] ?? {};
        descriptor.description = text;
        descriptor.position ??= power_user.persona_description_position;
        descriptor.depth ??= power_user.persona_description_depth;
        descriptor.role ??= power_user.persona_description_role;
        descriptor.lorebook ??= power_user.persona_description_lorebook ?? '';
        power_user.persona_descriptions[user_avatar] = descriptor;
    }

    $('#persona_description').val(text);
    saveSettingsDebounced();
}

function getRisuAuthorNote() {
    return chat_metadata.note_prompt ?? '';
}

function setRisuAuthorNote(value) {
    const text = String(value ?? '');
    chat_metadata.note_prompt = text;
    chat_metadata.tainted = true;
    $('#extension_floating_prompt').val(text);
}

async function promptRisuInput(display) {
    const content = document.createElement('div');
    content.textContent = String(display || 'Input');

    const value = await callGenericPopup(content, POPUP_TYPE.INPUT, '', {
        okButton: 'OK',
        cancelButton: 'Cancel',
        rows: 1,
        wider: true,
    });

    return value === null || value === undefined ? null : String(value);
}

async function promptRisuSelect(options, display) {
    const values = Array.isArray(options) ? options.map(option => String(option)) : [];
    if (!values.length) {
        return null;
    }

    const content = document.createElement('div');
    const label = document.createElement('div');
    label.textContent = String(display || 'Select an option');
    const select = document.createElement('select');
    select.classList.add('text_pole');

    for (const value of values) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        select.append(option);
    }

    content.append(label, select);

    const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Select',
        cancelButton: 'Cancel',
        wider: true,
    });

    return result === POPUP_RESULT.AFFIRMATIVE ? select.value : null;
}

function clearRisuSystemPrompts() {
    setExtensionPrompt(RISU_TRIGGER_PROMPT_KEYS.start, '', extension_prompt_types.BEFORE_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(RISU_TRIGGER_PROMPT_KEYS.historyend, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(RISU_TRIGGER_PROMPT_KEYS.promptend, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
}

function applyRisuSystemPrompts(systemPrompt) {
    if (!systemPrompt) {
        return;
    }

    if (systemPrompt.start) {
        setExtensionPrompt(RISU_TRIGGER_PROMPT_KEYS.start, systemPrompt.start, extension_prompt_types.BEFORE_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
    }
    if (systemPrompt.historyend) {
        setExtensionPrompt(RISU_TRIGGER_PROMPT_KEYS.historyend, systemPrompt.historyend, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
    }
    if (systemPrompt.promptend) {
        setExtensionPrompt(RISU_TRIGGER_PROMPT_KEYS.promptend, systemPrompt.promptend, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    }
}

function createRisuTriggerRuntime(character, triggerId) {
    return {
        defaultVariables: character?.data?.extensions?.risuai?.defaultVariables,
        messages: chat,
        getVariable: (name) => getLocalVariable(name),
        setVariable: (name, value) => setLocalVariable(name, value),
        addMessage: appendRisuTriggerMessage,
        insertMessage: insertRisuTriggerMessage,
        modifyMessage: modifyRisuTriggerMessage,
        setMessageRole: setRisuTriggerMessageRole,
        deleteMessage: deleteRisuTriggerMessage,
        cutChat: cutRisuTriggerChat,
        notify: notifyRisuTrigger,
        executeCommand: executeRisuFallbackCommand,
        runLLM: runRisuLLM,
        generateImage: runRisuImageGeneration,
        checkSimilarity: runRisuVectorSimilarity,
        request: runRisuScriptRequest,
        tokenCount: (text) => getTokenCount(text, 0),
        getCharacterName: () => character?.data?.name ?? character?.name ?? name2,
        setCharacterName: (value) => setRisuCharacterName(character, value),
        getCharacterDescription: () => getRisuCharacterDescription(character),
        setCharacterDescription: (value) => setRisuCharacterDescription(character, value),
        getFirstMessage: () => getRisuFirstMessage(character),
        setFirstMessage: (value) => setRisuFirstMessage(character, value),
        getReplaceGlobalNote: () => getRisuReplaceGlobalNote(character),
        setReplaceGlobalNote: (value) => setRisuReplaceGlobalNote(character, value),
        getBackgroundEmbedding: () => getRisuBackgroundEmbedding(character),
        setBackgroundEmbedding: (value) => setRisuBackgroundEmbedding(character, value),
        getLorebookEntries: () => getRisuLorebookEntries(character),
        setLorebookEntries: (entries) => setRisuLorebookEntries(character, entries),
        promptInput: promptRisuInput,
        promptSelect: promptRisuSelect,
        getPersonaName: () => name1,
        getPersonaDescription: getRisuPersonaDescription,
        setPersonaDescription: setRisuPersonaDescription,
        getAuthorNote: getRisuAuthorNote,
        setAuthorNote: setRisuAuthorNote,
        delay: (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds)),
        evaluateText: (text) => evaluateRisuCbs(text, {
            ...getRisuCbsContext(character, {
                messageId: chat.length - 1,
                role: 'char',
            }),
            triggerId,
        }),
        log: (message) => console.log('[RisuAI trigger]', message),
    };
}

function logUnsupported(result, triggerName) {
    if (!result.unsupported.length) {
        return;
    }

    console.warn('[RisuAI trigger] Unsupported effects skipped', {
        trigger: triggerName,
        unsupported: result.unsupported,
    });
}

async function applyRisuTriggerResult(result, triggerName, { render = true } = {}) {
    logUnsupported(result, triggerName);
    applyRisuSystemPrompts(result.systemPrompt);

    const shouldSaveChat = result.changed || result.chatChanged || result.metadataChanged;
    const shouldRefresh = shouldSaveChat || result.refresh || result.promptChanged || result.characterChanged || result.settingsChanged;

    if (shouldSaveChat) {
        await saveChatConditional();
    }

    if (render && shouldRefresh) {
        await printMessages();
        refreshRisuBackgroundHtml();
    }
}

async function handleRisuTriggerClick(event) {
    const origin = event.target?.closest?.('[risu-trigger], [risu-btn]');
    if (!origin) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const triggerName = origin.getAttribute('risu-trigger') || origin.getAttribute('risu-btn');
    const triggerId = origin.getAttribute('risu-id') || origin.id || undefined;
    if (!triggerName) {
        console.warn('[RisuAI trigger] Button is missing a trigger name.', origin);
        return;
    }

    const character = getActiveRisuCharacter();
    if (!character || isRunningTrigger) {
        return;
    }

    isRunningTrigger = true;
    setCurrentRisuTriggerId(triggerId);
    clearRisuSystemPrompts();

    try {
        const result = await runRisuManualTrigger(
            character,
            triggerName,
            createRisuTriggerRuntime(character, triggerId),
        );

        await applyRisuTriggerResult(result, triggerName);
        if (!result.ran) {
            console.warn('[RisuAI trigger] No matching manual trigger found or conditions failed.', triggerName);
        }
    } catch (error) {
        console.error('[RisuAI trigger] Failed to run manual trigger', error);
    } finally {
        isRunningTrigger = false;
        setTimeout(() => setCurrentRisuTriggerId(null), 100);
    }
}

async function runRisuStartTrigger() {
    const character = getActiveRisuCharacter();
    if (!character || isRunningTrigger) {
        return;
    }

    const chatId = getCurrentChatId?.() ?? '';
    const startKey = `${character.avatar ?? character.name ?? this_chid}:${chatId}`;
    if (lastStartTriggerKey === startKey) {
        return;
    }

    lastStartTriggerKey = startKey;
    modeTriggerKeys.clear();
    isRunningTrigger = true;
    clearRisuSystemPrompts();

    try {
        const result = await runRisuTriggerMode(
            character,
            'start',
            createRisuTriggerRuntime(character, 'start'),
        );
        await applyRisuTriggerResult(result, 'start');
    } catch (error) {
        console.error('[RisuAI trigger] Failed to run start trigger', error);
    } finally {
        isRunningTrigger = false;
    }
}

function getRisuModeTriggerKey(character, mode, messageId, type) {
    const chatId = getCurrentChatId?.() ?? '';
    const message = Number.isInteger(messageId) ? chat[messageId] : null;
    const swipeId = message?.swipe_id ?? '';
    return [character.avatar ?? character.name ?? this_chid, chatId, mode, messageId ?? '', swipeId, type ?? ''].join(':');
}

async function runRisuModeTriggerOnce(mode, messageId, type) {
    const character = getActiveRisuCharacter();
    if (!character || isRunningTrigger) {
        return;
    }

    const key = getRisuModeTriggerKey(character, mode, messageId, type);
    if (modeTriggerKeys.has(key)) {
        return;
    }

    modeTriggerKeys.add(key);
    isRunningTrigger = true;
    setCurrentRisuTriggerId(`${mode}:${messageId ?? ''}`);
    clearRisuSystemPrompts();
    let shouldSendAiPrompt = false;

    try {
        const result = await runRisuTriggerMode(
            character,
            mode,
            createRisuTriggerRuntime(character, `${mode}:${messageId ?? ''}`),
        );
        await applyRisuTriggerResult(result, mode, { render: false });
        shouldSendAiPrompt = mode === 'output' && result.sendAIprompt;
    } catch (error) {
        console.error(`[RisuAI trigger] Failed to run ${mode} trigger`, error);
    } finally {
        isRunningTrigger = false;
        setTimeout(() => setCurrentRisuTriggerId(null), 100);
    }

    if (shouldSendAiPrompt) {
        try {
            await Generate('normal', { automatic_trigger: true });
        } catch (error) {
            console.error('[RisuAI trigger] Failed to send AI prompt from output trigger', error);
        }
    }
}

export function initRisuTriggers() {
    if (initialized) {
        return;
    }

    const chatElement = document.getElementById('chat');
    if (!chatElement) {
        return;
    }

    initialized = true;
    chatElement.addEventListener('click', handleRisuTriggerClick);
    eventSource.on(event_types.APP_READY, runRisuStartTrigger);
    eventSource.on(event_types.CHAT_CHANGED, runRisuStartTrigger);
    eventSource.on(event_types.MESSAGE_SENT, (messageId) => runRisuModeTriggerOnce('input', messageId, 'user'));
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, type) => {
        if (type === 'first_message') {
            return;
        }
        runRisuModeTriggerOnce('output', messageId, type);
    });
}
