import { css, DOMPurify } from '../lib.js';
import { isExternalMediaAllowed } from './chats.js';
import { renderRisuAssetMacros } from './risu-assets.js';
import { evaluateRisuCbs } from './risu-cbs.js';

const RISU_BACKGROUND_STYLE_ID = 'risu_background_html_style';
const RISU_BACKGROUND_OVERLAY_ID = 'risu_background_html_overlay';
let lastAppliedSignature = '';
let viewportMetricsResizeHandler = null;
let viewportMetricsObserver = null;
let viewportMetricsMutationObserver = null;
let viewportMetricsFrame = null;
const viewportMetricsTimeouts = new Map();
let viewportMetricsTransitionHandler = null;
let viewportMetricsScrollElement = null;
let viewportMetricsScrollHandler = null;

export const RISU_SANITIZER_ATTRIBUTES = [
    'allow',
    'allowfullscreen',
    'frameborder',
    'scrolling',
    'risu-ctrl',
    'risu-btn',
    'risu-trigger',
    'risu-mark',
    'risu-id',
    'x-hl-lang',
    'x-hl-text',
];

function removeRisuBackgroundHtml() {
    document.getElementById(RISU_BACKGROUND_STYLE_ID)?.remove();
    document.getElementById(RISU_BACKGROUND_OVERLAY_ID)?.remove();
    document.getElementById('chat')?.classList.remove('risu-background-enabled');
    clearRisuChatViewportMetrics();
    lastAppliedSignature = '';
}

function getVisibleChatRightEdge(chatRect, viewportWidth) {
    let rightEdge = Math.min(chatRect.right, viewportWidth);
    const rightPanel = document.getElementById('right-nav-panel');
    if (!rightPanel) {
        return rightEdge;
    }

    const panelStyle = getComputedStyle(rightPanel);
    if (panelStyle.display === 'none' || panelStyle.visibility === 'hidden') {
        return rightEdge;
    }

    const panelRect = rightPanel.getBoundingClientRect();
    const panelOverlapsViewport = panelRect.width > 0 && panelRect.left < viewportWidth && panelRect.right > 0;
    const panelOverlapsChat = panelRect.left > chatRect.left && panelRect.left < rightEdge;
    if (panelOverlapsViewport && panelOverlapsChat) {
        rightEdge = panelRect.left;
    }

    return rightEdge;
}

function setRisuMetricProperty(element, property, value) {
    const normalized = `${Math.max(0, Math.round(value * 100) / 100)}px`;
    if (element.style.getPropertyValue(property) !== normalized) {
        element.style.setProperty(property, normalized);
    }
}

function createsFixedContainingBlock(element) {
    const style = getComputedStyle(element);
    const isActiveValue = (value) => Boolean(value) && value !== 'none' && value !== 'normal' && value !== 'auto';

    return isActiveValue(style.transform)
        || isActiveValue(style.perspective)
        || isActiveValue(style.filter)
        || isActiveValue(style.backdropFilter)
        || style.contentVisibility === 'auto'
        || style.containerType !== 'normal'
        || /\b(layout|paint|strict|content)\b/.test(style.contain)
        || /\b(transform|perspective|filter|backdrop-filter)\b/.test(style.willChange);
}

function rememberRisuFloatingControlOffsets(chatElement) {
    if (chatElement.classList.contains('risu-fixed-ui-scroll-contained')) {
        return;
    }

    for (const element of chatElement.querySelectorAll('.custom-buttons-container')) {
        if (element.style.getPropertyValue('--risu-fixed-control-top')) {
            continue;
        }

        const top = getComputedStyle(element).top;
        if (top && top !== 'auto') {
            element.style.setProperty('--risu-fixed-control-top', top);
        }
    }
}

