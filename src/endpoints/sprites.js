import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import mime from 'mime-types';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { clientRelativePath, ensureDirectory, getImageBuffers, normalizeZipEntryPath } from '../util.js';
import { mapCharXAssetsForStorage, persistCharXAssets } from '../charx.js';
import { applyRisuAssetMap } from '../risu/convert.js';

// RisuAI card JSON references PNG chunk assets as '__asset:<index>'
const RISU_ASSET_REF_PREFIX = '__asset:';
const RISU_EMBEDDED_URI_PREFIXES = ['embeded://', 'embedded://'];
const RISU_VITS_DIR = 'risuai-vits';

function isLocalOrRemoteUrl(value) {
    return typeof value === 'string'
        && (value.startsWith('/') || value.startsWith('http://') || value.startsWith('https://'));
}

function decodeBase64Asset(value) {
    const normalized = String(value || '').replace(/\s/g, '');
    if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
        return null;
    }

    const buffer = Buffer.from(normalized, 'base64');
    return buffer.length > 0 ? buffer : null;
}

/**
 * Gets the path to the sprites folder for the provided character name
 * @param {import('../users.js').UserDirectoryList} directories - User directories
 * @param {string} name - The name of the character
 * @param {boolean} isSubfolder - Whether the name contains a subfolder
 * @returns {string | null} The path to the sprites folder. Null if the name is invalid.
 */
function getSpritesPath(directories, name, isSubfolder) {
    if (isSubfolder) {
        const nameParts = name.split('/');
        const characterName = sanitize(nameParts[0]);
        const subfolderName = sanitize(nameParts[1]);

        if (!characterName || !subfolderName) {
            return null;
        }

        return path.join(directories.characters, characterName, subfolderName);
    }

    name = sanitize(name);

    if (!name) {
        return null;
    }

    return path.join(directories.characters, name);
}

/**
 * Resolves a RisuAI asset tuple value to a binary buffer.
 * Values are either base64 data (legacy exports) or '__asset:N' references
 * to PNG chunk assets (current exports).
 * @param {string} value Asset data or reference
 * @param {Map<string, Buffer>|null} assetBuffers PNG chunk assets keyed by index
 * @returns {Buffer|null} Resolved binary data, or null if unresolvable
 */
function resolveRisuAssetData(value, assetBuffers) {
    if (typeof value !== 'string' || !value) {
        return null;
    }

    if (isLocalOrRemoteUrl(value)) {
        return null;
    }

    if (value.startsWith(RISU_ASSET_REF_PREFIX)) {
        const index = value.slice(RISU_ASSET_REF_PREFIX.length).trim();
        return assetBuffers?.get(index) ?? null;
    }

    const lower = value.toLowerCase();
    for (const prefix of RISU_EMBEDDED_URI_PREFIXES) {
        if (lower.startsWith(prefix)) {
            const key = normalizeZipEntryPath(value.slice(prefix.length));
            return key ? assetBuffers?.get(key) ?? null : null;
        }
    }

    return decodeBase64Asset(value);
}

function sanitizeRisuPathSegments(input, fallback) {
    const segments = String(input || '')
        .replaceAll('\\', '/')
        .split('/')
        .map(segment => sanitize(segment.trim()))
        .filter(segment => segment && segment !== '.' && segment !== '..');

    return segments.length > 0 ? segments : [fallback];
}

function persistRisuVitsAssets(directories, characterFolder, risuData, assetBuffers) {
    const vits = risuData?.vits;
    if (!vits || typeof vits !== 'object' || Array.isArray(vits)) {
        return 0;
    }

    const baseDir = path.join(directories.files, RISU_VITS_DIR, characterFolder);
    const resolvedBaseDir = path.resolve(baseDir);
    let imported = 0;

    for (const [key, value] of Object.entries(vits)) {
        if (typeof value !== 'string' || !value || isLocalOrRemoteUrl(value)) {
            continue;
        }

        const buffer = resolveRisuAssetData(value, assetBuffers);
        if (!buffer || buffer.length === 0) {
            console.warn(`RisuAI: Could not resolve VITS asset "${key}" for ${characterFolder}, skipping.`);
            continue;
        }

        const segments = sanitizeRisuPathSegments(key, `vits-${imported}.bin`);
        const filePath = path.join(baseDir, ...segments);
        const resolvedFilePath = path.resolve(filePath);
        if (!resolvedFilePath.startsWith(resolvedBaseDir + path.sep)) {
            console.warn(`RisuAI: Rejected unsafe VITS path "${key}" for ${characterFolder}.`);
            continue;
        }

        if (!ensureDirectory(path.dirname(filePath))) {
            continue;
        }

        writeFileAtomicSync(filePath, buffer);
        vits[key] = clientRelativePath(directories.root, filePath);
        imported++;
    }

    return imported;
}

