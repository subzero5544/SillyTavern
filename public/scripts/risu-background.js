import { DOMPurify } from '../lib.js';
import { decodeStyleTags, encodeStyleTags } from './chats.js';
import { renderRisuAssetMacros } from './risu-assets.js';
import { evaluateRisuCbs } from './risu-cbs.js';

const RISU_BACKGROUND_STYLE_ID = 'risu_background_html_style';
const RISU_BACKGROUND_OVERLAY_ID = 'risu_background_html_overlay';

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

function sanitizeRisuCss(cssText) {
    const encoded = `<custom-style>${encodeURIComponent(cssText)}</custom-style>`;
    const decoded = decodeStyleTags(encoded, { prefix: '#chat ' });
    const match = decoded.match(/<style>([\s\S]*?)<\/style>/i);
    return match ? match[1] : '';
}

function sanitizeRisuBackgroundHtml(html) {
    const config = {
        RETURN_DOM: false,
        RETURN_DOM_FRAGMENT: false,
        RETURN_TRUSTED_TYPE: false,
        MESSAGE_SANITIZE: true,
        ADD_TAGS: ['custom-style'],
        ADD_ATTR: RISU_SANITIZER_ATTRIBUTES,
    };

    const sanitized = DOMPurify.sanitize(encodeStyleTags(html), config);
    return decodeStyleTags(sanitized, { prefix: '#chat ' });
}

function appendStyle(cssText, hasOverlay) {
    const style = document.createElement('style');
    style.id = RISU_BACKGROUND_STYLE_ID;
    style.textContent = [
        hasOverlay ? '#chat.risu-background-enabled { position: relative; }' : '',
        hasOverlay ? '#chat > .risu-background-html { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; }' : '',
        hasOverlay ? '#chat.risu-background-enabled > .mes { position: relative; z-index: 1; }' : '',
        cssText,
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
 * CSS is scoped to #chat and class names pass through the same sanitizer
 * prefixing as message HTML, so card display-script markup stays stylable.
 * @param {object|null|undefined} character Active character
 * @param {object} [cbsContext] CBS evaluation context
 */
export function applyRisuBackgroundHtml(character, cbsContext = {}) {
    removeRisuBackgroundHtml();

    const raw = character?.data?.extensions?.risuai?.backgroundHTML;
    if (typeof raw !== 'string' || !raw.trim()) {
        return;
    }

    const chatElement = document.getElementById('chat');
    if (!chatElement) {
        return;
    }

    let resolved = evaluateRisuCbs(raw, cbsContext);
    resolved = renderRisuAssetMacros(resolved, character, { mode: 'background' });

    const { cssText, htmlText } = splitStyleBlocks(resolved);
    const rawCss = cssText || (looksLikeCss(htmlText) ? htmlText : '');
    const overlayHtml = rawCss === htmlText ? '' : htmlText;
    const sanitizedCss = rawCss ? sanitizeRisuCss(rawCss) : '';
    const hasOverlay = appendOverlay(chatElement, overlayHtml);

    if (sanitizedCss || hasOverlay) {
        appendStyle(sanitizedCss, hasOverlay);
    }
}
