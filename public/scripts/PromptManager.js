'use strict';

import { DOMPurify } from '../lib.js';

import { event_types, eventSource, is_send_press, main_api, saveSettingsDebounced, substituteParams } from '../script.js';
import { is_group_generating } from './group-chats.js';
import { Message, MessageCollection, TokenHandler } from './openai.js';
import { power_user } from './power-user.js';
import { debounce, waitUntilCondition, escapeHtml, uuidv4 } from './utils.js';
import { debounce_timeout } from './constants.js';
import { renderTemplateAsync } from './templates.js';
import { Popup } from './popup.js';
import { t } from './i18n.js';
import { isMobile } from './RossAscends-mods.js';

function debouncePromise(func, delay) {
    let timeoutId;

    return (...args) => {
        clearTimeout(timeoutId);

        return new Promise((resolve) => {
            timeoutId = setTimeout(() => {
                const result = func(...args);
                resolve(result);
            }, delay);
        });
    };
}

const DEFAULT_DEPTH = 4;
const DEFAULT_ORDER = 100;

/**
 * @enum {number}
 */
export const INJECTION_POSITION = {
    RELATIVE: 0,
    ABSOLUTE: 1,
};

/**
 * Register migrations for the prompt manager when settings are loaded or an Open AI preset is loaded.
 */
const registerPromptManagerMigration = () => {
    const migrate = (settings, savePreset = null, presetName = null) => {
        if ('Default' === presetName) return;

        if (settings.main_prompt || settings.nsfw_prompt || settings.jailbreak_prompt) {
            console.log('Running prompt manager configuration migration');
            if (settings.prompts === undefined || settings.prompts.length === 0) settings.prompts = structuredClone(chatCompletionDefaultPrompts.prompts);

            const findPrompt = (identifier) => settings.prompts.find(prompt => identifier === prompt.identifier);
            if (settings.main_prompt) {
                findPrompt('main').content = settings.main_prompt;
                delete settings.main_prompt;
            }

            if (settings.nsfw_prompt) {
                findPrompt('nsfw').content = settings.nsfw_prompt;
                delete settings.nsfw_prompt;
            }

            if (settings.jailbreak_prompt) {
                findPrompt('jailbreak').content = settings.jailbreak_prompt;
                delete settings.jailbreak_prompt;
            }

            if (savePreset && presetName) savePreset(presetName, settings, false);
        }
    };

    eventSource.on(event_types.SETTINGS_LOADED_BEFORE, settings => migrate(settings));
    eventSource.on(event_types.OAI_PRESET_CHANGED_BEFORE, event => migrate(event.preset, event.savePreset, event.presetName));
};

/**
 * Represents a prompt.
 */
class Prompt {
    /**
     * Indicates if the prompt is enabled.
     * @type {boolean}
     */
    enabled;

    /**
     * Unique identifier for the prompt.
     * @type {string}
     */
    identifier;

    /**
     * Role of the prompt, e.g., 'system', 'user', etc.
     * @type {string}
     */
    role;

    /**
     * Content of the prompt.
     * @type {string}
     */
    content;

    /**
     * Display name of the prompt.
     * @type {string}
     */
    name;

    /**
     * Indicates if the prompt is a system prompt.
     * @type {boolean}
     */
    system_prompt;

    /**
     * Position of the prompt in the prompt list.
     * @type {string|number}
     */
    position;

    /**
     * Inject position of the prompt (relative = 0 or in-chat = 1)
     * @type {number}
     */
    injection_position;

    /**
     * Depth of the prompt in the chat.
     * @type {number}
     */
    injection_depth;

    /**
     * Order of the prompt in the chat.
     * @type {number}
     */
    injection_order;

    /**
     * Indicates if the prompt should not be overridden.
     * @type {boolean}
     */
    forbid_overrides;

    /**
     * Prompt is added by an extension.
     * @type {boolean}
     */
    extension;

    /**
     * A list of generation type triggers for the prompt injection.
     * @type {string[]}
     */
    injection_trigger;

    /**
     * Indicates if the prompt is a marker prompt.
     * @type {boolean}
     */
    marker;

    /**
     * Create a new Prompt instance.
     *
     * @param {Object} [param0] - Object containing the properties of the prompt.
     * @param {string} [param0.identifier] - The unique identifier of the prompt.
     * @param {string} [param0.role] - The role associated with the prompt.
     * @param {string} [param0.content] - The content of the prompt.
     * @param {string} [param0.name] - The name of the prompt.
     * @param {boolean} [param0.system_prompt] - Indicates if the prompt is a system prompt.
     * @param {string|number} [param0.position] - The position of the prompt in the prompt list.
     * @param {number} [param0.injection_position] - The insert position of the prompt.
     * @param {number} [param0.injection_depth] - The depth of the prompt in the chat.
     * @param {number} [param0.injection_order] - The order of the prompt in the chat.
     * @param {string[]} [param0.injection_trigger] - The generation type trigger for the prompt injection.
     * @param {boolean} [param0.forbid_overrides] - Indicates if the prompt should not be overridden.
     * @param {boolean} [param0.extension] - Prompt is added by an extension.
     */
    constructor({ identifier, role, content, name, system_prompt, position, injection_depth, injection_position, forbid_overrides, extension, injection_order, injection_trigger } = {}) {
        this.identifier = identifier;
        this.role = role;
        this.content = content;
        this.name = name;
        this.system_prompt = system_prompt;
        this.position = position;
        this.injection_depth = injection_depth;
        this.injection_position = injection_position;
        this.forbid_overrides = forbid_overrides;
        this.extension = extension ?? false;
        this.injection_order = injection_order ?? DEFAULT_ORDER;
        this.injection_trigger = injection_trigger ?? [];
    }
}

/**
 * Representing a collection of prompts.
 */
export class PromptCollection {
    /**
     * List of Prompts in the collection.
     * @type {Prompt[]}
     */
    collection = [];

    /**
     * List of identifiers of prompts that have been overridden.
     * @type {string[]}
     */
    overriddenPrompts = [];

    /**
     * Create a new PromptCollection instance.
     *
     * @param {...Prompt} prompts - An array of Prompt instances.
     */
    constructor(...prompts) {
        this.add(...prompts);
    }

    /**
     * Checks if the provided instances are of the Prompt class.
     *
     * @param {...Prompt} prompts - Instances to check.
     * @throws Will throw an error if one or more instances are not of the Prompt class.
     */
    checkPromptInstance(...prompts) {
        for (let prompt of prompts) {
            if (!(prompt instanceof Prompt)) {
                throw new Error('Only Prompt instances can be added to PromptCollection');
            }
        }
    }

    /**
     * Adds new Prompt instances to the collection.
     *
     * @param {...Prompt} prompts - An array of Prompt instances.
     */
    add(...prompts) {
        this.checkPromptInstance(...prompts);
        this.collection.push(...prompts);
    }

    /**
     * Sets a Prompt instance at a specific position in the collection.
     *
     * @param {Prompt} prompt - The Prompt instance to set.
     * @param {number} position - The position in the collection to set the Prompt instance.
     */
    set(prompt, position) {
        this.checkPromptInstance(prompt);
        this.collection[position] = prompt;
    }

    /**
     * Retrieves a Prompt instance from the collection by its identifier.
     *
     * @param {string} identifier - The identifier of the Prompt instance to retrieve.
     * @returns {Prompt} The Prompt instance with the provided identifier, or undefined if not found.
     */
    get(identifier) {
        return this.collection.find(prompt => prompt.identifier === identifier);
    }

    /**
     * Retrieves the index of a Prompt instance in the collection by its identifier.
     *
     * @param {string} identifier - The identifier of the Prompt instance to find.
     * @returns {number} The index of the Prompt instance in the collection, or -1 if not found.
     */
    index(identifier) {
        return this.collection.findIndex(prompt => prompt.identifier === identifier);
    }

    /**
     * Checks if a Prompt instance exists in the collection by its identifier.
     *
     * @param {string} identifier - The identifier of the Prompt instance to check.
     * @returns {boolean} true if the Prompt instance exists in the collection, false otherwise.
     */
    has(identifier) {
        return this.index(identifier) !== -1;
    }

    /**
     * Overrides a prompt at a specific position in the collection.
     *
     * @param {Prompt} prompt - The Prompt instance to override.
     * @param {number} position - The position in the collection to override the Prompt instance.
     */
    override(prompt, position) {
        this.set(prompt, position);
        this.overriddenPrompts.push(prompt.identifier);
    }
}

class PromptManager {
    get promptSources() {
        return {
            charDescription: t`Character Description`,
            charPersonality: t`Character Personality`,
            scenario: t`Character Scenario`,
            personaDescription: t`Persona Description`,
            worldInfoBefore: t`World Info (↑Char)`,
            worldInfoAfter: t`World Info (↓Char)`,
        };
    }

    constructor() {
        this.systemPrompts = [
            'main',
            'nsfw',
            'jailbreak',
            'enhanceDefinitions',
        ];

        this.overridablePrompts = [
            'main',
            'jailbreak',
        ];

        this.overriddenPrompts = [];

        this.configuration = {
            version: 1,
            prefix: '',
            containerIdentifier: '',
            listIdentifier: '',
            listItemTemplateIdentifier: '',
            toggleDisabled: [],
            promptOrder: {
                strategy: 'global',
                dummyId: 100000,
            },
            sortableDelay: 30,
            warningTokenThreshold: 1500,
            dangerTokenThreshold: 500,
            defaultPrompts: {
                main: '',
                nsfw: '',
                jailbreak: '',
                enhanceDefinitions: '',
            },
            getActivePreset: null,
        };

        // Chatcompletion configuration object
        this.serviceSettings = null;

        // DOM element containing the prompt manager
        this.containerElement = null;

        // DOM element containing the prompt list
        this.listElement = null;

        // Currently selected character
        this.activeCharacter = null;

        // Message collection of the most recent chatcompletion
        this.messages = null;

        // The current token handler instance
        this.tokenHandler = null;

        // Token usage of last dry run
        this.tokenUsage = 0;

        // Error state, contains error message.
        this.error = null;

        /** Dry-run for generate, must return a promise  */
        this.tryGenerate = async () => { };

        /** Called to persist the configuration, must return a promise */
        this.saveServiceSettings = () => { return Promise.resolve(); };

        /** Toggle prompt button click */
        this.handleToggle = () => { };

        /** Prompt name click */
        this.handleInspect = () => { };

        /** Edit prompt button click */
        this.handleEdit = () => { };

        /** Detach prompt button click */
        this.handleDetach = () => { };

        /** Save prompt button click */
        this.handleSavePrompt = () => { };

        /** Reset prompt button click */
        this.handleResetPrompt = () => { };

        /** New prompt button click */
        this.handleNewPrompt = () => { };

        /** Delete prompt button click */
        this.handleDeletePrompt = () => { };

        /** Append prompt button click */
        this.handleAppendPrompt = () => { };

        /** Import button click */
        this.handleImport = () => { };

        /** Full export click */
        this.handleFullExport = () => { };

        /** Character export click */
        this.handleCharacterExport = () => { };

        /** Character reset button click*/
        this.handleCharacterReset = () => { };

        /** Prompt categories setting changed */
        this.handlePromptCategoriesSettingChanged = () => {
            this.render(false);
        };

        /** Debounced version of render */
        this.renderDebounced = debounce(this.render.bind(this), debounce_timeout.relaxed);
    }


