import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import mime from 'mime-types';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { extractFileFromZipBuffer, extractFilesFromZipBuffer, normalizeZipEntryPath, ensureDirectory, clientRelativePath } from './util.js';
import { DEFAULT_AVATAR_PATH } from './constants.js';
import { readRisuModule } from './risu/risum.js';
import { convertRisuModuleLorebookToCharacterBook } from './risu/lorebook.js';

// 'embeded://' is intentional - RisuAI exports use this misspelling
const CHARX_EMBEDDED_URI_PREFIXES = ['embeded://', 'embedded://', '__asset:'];
const CHARX_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng', 'avif', 'bmp', 'jfif']);
// Audio/video are persisted as misc assets so RisuAI {{audio::}}/{{video::}} macros can resolve
const CHARX_MEDIA_EXTENSIONS = new Set([...CHARX_IMAGE_EXTENSIONS, 'mp4', 'webm', 'avi', 'm4p', 'm4v', 'mov', 'mkv', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus']);
const CHARX_SPRITE_TYPES = new Set(['emotion', 'expression']);
const CHARX_BACKGROUND_TYPES = new Set(['background']);
const CHARX_UNKNOWN_EXTENSIONS = new Set(['unknown', 'bin']);
const MAX_DATA_URI_ASSET_SIZE = 50 * 1024 * 1024;

// ZIP local file header signature: PK\x03\x04
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4B, 0x03, 0x04]);

/**
 * @typedef {Object} CharXAsset
 * @property {string} type - Asset type (emotion, expression, background, etc.)
 * @property {string} name - Asset name from metadata
 * @property {string} ext - File extension (lowercase, no dot)
 * @property {string} zipPath - Lookup key in the extracted buffer map
 * @property {number} order - Original index in assets array
 * @property {string} [storageCategory] - 'sprite' | 'background' | 'misc' (set by mapCharXAssetsForStorage)
 * @property {string} [baseName] - Normalized filename base (set by mapCharXAssetsForStorage)
 */

/**
 * @typedef {Object} CharXParseResult
 * @property {Object} card - Parsed card.json (CCv2 or CCv3 spec)
 * @property {string|Buffer} avatar - Avatar image buffer or DEFAULT_AVATAR_PATH
 * @property {CharXAsset[]} auxiliaryAssets - Assets mapped for storage
 * @property {Map<string, Buffer>} extractedBuffers - Map of zipPath to extracted buffer, including embedded RisuAI VITS files
 */

export class CharXParser {
    #data;
    #prefix;

    /**
     * @param {ArrayBuffer|Buffer} data
     */
    constructor(data) {
        // Handle SFX archives and RisuAI's "charx jpeg" format (a JPEG image with
        // the ZIP appended) by finding the actual ZIP start. The prefix bytes are
        // kept: for charx jpegs they are the cover image.
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const zipIndex = buffer.indexOf(ZIP_SIGNATURE);
        this.#data = zipIndex > 0 ? buffer.subarray(zipIndex) : buffer;
        this.#prefix = zipIndex > 0 ? buffer.subarray(0, zipIndex) : null;
    }

    /**
     * Returns the JPEG cover image for RisuAI "charx jpeg" files, if present.
     * @returns {Buffer|null}
     */
    getJpegCoverImage() {
        // JPEG SOI marker
        if (this.#prefix && this.#prefix.length > 3 && this.#prefix[0] === 0xFF && this.#prefix[1] === 0xD8 && this.#prefix[2] === 0xFF) {
            return this.#prefix;
        }
        return null;
    }