function updateRisuChatViewportMetrics(chatElement = document.getElementById('chat')) {
    if (!chatElement) {
        return;
    }

    const rect = chatElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || rect.right;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || rect.bottom;
    const rightEdge = getVisibleChatRightEdge(rect, viewportWidth);
    const visibleRightInset = Math.max(0, rect.right - rightEdge);

    rememberRisuFloatingControlOffsets(chatElement);
    chatElement.classList.toggle('risu-fixed-ui-scroll-contained', createsFixedContainingBlock(chatElement));
    setRisuMetricProperty(chatElement, '--risu-chat-left-edge', rect.left);
    setRisuMetricProperty(chatElement, '--risu-chat-right-edge', viewportWidth - rightEdge);
    setRisuMetricProperty(chatElement, '--risu-chat-top-edge', rect.top);
    setRisuMetricProperty(chatElement, '--risu-chat-bottom-edge', viewportHeight - rect.bottom);
    setRisuMetricProperty(chatElement, '--risu-chat-visible-width', rightEdge - rect.left);
    setRisuMetricProperty(chatElement, '--risu-chat-visible-height', rect.height);
    setRisuMetricProperty(chatElement, '--risu-chat-scroll-top', chatElement.scrollTop || 0);
    setRisuMetricProperty(chatElement, '--risu-chat-visible-right-inset', visibleRightInset);
    setRisuMetricProperty(chatElement, '--risu-chat-control-right-offset', visibleRightInset + 20);
}

function scheduleRisuChatViewportMetricsUpdate(chatElement = document.getElementById('chat')) {
    if (!chatElement) {
        return;
    }

    updateRisuChatViewportMetrics(chatElement);

    if (viewportMetricsFrame === null) {
        viewportMetricsFrame = requestAnimationFrame(() => {
            viewportMetricsFrame = null;
            updateRisuChatViewportMetrics();
        });
    }

    for (const delay of [50, 150, 350]) {
        const existingTimeout = viewportMetricsTimeouts.get(delay);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
        }

        viewportMetricsTimeouts.set(delay, setTimeout(() => {
            viewportMetricsTimeouts.delete(delay);
            updateRisuChatViewportMetrics();
        }, delay));
    }
}

function getRisuViewportMetricElements(chatElement) {
    return [
        chatElement,
        document.getElementById('sheld'),
        document.getElementById('right-nav-panel'),
        document.getElementById('top-bar'),
        document.getElementById('form_sheld'),
        document.getElementById('send_form'),
    ].filter((element, index, elements) => element && elements.indexOf(element) === index);
}

function clearRisuChatViewportMetrics() {
    const chatElement = document.getElementById('chat');
    chatElement?.style.removeProperty('--risu-chat-left-edge');
    chatElement?.style.removeProperty('--risu-chat-right-edge');
    chatElement?.style.removeProperty('--risu-chat-top-edge');
    chatElement?.style.removeProperty('--risu-chat-bottom-edge');
    chatElement?.style.removeProperty('--risu-chat-visible-width');
    chatElement?.style.removeProperty('--risu-chat-visible-height');
    chatElement?.style.removeProperty('--risu-chat-scroll-top');
    chatElement?.style.removeProperty('--risu-chat-visible-right-inset');
    chatElement?.style.removeProperty('--risu-chat-control-right-offset');
    chatElement?.classList.remove('risu-fixed-ui-scroll-contained');

    if (viewportMetricsResizeHandler) {
        window.removeEventListener('resize', viewportMetricsResizeHandler);
        viewportMetricsResizeHandler = null;
    }
    if (viewportMetricsScrollElement && viewportMetricsScrollHandler) {
        viewportMetricsScrollElement.removeEventListener('scroll', viewportMetricsScrollHandler);
        viewportMetricsScrollElement = null;
        viewportMetricsScrollHandler = null;
    }
    if (viewportMetricsFrame !== null) {
        cancelAnimationFrame(viewportMetricsFrame);
        viewportMetricsFrame = null;
    }
    for (const timeout of viewportMetricsTimeouts.values()) {
        clearTimeout(timeout);
    }
    viewportMetricsTimeouts.clear();
    viewportMetricsObserver?.disconnect();
    viewportMetricsObserver = null;
    viewportMetricsMutationObserver?.disconnect();
    viewportMetricsMutationObserver = null;
    if (viewportMetricsTransitionHandler) {
        document.removeEventListener('transitionend', viewportMetricsTransitionHandler, true);
        document.removeEventListener('animationend', viewportMetricsTransitionHandler, true);
        viewportMetricsTransitionHandler = null;
    }
}