    /**
     * Initializes the PromptManager with provided configuration and service settings.
     *
     * Sets up various handlers for user interactions, event listeners and initial rendering of prompts.
     * It is also responsible for preparing prompt edit form buttons, managing popup form close and clear actions.
     *
     * @param {Object} moduleConfiguration - Configuration object for the PromptManager.
     * @param {Object} serviceSettings - Service settings object for the PromptManager.
     */
    init(moduleConfiguration, serviceSettings) {
        this.configuration = Object.assign(this.configuration, moduleConfiguration);
        this.tokenHandler = this.tokenHandler || new TokenHandler(() => { throw new Error('Token handler not set'); });
        this.serviceSettings = serviceSettings;
        this.containerElement = document.getElementById(this.configuration.containerIdentifier);
        document.removeEventListener('prompt_categories_setting_changed', this.handlePromptCategoriesSettingChanged);
        document.addEventListener('prompt_categories_setting_changed', this.handlePromptCategoriesSettingChanged);

        if ('global' === this.configuration.promptOrder.strategy) this.activeCharacter = { id: this.configuration.promptOrder.dummyId };

        this.sanitizeServiceSettings();

        // Enable and disable prompts
        this.handleToggle = (event) => {
            const promptID = event.target.closest('.' + this.configuration.prefix + 'prompt_manager_prompt').dataset.pmIdentifier;
            const promptOrderEntry = this.getPromptOrderEntry(this.activeCharacter, promptID);
            const counts = this.tokenHandler.getCounts();

            counts[promptID] = null;
            promptOrderEntry.enabled = !promptOrderEntry.enabled;
            this.render();
            this.saveServiceSettings();
        };

        // Open edit form and load selected prompt
        this.handleEdit = (event) => {
            this.clearEditForm();
            this.clearInspectForm();

            const promptID = event.target.closest('.' + this.configuration.prefix + 'prompt_manager_prompt').dataset.pmIdentifier;
            const prompt = this.getPromptById(promptID);

            this.loadPromptIntoEditForm(prompt);

            this.showPopup();
        };

        // Open edit form and load selected prompt
        this.handleInspect = (event) => {
            this.clearEditForm();
            this.clearInspectForm();

            const promptID = event.target.closest('.' + this.configuration.prefix + 'prompt_manager_prompt').dataset.pmIdentifier;
            if (true === this.messages.hasItemWithIdentifier(promptID)) {
                const messages = this.messages.getItemByIdentifier(promptID);

                this.loadMessagesIntoInspectForm(messages);

                this.showPopup('inspect');
            }
        };

        // Detach selected prompt from list form and close edit form
        this.handleDetach = (event) => {
            if (null === this.activeCharacter) return;
            const promptID = event.target.closest('.' + this.configuration.prefix + 'prompt_manager_prompt').dataset.pmIdentifier;
            const prompt = this.getPromptById(promptID);

            this.detachPrompt(prompt, this.activeCharacter);
            this.hidePopup();
            this.clearEditForm();
            this.render();
            this.saveServiceSettings();
        };

        // Save prompt edit form to settings and close form.
        this.handleSavePrompt = (event) => {
            const promptId = event.target.dataset.pmPrompt;
            const prompt = this.getPromptById(promptId);

            if (null === prompt) {
                const newPrompt = {};
                this.updatePromptWithPromptEditForm(newPrompt);
                this.addPrompt(newPrompt, promptId);
            } else {
                this.updatePromptWithPromptEditForm(prompt);
            }

            if ('main' === promptId) this.updateQuickEdit('main', prompt);
            if ('nsfw' === promptId) this.updateQuickEdit('nsfw', prompt);
            if ('jailbreak' === promptId) this.updateQuickEdit('jailbreak', prompt);

            this.log('Saved prompt: ' + promptId);

            this.hidePopup();
            this.clearEditForm();
            this.render();
            this.saveServiceSettings();
        };

        // Reset prompt should it be a system prompt
        this.handleResetPrompt = (event) => {
            const promptId = event.target.dataset.pmPrompt;
            const prompt = this.getPromptById(promptId);
            const isPulledPrompt = Object.keys(this.promptSources).includes(promptId);

            switch (promptId) {
                case 'main':
                    prompt.name = 'Main Prompt';
                    prompt.content = this.configuration.defaultPrompts.main;
                    prompt.forbid_overrides = false;
                    break;
                case 'nsfw':
                    prompt.name = 'Nsfw Prompt';
                    prompt.content = this.configuration.defaultPrompts.nsfw;
                    break;
                case 'jailbreak':
                    prompt.name = 'Jailbreak Prompt';
                    prompt.content = this.configuration.defaultPrompts.jailbreak;
                    prompt.forbid_overrides = false;
                    break;
                case 'enhanceDefinitions':
                    prompt.name = 'Enhance Definitions';
                    prompt.content = this.configuration.defaultPrompts.enhanceDefinitions;
                    break;
            }

            const nameField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_name'));
            const roleField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_role'));
            const promptField = /** @type {HTMLTextAreaElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_prompt'));
            const injectionPositionField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_position'));
            const injectionDepthField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_depth'));
            const injectionOrderField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_order'));
            const injectionTriggerField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_trigger'));
            const depthBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_depth_block'));
            const orderBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_order_block'));
            const forbidOverridesField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_forbid_overrides'));
            const forbidOverridesBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_forbid_overrides_block'));
            const entrySourceBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_source_block'));
            const entrySource = /** @type {HTMLSpanElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_source'));

            nameField.value = prompt.name;
            roleField.value = 'system';
            promptField.value = prompt.content ?? '';
            injectionPositionField.value = (prompt.injection_position ?? 0).toString();
            injectionDepthField.value = (prompt.injection_depth ?? DEFAULT_DEPTH).toString();
            injectionOrderField.value = (prompt.injection_order ?? DEFAULT_ORDER).toString();
            Array.from(injectionTriggerField.options).forEach(option => {
                option.selected = false;
            });
            injectionTriggerField.dispatchEvent(new Event('change', { bubbles: true }));
            depthBlock.style.visibility = prompt.injection_position === INJECTION_POSITION.ABSOLUTE ? 'visible' : 'hidden';
            orderBlock.style.visibility = prompt.injection_position === INJECTION_POSITION.ABSOLUTE ? 'visible' : 'hidden';
            forbidOverridesField.checked = prompt.forbid_overrides ?? false;
            forbidOverridesBlock.style.visibility = this.overridablePrompts.includes(prompt.identifier) ? 'visible' : 'hidden';
            promptField.disabled = prompt.marker ?? false;
            entrySourceBlock.style.display = isPulledPrompt ? '' : 'none';

            if (isPulledPrompt) {
                const sourceName = this.promptSources[promptId];
                entrySource.textContent = sourceName;
            }
        };

        // Append prompt to selected character
        this.handleAppendPrompt = (event) => {
            const appendPromptFooter = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_footer_append_prompt'));
            const promptID = appendPromptFooter.value;
            const prompt = this.getPromptById(promptID);

            if (prompt) {
                this.appendPrompt(prompt, this.activeCharacter);
                this.render();
                this.saveServiceSettings();
            }
        };

        // Delete selected prompt from list form and close edit form
        this.handleDeletePrompt = async (event) => {
            Popup.show.confirm(t`Are you sure you want to delete this prompt?`, null).then((userChoice) => {
                if (!userChoice) return;
                const appendPromptFooter = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_footer_append_prompt'));
                const promptID = appendPromptFooter.value;
                const prompt = this.getPromptById(promptID);

                if (prompt && true === this.isPromptDeletionAllowed(prompt)) {
                    const promptIndex = this.getPromptIndexById(promptID);
                    this.serviceSettings.prompts.splice(Number(promptIndex), 1);

                    this.log('Deleted prompt: ' + prompt.identifier);

                    this.hidePopup();
                    this.clearEditForm();
                    this.render();
                    this.saveServiceSettings();
                }
            });
        };

        // Create new prompt, then save it to settings and close form.
        this.handleNewPrompt = (event) => {
            const prompt = {
                identifier: this.getUuidv4(),
                name: '',
                role: 'system',
                content: '',
            };

            this.loadPromptIntoEditForm(prompt);
            this.showPopup();
        };

        // Export all user prompts
        this.handleFullExport = () => {
            const prompts = this.serviceSettings.prompts.reduce((userPrompts, prompt) => {
                if (false === prompt.system_prompt && false === prompt.marker) userPrompts.push(prompt);
                return userPrompts;
            }, []);

            let promptOrder = [];
            if ('global' === this.configuration.promptOrder.strategy) {
                promptOrder = this.getPromptOrderForCharacter({ id: this.configuration.promptOrder.dummyId });
            } else if ('character' === this.configuration.promptOrder.strategy) {
                promptOrder = [];
            } else {
                throw new Error('Prompt order strategy not supported.');
            }

            const exportPrompts = {
                prompts: prompts,
                prompt_order: promptOrder,
            };

            this.export(exportPrompts, 'full', 'st-prompts');
        };

        // Export user prompts and order for this character
        this.handleCharacterExport = () => {
            const characterPrompts = this.getPromptsForCharacter(this.activeCharacter).reduce((userPrompts, prompt) => {
                if (false === prompt.system_prompt && !prompt.marker) userPrompts.push(prompt);
                return userPrompts;
            }, []);

            const characterList = this.getPromptOrderForCharacter(this.activeCharacter);

            const exportPrompts = {
                prompts: characterPrompts,
                prompt_order: characterList,
            };

            const name = this.activeCharacter.name + '-prompts';
            this.export(exportPrompts, 'character', name);
        };

        // Import prompts for the selected character
        this.handleImport = () => {
            Popup.show.confirm(t`Existing prompts with the same ID will be overridden. Do you want to proceed?`, null)
                .then(userChoice => {
                    if (!userChoice) return;

                    const fileOpener = document.createElement('input');
                    fileOpener.type = 'file';
                    fileOpener.accept = '.json';

                    fileOpener.addEventListener('change', (event) => {
                        if (!(event.target instanceof HTMLInputElement)) return;
                        const file = event.target.files[0];
                        if (!file) return;

                        const reader = new FileReader();

                        reader.onload = (event) => {
                            const fileContent = event.target.result;

                            try {
                                const data = JSON.parse(fileContent.toString());
                                this.import(data);
                            } catch (err) {
                                toastr.error(t`An error occurred while importing prompts. More info available in console.`);
                                console.log('An error occurred while importing prompts');
                                console.log(err.toString());
                            }
                        };

                        reader.readAsText(file);
                    });

                    fileOpener.click();
                });
        };

        // Restore default state of a characters prompt order
        this.handleCharacterReset = () => {
            Popup.show.confirm(t`This will reset the prompt order for this character. You will not lose any prompts.`, null)
                .then(userChoice => {
                    if (!userChoice) return;

                    this.removePromptOrderForCharacter(this.activeCharacter);
                    this.addPromptOrderForCharacter(this.activeCharacter, promptManagerDefaultPromptOrder);

                    this.render();
                    this.saveServiceSettings();
                });
        };

        // Fill quick edit fields for the first time
        if ('global' === this.configuration.promptOrder.strategy) {
            const handleQuickEditSave = (event) => {
                const promptId = event.target.dataset.pmPrompt;
                const prompt = this.getPromptById(promptId);

                prompt.content = event.target.value;

                // Update edit form if present
                // @see https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/offsetParent
                const popupEditFormPrompt = /** @type {HTMLTextAreaElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_prompt'));
                if (popupEditFormPrompt.offsetParent) {
                    popupEditFormPrompt.value = prompt.content;
                }

                this.log('Saved prompt: ' + promptId);
                this.saveServiceSettings().then(() => this.render());
            };

            const mainPrompt = this.getPromptById('main');
            const mainElementId = this.updateQuickEdit('main', mainPrompt);
            document.getElementById(mainElementId).addEventListener('blur', handleQuickEditSave);

            const nsfwPrompt = this.getPromptById('nsfw');
            const nsfwElementId = this.updateQuickEdit('nsfw', nsfwPrompt);
            document.getElementById(nsfwElementId).addEventListener('blur', handleQuickEditSave);

            const jailbreakPrompt = this.getPromptById('jailbreak');
            const jailbreakElementId = this.updateQuickEdit('jailbreak', jailbreakPrompt);
            document.getElementById(jailbreakElementId).addEventListener('blur', handleQuickEditSave);
        }

        // Re-render when chat history changes.
        eventSource.on(event_types.MESSAGE_DELETED, () => this.renderDebounced());
        eventSource.on(event_types.MESSAGE_EDITED, () => this.renderDebounced());
        eventSource.on(event_types.MESSAGE_RECEIVED, () => this.renderDebounced());

        // Re-render when chatcompletion settings change
        eventSource.on(event_types.CHATCOMPLETION_SOURCE_CHANGED, () => this.renderDebounced());

        eventSource.on(event_types.CHATCOMPLETION_MODEL_CHANGED, () => this.renderDebounced());

        // Re-render when the character changes.
        eventSource.on(event_types.CHAT_LOADED, (event) => {
            this.handleCharacterSelected(event);
            this.saveServiceSettings().then(() => this.renderDebounced());
        });

        // Re-render when the character gets edited.
        eventSource.on(event_types.CHARACTER_EDITED, (event) => {
            this.handleCharacterUpdated(event);
            this.saveServiceSettings().then(() => this.renderDebounced());
        });

        // Re-render when the group changes.
        eventSource.on('groupSelected', (event) => {
            this.handleGroupSelected(event);
            this.saveServiceSettings().then(() => this.renderDebounced());
        });

        // Sanitize settings after character has been deleted.
        eventSource.on(event_types.CHARACTER_DELETED, (event) => {
            this.handleCharacterDeleted(event);
            this.saveServiceSettings().then(() => this.renderDebounced());
        });

        // Trigger re-render when token settings are changed
        document.getElementById('openai_max_context').addEventListener('change', (event) => {
            if (!(event.target instanceof HTMLInputElement)) return;
            this.serviceSettings.openai_max_context = event.target.value;
            if (this.activeCharacter) this.renderDebounced();
        });

        document.getElementById('openai_max_tokens').addEventListener('change', (event) => {
            if (this.activeCharacter) this.renderDebounced();
        });

        // Prepare prompt edit form buttons
        document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_save').addEventListener('click', this.handleSavePrompt);
        document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_reset').addEventListener('click', this.handleResetPrompt);

        const closeAndClearPopup = () => {
            this.hidePopup();
            this.clearEditForm();
            this.clearInspectForm();
        };

        // Clear forms on closing the popup
        document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_close').addEventListener('click', closeAndClearPopup);
        document.getElementById(this.configuration.prefix + 'prompt_manager_popup_close_button').addEventListener('click', closeAndClearPopup);
        closeAndClearPopup();

        // Re-render prompt manager on openai preset change
        eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => {
            this.sanitizeServiceSettings();
            const mainPrompt = this.getPromptById('main');
            this.updateQuickEdit('main', mainPrompt);

            const nsfwPrompt = this.getPromptById('nsfw');
            this.updateQuickEdit('nsfw', nsfwPrompt);

            const jailbreakPrompt = this.getPromptById('jailbreak');
            this.updateQuickEdit('jailbreak', jailbreakPrompt);

            this.hidePopup();
            this.clearEditForm();
            this.renderDebounced();
        });

        // Re-render prompt manager on world settings update
        eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, () => this.renderDebounced());

        this.log('Initialized');
    }

    /**
     * Get the scroll position of the prompt manager
     * @returns {number} - Scroll position of the prompt manager
     */
    #getScrollPosition() {
        return document.getElementById(this.configuration.prefix + 'prompt_manager')?.closest('.scrollableInner')?.scrollTop;
    }

    /**
     * Set the scroll position of the prompt manager
     * @param {number} scrollPosition - The scroll position to set
     */
    #setScrollPosition(scrollPosition) {
        if (scrollPosition === undefined || scrollPosition === null) return;
        document.getElementById(this.configuration.prefix + 'prompt_manager')?.closest('.scrollableInner')?.scrollTo(0, scrollPosition);
    }