    /**
     * Parse the CharX archive and extract card data and assets.
     * @returns {Promise<CharXParseResult>}
     */
    async parse() {
        console.info('Importing from CharX');
        const cardBuffer = await extractFileFromZipBuffer(this.#data, 'card.json');

        if (!cardBuffer) {
            throw new Error('Failed to extract card.json from CharX file');
        }

        const card = JSON.parse(cardBuffer.toString());

        if (card.spec === undefined) {
            throw new Error('Invalid CharX card file: missing spec field');
        }

        await this.mergeRisuModule(card);

        const embeddedAssets = collectCharXAssets(card);
        const dataUriAssets = collectCharXDataUriAssets(card);
        const risuVitsAssetPaths = collectRisuVitsAssetPaths(card);
        const allAssets = [...embeddedAssets, ...dataUriAssets.assets];
        const iconAsset = pickCharXIconAsset(allAssets);
        const auxiliaryAssets = mapCharXAssetsForStorage(allAssets);

        const archivePaths = new Set();

        if (iconAsset?.zipPath && !dataUriAssets.buffers.has(iconAsset.zipPath)) {
            archivePaths.add(iconAsset.zipPath);
        }
        for (const asset of auxiliaryAssets) {
            if (asset?.zipPath && !dataUriAssets.buffers.has(asset.zipPath)) {
                archivePaths.add(asset.zipPath);
            }
        }
        for (const zipPath of risuVitsAssetPaths) {
            if (!dataUriAssets.buffers.has(zipPath)) {
                archivePaths.add(zipPath);
            }
        }

        let extractedBuffers = new Map(dataUriAssets.buffers);
        if (archivePaths.size > 0) {
            const archiveBuffers = await extractFilesFromZipBuffer(this.#data, [...archivePaths]);
            for (const [key, buffer] of archiveBuffers) {
                extractedBuffers.set(key, buffer);
            }
        }

        /** @type {string|Buffer} */
        let avatar = DEFAULT_AVATAR_PATH;
        if (iconAsset?.zipPath) {
            const iconBuffer = extractedBuffers.get(iconAsset.zipPath);
            if (iconBuffer) {
                avatar = iconBuffer;
            }
        }

        // Fall back to the JPEG cover image for RisuAI "charx jpeg" files
        if (avatar === DEFAULT_AVATAR_PATH) {
            const coverImage = this.getJpegCoverImage();
            if (coverImage) {
                avatar = coverImage;
            }
        }

        return { card, avatar, auxiliaryAssets, extractedBuffers };
    }

    /**
     * Merges scripts from an embedded module.risum back into the card data.
     * RisuAI's CharX export relocates triggerscript and customScripts from
     * card.json into module.risum; without this merge they would be lost.
     * Mirrors RisuAI's own import behavior. No-op if the archive has no module.
     * @param {object} card Parsed card.json data (mutated in place)
     * @returns {Promise<void>}
     */
    async mergeRisuModule(card) {
        try {
            const moduleBuffer = await extractFileFromZipBuffer(this.#data, 'module.risum');
            if (!moduleBuffer) {
                return;
            }

            const { module } = readRisuModule(moduleBuffer);

            if (!card.data || typeof card.data !== 'object') {
                return;
            }

            card.data.extensions = card.data.extensions ?? {};
            card.data.extensions.risuai = card.data.extensions.risuai ?? {};

            if (Array.isArray(module.trigger) && module.trigger.length > 0) {
                card.data.extensions.risuai.triggerscript = module.trigger;
            }
            if (Array.isArray(module.regex) && module.regex.length > 0) {
                card.data.extensions.risuai.customScripts = module.regex;
            }
            // RisuAI imports module.risum lorebook as an override for card.json's
            // character_book entries, while preserving book-level settings.
            if (Array.isArray(module.lorebook) && module.lorebook.length > 0) {
                card.data.character_book = convertRisuModuleLorebookToCharacterBook(module.lorebook, card.data.character_book);
            }
            if (typeof module.backgroundEmbedding === 'string' && module.backgroundEmbedding.trim()) {
                const existingBackground = typeof card.data.extensions.risuai.backgroundHTML === 'string'
                    ? card.data.extensions.risuai.backgroundHTML
                    : '';
                card.data.extensions.risuai.backgroundHTML = [existingBackground, module.backgroundEmbedding].filter(Boolean).join('\n');
            }

            console.info(`CharX: Merged module.risum (${module.trigger?.length ?? 0} trigger script(s), ${module.regex?.length ?? 0} regex script(s))`);
        } catch (error) {
            console.warn(`CharX: Failed to parse module.risum: ${error.message}`);
        }
    }
}

/**
 * Resolve an embedded asset URI ('embeded://', 'embedded://', '__asset:') to a lookup key.
 * For CharX zips the key is the archive path; for RisuAI PNGs ('__asset:N') it is the chunk index.
 * @param {string} uri Asset URI from card data
 * @returns {string|null} Normalized lookup key, or null if not an embedded URI
 */
export function getEmbeddedZipPathFromUri(uri) {
    if (typeof uri !== 'string') {
        return null;
    }

    const trimmed = uri.trim();
    if (!trimmed) {
        return null;
    }

    const lower = trimmed.toLowerCase();
    for (const prefix of CHARX_EMBEDDED_URI_PREFIXES) {
        if (lower.startsWith(prefix)) {
            const rawPath = trimmed.slice(prefix.length);
            return normalizeZipEntryPath(rawPath);
        }
    }

    return null;
}

/**
 * Normalize extension string: lowercase, strip leading dot.
 * @param {string} ext
 * @returns {string}
 */
function normalizeExtString(ext) {
    if (typeof ext !== 'string') return '';
    const normalized = ext.trim().toLowerCase().replace(/^\./, '');
    return CHARX_UNKNOWN_EXTENSIONS.has(normalized) ? '' : normalized;
}

function parseDataUri(uri) {
    if (typeof uri !== 'string' || !uri.trim().toLowerCase().startsWith('data:')) {
        return null;
    }

    const commaIndex = uri.indexOf(',');
    if (commaIndex === -1) {
        return null;
    }

    const meta = uri.slice(5, commaIndex);
    const payload = uri.slice(commaIndex + 1);
    const isBase64 = meta.toLowerCase().split(';').includes('base64');

    try {
        const buffer = isBase64
            ? Buffer.from(payload.replace(/\s/g, ''), 'base64')
            : Buffer.from(decodeURIComponent(payload), 'utf8');

        if (buffer.length === 0 || buffer.length > MAX_DATA_URI_ASSET_SIZE) {
            return null;
        }

        return {
            buffer,
            mimeType: meta.split(';')[0].trim().toLowerCase(),
        };
    } catch {
        return null;
    }
}

function deriveDataUriAssetExtension(assetExt, mimeType, buffer) {
    const metaExt = normalizeExtString(assetExt);
    const mimeExt = normalizeExtString(mime.extension(mimeType) || '');
    const inferredExt = inferCharXAssetExtension(buffer);
    return metaExt || mimeExt || inferredExt || 'bin';
}

/**
 * Strip trailing image extension from asset name if present.
 * Handles cases like "image.png" with ext "png" -> "image" (avoids "image.png.png")
 * @param {string} name - Asset name that may contain extension
 * @param {string} expectedExt - The expected extension (lowercase, no dot)
 * @returns {string} Name with trailing extension stripped if it matched
 */
function stripTrailingImageExtension(name, expectedExt) {
    if (!name || !expectedExt) return name;
    const lower = name.toLowerCase();
    // Check if name ends with the expected extension
    if (lower.endsWith(`.${expectedExt}`)) {
        return name.slice(0, -(expectedExt.length + 1));
    }
    // Also check for any known image extension at the end
    for (const ext of CHARX_IMAGE_EXTENSIONS) {
        if (lower.endsWith(`.${ext}`)) {
            return name.slice(0, -(ext.length + 1));
        }
    }
    return name;
}

function deriveCharXAssetExtension(assetExt, zipPath) {
    const metaExt = normalizeExtString(assetExt);
    const pathExt = normalizeExtString(path.extname(zipPath || ''));
    return metaExt || pathExt;
}

function inferCharXAssetExtension(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
        return '';
    }

    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png';
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg';
    if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'gif';
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
    if (buffer.subarray(0, 2).toString('ascii') === 'BM') return 'bmp';
    if (buffer.subarray(4, 12).toString('ascii').startsWith('ftypavif')) return 'avif';
    if (buffer.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
    if (buffer.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav';
    if (buffer.subarray(0, 3).toString('ascii') === 'ID3' || (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0)) return 'mp3';
    if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
    if (buffer.subarray(0, 4).equals(Buffer.from([0x1A, 0x45, 0xDF, 0xA3]))) return 'webm';

    return '';
}

function getCharXAssetStorageExtension(asset, bufferMap) {
    const ext = normalizeExtString(asset.ext);
    if (ext) {
        return ext;
    }

    return inferCharXAssetExtension(bufferMap?.get(asset.zipPath));
}

/**
 * Collect embedded assets referenced by a card's data.assets array.
 * Works for CharX zips ('embeded://...') and RisuAI PNG cards ('__asset:N').
 * @param {object} card Card data (CCv2/CCv3)
 * @returns {CharXAsset[]}
 */
export function collectCharXAssets(card) {
    const assets = _.get(card, 'data.assets');
    if (!Array.isArray(assets)) {
        return [];
    }

    return assets.map((asset, index) => {
        if (!asset) {
            return null;
        }

        const zipPath = getEmbeddedZipPathFromUri(asset.uri);
        if (!zipPath) {
            return null;
        }

        const ext = deriveCharXAssetExtension(asset.ext, zipPath);
        const type = typeof asset.type === 'string' ? asset.type.toLowerCase() : '';
        const name = typeof asset.name === 'string' ? asset.name : '';

        return {
            type,
            name,
            ext,
            zipPath,
            order: index,
        };
    }).filter(Boolean);
}

/**
 * Collect embedded RisuAI VITS file paths referenced outside data.assets.
 * @param {object} card Character card object
 * @returns {string[]} ZIP/member keys to extract
 */
export function collectRisuVitsAssetPaths(card) {
    const vits = _.get(card, 'data.extensions.risuai.vits');
    if (!vits || typeof vits !== 'object' || Array.isArray(vits)) {
        return [];
    }

    const paths = [];
    for (const value of Object.values(vits)) {
        const zipPath = getEmbeddedZipPathFromUri(value);
        if (zipPath) {
            paths.push(zipPath);
        }
    }

    return [...new Set(paths)];
}

/**
 * Collect data URI assets from a card's data.assets array.
 * RisuAI accepts data: URIs in CharacterCardV3 assets; decode them into the
 * same buffer map shape used for extracted ZIP/PNG assets.
 * @param {object} card Card data (CCv2/CCv3)
 * @returns {{assets: CharXAsset[], buffers: Map<string, Buffer>}}
 */
export function collectCharXDataUriAssets(card) {
    const cardAssets = _.get(card, 'data.assets');
    /** @type {CharXAsset[]} */
    const assets = [];
    /** @type {Map<string, Buffer>} */
    const buffers = new Map();

    if (!Array.isArray(cardAssets)) {
        return { assets, buffers };
    }

    cardAssets.forEach((asset, index) => {
        if (!asset) {
            return;
        }

        const parsed = parseDataUri(asset.uri);
        if (!parsed) {
            return;
        }

        const key = `data-uri-asset/${index}`;
        const type = typeof asset.type === 'string' ? asset.type.toLowerCase() : '';
        const name = typeof asset.name === 'string' ? asset.name : '';
        const ext = deriveDataUriAssetExtension(asset.ext, parsed.mimeType, parsed.buffer);

        assets.push({ type, name, ext, zipPath: key, order: index });
        buffers.set(key, parsed.buffer);
    });

    return { assets, buffers };
}

/**
 * Pick the asset to use as the character avatar.
 * @param {CharXAsset[]} assets
 * @returns {CharXAsset|null}
 */
export function pickCharXIconAsset(assets) {
    const iconAssets = assets.filter(asset => asset.type === 'icon' && CHARX_IMAGE_EXTENSIONS.has(asset.ext) && asset.zipPath);
    if (iconAssets.length === 0) {
        return null;
    }

    const mainIcon = iconAssets.find(asset => asset.name?.toLowerCase() === 'main');
    return mainIcon || iconAssets[0];
}

/**
 * Normalize asset name for filesystem storage.
 * @param {string} name - Original asset name
 * @param {string} fallback - Fallback name if normalization fails
 * @param {boolean} useHyphens - Use hyphens instead of underscores (for sprites)
 * @returns {string} Normalized filename base (without extension)
 */
export function getCharXAssetBaseName(name, fallback, useHyphens = false) {
    const cleaned = (String(name ?? '').trim() || '');
    if (!cleaned) {
        return fallback.toLowerCase();
    }

    const separator = useHyphens ? '-' : '_';
    // Convert to lowercase, collapse non-alphanumeric runs to separator, trim edges
    const base = cleaned
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, separator)
        .replace(new RegExp(`^${separator}|${separator}$`, 'g'), '');

    if (!base) {
        return fallback.toLowerCase();
    }

    const sanitized = sanitize(base);
    return (sanitized || fallback).toLowerCase();
}

/**
 * Classify assets for storage and assign filesystem-safe base names.
 * @param {CharXAsset[]} assets
 * @param {Map<string, Buffer>} [bufferMap] Optional extracted buffers for assets without reliable extension metadata
 * @returns {CharXAsset[]}
 */
export function mapCharXAssetsForStorage(assets, bufferMap = null) {
    return assets.reduce((acc, asset) => {
        if (!asset?.zipPath) {
            return acc;
        }

        if (asset.type === 'icon' || asset.type === 'user_icon') {
            return acc;
        }

        let storageCategory;
        if (CHARX_SPRITE_TYPES.has(asset.type)) {
            storageCategory = 'sprite';
        } else if (CHARX_BACKGROUND_TYPES.has(asset.type)) {
            storageCategory = 'background';
        } else {
            storageCategory = 'misc';
        }

        // Sprites and backgrounds must be images; misc assets may also be audio/video
        const ext = getCharXAssetStorageExtension(asset, bufferMap);
        const allowedExtensions = storageCategory === 'misc' ? CHARX_MEDIA_EXTENSIONS : CHARX_IMAGE_EXTENSIONS;
        if (!allowedExtensions.has(ext)) {
            return acc;
        }

        // Use hyphens for sprites so ST's expression label extraction works correctly
        // (sprites.js extracts label via regex that splits on dash or dot)
        const useHyphens = storageCategory === 'sprite';
        // Strip trailing extension from name if present (e.g., "image.png" with ext "png")
        const nameWithoutExt = stripTrailingImageExtension(asset.name, ext);
        acc.push({
            ...asset,
            ext,
            storageCategory,
            baseName: getCharXAssetBaseName(nameWithoutExt, `${storageCategory}-${asset.order ?? 0}`, useHyphens),
        });

        return acc;
    }, []);
}

/**
 * Delete existing file with same base name (any extension) before overwriting.
 * Matches ST's sprite upload behavior in sprites.js.
 * @param {string} dirPath - Directory path
 * @param {string} baseName - Base filename without extension
 */
function deleteExistingByBaseName(dirPath, baseName) {
    try {
        const files = fs.readdirSync(dirPath, { withFileTypes: true }).filter(f => f.isFile()).map(f => f.name);
        for (const file of files) {
            if (path.parse(file).name === baseName) {
                fs.unlinkSync(path.join(dirPath, file));
            }
        }
    } catch {
        // Directory doesn't exist yet or other error, that's fine
    }
}

/**
 * @typedef {Object} PersistedCharXAsset
 * @property {string} name - Original asset name from card data
 * @property {string} category - 'sprite' | 'background' | 'misc'
 * @property {string} url - Client-relative URL of the saved file
 * @property {number} [order] - Original index in data.assets
 * @property {string} [zipPath] - Lookup key used to extract the asset buffer
 */

/**
 * Persist extracted CharX assets to appropriate ST directories.
 * Note: Uses sync writes consistent with ST's existing file handling.
 * @param {Array} assets - Mapped assets from CharXParser
 * @param {Map<string, Buffer>} bufferMap - Extracted file buffers
 * @param {Object} directories - User directories object
 * @param {string} characterFolder - Character folder name (sanitized)
 * @returns {{sprites: number, backgrounds: number, misc: number, files: PersistedCharXAsset[]}}
 */
export function persistCharXAssets(assets, bufferMap, directories, characterFolder) {
    /** @type {{sprites: number, backgrounds: number, misc: number, files: PersistedCharXAsset[]}} */
    const summary = { sprites: 0, backgrounds: 0, misc: 0, files: [] };
    if (!Array.isArray(assets) || assets.length === 0) {
        return summary;
    }

    const recordFile = (asset, category, filePath) => {
        try {
            summary.files.push({
                name: String(asset.name || asset.baseName || ''),
                category,
                url: clientRelativePath(directories.root, filePath),
                order: asset.order,
                zipPath: asset.zipPath,
            });
        } catch (error) {
            console.warn(`CharX: Could not record asset URL for "${asset.name}": ${error.message}`);
        }
    };

    let spritesPath = null;
    let miscPath = null;

    const ensureSpritesPath = () => {
        if (spritesPath) {
            return spritesPath;
        }
        const candidate = path.join(directories.characters, characterFolder);
        if (!ensureDirectory(candidate)) {
            return null;
        }
        spritesPath = candidate;
        return spritesPath;
    };

    const ensureMiscPath = () => {
        if (miscPath) {
            return miscPath;
        }
        // Use the image gallery path: user/images/{characterName}/
        const candidate = path.join(directories.userImages, characterFolder);
        if (!ensureDirectory(candidate)) {
            return null;
        }
        miscPath = candidate;
        return miscPath;
    };

    for (const asset of assets) {
        if (!asset?.zipPath) {
            continue;
        }
        const buffer = bufferMap.get(asset.zipPath);
        if (!buffer) {
            console.warn(`CharX: Asset ${asset.zipPath} missing or unsupported, skipping.`);
            continue;
        }

        try {
            if (asset.storageCategory === 'sprite') {
                const targetDir = ensureSpritesPath();
                if (!targetDir) {
                    continue;
                }
                // Delete existing sprite with same base name (any extension) - matches sprites.js behavior
                deleteExistingByBaseName(targetDir, asset.baseName);
                const filePath = path.join(targetDir, `${asset.baseName}.${asset.ext || 'png'}`);
                writeFileAtomicSync(filePath, buffer);
                summary.sprites += 1;
                recordFile(asset, 'sprite', filePath);
                continue;
            }

            if (asset.storageCategory === 'background') {
                // Store in character-specific backgrounds folder: characters/{charName}/backgrounds/
                const backgroundDir = path.join(directories.characters, characterFolder, 'backgrounds');
                if (!ensureDirectory(backgroundDir)) {
                    continue;
                }
                // Delete existing background with same base name
                deleteExistingByBaseName(backgroundDir, asset.baseName);
                const fileName = `${asset.baseName}.${asset.ext || 'png'}`;
                const filePath = path.join(backgroundDir, fileName);
                writeFileAtomicSync(filePath, buffer);
                summary.backgrounds += 1;
                recordFile(asset, 'background', filePath);
                continue;
            }

            if (asset.storageCategory === 'misc') {
                const miscDir = ensureMiscPath();
                if (!miscDir) {
                    continue;
                }
                // Overwrite existing misc asset with same name
                const filePath = path.join(miscDir, `${asset.baseName}.${asset.ext || 'png'}`);
                writeFileAtomicSync(filePath, buffer);
                summary.misc += 1;
                recordFile(asset, 'misc', filePath);
            }
        } catch (error) {
            console.warn(`CharX: Failed to save asset "${asset.name}": ${error.message}`);
        }
    }

    return summary;
}
