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

function updateRisuChatViewportMetrics(chatElement = document.getElementById('chat')) {
    if (!chatElement) {
        return;
    }

    const rect = chatElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || rect.right;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || rect.bottom;
    const rightEdge = getVisibleChatRightEdge(rect, viewportWidth);

    chatElement.style.setProperty('--risu-chat-left-edge', `${Math.max(0, rect.left)}px`);
    chatElement.style.setProperty('--risu-chat-right-edge', `${Math.max(0, viewportWidth - rightEdge)}px`);
    chatElement.style.setProperty('--risu-chat-top-edge', `${Math.max(0, rect.top)}px`);
    chatElement.style.setProperty('--risu-chat-bottom-edge', `${Math.max(0, viewportHeight - rect.bottom)}px`);
}

function clearRisuChatViewportMetrics() {
    const chatElement = document.getElementById('chat');
    chatElement?.style.removeProperty('--risu-chat-left-edge');
    chatElement?.style.removeProperty('--risu-chat-right-edge');
    chatElement?.style.removeProperty('--risu-chat-top-edge');
    chatElement?.style.removeProperty('--risu-chat-bottom-edge');

    if (viewportMetricsResizeHandler) {
        window.removeEventListener('resize', viewportMetricsResizeHandler);
        viewportMetricsResizeHandler = null;
    }
    viewportMetricsObserver?.disconnect();
    viewportMetricsObserver = null;
    viewportMetricsMutationObserver?.disconnect();
    viewportMetricsMutationObserver = null;
}

function observeRisuChatViewportMetrics(chatElement) {
    updateRisuChatViewportMetrics(chatElement);

    if (!viewportMetricsResizeHandler) {
        viewportMetricsResizeHandler = () => updateRisuChatViewportMetrics();
        window.addEventListener('resize', viewportMetricsResizeHandler);
    }

    viewportMetricsObserver?.disconnect();
    if (typeof ResizeObserver === 'function') {
        viewportMetricsObserver = new ResizeObserver(() => updateRisuChatViewportMetrics());
        viewportMetricsObserver.observe(chatElement);
        const shellElement = document.getElementById('sheld');
        const rightPanel = document.getElementById('right-nav-panel');
        if (shellElement && shellElement !== chatElement) {
            viewportMetricsObserver.observe(shellElement);
        }
        if (rightPanel) {
            viewportMetricsObserver.observe(rightPanel);
        }
    }

    viewportMetricsMutationObserver?.disconnect();
    if (typeof MutationObserver === 'function') {
        viewportMetricsMutationObserver = new MutationObserver(() => requestAnimationFrame(() => updateRisuChatViewportMetrics()));
        const shellElement = document.getElementById('sheld');
        const rightPanel = document.getElementById('right-nav-panel');
        for (const element of [chatElement, shellElement, rightPanel]) {
            if (element) {
                viewportMetricsMutationObserver.observe(element, { attributes: true, attributeFilter: ['class', 'style'] });
            }
        }
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
