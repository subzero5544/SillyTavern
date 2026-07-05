import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

import archiver from 'archiver';
import sanitize from 'sanitize-filename';

import { writeRisuModule } from './risum.js';
import { convertRegexScriptsToRisu } from './convert.js';

/**
 * Exports a SillyTavern character as a RisuAI-compatible .charx archive:
 *   card.json     - CharacterCardV3
 *   module.risum  - trigger scripts + regex scripts (RisuAI relocates these out of card.json)
 *   assets/...    - avatar (icon), sprites (emotions), backgrounds, gallery assets
 */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng', 'avif', 'bmp', 'jfif']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'avi', 'm4p', 'm4v', 'mov', 'mkv']);
const AI_EXTENSIONS = new Set(['onnx', 'safetensors', 'ckpt', 'cpkt']);

/**
 * Maps a file extension to RisuAI's asset folder category inside the zip.
 * @param {string} ext Extension without dot
 * @returns {string} 'image' | 'audio' | 'video' | 'ai' | 'other'
 */
function getAssetItype(ext) {
    if (IMAGE_EXTENSIONS.has(ext)) return 'image';
    if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
    if (VIDEO_EXTENSIONS.has(ext)) return 'video';
    if (AI_EXTENSIONS.has(ext)) return 'ai';
    return 'other';
}

function isRenderableAssetExtension(ext) {
    return IMAGE_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);
}

/**
 * Lists media files (not directories) in a folder. Returns [] if it doesn't exist.
 * @param {string} dirPath Directory path
 * @returns {{name: string, filePath: string, ext: string}[]}
 */
function listMediaFiles(dirPath) {
    try {
        return fs.readdirSync(dirPath, { withFileTypes: true })
            .filter(entry => entry.isFile())
            .map(entry => {
                const ext = path.extname(entry.name).slice(1).toLowerCase();
                return { name: path.basename(entry.name, path.extname(entry.name)), filePath: path.join(dirPath, entry.name), ext };
            })
            .filter(file => isRenderableAssetExtension(file.ext));
    } catch {
        return [];
    }
}

/**
 * Builds a reverse lookup (stored file base name → original RisuAI asset name)
 * from the asset map recorded at import time.
 * @param {object} assetMap data.extensions.risuai.assetMap
 * @returns {Map<string, string>}
 */
function buildOriginalNameLookup(assetMap) {
    const lookup = new Map();
    for (const source of [assetMap?.assets, assetMap?.emotions]) {
        if (!source || typeof source !== 'object') continue;
        for (const [originalName, url] of Object.entries(source)) {
            if (typeof url !== 'string') continue;
            const base = path.basename(url, path.extname(url)).toLowerCase();
            if (!lookup.has(base)) {
                lookup.set(base, originalName);
            }
        }
    }
    return lookup;
}

function isHttpOrEmbeddedUri(value) {
    return /^https?:\/\//i.test(value)
        || value.toLowerCase().startsWith('data:')
        || value.toLowerCase().startsWith('embeded://')
        || value.toLowerCase().startsWith('embedded://')
        || value.startsWith('__asset:');
}