    /**
     * Main rendering function
     *
     * @param afterTryGenerate - Whether a dry run should be attempted before rendering
     */
    render(afterTryGenerate = true) {
        if (main_api !== 'openai') return;

        if ('character' === this.configuration.promptOrder.strategy && null === this.activeCharacter) return;
        this.error = null;

        waitUntilCondition(() => !is_send_press && !is_group_generating, 1024 * 1024, 100).then(async () => {
            if (true === afterTryGenerate) {
                // Executed during dry-run for determining context composition
                this.profileStart('filling context');
                this.tryGenerate().finally(async () => {
                    this.profileEnd('filling context');
                    this.profileStart('render');
                    const scrollPosition = this.#getScrollPosition();
                    await this.renderPromptManager();
                    await this.renderPromptManagerListItems();
                    this.makeDraggable();
                    this.#setScrollPosition(scrollPosition);
                    this.profileEnd('render');
                });
            } else {
                // Executed during live communication
                this.profileStart('render');
                const scrollPosition = this.#getScrollPosition();
                await this.renderPromptManager();
                await this.renderPromptManagerListItems();
                this.makeDraggable();
                this.#setScrollPosition(scrollPosition);
                this.profileEnd('render');
            }
        }).catch(() => {
            console.log('Timeout while waiting for send press to be false');
        });
    }

    /**
     * Whether local prompt categories are enabled for the prompt manager.
     * @returns {boolean}
     */
    arePromptCategoriesEnabled() {
        return Boolean(power_user.prompt_categories_enabled);
    }

    /**
     * Gets the local settings key for the current chat completion preset.
     * @returns {string}
     */
    getPromptCategoryPresetKey() {
        const selectedPreset = this.serviceSettings?.preset_settings_openai || document.getElementById('settings_preset_openai')?.selectedOptions?.[0]?.textContent;
        return String(selectedPreset || 'Default').trim() || 'Default';
    }

    /**
     * Gets the mutable active chat completion preset object, if available.
     * @returns {object|null}
     */
    getActivePresetObject() {
        if (typeof this.configuration.getActivePreset === 'function') {
            const preset = this.configuration.getActivePreset();
            if (preset && typeof preset === 'object') return preset;
        }

        return this.serviceSettings || null;
    }

    /**
     * Gets or creates the Wulf's Hollow extension namespace on an object.
     * @param {object} target Preset or settings object
     * @returns {object}
     */
    getWulfsHollowExtension(target) {
        target.extensions = target.extensions && typeof target.extensions === 'object' ? target.extensions : {};
        target.extensions.wulfs_hollow = target.extensions.wulfs_hollow && typeof target.extensions.wulfs_hollow === 'object'
            ? target.extensions.wulfs_hollow
            : {};
        return target.extensions.wulfs_hollow;
    }

    /**
     * Gets or creates the WH-local prompt category state for the current preset.
     * @returns {{version: number, categories: {id: string, name: string, order: number, collapsed: boolean}[], assignments: Record<string, string>}}
     */
    getPromptCategoryState() {
        const activePreset = this.getActivePresetObject();
        if (!activePreset) {
            return { version: 1, categories: [], assignments: {} };
        }

        const extension = this.getWulfsHollowExtension(activePreset);
        if (!extension.prompt_categories || typeof extension.prompt_categories !== 'object') {
            extension.prompt_categories = { version: 1, categories: [], assignments: {} };
        }

        const state = extension.prompt_categories;
        state.version = Number.isFinite(state.version) ? state.version : 1;
        if (!Array.isArray(state.categories)) state.categories = [];
        if (!state.assignments || typeof state.assignments !== 'object') state.assignments = {};

        const stateIsEmpty = () => state.categories.length === 0 && Object.keys(state.assignments).length === 0;

        // Preserve category data from the active settings snapshot if the preset file has not been updated yet.
        const settingsState = this.serviceSettings && this.serviceSettings !== activePreset
            ? this.serviceSettings.extensions?.wulfs_hollow?.prompt_categories
            : null;
        if (stateIsEmpty() && settingsState && typeof settingsState === 'object') {
            state.categories = structuredClone(Array.isArray(settingsState.categories) ? settingsState.categories : []);
            state.assignments = structuredClone(settingsState.assignments && typeof settingsState.assignments === 'object' ? settingsState.assignments : {});
        }

        // One-time migration from the earlier WH-local user setting storage.
        const presetKey = this.getPromptCategoryPresetKey();
        const localState = power_user.prompt_categories?.chat_completion?.[presetKey];
        if (stateIsEmpty() && localState && typeof localState === 'object') {
            state.categories = structuredClone(Array.isArray(localState.categories) ? localState.categories : []);
            state.assignments = structuredClone(localState.assignments && typeof localState.assignments === 'object' ? localState.assignments : {});
            delete power_user.prompt_categories.chat_completion[presetKey];
            saveSettingsDebounced();
        }

        state.categories = state.categories
            .filter(category => category && typeof category.id === 'string' && typeof category.name === 'string')
            .map((category, index) => ({
                id: category.id,
                name: category.name,
                order: Number.isFinite(category.order) ? category.order : index,
                collapsed: Boolean(category.collapsed),
            }));

        if (this.serviceSettings && this.serviceSettings !== activePreset) {
            const settingsExtension = this.getWulfsHollowExtension(this.serviceSettings);
            settingsExtension.prompt_categories = state;
        }

        return state;
    }

    /**
     * Gets sorted prompt categories for the current preset.
     * @returns {{id: string, name: string, order: number, collapsed: boolean}[]}
     */
    getPromptCategories() {
        return [...this.getPromptCategoryState().categories].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    }

    /**
     * Gets a category by id.
     * @param {string} categoryId Category id
     * @returns {{id: string, name: string, order: number, collapsed: boolean}|null}
     */
    getPromptCategoryById(categoryId) {
        return this.getPromptCategoryState().categories.find(category => category.id === categoryId) || null;
    }

    /**
     * Gets the assigned category for a prompt.
     * @param {string} promptId Prompt identifier
     * @returns {{id: string, name: string, order: number, collapsed: boolean}|null}
     */
    getPromptCategoryForPrompt(promptId) {
        const state = this.getPromptCategoryState();
        const categoryId = state.assignments[promptId];
        const category = categoryId ? this.getPromptCategoryById(categoryId) : null;
        if (!category && categoryId) {
            delete state.assignments[promptId];
        }
        return category;
    }

    /**
     * Assigns a prompt to a local category.
     * @param {string} promptId Prompt identifier
     * @param {string|null} categoryId Category id
     */
    setPromptCategoryForPrompt(promptId, categoryId) {
        const state = this.getPromptCategoryState();
        if (!categoryId) {
            delete state.assignments[promptId];
        } else {
            state.assignments[promptId] = categoryId;
        }
        this.syncPromptOrderFromCategoryState();
        saveSettingsDebounced();
    }

    /**
     * Saves prompt order entries by visible DOM/prompt identifier order.
     * @param {string[]} promptIdentifiers Ordered prompt identifiers
     */
    savePromptOrderByIdentifiers(promptIdentifiers) {
        if (!this.activeCharacter) return;

        const promptOrder = this.getPromptOrderForCharacter(this.activeCharacter);
        const idToObjectMap = new Map(promptOrder.map(prompt => [prompt.identifier, prompt]));
        const updatedPromptOrder = promptIdentifiers.map(identifier => idToObjectMap.get(identifier)).filter(Boolean);

        this.removePromptOrderForCharacter(this.activeCharacter);
        this.addPromptOrderForCharacter(this.activeCharacter, updatedPromptOrder);
    }

    /**
     * Rebuilds the saved prompt order from current category assignment and category order.
     */
    syncPromptOrderFromCategoryState() {
        if (!this.arePromptCategoriesEnabled() || !this.activeCharacter) return;

        const state = this.getPromptCategoryState();
        const categories = this.getPromptCategories();
        const categoryIds = new Set(categories.map(category => category.id));
        const currentPromptOrder = this.getPromptOrderForCharacter(this.activeCharacter);
        const currentPromptIds = currentPromptOrder.map(entry => entry.identifier);
        const orderedPromptIds = [];

        for (const category of categories) {
            for (const promptId of currentPromptIds) {
                if (state.assignments[promptId] === category.id) {
                    orderedPromptIds.push(promptId);
                }
            }
        }

        for (const promptId of currentPromptIds) {
            const categoryId = state.assignments[promptId];
            if (!categoryId || !categoryIds.has(categoryId)) {
                orderedPromptIds.push(promptId);
            }
        }

        this.savePromptOrderByIdentifiers(orderedPromptIds);
        this.saveServiceSettings();
    }

    /**
     * Creates a category and returns its id.
     * @returns {Promise<string|null>}
     */
    async createPromptCategory() {
        const name = String(await Popup.show.input('New category', 'Enter a category name:', '') || '').trim();
        if (!name) return null;

        const state = this.getPromptCategoryState();
        const existing = state.categories.find(category => category.name.toLowerCase() === name.toLowerCase());
        if (existing) return existing.id;

        const id = this.getUuidv4();
        state.categories.push({
            id,
            name,
            order: state.categories.length,
            collapsed: false,
        });
        saveSettingsDebounced();
        return id;
    }