function observeRisuChatViewportMetrics(chatElement) {
    scheduleRisuChatViewportMetricsUpdate(chatElement);

    if (!viewportMetricsResizeHandler) {
        viewportMetricsResizeHandler = () => scheduleRisuChatViewportMetricsUpdate();
        window.addEventListener('resize', viewportMetricsResizeHandler);
    }

    if (viewportMetricsScrollElement !== chatElement) {
        if (viewportMetricsScrollElement && viewportMetricsScrollHandler) {
            viewportMetricsScrollElement.removeEventListener('scroll', viewportMetricsScrollHandler);
        }
        viewportMetricsScrollElement = chatElement;
        viewportMetricsScrollHandler = () => updateRisuChatViewportMetrics(chatElement);
        chatElement.addEventListener('scroll', viewportMetricsScrollHandler, { passive: true });
    }

    viewportMetricsObserver?.disconnect();
    if (typeof ResizeObserver === 'function') {
        viewportMetricsObserver = new ResizeObserver(() => scheduleRisuChatViewportMetricsUpdate());
        for (const element of getRisuViewportMetricElements(chatElement)) {
            viewportMetricsObserver.observe(element);
        }
    }

    viewportMetricsMutationObserver?.disconnect();
    if (typeof MutationObserver === 'function') {
        viewportMetricsMutationObserver = new MutationObserver(() => scheduleRisuChatViewportMetricsUpdate());
        for (const element of [
            ...getRisuViewportMetricElements(chatElement),
            document.documentElement,
            document.body,
        ]) {
            if (element) {
                viewportMetricsMutationObserver.observe(element, { attributes: true, attributeFilter: ['class', 'style'] });
            }
        }
    }

    if (!viewportMetricsTransitionHandler) {
        viewportMetricsTransitionHandler = (event) => {
            const target = event?.target;
            if (!(target instanceof Element)) {
                scheduleRisuChatViewportMetricsUpdate();
                return;
            }

            if (target === document.documentElement
                || target === document.body
                || target.closest('#sheld, #right-nav-panel, #top-bar, #form_sheld, #send_form, #chat')) {
                scheduleRisuChatViewportMetricsUpdate();
            }
        };
        document.addEventListener('transitionend', viewportMetricsTransitionHandler, true);
        document.addEventListener('animationend', viewportMetricsTransitionHandler, true);
    }
}

function splitStyleBlocks(html) {
    let cssText = '';
    const htmlText = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_match, css) => {
        cssText += `${css}\n`;
        return '';
    });

    return { cssText, htmlText };
}

function looksLikeCss(text) {
    const value = String(text ?? '').trim();
    return !value.includes('<') && /[{}]/.test(value) && /[^{}]+\{[\s\S]*:[\s\S]*\}/.test(value);
}

function scopeRisuSelector(selector) {
    const value = String(selector ?? '').trim();
    if (!value) {
        return value;
    }

    const scopeSelector = (scopedSelector) => scopedSelector.replace(/\.([\w-]+)/g, (match, className) => {
        if (className.startsWith('custom-') || className.startsWith('fa-') || className.startsWith('note-') || className === 'monospace') {
            return match;
        }

        return `.custom-${className}`;
    });

    if (/^(:root|html|body|\*)$/i.test(value)) {
        return '#chat';
    }

    if (/^(:root|html|body)\b/i.test(value)) {
        return scopeSelector(value.replace(/^(:root|html|body)\b/i, '#chat'));
    }

    return scopeSelector(`#chat ${value}`);
}

