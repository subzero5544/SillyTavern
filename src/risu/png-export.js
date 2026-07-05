import fs from 'node:fs';
import path from 'node:path';

function isExternalOrEmbeddedUri(value) {
    const lower = value.toLowerCase();
    return /^https?:\/\//i.test(value)
        || lower.startsWith('data:')
        || lower.startsWith('ccdefault:')
        || lower.startsWith('embeded://')
        || lower.startsWith('embedded://')
        || value.startsWith('__asset:');
}

function isPathInside(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveClientRelativeFilePath(root, value) {
    if (typeof root !== 'string' || !root || typeof value !== 'string' || !value.trim() || isExternalOrEmbeddedUri(value.trim())) {
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

function getUrlExtension(value, sourcePath) {
    const urlPath = String(value || '').replace(/\\/g, '/').split(/[?#]/)[0];
    return path.extname(urlPath).slice(1).toLowerCase()
        || path.extname(sourcePath || '').slice(1).toLowerCase()
        || 'unknown';
}

function getAssetMapAssetType(category, url) {
    if (category === 'emotions') {
        return 'emotion';
    }

    return /\/backgrounds\//i.test(String(url || '').replace(/\\/g, '/')) ? 'background' : 'x-risu-asset';
}

function ensureAssetsFromAssetMap(card, directories) {
    const data = card?.data;
    const assetMap = data?.extensions?.risuai?.assetMap;
    if (!data || !assetMap || typeof assetMap !== 'object') {
        return false;
    }

    data.assets = Array.isArray(data.assets) ? data.assets : [];
    const seen = new Set(data.assets.map(asset => `${asset?.type || ''}\0${asset?.name || ''}\0${asset?.uri || ''}`.toLowerCase()));
    let added = false;

    for (const category of ['emotions', 'assets']) {
        const source = assetMap[category];
        if (!source || typeof source !== 'object') {
            continue;
        }

        for (const [name, url] of Object.entries(source)) {
            const sourcePath = resolveClientRelativeFilePath(directories.root, url);
            if (!sourcePath) {
                continue;
            }

            const type = getAssetMapAssetType(category, url);
            const key = `${type}\0${name}\0${url}`.toLowerCase();
            if (seen.has(key)) {
                continue;
            }

            data.assets.push({
                type,
                uri: url,
                name,
                ext: getUrlExtension(url, sourcePath),
            });
            seen.add(key);
            added = true;
        }
    }

    return added;
}

/**
 * Rewrites local RisuAI asset references in PNG export metadata to portable
 * '__asset:N' chunk references and returns the chunk buffers to write.
 * @param {string} data Character card JSON string
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {{data: string, assetChunks: Map<string, Buffer>}}
 */
export function prepareRisuPngExport(data, directories) {
    /** @type {Map<string, Buffer>} */
    const assetChunks = new Map();

    let card;
    try {
        card = JSON.parse(data);
    } catch {
        return { data, assetChunks };
    }

    const risuai = card?.data?.extensions?.risuai;
    if (!risuai || typeof risuai !== 'object') {
        return { data, assetChunks };
    }

    let convertedAssetMap = ensureAssetsFromAssetMap(card, directories);

    const addAssetChunk = (sourcePath) => {
        const index = String(assetChunks.size);
        assetChunks.set(index, fs.readFileSync(sourcePath));
        return `__asset:${index}`;
    };

    if (Array.isArray(card.data?.assets)) {
        for (const asset of card.data.assets) {
            const sourcePath = resolveClientRelativeFilePath(directories.root, asset?.uri);
            if (!sourcePath) {
                continue;
            }

            asset.ext = asset.ext || getUrlExtension(asset.uri, sourcePath);
            asset.uri = addAssetChunk(sourcePath);
            convertedAssetMap = true;
        }
    }

    const vits = risuai.vits;
    if (vits && typeof vits === 'object' && !Array.isArray(vits)) {
        for (const [key, value] of Object.entries(vits)) {
            const sourcePath = resolveClientRelativeFilePath(directories.root, value);
            if (!sourcePath) {
                continue;
            }

            vits[key] = addAssetChunk(sourcePath);
        }
    }

    if (convertedAssetMap) {
        delete risuai.assetMap;
    }

    return { data: JSON.stringify(card), assetChunks };
}