function isPathInside(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveClientRelativeFilePath(root, value) {
    if (typeof root !== 'string' || !root || typeof value !== 'string' || !value.trim() || isHttpOrEmbeddedUri(value.trim())) {
        return null;
    }

    const normalized = value.trim().replace(/\\/g, '/').split(/[?#]/)[0].replace(/^\/+/, '');
    if (!normalized) {
        return null;
    }

    const rootPath = path.resolve(root);
    const candidate = path.resolve(rootPath, ...normalized.split('/').filter(Boolean));
    if (!isPathInside(rootPath, candidate)) {
        return null;
    }

    try {
        return fs.statSync(candidate).isFile() ? candidate : null;
    } catch {
        return null;
    }
}

function sanitizeZipSegment(segment, fallback) {
    return sanitize(String(segment || '').trim()).replace(/\s+/g, '_') || fallback;
}

function getVitsZipPath(key, sourcePath, index) {
    const rawSegments = String(key || '').replace(/\\/g, '/').split('/').filter(Boolean);
    const fallbackName = path.basename(sourcePath) || `vits_${index}`;
    let fileName = sanitizeZipSegment(rawSegments.pop() || fallbackName, `vits_${index}`);
    const sourceExt = path.extname(sourcePath).slice(1).toLowerCase();
    const fileExt = path.extname(fileName).slice(1).toLowerCase();
    const ext = fileExt || sourceExt || 'bin';

    if (!fileExt) {
        fileName = `${fileName}.${ext}`;
    }

    const folders = rawSegments.map((segment, segmentIndex) => sanitizeZipSegment(segment, `folder_${segmentIndex}`));
    return path.posix.join('assets', 'other', getAssetItype(ext), ...folders, fileName);
}

/**
 * Exports a character as a RisuAI .charx archive.
 * @param {object} card Character card object (V2 with data block, private fields unset)
 * @param {Buffer} avatarBuffer Character avatar PNG buffer
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {Promise<Buffer>} .charx file contents
 */
export async function exportToCharX(card, avatarBuffer, directories) {
    const data = structuredClone(card?.data ?? {});
    const characterName = String(data.name ?? 'character');
    const characterFolder = sanitize(characterName);

    data.extensions = data.extensions ?? {};
    const risuai = data.extensions.risuai ?? {};
    data.extensions.risuai = risuai;

    // RisuAI's own CharX export relocates these into module.risum
    const triggerScripts = Array.isArray(risuai.triggerscript) ? risuai.triggerscript : [];
    const customScripts = Array.isArray(risuai.customScripts) && risuai.customScripts.length > 0
        ? risuai.customScripts
        : convertRegexScriptsToRisu(data.extensions.regex_scripts);
    const originalNames = buildOriginalNameLookup(risuai.assetMap);
    delete risuai.triggerscript;
    delete risuai.customScripts;
    // ST-local file paths are meaningless outside this install
    delete risuai.assetMap;

    /** @type {{zipPath: string, name?: string, ext?: string, type?: string, content: Buffer|string}[]} */
    const zipFiles = [];
    const takenZipPaths = new Set();

    const addZipFile = (zipPath, content, metadata = {}) => {
        const parsed = path.posix.parse(zipPath);
        let candidate = zipPath;
        let counter = 1;
        while (takenZipPaths.has(candidate)) {
            candidate = path.posix.join(parsed.dir, `${parsed.name}_${counter}${parsed.ext}`);
            counter++;
        }
        takenZipPaths.add(candidate);
        zipFiles.push({ zipPath: candidate, content, ...metadata });
        return candidate;
    };

    const addAsset = (type, name, ext, content) => {
        const itype = getAssetItype(ext);
        const safeName = sanitize(String(name)).replace(/\s+/g, '_') || `asset_${zipFiles.length}`;
        const zipPath = `assets/${type}/${itype}/${safeName}.${ext}`;
        return addZipFile(zipPath, content, { name: String(name), ext, type });
    };

    const embedRisuVitsAssets = () => {
        const vits = risuai.vits;
        if (!vits || typeof vits !== 'object' || Array.isArray(vits)) {
            return 0;
        }

        let exported = 0;
        for (const [key, value] of Object.entries(vits)) {
            const sourcePath = resolveClientRelativeFilePath(directories.root, value);
            if (!sourcePath) {
                continue;
            }

            const zipPath = addZipFile(
                getVitsZipPath(key, sourcePath, exported),
                fs.readFileSync(sourcePath),
                { name: key, ext: path.extname(sourcePath).slice(1).toLowerCase(), type: 'vits' },
            );
            vits[key] = `embeded://${zipPath}`;
            exported++;
        }

        return exported;
    };

    embedRisuVitsAssets();

    /** @type {object[]} */
    const assets = [];

    // Avatar as the main icon
    if (Buffer.isBuffer(avatarBuffer) && avatarBuffer.length > 0) {
        const zipPath = addAsset('icon', 'main', 'png', avatarBuffer);
        assets.push({ type: 'icon', uri: `embeded://${zipPath}`, name: 'main', ext: 'png' });
    }

    // Sprites → RisuAI emotions (skip the backgrounds subfolder handled below)
    for (const file of listMediaFiles(path.join(directories.characters, characterFolder))) {
        const name = originalNames.get(file.name.toLowerCase()) ?? file.name;
        const zipPath = addAsset('emotion', name, file.ext, fs.readFileSync(file.filePath));
        assets.push({ type: 'emotion', uri: `embeded://${zipPath}`, name, ext: file.ext });
    }

    // Character-specific backgrounds
    for (const file of listMediaFiles(path.join(directories.characters, characterFolder, 'backgrounds'))) {
        const name = originalNames.get(file.name.toLowerCase()) ?? file.name;
        const zipPath = addAsset('background', name, file.ext, fs.readFileSync(file.filePath));
        assets.push({ type: 'background', uri: `embeded://${zipPath}`, name, ext: file.ext });
    }

    // Gallery assets → RisuAI additional assets
    for (const file of listMediaFiles(path.join(directories.userImages, characterFolder))) {
        const name = originalNames.get(file.name.toLowerCase()) ?? file.name;
        const zipPath = addAsset('other', name, file.ext, fs.readFileSync(file.filePath));
        assets.push({ type: 'x-risu-asset', uri: `embeded://${zipPath}`, name, ext: file.ext });
    }

    data.assets = assets;
    data.group_only_greetings = data.group_only_greetings ?? [];

    const cardV3 = {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: data,
    };

    // NOTE: no 'lorebook' field in the module - RisuAI would let it override
    // card.json's character_book, even when empty
    const risuModule = {
        name: `${characterName} Module`,
        description: `Module for ${characterName}`,
        id: crypto.randomUUID(),
        trigger: triggerScripts,
        regex: customScripts,
    };

    return await new Promise((resolve, reject) => {
        const archive = archiver('zip', { zlib: { level: 6 } });
        /** @type {Buffer[]} */
        const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        archive.on('end', () => resolve(Buffer.concat(chunks)));
        archive.on('error', reject);

        archive.append(JSON.stringify(cardV3, null, 4), { name: 'card.json' });
        archive.append(writeRisuModule(risuModule), { name: 'module.risum' });
        for (const file of zipFiles) {
            archive.append(file.content, { name: file.zipPath });
        }

        archive.finalize();
    });
}
