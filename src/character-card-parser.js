import fs from 'node:fs';
import { Buffer } from 'node:buffer';

import encode from './png/encode.js';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

// RisuAI PNG exports store binary assets in one tEXt chunk each, keyed
// 'chara-ext-asset_:<index>' (legacy: 'chara-ext-asset_<index>'), referenced
// from the card JSON as '__asset:<index>'.
const RISU_ASSET_CHUNK_PREFIX = 'chara-ext-asset_';

/**
 * Writes Character metadata to a PNG image buffer.
 * Writes both 'chara' (V2) and 'ccv3' (V3) chunks.
 * Strips RisuAI 'chara-ext-asset_' chunks: their contents are persisted to disk
 * at import time, so keeping them would only bloat the avatar file.
 * @param {Buffer} image PNG image buffer
 * @param {string} data Character data to write
 * @param {Map<string, Buffer>} [assetChunks] Optional RisuAI asset chunks to write for portable export
 * @returns {Buffer} PNG image buffer with metadata
 */
export const write = (image, data, assetChunks = new Map()) => {
    const chunks = extract(new Uint8Array(image));
    const tEXtChunks = chunks.filter(chunk => chunk.name === 'tEXt');

    // Remove existing tEXt chunks
    for (const tEXtChunk of tEXtChunks) {
        const data = PNGtext.decode(tEXtChunk.data);
        const keyword = data.keyword.toLowerCase();
        if (keyword === 'chara' || keyword === 'ccv3' || keyword.startsWith(RISU_ASSET_CHUNK_PREFIX)) {
            chunks.splice(chunks.indexOf(tEXtChunk), 1);
        }
    }

    // Add new v2 chunk before the IEND chunk
    const base64EncodedData = Buffer.from(data, 'utf8').toString('base64');
    chunks.splice(-1, 0, PNGtext.encode('chara', base64EncodedData));

    // Try adding v3 chunk before the IEND chunk
    try {
        //change v2 format to v3
        const v3Data = JSON.parse(data);
        v3Data.spec = 'chara_card_v3';
        v3Data.spec_version = '3.0';

        const base64EncodedData = Buffer.from(JSON.stringify(v3Data), 'utf8').toString('base64');
        chunks.splice(-1, 0, PNGtext.encode('ccv3', base64EncodedData));
    } catch (error) {
        // Ignore errors when adding v3 chunk
    }

    if (assetChunks instanceof Map) {
        for (const [index, buffer] of assetChunks) {
            if (!index || !Buffer.isBuffer(buffer) || buffer.length === 0) {
                continue;
            }
            chunks.splice(-1, 0, PNGtext.encode(`${RISU_ASSET_CHUNK_PREFIX}:${index}`, buffer.toString('base64')));
        }
    }

    const newBuffer = Buffer.from(encode(chunks));
    return newBuffer;
};

/**
 * Reads Character metadata from a PNG image buffer.
 * Supports both V2 (chara) and V3 (ccv3). V3 (ccv3) takes precedence.
 * @param {Buffer} image PNG image buffer
 * @returns {string} Character data
 */
export const read = (image) => {
    const chunks = extract(new Uint8Array(image));

    const textChunks = chunks.filter((chunk) => chunk.name === 'tEXt').map((chunk) => PNGtext.decode(chunk.data));

    if (textChunks.length === 0) {
        console.error('PNG metadata does not contain any text chunks.');
        throw new Error('No PNG metadata.');
    }

    const ccv3Index = textChunks.findIndex((chunk) => chunk.keyword.toLowerCase() === 'ccv3');

    if (ccv3Index > -1) {
        return Buffer.from(textChunks[ccv3Index].text, 'base64').toString('utf8');
    }

    const charaIndex = textChunks.findIndex((chunk) => chunk.keyword.toLowerCase() === 'chara');

    if (charaIndex > -1) {
        return Buffer.from(textChunks[charaIndex].text, 'base64').toString('utf8');
    }

    console.error('PNG metadata does not contain any character data.');
    throw new Error('No PNG metadata.');
};

/**
 * Reads RisuAI asset chunks ('chara-ext-asset_:N' / 'chara-ext-asset_N') from a PNG image buffer.
 * @param {Buffer} image PNG image buffer
 * @returns {Map<string, Buffer>} Map of asset index (as string) to decoded binary data
 */
export const readAssetChunks = (image) => {
    /** @type {Map<string, Buffer>} */
    const assets = new Map();

    try {
        const chunks = extract(new Uint8Array(image));

        for (const chunk of chunks) {
            if (chunk.name !== 'tEXt') {
                continue;
            }

            const decoded = PNGtext.decode(chunk.data);
            const keyword = decoded.keyword.toLowerCase();

            if (!keyword.startsWith(RISU_ASSET_CHUNK_PREFIX)) {
                continue;
            }

            // Key formats: 'chara-ext-asset_:0' (current) or 'chara-ext-asset_0' (legacy)
            const index = decoded.keyword.slice(RISU_ASSET_CHUNK_PREFIX.length).replace(/^:/, '').trim();

            if (!index || assets.has(index)) {
                continue;
            }

            assets.set(index, Buffer.from(decoded.text, 'base64'));
        }
    } catch (error) {
        console.warn('Failed to read RisuAI asset chunks from PNG:', error.message);
    }

    return assets;
};

/**
 * Parses a card image and returns the character metadata.
 * @param {string} cardUrl Path to the card image
 * @param {string} format File format
 * @returns {Promise<string>} Character data
 */
export const parse = async (cardUrl, format) => {
    let fileFormat = format === undefined ? 'png' : format;

    switch (fileFormat) {
        case 'png': {
            const buffer = fs.readFileSync(cardUrl);
            return read(buffer);
        }
    }

    throw new Error('Unsupported format');
};