    /**
     * Renames a category.
     * @param {string} categoryId Category id
     */
    async renamePromptCategory(categoryId) {
        const state = this.getPromptCategoryState();
        const category = state.categories.find(item => item.id === categoryId);
        if (!category) return;

        const name = String(await Popup.show.input('Rename category', 'Enter a new category name:', category.name) || '').trim();
        if (!name || name === category.name) return;

        const duplicate = state.categories.find(item => item.id !== categoryId && item.name.toLowerCase() === name.toLowerCase());
        if (duplicate) return;

        category.name = name;
        saveSettingsDebounced();
        this.render(false);
    }

    /**
     * Deletes a category and leaves its prompts uncategorized.
     * @param {string} categoryId Category id
     */
    async deletePromptCategory(categoryId) {
        const category = this.getPromptCategoryById(categoryId);
        if (!category) return;

        const confirmed = await Popup.show.confirm('Delete category?', `Prompts in "${escapeHtml(category.name)}" will become uncategorized.`);
        if (!confirmed) return;

        const state = this.getPromptCategoryState();
        state.categories = state.categories.filter(item => item.id !== categoryId);
        for (const promptId of Object.keys(state.assignments)) {
            if (state.assignments[promptId] === categoryId) {
                delete state.assignments[promptId];
            }
        }
        state.categories.forEach((item, index) => item.order = index);
        saveSettingsDebounced();
        this.render(false);
    }

    /**
     * Toggles category collapse state.
     * @param {string} categoryId Category id
     */
    togglePromptCategoryCollapsed(categoryId) {
        const category = this.getPromptCategoryById(categoryId);
        if (!category) return;

        category.collapsed = !category.collapsed;
        saveSettingsDebounced();
        this.render(false);
    }

    /**
     * Closes the prompt category assignment menu.
     */
    closePromptCategoryMenu() {
        $('.prompt-manager-category-menu').remove();
        $(document).off('mousedown.promptCategoryMenu touchstart.promptCategoryMenu keydown.promptCategoryMenu');
    }

    /**
     * Shows a small assignment menu for a prompt category button.
     * @param {string} promptId Prompt identifier
     * @param {HTMLElement} anchorElement Button that opened the menu
     */
    showPromptCategoryMenu(promptId, anchorElement) {
        this.closePromptCategoryMenu();

        const currentCategory = this.getPromptCategoryForPrompt(promptId);
        const categories = this.getPromptCategories();
        const $menu = $('<div class="prompt-manager-category-menu" />');
        const $title = $('<div class="prompt-manager-category-menu-title" />').text('Assign category');
        $menu.append($title);

        const addItem = (label, icon, active, handler) => {
            const $item = $('<button type="button" class="prompt-manager-category-menu-item" />');
            if (active) $item.addClass('active');
            $item.append($('<i />').addClass(`fa-solid ${icon} fa-fw`));
            $item.append($('<span />').text(label));
            if (active) $item.append($('<i class="fa-solid fa-check fa-fw prompt-manager-category-menu-check" />'));
            $item.on('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();
                await handler();
            });
            $menu.append($item);
        };

        addItem('Uncategorized', 'fa-folder-open', !currentCategory, async () => {
            this.setPromptCategoryForPrompt(promptId, null);
            this.closePromptCategoryMenu();
            this.render(false);
        });

        if (categories.length) {
            $menu.append($('<div class="prompt-manager-category-menu-separator" />'));
            for (const category of categories) {
                addItem(category.name, 'fa-folder', currentCategory?.id === category.id, async () => {
                    this.setPromptCategoryForPrompt(promptId, category.id);
                    this.closePromptCategoryMenu();
                    this.render(false);
                });
            }
        }

        $menu.append($('<div class="prompt-manager-category-menu-separator" />'));
        addItem('New category...', 'fa-folder-plus', false, async () => {
            const categoryId = await this.createPromptCategory();
            if (categoryId) {
                this.setPromptCategoryForPrompt(promptId, categoryId);
                this.closePromptCategoryMenu();
                this.render(false);
            }
        });

        $menu.on('mousedown touchstart click', event => event.stopPropagation());
        $('body').append($menu);

