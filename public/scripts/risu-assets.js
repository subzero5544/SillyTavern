/**
 * Native rendering of RisuAI asset macros in chat messages.
 *
 * RisuAI cards inline media via CBS macros like {{img::name}} or {{asset::name}}.
 * In RisuAI these are resolved at display time only - the raw macro text is what
 * the model sees. This module mirrors that behavior: the server stores a
 * name → URL map at import (data.extensions.risuai.assetMap), and this renders
 * the macros to HTML when a message is displayed.
 *
 * Markup mirrors RisuAI's parseAdditionalAssets (src/ts/parser/parser.svelte.ts),
 * including the 'risu-inlay-image' class that card CSS targets.
 */

const RISU_ASSET_MACRO_REGEX = /{{(raw|path|img|image|video|audio|bgm|bg|emotion|asset|video-img|inlay|inlayed|inlayeddata)::(.+?)}}/gims;
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'avi', 'm4p', 'm4v'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'];
const MEDIA_EXT_REGEX = /\.(png|jpg|jpeg|webp|gif|apng|avif|bmp|jfif|mp4|webm|avi|m4p|m4v|mov|mkv|mp3|wav|ogg|flac|m4a|aac|opus)$/i;
const DIRECT_MEDIA_DATA_URL_REGEX = /^data:(image|video|audio)\//i;
const DIRECT_MEDIA_RELATIVE_REGEX = /^(user|characters|backgrounds|img|images|thumbnails|thumbnail)\//i;

/** @type {WeakMap<object, {assets: Map<string, string>, emotions: Map<string, string>}>} */
const lookupCache = new WeakMap();

/**
 * Gets the RisuAI asset map of a character, if it has one.
 * @param {object} character Character object
 * @returns {{assets: Record<string, string>, emotions: Record<string, string>}|null}
 */
export function getRisuAssetMap(character) {
    const assetMap = character?.data?.extensions?.risuai?.assetMap;
    if (!assetMap || (typeof assetMap !== 'object')) {
        return null;
    }
    return assetMap;
}

/**
 * Gets the original asset names of a character (for the {{assetlist}} macro).
 * @param {object} character Character object
 * @returns {string[]}
 */
export function getRisuAssetNames(character) {
    const assetMap = getRisuAssetMap(character);
    return assetMap?.assets && typeof assetMap.assets === 'object' ? Object.keys(assetMap.assets) : [];
}

/**
 * Normalized forms of an asset name, most to least specific.
 * RisuAI lookups are lowercased and fall back to closest-match; card scripts
 * often reference assets with separators or extensions that differ from the
 * stored name (e.g. 'Marin_Preppy_shocked' vs 'marin_preppy_shocked.png').
 * @param {string} name Asset name
 * @returns {string[]}
 */
function getNameForms(name) {
    const lower = String(name).trim().toLowerCase();
    const noExt = lower.replace(MEDIA_EXT_REGEX, '');
    const squashed = noExt.replace(/[^a-z0-9]/g, '');
    return [...new Set([lower, noExt, squashed])].filter(Boolean);
}

/**
 * Builds (and caches) a normalized lookup index for an asset map.
 * @param {object} assetMap data.extensions.risuai.assetMap
 * @returns {{assets: Map<string, string>, emotions: Map<string, string>}}
 */
function getLookupIndex(assetMap) {
    const cached = lookupCache.get(assetMap);
    if (cached) {
        return cached;
    }

    const buildIndex = (source) => {
        const index = new Map();
        if (source && typeof source === 'object') {
            for (const [name, url] of Object.entries(source)) {
                if (typeof url !== 'string' || !url) continue;
                for (const form of getNameForms(name)) {
                    if (!index.has(form)) {
                        index.set(form, url);
                    }
                }
            }
        }
        return index;
    };

    const index = { assets: buildIndex(assetMap.assets), emotions: buildIndex(assetMap.emotions) };
    lookupCache.set(assetMap, index);
    return index;
}

/**
 * Resolves an asset name to a URL.
 * @param {object} assetMap data.extensions.risuai.assetMap
 * @param {string} name Requested asset name
 * @param {boolean} isEmotion Whether the request is an {{emotion::}} lookup
 * @returns {string|null}
 */
function resolveAssetUrl(assetMap, name, isEmotion) {
    const index = getLookupIndex(assetMap);
    const primary = isEmotion ? index.emotions : index.assets;
    const secondary = isEmotion ? index.assets : index.emotions;

    for (const form of getNameForms(name)) {
        const url = primary.get(form) ?? secondary.get(form);
        if (url) {
            return url;
        }
    }
    return null;
}