/**
 * Imports sprites, additional assets, and VITS files from RisuAI character data (V2-style
 * 'risuai' extension arrays). Emotions are saved to the character's sprites
 * folder, additional assets to the character's image gallery folder, and VITS
 * files to the user's files folder.
 * The additionalAssets and emotions are removed from the data.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {object} data RisuAI character data
 * @param {Map<string, Buffer>|null} assetBuffers PNG chunk assets keyed by index ('__asset:N' refs)
 * @returns {void}
 */
export function importRisuSprites(directories, data, assetBuffers = null) {
    try {
        const name = data?.data?.name;
        const risuData = data?.data?.extensions?.risuai;

        // Not a Risu AI character
        if (!risuData || !name) {
            return;
        }

        const characterFolder = sanitize(name);
        if (!characterFolder) {
            return;
        }

        /** @type {Array<{type: string, name: string, ext: string, zipPath: string, order: number}>} */
        const assets = [];
        /** @type {Map<string, Buffer>} */
        const bufferMap = new Map();
        let order = 0;

        /**
         * @param {string} type Asset type ('emotion' or 'x-risu-asset')
         * @param {string} label Asset name/label
         * @param {string} value Base64 data or '__asset:N' reference
         * @param {string} fileName Optional file name hint (may carry the extension)
         */
        const addAsset = (type, label, value, fileName = '') => {
            const buffer = resolveRisuAssetData(value, assetBuffers);
            if (!buffer || buffer.length === 0) {
                console.warn(`RisuAI: Could not resolve asset "${label}" for ${name}, skipping.`);
                return;
            }
            const ext = path.extname(fileName || '').replace('.', '').toLowerCase();
            const key = `risu-ext-asset/${order}`;
            assets.push({ type, name: label || fileName || `asset-${order}`, ext, zipPath: key, order });
            bufferMap.set(key, buffer);
            order++;
        };

        if (Array.isArray(risuData.emotions)) {
            for (const emotion of risuData.emotions) {
                if (!Array.isArray(emotion)) continue;
                addAsset('emotion', emotion[0], emotion[1]);
            }
        }

        if (Array.isArray(risuData.additionalAssets)) {
            for (const asset of risuData.additionalAssets) {
                if (!Array.isArray(asset)) continue;
                addAsset('x-risu-asset', asset[0], asset[1], asset[2] || '');
            }
        }

        if (assets.length > 0) {
            console.info(`RisuAI: Found ${assets.length} assets for ${name}. Writing to disk.`);
            const mapped = mapCharXAssetsForStorage(assets, bufferMap);
            const summary = persistCharXAssets(mapped, bufferMap, directories, characterFolder);
            console.info(`RisuAI: Imported ${summary.sprites} sprite(s) and ${summary.misc} misc asset(s) for ${name}.`);
            applyRisuAssetMap(data, summary.files);
        }

        const importedVits = persistRisuVitsAssets(directories, characterFolder, risuData, assetBuffers);
        if (importedVits > 0) {
            console.info(`RisuAI: Imported ${importedVits} VITS file(s) for ${name}.`);
        }

        // Remove additionalAssets and emotions from data (they are now on disk)
        delete data.data.extensions.risuai.additionalAssets;
        delete data.data.extensions.risuai.emotions;
    } catch (error) {
        console.error(error);
    }
}

export const router = express.Router();