function boostCardCssDeclaration(declaration) {
    if (!declaration || declaration.type !== 'declaration') {
        return declaration;
    }

    const property = String(declaration.property ?? '').toLowerCase();
    if (/^(color|background|background-color|background-image|-webkit-text-fill-color)$/.test(property)
        && typeof declaration.value === 'string'
        && !/!important/i.test(declaration.value)) {
        declaration.value = `${declaration.value} !important`;
    }

    return declaration;
}

function sanitizeRisuCssRuleSet(ruleSet, mediaAllowed) {
    if (!ruleSet || typeof ruleSet !== 'object') {
        return;
    }

    if (Array.isArray(ruleSet.rules)) {
        ruleSet.rules = ruleSet.rules.filter(rule => mediaAllowed || rule.type !== 'import');
        for (const rule of ruleSet.rules) {
            sanitizeRisuCssRuleSet(rule, mediaAllowed);
        }
    }

    if (Array.isArray(ruleSet.selectors)) {
        ruleSet.selectors = ruleSet.selectors.map(scopeRisuSelector).filter(Boolean);
    }

    if (Array.isArray(ruleSet.declarations)) {
        if (!mediaAllowed) {
            ruleSet.declarations = ruleSet.declarations.filter(declaration => !String(declaration.value ?? '').includes('://'));
        }
        ruleSet.declarations = ruleSet.declarations.map(boostCardCssDeclaration);
    }
}

function sanitizeRisuCss(cssText) {
    try {
        const ast = css.parse(String(cssText ?? ''));
        sanitizeRisuCssRuleSet(ast?.stylesheet, isExternalMediaAllowed());
        return css.stringify(ast);
    } catch (error) {
        console.warn('RisuAI: Failed to parse background CSS:', error);
        return '';
    }
}

function sanitizeRisuBackgroundHtml(html) {
    const config = {
        RETURN_DOM: false,
        RETURN_DOM_FRAGMENT: false,
        RETURN_TRUSTED_TYPE: false,
        MESSAGE_SANITIZE: true,
        ADD_ATTR: RISU_SANITIZER_ATTRIBUTES,
    };

    return DOMPurify.sanitize(html, config);
}

function appendStyle(cssText, hasOverlay) {
    const style = document.createElement('style');
    style.id = RISU_BACKGROUND_STYLE_ID;
    style.textContent = [
        '#chat { position: relative; }',
        hasOverlay ? '#chat > .risu-background-html { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; }' : '',
        hasOverlay ? '#chat.risu-background-enabled > .mes { position: relative; z-index: 1; }' : '',
        cssText,
        [
            '#chat .custom-buttons-container { position: fixed !important; right: calc(var(--risu-chat-right-edge, 0px) + 20px) !important; z-index: 1001 !important; }',
            '#chat .custom-settings-panel { position: fixed !important; top: var(--risu-chat-top-edge, 0px) !important; right: calc(var(--risu-chat-right-edge, 0px) + 20px) !important; height: calc(100vh - var(--risu-chat-top-edge, 0px) - var(--risu-chat-bottom-edge, 0px)) !important; max-width: min(350px, calc(100vw - var(--risu-chat-left-edge, 0px) - var(--risu-chat-right-edge, 0px) - 40px)) !important; transform: translateX(calc(100% + 20px)) !important; z-index: 1000 !important; }',
            '#chat .custom-settings-panel.custom-opened { right: calc(var(--risu-chat-right-edge, 0px) + 20px) !important; transform: translateX(0) !important; }',
            '#chat .custom-sys-backdrop { position: fixed !important; inset: var(--risu-chat-top-edge, 0px) var(--risu-chat-right-edge, 0px) var(--risu-chat-bottom-edge, 0px) var(--risu-chat-left-edge, 0px) !important; z-index: 999 !important; }',
            '#chat.risu-fixed-ui-scroll-contained .custom-buttons-container { top: calc(var(--risu-chat-scroll-top, 0px) + var(--risu-fixed-control-top, 40px)) !important; right: var(--risu-chat-control-right-offset, 20px) !important; }',
            '#chat.risu-fixed-ui-scroll-contained .custom-settings-panel { top: var(--risu-chat-scroll-top, 0px) !important; right: var(--risu-chat-control-right-offset, 20px) !important; height: var(--risu-chat-visible-height, 100vh) !important; max-height: var(--risu-chat-visible-height, 100vh) !important; }',
            '#chat.risu-fixed-ui-scroll-contained .custom-settings-panel.custom-opened { right: var(--risu-chat-control-right-offset, 20px) !important; }',
            '#chat.risu-fixed-ui-scroll-contained .custom-sys-backdrop { top: var(--risu-chat-scroll-top, 0px) !important; right: auto !important; bottom: auto !important; left: 0 !important; width: var(--risu-chat-visible-width, 100%) !important; height: var(--risu-chat-visible-height, 100vh) !important; }',
        ].join('\n'),
    ].filter(Boolean).join('\n');
    document.head.appendChild(style);
}