        const rect = anchorElement.getBoundingClientRect();
        const menuWidth = $menu.outerWidth();
        const menuHeight = $menu.outerHeight();
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
        const top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menuHeight - 8));
        $menu.css({ left, top });

        setTimeout(() => {
            $(document).on('mousedown.promptCategoryMenu touchstart.promptCategoryMenu', event => {
                if ($(event.target).closest('.prompt-manager-category-menu').length) return;
                this.closePromptCategoryMenu();
            });
            $(document).on('keydown.promptCategoryMenu', event => {
                if (event.key === 'Escape') this.closePromptCategoryMenu();
            });
        }, 0);
    }

    /**
     * Renders the prompt category toolbar.
     * @param {HTMLElement} promptManagerDiv Prompt manager root
     */
    renderPromptCategoryToolbar(promptManagerDiv) {
        const listElement = promptManagerDiv.querySelector(`#${this.configuration.prefix}prompt_manager_list`);
        if (!listElement) return;

        const toolbar = document.createElement('div');
        const categoryButtons = this.arePromptCategoriesEnabled() ? `
            <div class="prompt-manager-toolbar-right">
                <button type="button" class="menu_button prompt-manager-category-toolbar-button" data-pm-category-action="new" title="New category"><i class="fa-solid fa-folder-plus"></i></button>
                <button type="button" class="menu_button prompt-manager-category-toolbar-button" data-pm-category-action="expand" title="Expand all categories"><i class="fa-solid fa-angles-down"></i></button>
                <button type="button" class="menu_button prompt-manager-category-toolbar-button" data-pm-category-action="collapse" title="Collapse all categories"><i class="fa-solid fa-angles-up"></i></button>
            </div>
        ` : '';

        toolbar.classList.add('prompt-manager-category-toolbar', 'prompt-manager-toolbar');
        toolbar.innerHTML = `
            <div class="prompt-manager-toolbar-left">
                <button id="manage_preset_variables" type="button" class="menu_button prompt-manager-preset-variable-button" title="Inspect variable macros used in the active completion preset." data-i18n="[title]Inspect variable macros used in the active completion preset.">
                    <i class="fa-solid fa-list-check"></i>
                    <span data-i18n="Variables">Variables</span>
                </button>
            </div>
            ${categoryButtons}
        `;

        toolbar.addEventListener('click', async (event) => {
            const button = event.target instanceof HTMLElement ? event.target.closest('[data-pm-category-action]') : null;
            if (!(button instanceof HTMLElement)) return;

            event.preventDefault();
            event.stopPropagation();

            const action = button.dataset.pmCategoryAction;
            if (action === 'new') {
                await this.createPromptCategory();
                this.render(false);
                return;
            }

            const state = this.getPromptCategoryState();
            if (action === 'expand') {
                state.categories.forEach(category => category.collapsed = false);
            } else if (action === 'collapse') {
                state.categories.forEach(category => category.collapsed = true);
            }
            saveSettingsDebounced();
            this.render(false);
        });

        listElement.insertAdjacentElement('beforebegin', toolbar);
    }

    /**
     * Renders a prompt category header row.
     * @param {{id: string, name: string, collapsed: boolean}} category Category object
     * @param {number} count Number of prompts in the category
     * @returns {string}
     */
    renderPromptCategoryHeader(category, count) {
        const collapsedClass = category.collapsed ? ' prompt-manager-category-collapsed' : '';
        return `
            <li class="prompt-manager-category-header${collapsedClass}" data-pm-category-id="${escapeHtml(category.id)}">
                <span class="prompt-manager-category-drag-handle drag-handle fa-solid fa-grip-lines" title="Drag to reorder category"></span>
                <button type="button" class="prompt-manager-category-collapse fa-solid fa-chevron-down" title="Expand or collapse category"></button>
                <span class="prompt-manager-category-name" title="${escapeHtml(category.name)}">${escapeHtml(category.name)}</span>
                <span class="prompt-manager-category-count">${count}</span>
                <button type="button" class="prompt-manager-category-rename fa-solid fa-pencil" title="Rename category"></button>
                <button type="button" class="prompt-manager-category-delete fa-solid fa-trash-can" title="Delete category"></button>
            </li>
        `;
    }

    /**
     * Renders an uncategorized prompt header.
     * @param {number} count Number of uncategorized prompts
     * @returns {string}
     */
    renderUncategorizedPromptHeader(count) {
        return `
            <li class="prompt-manager-uncategorized-header" data-pm-category-id="">
                <span class="prompt-manager-category-name">Uncategorized</span>
                <span class="prompt-manager-category-count">${count}</span>
            </li>
        `;
    }

    /**
     * Inserts category headers and groups rendered prompt rows.
     * @param {HTMLElement} promptManagerList Prompt manager list element
     */
    applyPromptCategoryGrouping(promptManagerList) {
        if (!this.arePromptCategoriesEnabled()) return;

        const $list = $(promptManagerList);
        $list.children('.prompt-manager-category-header').remove();
        $list.children('.prompt-manager-uncategorized-header').remove();
        $list.children('.prompt-manager-category-collapsed-prompt').removeClass('prompt-manager-category-collapsed-prompt');

        const $headRow = $list.children(`.${this.configuration.prefix}prompt_manager_list_head`).detach();
        const $separator = $list.children(`.${this.configuration.prefix}prompt_manager_list_separator`).detach();
        const $promptRows = $list.children(`.${this.configuration.prefix}prompt_manager_prompt[data-pm-identifier]`).detach();
        const state = this.getPromptCategoryState();
        const categories = this.getPromptCategories();
        const categoryIds = new Set(categories.map(category => category.id));
        const groupedRows = new Map(categories.map(category => [category.id, []]));
        const uncategorizedRows = [];

        $promptRows.each((_, element) => {
            const promptId = element.dataset.pmIdentifier;
            const categoryId = state.assignments[promptId];
            if (categoryId && categoryIds.has(categoryId)) {
                groupedRows.get(categoryId).push(element);
            } else {
                uncategorizedRows.push(element);
            }
        });

        $list.append($headRow, $separator);

        for (const category of categories) {
            const rows = groupedRows.get(category.id) || [];
            $list.append(this.renderPromptCategoryHeader(category, rows.length));
            for (const row of rows) {
                if (category.collapsed) row.classList.add('prompt-manager-category-collapsed-prompt');
                $list.append(row);
            }
        }

        if (uncategorizedRows.length || categories.length) {
            $list.append(this.renderUncategorizedPromptHeader(uncategorizedRows.length));
            for (const row of uncategorizedRows) {
                $list.append(row);
            }
        }
    }

    /**
     * Persists prompt order and prompt category assignments from the current DOM order.
     * @param {HTMLElement} promptManagerList Prompt manager list element
     */
    syncPromptCategoryStateFromList(promptManagerList) {
        const state = this.getPromptCategoryState();
        const categories = this.getPromptCategories();
        const categoryIds = new Set(categories.map(category => category.id));
        const promptIdentifiers = [];
        let currentCategoryId = null;

        for (const child of Array.from(promptManagerList.children)) {
            if (!(child instanceof HTMLElement)) continue;

            if (child.classList.contains('prompt-manager-category-header')) {
                const categoryId = child.dataset.pmCategoryId;
                currentCategoryId = categoryId && categoryIds.has(categoryId) ? categoryId : null;
                continue;
            }

            if (child.classList.contains('prompt-manager-uncategorized-header')) {
                currentCategoryId = null;
                continue;
            }

            if (child.matches(`.${this.configuration.prefix}prompt_manager_prompt[data-pm-identifier]`)) {
                const promptId = child.dataset.pmIdentifier;
                if (!promptId) continue;

                promptIdentifiers.push(promptId);
                if (currentCategoryId) {
                    state.assignments[promptId] = currentCategoryId;
                } else {
                    delete state.assignments[promptId];
                }
            }
        }

        this.savePromptOrderByIdentifiers(promptIdentifiers);
        saveSettingsDebounced();
        this.saveServiceSettings();
    }

    /**
     * Persists category order from the current DOM header order.
     * @param {HTMLElement} promptManagerList Prompt manager list element
     */
    syncPromptCategoryOrderFromList(promptManagerList) {
        const state = this.getPromptCategoryState();
        const categoryOrder = Array.from(promptManagerList.querySelectorAll('.prompt-manager-category-header'))
            .map(element => element instanceof HTMLElement ? element.dataset.pmCategoryId : null)
            .filter(Boolean);

        categoryOrder.forEach((categoryId, order) => {
            const category = state.categories.find(item => item.id === categoryId);
            if (category) category.order = order;
        });

        this.syncPromptOrderFromCategoryState();
        saveSettingsDebounced();
    }

    /**
     * Adds prompt category event handlers after the list is rendered.
     * @param {HTMLElement} promptManagerList Prompt manager list element
     */
    bindPromptCategoryEvents(promptManagerList) {
        if (!this.arePromptCategoriesEnabled()) return;

        Array.from(promptManagerList.getElementsByClassName('prompt-manager-category-action')).forEach(el => {
            el.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                const prompt = event.target instanceof HTMLElement ? event.target.closest('[data-pm-identifier]') : null;
                if (!(prompt instanceof HTMLElement)) return;
                this.showPromptCategoryMenu(prompt.dataset.pmIdentifier, /** @type {HTMLElement} */(el));
            });
        });

        Array.from(promptManagerList.getElementsByClassName('prompt-manager-category-header')).forEach(el => {
            el.addEventListener('click', async event => {
                const header = /** @type {HTMLElement} */(el);
                const categoryId = header.dataset.pmCategoryId;
                if (!categoryId) return;

                const target = event.target instanceof HTMLElement ? event.target : null;
                if (target?.closest('.prompt-manager-category-drag-handle')) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }

                if (target?.closest('.prompt-manager-category-rename')) {
                    event.preventDefault();
                    event.stopPropagation();
                    await this.renamePromptCategory(categoryId);
                    return;
                }

                if (target?.closest('.prompt-manager-category-delete')) {
                    event.preventDefault();
                    event.stopPropagation();
                    await this.deletePromptCategory(categoryId);
                    return;
                }

                event.preventDefault();
                event.stopPropagation();
                this.togglePromptCategoryCollapsed(categoryId);
            });
        });
    }

    /**
     * Update a prompt with the values from the HTML form.
     * @param {Partial<Prompt>} prompt - The prompt to be updated.
     * @returns {void}
     */
    updatePromptWithPromptEditForm(prompt) {
        const nameField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_name'));
        const roleField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_role'));
        const promptField = /** @type {HTMLTextAreaElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_prompt'));
        const injectionPositionField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_position'));
        const injectionDepthField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_depth'));
        const injectionOrderField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_order'));
        const injectionTriggerField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_trigger'));
        const forbidOverridesField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_forbid_overrides'));

        prompt.name = nameField.value;
        prompt.role = roleField.value;
        prompt.content = promptField.value;
        prompt.injection_position = Number(injectionPositionField.value);
        prompt.injection_depth = Number(injectionDepthField.value);
        prompt.injection_order = Number(injectionOrderField.value);
        prompt.injection_trigger = Array.from(injectionTriggerField.selectedOptions).map(option => option.value);
        prompt.forbid_overrides = forbidOverridesField.checked;
    }

    /**
     * Find a prompt by its identifier and update it with the provided object.
     * @param {string} identifier - The identifier of the prompt.
     * @param {Prompt} updatePrompt - An object with properties to be updated in the prompt.
     * @returns {void}
     */
    updatePromptByIdentifier(identifier, updatePrompt) {
        let prompt = this.serviceSettings.prompts.find((item) => identifier === item.identifier);
        if (prompt) prompt = Object.assign(prompt, updatePrompt);
    }

    /**
     * Iterate over an array of prompts, find each one by its identifier, and update them with the provided data.
     * @param {Prompt[]} prompts - An array of prompt updates.
     * @returns {void}
     */
    updatePrompts(prompts) {
        prompts.forEach((update) => {
            let prompt = this.getPromptById(update.identifier);
            if (prompt) Object.assign(prompt, update);
        });
    }

    getTokenHandler() {
        return this.tokenHandler;
    }

    isPromptDisabledForActiveCharacter(identifier) {
        const promptOrderEntry = this.getPromptOrderEntry(this.activeCharacter, identifier);
        if (promptOrderEntry) return !promptOrderEntry.enabled;
        return false;
    }

    /**
     * Add a prompt to the current character's prompt list.
     * @param {Prompt} prompt - The prompt to be added.
     * @param {object} character - The character whose prompt list will be updated.
     * @returns {void}
     */
    appendPrompt(prompt, character) {
        const promptOrder = this.getPromptOrderForCharacter(character);
        const index = promptOrder.findIndex(entry => entry.identifier === prompt.identifier);

        if (-1 === index) promptOrder.unshift({ identifier: prompt.identifier, enabled: false });
    }

    /**
     * Remove a prompt from the current character's prompt list.
     * @param {Prompt} prompt - The prompt to be removed.
     * @param {object} character - The character whose prompt list will be updated.
     * @returns {void}
     */
    // Remove a prompt from the current characters prompt list
    detachPrompt(prompt, character) {
        const promptOrder = this.getPromptOrderForCharacter(character);
        const index = promptOrder.findIndex(entry => entry.identifier === prompt.identifier);
        if (-1 === index) return;
        promptOrder.splice(index, 1);
    }

    /**
     * Create a new prompt and add it to the list of prompts.
     * @param {Partial<Prompt>} prompt - The prompt to be added.
     * @param {string} identifier - The identifier for the new prompt.
     * @returns {void}
     */
    addPrompt(prompt, identifier) {
        if (typeof prompt !== 'object' || prompt === null) throw new Error('Object is not a prompt');

        const newPrompt = {
            identifier: identifier,
            system_prompt: false,
            enabled: false,
            marker: false,
            ...prompt,
        };

        this.serviceSettings.prompts.push(newPrompt);
    }

    /**
     * Sanitize the service settings, ensuring each prompt has a unique identifier.
     * @returns {void}
     */
    sanitizeServiceSettings() {
        this.serviceSettings.prompts = this.serviceSettings.prompts ?? [];
        this.serviceSettings.prompt_order = this.serviceSettings.prompt_order ?? [];

        if ('global' === this.configuration.promptOrder.strategy) {
            const dummyCharacter = { id: this.configuration.promptOrder.dummyId };
            const promptOrder = this.getPromptOrderForCharacter(dummyCharacter);

            if (0 === promptOrder.length) this.addPromptOrderForCharacter(dummyCharacter, promptManagerDefaultPromptOrder);
        }

        // Check whether the referenced prompts are present.
        this.serviceSettings.prompts.length === 0
            ? this.setPrompts(chatCompletionDefaultPrompts.prompts)
            : this.checkForMissingPrompts(this.serviceSettings.prompts);

        // Add identifiers if there are none assigned to a prompt
        this.serviceSettings.prompts.forEach(prompt => prompt && (prompt.identifier = prompt.identifier ?? this.getUuidv4()));

        if (this.activeCharacter) {
            const promptReferences = this.getPromptOrderForCharacter(this.activeCharacter);
            for (let i = promptReferences.length - 1; i >= 0; i--) {
                const reference = promptReferences[i];
                if (reference && -1 === this.serviceSettings.prompts.findIndex(prompt => prompt.identifier === reference.identifier)) {
                    promptReferences.splice(i, 1);
                    this.log('Removed unused reference: ' + reference.identifier);
                }
            }
        }
    }

    /**
     * Checks whether entries of a characters prompt order are orphaned
     * and if all mandatory system prompts for a character are present.
     *
     * @param prompts
     */
    checkForMissingPrompts(prompts) {
        const defaultPromptIdentifiers = chatCompletionDefaultPrompts.prompts.reduce((list, prompt) => { list.push(prompt.identifier); return list; }, []);

        const missingIdentifiers = defaultPromptIdentifiers.filter(identifier =>
            !prompts.some(prompt => prompt.identifier === identifier),
        );

        missingIdentifiers.forEach(identifier => {
            const defaultPrompt = chatCompletionDefaultPrompts.prompts.find(prompt => prompt?.identifier === identifier);
            if (defaultPrompt) {
                prompts.push(defaultPrompt);
                this.log(`Missing system prompt: ${defaultPrompt.identifier}. Added default.`);
            }
        });
    }

    /**
     * Check whether a prompt can be inspected.
     * @param {Prompt} prompt - The prompt to check.
     * @returns {boolean} True if the prompt is a marker, false otherwise.
     */
    isPromptInspectionAllowed(prompt) {
        return true;
    }

    /**
     * Check whether a prompt can be deleted. System prompts cannot be deleted.
     * @param {Prompt} prompt - The prompt to check.
     * @returns {boolean} True if the prompt can be deleted, false otherwise.
     */
    isPromptDeletionAllowed(prompt) {
        return false === prompt.system_prompt;
    }

    /**
     * Check whether a prompt can be edited.
     * @param {Prompt} prompt - The prompt to check.
     * @returns {boolean} True if the prompt can be edited, false otherwise.
     */
    isPromptEditAllowed(prompt) {
        const forceEditPrompts = [
            'charDescription',
            'charPersonality',
            'scenario',
            'personaDescription',
            'worldInfoBefore',
            'worldInfoAfter',
        ];
        return forceEditPrompts.includes(prompt.identifier) || !prompt.marker;
    }

    /**
     * Check whether a prompt can be toggled on or off.
     * @param {Prompt} prompt - The prompt to check.
     * @returns {boolean} True if the prompt can be deleted, false otherwise.
     */
    isPromptToggleAllowed(prompt) {
        const forceTogglePrompts = [
            'charDescription',
            'charPersonality',
            'scenario',
            'personaDescription',
            'worldInfoBefore',
            'worldInfoAfter',
            'main',
            'chatHistory',
            'dialogueExamples',
        ];
        return prompt.marker && !forceTogglePrompts.includes(prompt.identifier) ? false : !this.configuration.toggleDisabled.includes(prompt.identifier);
    }

    /**
     * Handle the deletion of a character by removing their prompt list and nullifying the active character if it was the one deleted.
     * @param {object} event - The event object containing the character's ID.
     * @returns void
     */
    handleCharacterDeleted(event) {
        if ('global' === this.configuration.promptOrder.strategy) return;
        this.removePromptOrderForCharacter(this.activeCharacter);
        if (this.activeCharacter.id === event.detail.id) this.activeCharacter = null;
    }

    /**
     * Handle the selection of a character by setting them as the active character and setting up their prompt list if necessary.
     * @param {object} event - The event object containing the character's ID and character data.
     * @returns {void}
     */
    handleCharacterSelected(event) {
        if ('global' === this.configuration.promptOrder.strategy) {
            this.activeCharacter = { id: this.configuration.promptOrder.dummyId };
        } else if ('character' === this.configuration.promptOrder.strategy) {
            console.log('FOO');
            this.activeCharacter = { id: event.detail.id, ...event.detail.character };
            const promptOrder = this.getPromptOrderForCharacter(this.activeCharacter);

            // ToDo: These should be passed as parameter or attached to the manager as a set of default options.
            // Set default prompts and order for character.
            if (0 === promptOrder.length) this.addPromptOrderForCharacter(this.activeCharacter, promptManagerDefaultPromptOrder);
        } else {
            throw new Error('Unsupported prompt order mode.');
        }
    }

    /**
     * Set the most recently selected character
     *
     * @param event
     */
    handleCharacterUpdated(event) {
        if ('global' === this.configuration.promptOrder.strategy) {
            this.activeCharacter = { id: this.configuration.promptOrder.dummyId };
        } else if ('character' === this.configuration.promptOrder.strategy) {
            this.activeCharacter = { id: event.detail.id, ...event.detail.character };
        } else {
            throw new Error('Prompt order strategy not supported.');
        }
    }

    /**
     * Set the most recently selected character group
     *
     * @param event
     */
    handleGroupSelected(event) {
        if ('global' === this.configuration.promptOrder.strategy) {
            this.activeCharacter = { id: this.configuration.promptOrder.dummyId };
        } else if ('character' === this.configuration.promptOrder.strategy) {
            const characterDummy = { id: event.detail.id, group: event.detail.group };
            this.activeCharacter = characterDummy;
            const promptOrder = this.getPromptOrderForCharacter(characterDummy);

            if (0 === promptOrder.length) this.addPromptOrderForCharacter(characterDummy, promptManagerDefaultPromptOrder);
        } else {
            throw new Error('Prompt order strategy not supported.');
        }
    }

    /**
     * Get a list of group characters, regardless of whether they are active or not.
     *
     * @returns {string[]}
     */
    getActiveGroupCharacters() {
        // ToDo: Ideally, this should return the actual characters.
        return (this.activeCharacter?.group?.members || []).map(member => member && member.substring(0, member.lastIndexOf('.')));
    }

    /**
     * Get the prompts for a specific character. Can be filtered to only include enabled prompts.
     * @returns {Prompt[]} The prompts for the character.
     * @param character
     * @param onlyEnabled
     */
    getPromptsForCharacter(character, onlyEnabled = false) {
        return this.getPromptOrderForCharacter(character)
            .map(item => true === onlyEnabled ? (true === item.enabled ? this.getPromptById(item.identifier) : null) : this.getPromptById(item.identifier))
            .filter(prompt => null !== prompt);
    }

    /**
     * Get the order of prompts for a specific character. If no character is specified or the character doesn't have a prompt list, an empty array is returned.
     * @param {object|null} character - The character to get the prompt list for.
     * @returns {Partial<Prompt>[]} The prompt list for the character, or an empty array.
     */
    getPromptOrderForCharacter(character) {
        return !character ? [] : (this.serviceSettings.prompt_order.find(list => String(list.character_id) === String(character.id))?.order ?? []);
    }

    /**
     * Set the prompts for the manager.
     * @param {Partial<Prompt>[]} prompts - The prompts to be set.
     * @returns {void}
     */
    setPrompts(prompts) {
        this.serviceSettings.prompts = prompts;
    }

    /**
     * Remove the prompt list for a specific character.
     * @param {object} character - The character whose prompt list will be removed.
     * @returns {void}
     */
    removePromptOrderForCharacter(character) {
        const index = this.serviceSettings.prompt_order.findIndex(list => String(list.character_id) === String(character.id));
        if (-1 !== index) this.serviceSettings.prompt_order.splice(index, 1);
    }

    /**
     * Adds a new prompt list for a specific character.
     * @param {Object} character - Object with at least an `id` property
     * @param {Array<Object>} promptOrder - Array of prompt objects
     */
    addPromptOrderForCharacter(character, promptOrder) {
        this.serviceSettings.prompt_order.push({
            character_id: character.id,
            order: JSON.parse(JSON.stringify(promptOrder)),
        });
    }

    /**
     * Searches for a prompt list entry for a given character and identifier.
     * @param {Object} character - Character object
     * @param {string} identifier - Identifier of the prompt list entry
     * @returns {Object|null} The prompt list entry object, or null if not found
     */
    getPromptOrderEntry(character, identifier) {
        return this.getPromptOrderForCharacter(character).find(entry => entry.identifier === identifier) ?? null;
    }

    /**
     * Finds and returns a prompt by its identifier.
     * @param {string} identifier - Identifier of the prompt
     * @returns {Prompt|null} The prompt object, or null if not found
     */
    getPromptById(identifier) {
        return this.serviceSettings.prompts.find(item => item && item.identifier === identifier) ?? null;
    }

    /**
     * Finds and returns the index of a prompt by its identifier.
     * @param {string} identifier - Identifier of the prompt
     * @returns {number|null} Index of the prompt, or null if not found
     */
    getPromptIndexById(identifier) {
        return this.serviceSettings.prompts.findIndex(item => item.identifier === identifier) ?? null;
    }

    /**
     * Enriches a generic object, creating a new prompt object in the process
     *
     * @param {Partial<Prompt>} prompt - Prompt object
     * @param original
     * @returns {Prompt} An object with "role" and "content" properties
     */
    preparePrompt(prompt, original = null) {
        const groupMembers = this.getActiveGroupCharacters();
        const preparedPrompt = new Prompt(prompt);

        if (typeof original === 'string') {
            if (0 < groupMembers.length) preparedPrompt.content = substituteParams(prompt.content ?? '', { original, groupOverride: groupMembers.join(', ') });
            else preparedPrompt.content = substituteParams(prompt.content, { original });
        } else {
            if (0 < groupMembers.length) preparedPrompt.content = substituteParams(prompt.content ?? '', { groupOverride: groupMembers.join(', ') });
            else preparedPrompt.content = substituteParams(prompt.content);
        }

        return preparedPrompt;
    }

    /**
     * Factory function for creating a QuickEdit object associated with a prompt element.
     *
     * The QuickEdit object provides methods to synchronize an input element's value with a prompt's content
     * and handle input events to update the prompt content.
     *
     */
    createQuickEdit(identifier, title) {
        const prompt = this.getPromptById(identifier);
        const textareaIdentifier = `${identifier}_prompt_quick_edit_textarea`;
        const html = `<div class="range-block m-t-1">
                        <div class="justifyLeft">${title}</div>
                        <div class="wide100p">
                            <textarea id="${textareaIdentifier}" class="text_pole textarea_compact" rows="6" placeholder="">${prompt.content}</textarea>
                        </div>
                    </div>`;

        const quickEditContainer = document.getElementById('quick-edit-container');
        quickEditContainer.insertAdjacentHTML('afterbegin', html);

        const debouncedSaveServiceSettings = debouncePromise(() => this.saveServiceSettings(), 300);

        const textarea = /** @type {HTMLTextAreaElement} */(document.getElementById(textareaIdentifier));
        textarea.addEventListener('blur', () => {
            prompt.content = textarea.value;
            this.updatePromptByIdentifier(identifier, prompt);
            debouncedSaveServiceSettings().then(() => this.render());
        });
    }

    /**
     * Updates the quick edit textarea for a specific prompt.
     * @param {string} identifier - The identifier of the prompt.
     * @param {Prompt} prompt - The updated prompt object.
     * @returns {string} The ID of the updated textarea element.
     */
    updateQuickEdit(identifier, prompt) {
        const elementId = `${identifier}_prompt_quick_edit_textarea`;
        const textarea = /** @type {HTMLTextAreaElement} */(document.getElementById(elementId));
        textarea.value = prompt.content;

        return elementId;
    }

    /**
     * Checks if a given name is accepted by OpenAi API
     * @link https://platform.openai.com/docs/api-reference/chat/create
     *
     * @param name
     * @returns {boolean}
     */
    isValidName(name) {
        const regex = /^[a-zA-Z0-9_]{1,64}$/;

        return regex.test(name);
    }

    sanitizeName(name) {
        return name.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 64);
    }

    /**
     * Loads a given prompt into the edit form fields.
     * @param {Partial<Prompt>} prompt - Prompt object with properties 'name', 'role', 'content', and 'system_prompt'
     */
    loadPromptIntoEditForm(prompt) {
        const nameField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_name'));
        const roleField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_role'));
        const promptField = /** @type {HTMLTextAreaElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_prompt'));
        const injectionPositionField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_position'));
        const injectionDepthField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_depth'));
        const injectionOrderField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_order'));
        const injectionTriggerField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_trigger'));
        const injectionDepthBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_depth_block'));
        const injectionOrderBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_order_block'));
        const forbidOverridesField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_forbid_overrides'));
        const forbidOverridesBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_forbid_overrides_block'));
        const entrySourceBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_source_block'));
        const entrySource = /** @type {HTMLSpanElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_source'));
        const isPulledPrompt = Object.keys(this.promptSources).includes(prompt.identifier);

        nameField.value = prompt.name ?? '';
        roleField.value = prompt.role || 'system';
        promptField.value = prompt.content ?? '';
        promptField.disabled = prompt.marker ?? false;
        injectionPositionField.value = (prompt.injection_position ?? INJECTION_POSITION.RELATIVE).toString();
        injectionDepthField.value = (prompt.injection_depth ?? DEFAULT_DEPTH).toString();
        injectionOrderField.value = (prompt.injection_order ?? DEFAULT_ORDER).toString();
        Array.from(injectionTriggerField.options).forEach(option => {
            option.selected = Array.isArray(prompt.injection_trigger) && prompt.injection_trigger.includes(option.value);
        });
        injectionTriggerField.dispatchEvent(new Event('change', { bubbles: true }));
        injectionDepthBlock.style.visibility = prompt.injection_position === INJECTION_POSITION.ABSOLUTE ? 'visible' : 'hidden';
        injectionOrderBlock.style.visibility = prompt.injection_position === INJECTION_POSITION.ABSOLUTE ? 'visible' : 'hidden';
        injectionPositionField.removeAttribute('disabled');
        forbidOverridesField.checked = prompt.forbid_overrides ?? false;
        forbidOverridesBlock.style.visibility = this.overridablePrompts.includes(prompt.identifier) ? 'visible' : 'hidden';
        entrySourceBlock.style.display = isPulledPrompt ? '' : 'none';

        if (isPulledPrompt) {
            const sourceName = this.promptSources[prompt.identifier];
            entrySource.textContent = sourceName;
        }

        const resetPromptButton = document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_reset');
        if (true === prompt.system_prompt) {
            resetPromptButton.style.display = 'block';
            resetPromptButton.dataset.pmPrompt = prompt.identifier;
        } else {
            resetPromptButton.style.display = 'none';
        }

        injectionPositionField.removeEventListener('change', (e) => this.handleInjectionPositionChange(e));
        injectionPositionField.addEventListener('change', (e) => this.handleInjectionPositionChange(e));

        const savePromptButton = document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_save');
        savePromptButton.dataset.pmPrompt = prompt.identifier;
    }

    handleInjectionPositionChange(event) {
        const injectionDepthBlock = document.getElementById(this.configuration.prefix + 'prompt_manager_depth_block');
        const injectionOrderBlock = document.getElementById(this.configuration.prefix + 'prompt_manager_order_block');
        const injectionPosition = Number(event.target.value);
        if (injectionPosition === INJECTION_POSITION.ABSOLUTE) {
            injectionDepthBlock.style.visibility = 'visible';
            injectionOrderBlock.style.visibility = 'visible';
        } else {
            injectionDepthBlock.style.visibility = 'hidden';
            injectionOrderBlock.style.visibility = 'hidden';
        }
    }

    /**
     * Loads a given prompt into the inspect form
     * @param {MessageCollection} messages - Prompt object with properties 'name', 'role', 'content', and 'system_prompt'
     */
    loadMessagesIntoInspectForm(messages) {
        if (!messages) return;

        const createInlineDrawer = (message) => {
            const truncatedTitle = message.content.length > 32 ? message.content.slice(0, 32) + '...' : message.content;
            const title = message.identifier || truncatedTitle;
            const role = message.role;
            const content = message.content || 'No Content';
            const tokens = message.getTokens();

            let drawerHTML = `
        <div class="inline-drawer ${this.configuration.prefix}prompt_manager_prompt">
            <div class="inline-drawer-toggle inline-drawer-header">
                <span>Name: ${escapeHtml(title)}, Role: ${role}, Tokens: ${tokens}</span>
                <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
            </div>
            <div class="inline-drawer-content" style="white-space: pre-wrap;">${escapeHtml(content)}</div>
        </div>
        `;

            let template = document.createElement('template');
            template.innerHTML = drawerHTML.trim();
            return template.content.firstChild;
        };

        const messageList = document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_inspect_list');

        const messagesCollection = messages instanceof Message ? [messages] : messages.getCollection();

        if (0 === messagesCollection.length) messageList.innerHTML = '<span>This marker does not contain any prompts.</span>';

        messagesCollection.forEach(message => {
            messageList.append(createInlineDrawer(message));
        });
    }

    /**
     * Clears all input fields in the edit form.
     */
    clearEditForm() {
        const editArea = document.getElementById(this.configuration.prefix + 'prompt_manager_popup_edit');
        editArea.style.display = 'none';

        const nameField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_name'));
        const roleField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_role'));
        const promptField = /** @type {HTMLTextAreaElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_prompt'));
        const injectionPositionField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_position'));
        const injectionDepthField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_depth'));
        const injectionDepthBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_depth_block'));
        const injectionOrderBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_order_block'));
        const injectionOrderField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_order'));
        const injectionTriggerField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_trigger'));
        const forbidOverridesField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_forbid_overrides'));
        const forbidOverridesBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_forbid_overrides_block'));
        const entrySourceBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_source_block'));
        const entrySource = /** @type {HTMLSpanElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_source'));

        nameField.value = '';
        roleField.selectedIndex = 0;
        promptField.value = '';
        promptField.disabled = false;
        injectionPositionField.selectedIndex = 0;
        injectionPositionField.removeAttribute('disabled');
        injectionDepthField.value = DEFAULT_DEPTH.toString();
        injectionOrderField.value = DEFAULT_ORDER.toString();
        injectionTriggerField.value = '';
        injectionDepthBlock.style.visibility = 'unset';
        injectionOrderBlock.style.visibility = 'unset';
        forbidOverridesBlock.style.visibility = 'unset';
        forbidOverridesField.checked = false;
        entrySourceBlock.style.display = 'none';
        entrySource.textContent = '';

        roleField.disabled = false;
    }

    clearInspectForm() {
        const inspectArea = document.getElementById(this.configuration.prefix + 'prompt_manager_popup_inspect');
        inspectArea.style.display = 'none';
        const messageList = document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_inspect_list');
        messageList.innerHTML = '';
    }

    /**
     * Returns a full list of prompts whose content markers have been substituted.
     * @param {string} generationType - The type of generation, e.g., 'continue' or 'quiet'.
     * @returns {PromptCollection} A PromptCollection object
     */
    getPromptCollection(generationType) {
        generationType = String(generationType || 'normal').toLowerCase().trim();
        const promptCollection = new PromptCollection();
        const promptOrder = this.getPromptOrderForCharacter(this.activeCharacter);

        promptOrder.forEach(entry => {
            const prompt = this.getPromptById(entry.identifier);
            const allowedTrigger = entry.enabled && this.shouldTrigger(prompt, generationType);

            if (!prompt) {
                return;
            }

            if (allowedTrigger) {
                promptCollection.add(this.preparePrompt(prompt));
            } else if (entry.identifier === 'main') {
                // Some extensions require main prompt to be present for relative inserts.
                // So we make a GMO-free vegan replacement.
                const replacementPrompt = structuredClone(prompt);
                replacementPrompt.content = '';
                promptCollection.add(this.preparePrompt(replacementPrompt));
            }
        });

        return promptCollection;
    }

    /**
     * Checks if a prompt should be triggered based on its injection triggers.
     * @param {Prompt} prompt - The prompt to check.
     * @param {string} generationType - The type of generation to check against.
     * @returns {boolean} True if the prompt should be triggered, false otherwise.
     */
    shouldTrigger(prompt, generationType) {
        if (!Array.isArray(prompt?.injection_trigger)) return true;
        if (!prompt.injection_trigger.length) return true;
        return prompt.injection_trigger.includes(generationType);
    }

    /**
     * Setter for messages property
     *
     * @param {import('./openai.js').MessageCollection} messages
     */
    setMessages(messages) {
        this.messages = messages;
    }

    /**
     * Set and process a finished chat completion object
     *
     * @param {import('./openai.js').ChatCompletion} chatCompletion
     */
    setChatCompletion(chatCompletion) {
        const messages = chatCompletion.getMessages();

        this.setMessages(messages);
        this.populateTokenCounts(messages);
        this.overriddenPrompts = chatCompletion.getOverriddenPrompts();
    }

    /**
     * Populates the token handler
     *
     * @param {import('./openai.js').MessageCollection} messages
     */
    populateTokenCounts(messages) {
        this.tokenHandler.resetCounts();
        const counts = this.tokenHandler.getCounts();
        messages.getCollection().forEach(message => {
            counts[message.identifier] = message.getTokens();
        });

        this.tokenUsage = this.tokenHandler.getTotal();

        this.log('Updated token usage with ' + this.tokenUsage);
    }

    /**
     * Empties, then re-assembles the container containing the prompt list.
     */
    async renderPromptManager() {
        let selectedPromptIndex = 0;
        const existingAppendSelect = document.getElementById(`${this.configuration.prefix}prompt_manager_footer_append_prompt`);
        if (existingAppendSelect instanceof HTMLSelectElement) {
            selectedPromptIndex = existingAppendSelect.selectedIndex;
        }
        const promptManagerDiv = this.containerElement;
        promptManagerDiv.innerHTML = '';

        const errorDiv = this.error ? `
                <div class="${this.configuration.prefix}prompt_manager_error">
                    <span class="fa-solid tooltip fa-triangle-exclamation text_danger"></span> ${DOMPurify.sanitize(this.error)}
                </div>
        ` : '';

        const totalActiveTokens = this.tokenUsage;

        const headerHtml = await renderTemplateAsync('promptManagerHeader', { error: this.error, errorDiv, prefix: this.configuration.prefix, totalActiveTokens });
        promptManagerDiv.insertAdjacentHTML('beforeend', headerHtml);

        this.listElement = promptManagerDiv.querySelector(`#${this.configuration.prefix}prompt_manager_list`);
        this.renderPromptCategoryToolbar(promptManagerDiv);

        if (null !== this.activeCharacter) {
            const prompts = [...this.serviceSettings.prompts]
                .filter(prompt => prompt && !prompt?.system_prompt)
                .sort((promptA, promptB) => promptA.name.localeCompare(promptB.name));
            const promptsHtml = prompts.reduce((acc, prompt) => acc + `<option value="${prompt.identifier}">${escapeHtml(prompt.name)}</option>`, '');

            if (selectedPromptIndex > 0) {
                selectedPromptIndex = Math.min(selectedPromptIndex, prompts.length - 1);
            }

            if (selectedPromptIndex === -1 && prompts.length) {
                selectedPromptIndex = 0;
            }

            const rangeBlockDiv = promptManagerDiv.querySelector('.range-block');
            const headerDiv = promptManagerDiv.querySelector('.completion_prompt_manager_header');
            const footerHtml = await renderTemplateAsync('promptManagerFooter', { promptsHtml, prefix: this.configuration.prefix });
            headerDiv.insertAdjacentHTML('afterend', footerHtml);
            rangeBlockDiv.querySelector('#prompt-manager-reset-character').addEventListener('click', this.handleCharacterReset);

            const footerDiv = rangeBlockDiv.querySelector(`.${this.configuration.prefix}prompt_manager_footer`);
            footerDiv.querySelector('.menu_button:nth-child(2)').addEventListener('click', this.handleAppendPrompt);
            footerDiv.querySelector('.caution').addEventListener('click', this.handleDeletePrompt);
            footerDiv.querySelector('.menu_button:last-child').addEventListener('click', this.handleNewPrompt);
            footerDiv.querySelector('select').selectedIndex = selectedPromptIndex;

            // Add prompt export dialogue and options
            footerDiv.querySelector('#prompt-manager-import').addEventListener('click', this.handleImport);
            footerDiv.querySelector('#prompt-manager-export').addEventListener('click', this.handleFullExport);
        }
    }

    /**
     * Empties, then re-assembles the prompt list
     */
    async renderPromptManagerListItems() {
        if (!this.serviceSettings.prompts) return;

        const promptManagerList = this.listElement;
        promptManagerList.innerHTML = '';

        const { prefix } = this.configuration;
        const promptCategoriesEnabled = this.arePromptCategoriesEnabled();
        promptManagerList.classList.toggle('prompt-manager-categories-enabled', promptCategoriesEnabled);

        let listItemHtml = await renderTemplateAsync('promptManagerListHeader', { prefix });

        this.getPromptsForCharacter(this.activeCharacter).forEach(prompt => {
            if (!prompt) return;

            const listEntry = this.getPromptOrderEntry(this.activeCharacter, prompt.identifier);
            const enabledClass = listEntry.enabled ? '' : `${prefix}prompt_manager_prompt_disabled`;
            const draggableClass = `${prefix}prompt_manager_prompt_draggable`;
            const markerClass = prompt.marker ? `${prefix}prompt_manager_marker` : '';
            const tokens = this.tokenHandler?.getCounts()[prompt.identifier] ?? 0;

            // Warn the user if the chat history goes below certain token thresholds.
            let warningClass = '';
            let warningTitle = '';

            const tokenBudget = this.serviceSettings.openai_max_context - this.serviceSettings.openai_max_tokens;
            if (this.tokenUsage > tokenBudget * 0.8 &&
                'chatHistory' === prompt.identifier) {
                const warningThreshold = this.configuration.warningTokenThreshold;
                const dangerThreshold = this.configuration.dangerTokenThreshold;

                if (tokens <= dangerThreshold) {
                    warningClass = 'fa-solid tooltip fa-triangle-exclamation text_danger';
                    warningTitle = 'Very little of your chat history is being sent, consider deactivating some other prompts.';
                } else if (tokens <= warningThreshold) {
                    warningClass = 'fa-solid tooltip fa-triangle-exclamation text_warning';
                    warningTitle = 'Only a few messages worth chat history are being sent.';
                }
            }

            const calculatedTokens = tokens ? tokens : '-';

            let detachSpanHtml = '';
            if (this.isPromptDeletionAllowed(prompt)) {
                detachSpanHtml = `
                    <span title="Remove" class="prompt-manager-detach-action caution fa-solid fa-chain-broken fa-xs"></span>
                `;
            } else {
                detachSpanHtml = '<span class="fa-solid"></span>';
            }

            let editSpanHtml = '';
            if (this.isPromptEditAllowed(prompt)) {
                editSpanHtml = `
                    <span title="edit" class="prompt-manager-edit-action fa-solid fa-pencil fa-xs"></span>
                `;
            } else {
                editSpanHtml = '<span class="fa-solid"></span>';
            }

            let toggleSpanHtml = '';
            if (this.isPromptToggleAllowed(prompt)) {
                toggleSpanHtml = `
                    <span class="prompt-manager-toggle-action ${listEntry.enabled ? 'fa-solid fa-toggle-on' : 'fa-solid fa-toggle-off'}"></span>
                `;
            } else {
                toggleSpanHtml = '<span class="fa-solid"></span>';
            }

            const encodedName = escapeHtml(prompt.name);
            const isMarkerPrompt = prompt.marker && prompt.injection_position !== INJECTION_POSITION.ABSOLUTE;
            const isSystemPrompt = !prompt.marker && prompt.system_prompt && prompt.injection_position !== INJECTION_POSITION.ABSOLUTE && !prompt.forbid_overrides;
            const isImportantPrompt = !prompt.marker && prompt.system_prompt && prompt.injection_position !== INJECTION_POSITION.ABSOLUTE && prompt.forbid_overrides;
            const isUserPrompt = !prompt.marker && !prompt.system_prompt && prompt.injection_position !== INJECTION_POSITION.ABSOLUTE;
            const isInjectionPrompt = prompt.injection_position === INJECTION_POSITION.ABSOLUTE;
            const isOverriddenPrompt = Array.isArray(this.overriddenPrompts) && this.overriddenPrompts.includes(prompt.identifier);
            const importantClass = isImportantPrompt ? `${prefix}prompt_manager_important` : '';
            const iconLookup = prompt.role === 'system' && (prompt.marker || prompt.system_prompt) ? '' : prompt.role;

            //add role icons to the right of prompt name
            const promptRoles = {
                assistant: { roleIcon: 'fa-robot', roleTitle: 'Prompt will be sent as Assistant' },
                user: { roleIcon: 'fa-user', roleTitle: 'Prompt will be sent as User' },
            };
            const roleIcon = promptRoles[iconLookup]?.roleIcon || '';
            const roleTitle = promptRoles[iconLookup]?.roleTitle || '';
            const category = promptCategoriesEnabled ? this.getPromptCategoryForPrompt(prompt.identifier) : null;
            const categoryTitle = category ? `Category: ${category.name}` : 'Assign category';
            const categorySpanHtml = promptCategoriesEnabled ? `
                                <span title="${escapeHtml(categoryTitle)}" class="prompt-manager-category-action fa-solid ${category ? 'fa-folder' : 'fa-folder-open'} fa-xs"></span>
            ` : '';

            listItemHtml += `
                <li class="${prefix}prompt_manager_prompt ${draggableClass} ${enabledClass} ${markerClass} ${importantClass}" data-pm-identifier="${escapeHtml(prompt.identifier)}">
                    <span class="drag-handle">☰</span>
                    <span class="${prefix}prompt_manager_prompt_name" data-pm-name="${encodedName}">
                        ${isMarkerPrompt ? '<span class="fa-fw fa-solid fa-thumb-tack" title="Marker"></span>' : ''}
                        ${isSystemPrompt ? '<span class="fa-fw fa-solid fa-square-poll-horizontal" title="Global Prompt"></span>' : ''}
                        ${isImportantPrompt ? '<span class="fa-fw fa-solid fa-star" title="Important Prompt"></span>' : ''}
                        ${isUserPrompt ? '<span class="fa-fw fa-solid fa-asterisk" title="Preset Prompt"></span>' : ''}
                        ${isInjectionPrompt ? '<span class="fa-fw fa-solid fa-syringe" title="In-Chat Injection"></span>' : ''}
                        ${this.isPromptInspectionAllowed(prompt) ? `<a title="${encodedName}" class="prompt-manager-inspect-action">${encodedName}</a>` : `<span title="${encodedName}">${encodedName}</span>`}
                        ${roleIcon ? `<span data-role="${escapeHtml(prompt.role)}" class="fa-xs fa-solid ${roleIcon}" title="${roleTitle}"></span>` : ''}
                        ${isInjectionPrompt ? `<small class="prompt-manager-injection-depth">@ ${escapeHtml(prompt.injection_depth.toString())}</small>` : ''}
                        ${isOverriddenPrompt ? '<small class="fa-solid fa-address-card prompt-manager-overridden" title="Pulled from a character card"></small>' : ''}
                    </span>
                    <span>
                            <span class="prompt_manager_prompt_controls">
                                ${categorySpanHtml}
                                ${detachSpanHtml}
                                ${editSpanHtml}
                                ${toggleSpanHtml}
                            </span>
                    </span>

                    <span class="prompt_manager_prompt_tokens" data-pm-tokens="${calculatedTokens}"><span class="${warningClass}" title="${warningTitle}"> </span>${calculatedTokens}</span>
                </li>
            `;
        });

        promptManagerList.insertAdjacentHTML('beforeend', listItemHtml);
        this.applyPromptCategoryGrouping(promptManagerList);

        // Now that the new elements are in the DOM, you can add the event listeners.
        Array.from(promptManagerList.getElementsByClassName('prompt-manager-detach-action')).forEach(el => {
            el.addEventListener('click', this.handleDetach);
        });

        Array.from(promptManagerList.getElementsByClassName('prompt-manager-inspect-action')).forEach(el => {
            el.addEventListener('click', this.handleInspect);
        });

        Array.from(promptManagerList.getElementsByClassName('prompt-manager-edit-action')).forEach(el => {
            el.addEventListener('click', this.handleEdit);
        });

        Array.from(promptManagerList.querySelectorAll('.prompt-manager-toggle-action')).forEach(el => {
            el.addEventListener('click', this.handleToggle);
        });

        this.bindPromptCategoryEvents(promptManagerList);
    }

    /**
     * Writes the passed data to a json file
     *
     * @param data
     * @param type
     * @param name
     */
    export(data, type, name = 'export') {
        const promptExport = {
            version: this.configuration.version,
            type: type,
            data: data,
        };

        const serializedObject = JSON.stringify(promptExport, null, 4);
        const blob = new Blob([serializedObject], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const downloadLink = document.createElement('a');
        downloadLink.href = url;

        const dateString = this.getFormattedDate();
        downloadLink.download = `${name}-${dateString}.json`;

        downloadLink.click();

        URL.revokeObjectURL(url);
    }

    /**
     * Imports a json file with prompts and an optional prompt list for the active character
     *
     * @param importData
     */
    import(importData) {
        const mergeKeepNewer = (prompts, newPrompts) => {
            let merged = [...prompts, ...newPrompts];

            let map = new Map();
            for (let obj of merged) {
                map.set(obj.identifier, obj);
            }

            merged = Array.from(map.values());

            return merged;
        };

        const controlObj = {
            version: 1,
            type: '',
            data: {
                prompts: [],
                prompt_order: null,
            },
        };

        if (false === this.validateObject(controlObj, importData)) {
            toastr.warning(t`Could not import prompts. Export failed validation.`);
            return;
        }

        const prompts = mergeKeepNewer(this.serviceSettings.prompts, importData.data.prompts);

        this.setPrompts(prompts);
        this.log('Prompt import succeeded');

        if ('global' === this.configuration.promptOrder.strategy) {
            const promptOrder = this.getPromptOrderForCharacter({ id: this.configuration.promptOrder.dummyId });
            Object.assign(promptOrder, importData.data.prompt_order);
            this.log('Prompt order import succeeded');
        } else if ('character' === this.configuration.promptOrder.strategy) {
            if ('character' === importData.type) {
                const promptOrder = this.getPromptOrderForCharacter(this.activeCharacter);
                Object.assign(promptOrder, importData.data.prompt_order);
                this.log(`Prompt order import for character ${this.activeCharacter.name} succeeded`);
            }
        } else {
            throw new Error('Prompt order strategy not supported.');
        }

        toastr.success(t`Prompt import complete.`);
        this.saveServiceSettings().then(() => this.render());
    }

    /**
     * Helper function to check whether the structure of object matches controlObj
     *
     * @param controlObj
     * @param object
     * @returns {boolean}
     */
    validateObject(controlObj, object) {
        for (let key in controlObj) {
            if (!Object.hasOwn(object, key)) {
                if (controlObj[key] === null) continue;
                else return false;
            }

            if (typeof controlObj[key] === 'object' && controlObj[key] !== null) {
                if (typeof object[key] !== 'object') return false;
                if (!this.validateObject(controlObj[key], object[key])) return false;
            } else {
                if (typeof object[key] !== typeof controlObj[key]) return false;
            }
        }

        return true;
    }

    /**
     * Get current date as mm/dd/YYYY
     *
     * @returns {`${string}_${string}_${string}`}
     */
    getFormattedDate() {
        const date = new Date();
        let month = String(date.getMonth() + 1);
        let day = String(date.getDate());
        const year = String(date.getFullYear());

        if (month.length < 2) month = '0' + month;
        if (day.length < 2) day = '0' + day;

        return `${month}_${day}_${year}`;
    }

    /**
     * Makes the prompt list draggable and handles swapping of two entries in the list.
     * @typedef {Object} Entry
     * @property {string} identifier
     * @returns {void}
     */
    makeDraggable() {
        const $promptManagerList = $(`#${this.configuration.prefix}prompt_manager_list`);
        const categoriesEnabled = this.arePromptCategoriesEnabled();
        $promptManagerList.sortable({
            delay: this.configuration.sortableDelay,
            handle: isMobile() ? '.drag-handle, .prompt-manager-category-drag-handle' : null,
            items: categoriesEnabled
                ? `.${this.configuration.prefix}prompt_manager_prompt_draggable:not(.prompt-manager-category-collapsed-prompt), .prompt-manager-category-header`
                : `.${this.configuration.prefix}prompt_manager_prompt_draggable`,
            update: (event, ui) => {
                if (categoriesEnabled && ui.item.hasClass('prompt-manager-category-header')) {
                    this.syncPromptCategoryOrderFromList($promptManagerList[0]);
                    this.render(false);
                    return;
                }

                if (categoriesEnabled) {
                    this.syncPromptCategoryStateFromList($promptManagerList[0]);
                    this.render(false);
                    return;
                }

                const promptListElement = $promptManagerList.sortable('toArray', { attribute: 'data-pm-identifier' });
                this.savePromptOrderByIdentifiers(promptListElement);
                this.log(`Prompt order updated for ${this.activeCharacter.name}.`);
                this.saveServiceSettings();
            },
        });
    }

    /**
     * Slides down the edit form and adds the class 'openDrawer' to the first element of '#openai_prompt_manager_popup'.
     * @returns {void}
     */
    showPopup(area = 'edit') {
        const areaElement = document.getElementById(this.configuration.prefix + 'prompt_manager_popup_' + area);
        areaElement.style.display = 'flex';

        $('#' + this.configuration.prefix + 'prompt_manager_popup').first()
            .slideDown(200, 'swing')
            .addClass('openDrawer');
    }

    /**
     * Slides up the edit form and removes the class 'openDrawer' from the first element of '#openai_prompt_manager_popup'.
     * @returns {void}
     */
    hidePopup() {
        $('#' + this.configuration.prefix + 'prompt_manager_popup').first()
            .slideUp(200, 'swing')
            .removeClass('openDrawer');
    }

    /**
     * Quick uuid4 implementation
     * @returns {string} A string representation of an uuid4
     */
    getUuidv4() {
        return uuidv4();
    }

    /**
     * Write to console with prefix
     *
     * @param output
     */
    log(output) {
        if (power_user.console_log_prompts) console.log('[PromptManager] ' + output);
    }

    /**
     * Start a profiling task
     *
     * @param identifier
     */
    profileStart(identifier) {
        if (power_user.console_log_prompts) console.time(identifier);
    }

    /**
     * End a profiling task
     *
     * @param identifier
     */
    profileEnd(identifier) {
        if (power_user.console_log_prompts) {
            this.log('Profiling of "' + identifier + '" finished. Result below.');
            console.timeEnd(identifier);
        }
    }
}

const chatCompletionDefaultPrompts = {
    'prompts': [
        {
            'name': 'Main Prompt',
            'system_prompt': true,
            'role': 'system',
            'content': 'Write {{char}}\'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.',
            'identifier': 'main',
        },
        {
            'name': 'Auxiliary Prompt',
            'system_prompt': true,
            'role': 'system',
            'content': '',
            'identifier': 'nsfw',
        },
        {
            'identifier': 'dialogueExamples',
            'name': 'Chat Examples',
            'system_prompt': true,
            'marker': true,
        },
        {
            'name': 'Post-History Instructions',
            'system_prompt': true,
            'role': 'system',
            'content': '',
            'identifier': 'jailbreak',
        },
        {
            'identifier': 'chatHistory',
            'name': 'Chat History',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'worldInfoAfter',
            'name': 'World Info (after)',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'worldInfoBefore',
            'name': 'World Info (before)',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'enhanceDefinitions',
            'role': 'system',
            'name': 'Enhance Definitions',
            'content': 'If you have more knowledge of {{char}}, add to the character\'s lore and personality to enhance them but keep the Character Sheet\'s definitions absolute.',
            'system_prompt': true,
            'marker': false,
        },
        {
            'identifier': 'charDescription',
            'name': 'Char Description',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'charPersonality',
            'name': 'Char Personality',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'scenario',
            'name': 'Scenario',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'personaDescription',
            'name': 'Persona Description',
            'system_prompt': true,
            'marker': true,
        },
    ],
};

const promptManagerDefaultPromptOrders = {
    'prompt_order': [],
};

const promptManagerDefaultPromptOrder = [
    {
        'identifier': 'main',
        'enabled': true,
    },
    {
        'identifier': 'worldInfoBefore',
        'enabled': true,
    },
    {
        'identifier': 'personaDescription',
        'enabled': true,
    },
    {
        'identifier': 'charDescription',
        'enabled': true,
    },
    {
        'identifier': 'charPersonality',
        'enabled': true,
    },
    {
        'identifier': 'scenario',
        'enabled': true,
    },
    {
        'identifier': 'enhanceDefinitions',
        'enabled': false,
    },
    {
        'identifier': 'nsfw',
        'enabled': true,
    },
    {
        'identifier': 'worldInfoAfter',
        'enabled': true,
    },
    {
        'identifier': 'dialogueExamples',
        'enabled': true,
    },
    {
        'identifier': 'chatHistory',
        'enabled': true,
    },
    {
        'identifier': 'jailbreak',
        'enabled': true,
    },
];

export {
    PromptManager,
    registerPromptManagerMigration,
    chatCompletionDefaultPrompts,
    promptManagerDefaultPromptOrders,
    Prompt,
};