router.get('/get', function (request, response) {
    const name = String(request.query.name);
    const isSubfolder = name.includes('/');
    const spritesPath = getSpritesPath(request.user.directories, name, isSubfolder);
    let sprites = [];

    try {
        if (spritesPath && fs.existsSync(spritesPath) && fs.statSync(spritesPath).isDirectory()) {
            sprites = fs.readdirSync(spritesPath)
                .filter(file => {
                    const mimeType = mime.lookup(file);
                    return mimeType && mimeType.startsWith('image/');
                })
                .map((file) => {
                    const pathToSprite = path.join(spritesPath, file);
                    const mtime = fs.statSync(pathToSprite).mtime?.toISOString().replace(/[^0-9]/g, '').slice(0, 14);

                    const fileName = path.parse(pathToSprite).name.toLowerCase();
                    // Extract the label from the filename via regex, which can be suffixed with a sub-name, either connected with a dash or a dot.
                    // Examples: joy.png, joy-1.png, joy.expressive.png
                    const label = fileName.match(/^(.+?)(?:[-\\.].*?)?$/)?.[1] ?? fileName;

                    return {
                        label: label,
                        path: `/characters/${name}/${file}` + (mtime ? `?t=${mtime}` : ''),
                    };
                });
        }
    } catch (err) {
        console.error(err);
    }
    return response.send(sprites);
});

router.post('/delete', async (request, response) => {
    const label = request.body.label;
    const name = String(request.body.name);
    const isSubfolder = name.includes('/');
    const spriteName = request.body.spriteName || label;

    if (!spriteName || !name) {
        return response.sendStatus(400);
    }

    try {
        const spritesPath = getSpritesPath(request.user.directories, name, isSubfolder);

        // No sprites folder exists, or not a directory
        if (!spritesPath || !fs.existsSync(spritesPath) || !fs.statSync(spritesPath).isDirectory()) {
            return response.sendStatus(404);
        }

        const files = fs.readdirSync(spritesPath);

        // Remove existing sprite with the same label
        for (const file of files) {
            if (path.parse(file).name === spriteName) {
                fs.unlinkSync(path.join(spritesPath, file));
            }
        }

        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/upload-zip', async (request, response) => {
    const file = request.file;
    const name = String(request.body.name);
    const isSubfolder = name.includes('/');

    if (!file || !name) {
        return response.sendStatus(400);
    }

    try {
        const spritesPath = getSpritesPath(request.user.directories, name, isSubfolder);

        // Invalid sprites path
        if (!spritesPath) {
            return response.sendStatus(400);
        }

        // Create sprites folder if it doesn't exist
        if (!fs.existsSync(spritesPath)) {
            fs.mkdirSync(spritesPath, { recursive: true });
        }

        // Path to sprites is not a directory. This should never happen.
        if (!fs.statSync(spritesPath).isDirectory()) {
            return response.sendStatus(404);
        }

        const spritePackPath = path.join(file.destination, file.filename);
        const sprites = await getImageBuffers(spritePackPath);
        const files = fs.readdirSync(spritesPath);

        for (const [filename, buffer] of sprites) {
            // Remove existing sprite with the same label
            const existingFile = files.find(file => path.parse(file).name === path.parse(filename).name);

            if (existingFile) {
                fs.unlinkSync(path.join(spritesPath, existingFile));
            }

            // Write sprite buffer to disk
            const pathToSprite = path.join(spritesPath, sanitize(filename));
            writeFileAtomicSync(pathToSprite, buffer);
        }

        // Remove uploaded ZIP file
        fs.unlinkSync(spritePackPath);
        return response.send({ ok: true, count: sprites.length });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/upload', async (request, response) => {
    const file = request.file;
    const label = request.body.label;
    const name = String(request.body.name);
    const isSubfolder = name.includes('/');
    const spriteName = request.body.spriteName || label;

    if (!file || !label || !name) {
        return response.sendStatus(400);
    }

    try {
        const spritesPath = getSpritesPath(request.user.directories, name, isSubfolder);

        // Invalid sprites path
        if (!spritesPath) {
            return response.sendStatus(400);
        }

        // Create sprites folder if it doesn't exist
        if (!fs.existsSync(spritesPath)) {
            fs.mkdirSync(spritesPath, { recursive: true });
        }

        // Path to sprites is not a directory. This should never happen.
        if (!fs.statSync(spritesPath).isDirectory()) {
            return response.sendStatus(404);
        }

        const files = fs.readdirSync(spritesPath);

        // Remove existing sprite with the same label
        for (const file of files) {
            if (path.parse(file).name === spriteName) {
                fs.unlinkSync(path.join(spritesPath, file));
            }
        }

        const filename = spriteName + path.parse(file.originalname).ext;
        const spritePath = path.join(file.destination, file.filename);
        const pathToFile = path.join(spritesPath, sanitize(filename));
        // Copy uploaded file to sprites folder
        fs.cpSync(spritePath, pathToFile);
        // Remove uploaded file
        fs.unlinkSync(spritePath);
        return response.send({ ok: true });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