function appendOverlay(chatElement, html) {
    if (!html.trim()) {
        return false;
    }

    const overlay = document.createElement('div');
    overlay.id = RISU_BACKGROUND_OVERLAY_ID;
    overlay.className = 'risu-background-html';
    overlay.innerHTML = sanitizeRisuBackgroundHtml(html);
    chatElement.prepend(overlay);
    chatElement.classList.add('risu-background-enabled');
    return true;
}

/**
 * Applies the selected RisuAI character's backgroundHTML to the chat surface.
 * CSS is scoped to #chat and class selectors are rewritten the same way as
 * sanitized message HTML, so display-script markup keeps matching its styles.
 * @param {object|null|undefined} character Active character
 * @param {object} [cbsContext] CBS evaluation context
 */
export function applyRisuBackgroundHtml(character, cbsContext = {}) {
    const raw = character?.data?.extensions?.risuai?.backgroundHTML;
    if (typeof raw !== 'string' || !raw.trim()) {
        removeRisuBackgroundHtml();
        return;
    }

    const chatElement = document.getElementById('chat');
    if (!chatElement) {
        return;
    }
    observeRisuChatViewportMetrics(chatElement);

    let resolved = evaluateRisuCbs(raw, cbsContext);
    resolved = renderRisuAssetMacros(resolved, character, { mode: 'background' });

    const { cssText, htmlText } = splitStyleBlocks(resolved);
    const rawCss = cssText || (looksLikeCss(htmlText) ? htmlText : '');
    const overlayHtml = rawCss === htmlText ? '' : htmlText;
    const signature = [
        character?.avatar || character?.name || '',
        isExternalMediaAllowed() ? 'media' : 'no-media',
        resolved,
    ].join('\n');
    const styleElement = document.getElementById(RISU_BACKGROUND_STYLE_ID);
    const overlayElement = document.getElementById(RISU_BACKGROUND_OVERLAY_ID);
    const overlayStillPresent = !overlayHtml.trim() || chatElement.contains(overlayElement);

    if (lastAppliedSignature === signature && styleElement && overlayStillPresent) {
        return;
    }

    removeRisuBackgroundHtml();
    observeRisuChatViewportMetrics(chatElement);

    const sanitizedCss = rawCss ? sanitizeRisuCss(rawCss) : '';
    const hasOverlay = appendOverlay(chatElement, overlayHtml);

    if (sanitizedCss || hasOverlay) {
        appendStyle(sanitizedCss, hasOverlay);
    }

    lastAppliedSignature = signature;
}
