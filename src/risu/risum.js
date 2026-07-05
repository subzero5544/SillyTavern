import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

/**
 * RisuAI .risum module format support.
 *
 * Binary layout (see RisuAI src/ts/process/modules.ts):
 *   byte 111                     - magic number
 *   byte 0                       - format version
 *   uint32 LE length + payload   - rpack-encoded JSON: { module: RisuModule, type: 'risuModule' }
 *   repeated: byte 1 + uint32 LE length + payload - rpack-encoded asset binary
 *   byte 0                       - end of file
 *
 * "rpack" is a 1:1 byte substitution table (obfuscation, not compression):
 * rpack_map.bin holds 256 bytes of encode map followed by 256 bytes of decode map.
 */

const RISUM_MAGIC = 111;
const RISUM_VERSION = 0;
// Backstop against malformed length fields
const MAX_SEGMENT_SIZE = 512 * 1024 * 1024;

const mapPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rpack_map.bin');
const mapData = fs.readFileSync(mapPath);
const encodeMap = mapData.subarray(0, 256);
const decodeMap = mapData.subarray(256, 512);

/**
 * @typedef {Object} RisuModule
 * @property {string} name
 * @property {string} description
 * @property {string} id
 * @property {object[]} [lorebook] - RisuAI-internal lorebook entries
 * @property {object[]} [regex] - RisuAI customscript entries
 * @property {object[]} [trigger] - RisuAI trigger scripts
 * @property {[string, string, string][]} [assets] - [name, uri, ext] tuples
 * @property {boolean} [lowLevelAccess]
 * @property {string} [cjs]
 */

/**
 * Applies a substitution map to a buffer.
 * @param {Buffer|Uint8Array} data Input data
 * @param {Buffer} map 256-byte substitution table
 * @returns {Buffer} Transformed data
 */
function applyMap(data, map) {
    const result = Buffer.allocUnsafe(data.length);
    for (let i = 0; i < data.length; i++) {
        result[i] = map[data[i]];
    }
    return result;
}

/**
 * Encodes data with the RisuAI rpack substitution table.
 * @param {Buffer|Uint8Array} data Input data
 * @returns {Buffer} Encoded data
 */
export function encodeRPack(data) {
    return applyMap(data, encodeMap);
}

/**
 * Decodes data encoded with the RisuAI rpack substitution table.
 * @param {Buffer|Uint8Array} data Encoded data
 * @returns {Buffer} Decoded data
 */
export function decodeRPack(data) {
    return applyMap(data, decodeMap);
}

/**
 * @typedef {Object} RisumReadResult
 * @property {RisuModule} module - Parsed module data
 * @property {Buffer[]} assetBuffers - Decoded asset binaries, aligned with module.assets by index
 */

/**
 * Parses a RisuAI .risum module buffer.
 * @param {Buffer|Uint8Array} buffer Module file contents
 * @returns {RisumReadResult} Parsed module and asset binaries
 * @throws {Error} If the buffer is not a valid risum module
 */
export function readRisuModule(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    let pos = 0;

    const readByte = () => {
        if (pos + 1 > buf.length) throw new Error('Unexpected end of risum data');
        return buf.readUInt8(pos++);
    };
    const readSegment = () => {
        if (pos + 4 > buf.length) throw new Error('Unexpected end of risum data');
        const length = buf.readUInt32LE(pos);
        pos += 4;
        if (length > MAX_SEGMENT_SIZE || pos + length > buf.length) throw new Error('Invalid risum segment length');
        const data = buf.subarray(pos, pos + length);
        pos += length;
        return data;
    };

    if (readByte() !== RISUM_MAGIC) {
        throw new Error('Invalid risum magic number');
    }
    if (readByte() !== RISUM_VERSION) {
        throw new Error('Unsupported risum version');
    }

    const main = JSON.parse(decodeRPack(readSegment()).toString('utf8'));

    if (main?.type !== 'risuModule' || !main.module) {
        throw new Error('Invalid risum module type');
    }

    const assetBuffers = [];
    for (;;) {
        // Tolerate truncated files: the module JSON is already parsed
        if (pos >= buf.length) break;
        const mark = readByte();
        if (mark === 0) break;
        if (mark !== 1) throw new Error('Invalid risum asset marker');
        assetBuffers.push(decodeRPack(readSegment()));
    }

    return { module: main.module, assetBuffers };
}

/**
 * Serializes a RisuAI module to the .risum binary format.
 * @param {RisuModule} module Module data (assets entries should be [name, '', ext])
 * @param {Buffer[]} [assetBuffers] Asset binaries aligned with module.assets by index
 * @returns {Buffer} .risum file contents
 */
export function writeRisuModule(module, assetBuffers = []) {
    const parts = [];
    const writeByte = (byte) => parts.push(Buffer.from([byte]));
    const writeSegment = (data) => {
        const lengthBuffer = Buffer.alloc(4);
        lengthBuffer.writeUInt32LE(data.length, 0);
        parts.push(lengthBuffer, data);
    };

    writeByte(RISUM_MAGIC);
    writeByte(RISUM_VERSION);
    writeSegment(encodeRPack(Buffer.from(JSON.stringify({ module, type: 'risuModule' }, null, 2), 'utf8')));

    for (const assetBuffer of assetBuffers) {
        writeByte(1);
        writeSegment(encodeRPack(assetBuffer ?? Buffer.alloc(0)));
    }

    writeByte(0);
    return Buffer.concat(parts);
}
