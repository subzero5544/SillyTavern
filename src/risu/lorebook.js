function clonePlain(value) {
    if (!value || typeof value !== 'object') {
        return {};
    }

    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value));
    }
}

function splitKeys(value) {
    if (Array.isArray(value)) {
        return value.map(key => String(key).trim()).filter(Boolean);
    }
    return String(value ?? '').split(',').map(key => key.trim()).filter(Boolean);
}

function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/**
 * Converts RisuAI's internal module lorebook entries to CharacterCardV3
 * character_book entries, preserving existing book-level settings when present.
 * @param {object[]} lorebook RisuAI module lorebook entries
 * @param {object|null} existingBook Existing CharacterCard character_book, if any
 * @returns {object|null} CharacterCard character_book
 */
export function convertRisuModuleLorebookToCharacterBook(lorebook, existingBook = null) {
    if (!Array.isArray(lorebook) || lorebook.length === 0) {
        return existingBook && typeof existingBook === 'object' ? clonePlain(existingBook) : null;
    }

    const characterBook = existingBook && typeof existingBook === 'object'
        ? clonePlain(existingBook)
        : { entries: [] };

    characterBook.entries = lorebook.map((entry, index) => {
        const extensions = clonePlain(entry?.extentions ?? entry?.extensions);
        if (entry?.activationPercent !== undefined) {
            extensions.risu_activationPercent = entry.activationPercent;
        }
        if (entry?.loreCache !== undefined && entry?.loreCache !== null) {
            extensions.risu_loreCache = entry.loreCache;
        }

        const converted = {
            keys: splitKeys(entry?.key ?? entry?.keys),
            content: String(entry?.content ?? ''),
            extensions,
            enabled: entry?.enabled ?? true,
            insertion_order: finiteNumber(entry?.insertorder ?? entry?.insertion_order, index),
            constant: entry?.alwaysActive ?? entry?.constant ?? entry?.mode === 'constant' ?? false,
            selective: entry?.selective ?? false,
            name: entry?.comment ?? entry?.name ?? '',
            comment: entry?.comment ?? entry?.name ?? '',
            case_sensitive: extensions.risu_case_sensitive ?? entry?.case_sensitive ?? false,
            use_regex: entry?.useRegex ?? entry?.use_regex ?? false,
            mode: entry?.mode ?? 'normal',
            folder: entry?.folder,
        };

        const secondaryKeys = splitKeys(entry?.secondkey ?? entry?.secondary_keys);
        if (converted.selective && secondaryKeys.length > 0) {
            converted.secondary_keys = secondaryKeys;
        }

        return converted;
    });

    return characterBook;
}