function escapeAttribute(value) {
    return String(value).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Resolves generated-image macros such as {{inlay::/user/images/foo.png}}.
 * Imported asset names still go through assetMap lookup; this only accepts
 * already materialized browser-safe media URLs.
 * @param {string} name Requested asset name or direct media URL
 * @returns {string|null}
 */
function resolveDirectAssetUrl(name) {
    const value = String(name || '').trim().replace(/\\/g, '/');
    if (!value || /[\u0000<>"]/.test(value)) {
        return null;
    }

    if (/^https?:\/\//i.test(value) || /^blob:/i.test(value) || DIRECT_MEDIA_DATA_URL_REGEX.test(value)) {
        return value;
    }

    if (value.startsWith('/') && !value.startsWith('//')) {
        return value;
    }

    if (DIRECT_MEDIA_RELATIVE_REGEX.test(value)) {
        return `/${value}`;
    }

    return null;
}

function normalizeAssetSrc(url, isAssetMapUrl) {
    const value = String(url || '').replace(/\\/g, '/');
    const source = isAssetMapUrl ? `/${value.replace(/^\/+/, '')}` : value;
    return escapeAttribute(encodeURI(source));
}

function getAssetExtension(url) {
    const withoutQuery = String(url || '').split(/[?#]/)[0];
    return withoutQuery.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Renders media for RisuAI {{inlay::*}} macros.
 * @param {string} src Client URL
 * @param {string} ext Lowercase asset extension
 * @param {string} altText Escaped alt text for images
 * @returns {string}
 */
function renderInlayMedia(src, ext, altText) {
    if (VIDEO_EXTENSIONS.includes(ext)) {
        return `<video class="risu_inline_asset" controls><source src="${src}"></video>`;
    }
    if (AUDIO_EXTENSIONS.includes(ext)) {
        return `<audio controls><source src="${src}"></audio>`;
    }
    return `<img class="risu_inline_asset" src="${src}" alt="${altText}">`;
}

/**
 * Renders RisuAI asset macros in a message to HTML.
 * Unresolvable asset names render as an empty string, matching RisuAI.
 * No-op for characters without imported RisuAI assets.
 * @param {string} text Message text
 * @param {object} character Character object the message belongs to
 * @param {{ mode?: 'normal' | 'background' }} [options] Rendering options
 * @returns {string} Text with asset macros replaced
 */
export function renderRisuAssetMacros(text, character, options = {}) {
    if (!text || typeof text !== 'string' || !text.includes('{{')) {
        return text;
    }

    const assetMap = getRisuAssetMap(character);

    return text.replace(RISU_ASSET_MACRO_REGEX, (_match, type, name) => {
        type = type.toLowerCase();
        name = String(name).trim();

        const mappedUrl = assetMap ? resolveAssetUrl(assetMap, name, type === 'emotion') : null;
        const directUrl = resolveDirectAssetUrl(name);
        const url = mappedUrl ?? directUrl;

        if (!url) {
            return assetMap ? '' : _match;
        }

        const src = normalizeAssetSrc(url, Boolean(mappedUrl));
        const ext = getAssetExtension(url);
        const altText = escapeAttribute(name.toLowerCase());

        switch (type) {
            case 'raw':
            case 'path':
                return src;
            case 'img':
            case 'emotion':
                return `<img class="risu_inline_asset" src="${src}" alt="${altText}">`;
            case 'inlay':
                return renderInlayMedia(src, ext, altText);
            case 'inlayed':
            case 'inlayeddata':
                return `<div class="risu-inlay-image">${renderInlayMedia(src, ext, altText)}</div>\n\n`;
            case 'image':
                return `<div class="risu-inlay-image"><img class="risu_inline_asset" src="${src}" alt="${altText}"></div>\n`;
            case 'video':
                return `<video class="risu_inline_asset" controls loop><source src="${src}"></video>\n`;
            case 'video-img':
                return `<video class="risu_inline_asset" autoplay muted loop><source src="${src}"></video>\n`;
            case 'audio':
                return `<audio controls loop><source src="${src}"></audio>\n`;
            case 'asset': {
                if (VIDEO_EXTENSIONS.includes(ext)) {
                    return `<video class="risu_inline_asset" autoplay muted loop><source src="${src}"></video>\n`;
                }
                return `<img class="risu_inline_asset" src="${src}" alt="${altText}">\n`;
            }
            case 'bg':
                if (options.mode === 'background') {
                    return `<div class="risu-background-image" style="width:100%;height:100%;background: linear-gradient(rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0.8)), url(${src}); background-size: cover; background-position: center;"></div>`;
                }
                return '';
            case 'bgm':
                if (options.mode === 'background') {
                    return `<div risu-ctrl="bgm___auto___${src}" style="display:none;"></div>\n`;
                }
                // Chat backgrounds/BGM are not rendered inline in messages (same as RisuAI's normal display mode)
                return '';
            default:
                return '';
        }
    });
}
