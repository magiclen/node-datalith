import type {
    Capabilities,
    CropRatio,
    ImageVariantSpec,
    ResourceUploadOptions,
    VideoFrameRate,
    VideoResolution,
} from "node-datalith";

export class UploadOptionsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UploadOptionsError";
    }
}

const resolutions: readonly VideoResolution[] = [
    144, 240, 360, 432, 480, 540, 576, 720, 900, 1080, 1440, 2160,
];
const frameRates: readonly VideoFrameRate[] = [10, 12, 15, 20, 24, 25, 30, 48, 50, 60];
const crops: Readonly<Record<string, CropRatio | null>> = {
    none: null,
    square: { width: 1, height: 1 },
    wide: { width: 16, height: 9 },
    tall: { width: 4, height: 5 },
};
const object = (value: unknown, name: string, keys: readonly string[]): Record<string, unknown> => {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new UploadOptionsError(name + " must be an object.");
    }
    for (const key of Object.keys(value)) {
        if (!keys.includes(key)) {
            throw new UploadOptionsError("Unknown option in " + name + ": " + key);
        }
    }
    return Object.fromEntries(Object.entries(value));
};
const integer = (value: unknown, name: string, max: number): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
        throw new UploadOptionsError(name + " must be an integer from 1 to " + max + ".");
    }
    return value;
};
const boolean = (value: unknown, name: string, fallback: boolean): boolean => {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== "boolean") {
        throw new UploadOptionsError(name + " must be true or false.");
    }
    return value;
};
const numbers = (value: unknown, name: string, max: number): number[] => {
    if (!Array.isArray(value)) {
        throw new UploadOptionsError(name + " must be a list.");
    }
    const entries: unknown[] = value;
    const result = entries.map((entry) => integer(entry, name, max));
    if (result.length === 0 || new Set(result).size !== result.length) {
        throw new UploadOptionsError(name + " must contain unique values.");
    }
    return result;
};
const imageVariant = (
    value: unknown,
    name: string,
    defaultEdge: number,
    defaultCrop: string,
    maxMultiplier: number,
): ImageVariantSpec => {
    const input = object(value, name, ["name", "maxEdge", "crop", "multipliers"]);
    const outputName = input["name"] ?? name;
    if (
        typeof outputName !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/u.test(outputName) ||
        outputName === "original"
    ) {
        throw new UploadOptionsError(
            "Output names need 1 to 64 letters, numbers, underscores or dashes; original is reserved.",
        );
    }
    const edge = integer(input["maxEdge"] ?? defaultEdge, "Max edge", 4_294_967_295);
    const crop = input["crop"] ?? defaultCrop;
    if (typeof crop !== "string" || !Object.hasOwn(crops, crop)) {
        throw new UploadOptionsError("Choose no crop, square, wide, or tall.");
    }
    const multipliers = numbers(
        input["multipliers"] ?? [1, 2].filter((scale) => scale <= maxMultiplier),
        "Image scales",
        maxMultiplier,
    );
    if (!multipliers.includes(1)) {
        throw new UploadOptionsError("Image scales must include 1x.");
    }
    return {
        name: outputName,
        maxWidth: edge,
        maxHeight: edge,
        crop: crops[crop],
        multipliers: multipliers.toSorted((a, b) => a - b),
    };
};

export const createUploadOptions = (
    encoded: string | null,
    mode: string,
    capabilities: Capabilities,
): ResourceUploadOptions => {
    let data: unknown;
    if (encoded !== null) {
        if (encoded.length > 8192) {
            throw new UploadOptionsError("Upload options are too long.");
        }
        try {
            data = JSON.parse(encoded) as unknown;
        } catch {
            throw new UploadOptionsError("Upload options must be valid JSON.");
        }
    }
    const input = object(data, "Upload options", [
        "retention",
        "saveOriginal",
        "preserveLossless",
        "image",
        "video",
    ]);
    const retention = object(input["retention"], "Retention", ["expiresInSeconds", "singleUse"]);
    const expiry = retention["expiresInSeconds"];
    const singleUse = boolean(retention["singleUse"], "Single use", false);
    const base: ResourceUploadOptions =
        expiry === undefined || expiry === null
            ? {}
            : { retention: { expiresInSeconds: integer(expiry, "Expiry in seconds", 36_000_000) } };
    if (singleUse) {
        base.retention = { ...base.retention, singleUse };
    }
    if (mode === "resource") {
        return base;
    }
    const saveOriginal = boolean(input["saveOriginal"], "Keep original", true);
    const preserveLossless = boolean(input["preserveLossless"], "Keep lossless audio", false);
    if (
        preserveLossless &&
        !capabilities.av.flacEncoder &&
        (capabilities.media.audio || capabilities.media.video)
    ) {
        throw new UploadOptionsError("The service cannot create FLAC audio.");
    }
    const image = object(input["image"], "Image options", ["variants", "thumbnail", "preview"]);
    const imageValues: unknown[] = [];
    if (capabilities.media.image) {
        if (image["variants"] !== undefined) {
            if (!Array.isArray(image["variants"])) {
                throw new UploadOptionsError("Image outputs must be a list.");
            }
            const entries: unknown[] = image["variants"];
            imageValues.push(...entries);
        } else if (image["thumbnail"] !== undefined || image["preview"] !== undefined) {
            const thumbnail = object(image["thumbnail"], "thumbnail", [
                "maxEdge",
                "crop",
                "multipliers",
            ]);
            imageValues.push({
                ...thumbnail,
                name: "thumbnail",
                crop: thumbnail["crop"] ?? "square",
            });
            if (capabilities.image.limits.maxVariants >= 2) {
                const preview = object(image["preview"], "preview", [
                    "maxEdge",
                    "crop",
                    "multipliers",
                ]);
                imageValues.push({
                    ...preview,
                    name: "preview",
                    maxEdge: preview["maxEdge"] ?? 960,
                });
            }
        } else {
            imageValues.push(
                ...[
                    { name: "image_1", maxEdge: 256 },
                    { name: "image_2", maxEdge: 960 },
                ].slice(0, capabilities.image.limits.maxVariants),
            );
        }
    }
    const variants = imageValues.map((value, index) =>
        imageVariant(
            value,
            "image_" + (index + 1),
            index === 0 ? 256 : 960,
            "none",
            capabilities.image.limits.maxMultiplier,
        ),
    );
    if (new Set(variants.map((variant) => variant.name)).size !== variants.length) {
        throw new UploadOptionsError("Image output names must be unique.");
    }
    const options = {
        ...base,
        enableConvertToImage: capabilities.media.image && variants.length > 0,
        enableConvertToAudio: capabilities.media.audio,
        image: variants.length > 0 ? { saveOriginal, variants } : undefined,
        audio: capabilities.media.audio ? { saveOriginal, preserveLossless } : undefined,
    };
    if (!capabilities.media.video) {
        return { ...options, enableConvertToVideo: false };
    }
    const video = object(input["video"], "Video options", ["variants", "resolutions", "fps"]);
    const available = resolutions.filter((tier) =>
        capabilities.video.resolutionTiers.includes(tier),
    );
    const availableRates = frameRates.filter((rate) =>
        capabilities.video.frameRateTiers.includes(rate),
    );
    let values: unknown[];
    if (video["variants"] !== undefined) {
        if (!Array.isArray(video["variants"])) {
            throw new UploadOptionsError("Video outputs must be a list.");
        }
        values = video["variants"];
    } else if (video["resolutions"] !== undefined || video["fps"] !== undefined) {
        const sizes = numbers(video["resolutions"] ?? available.slice(0, 1), "Video sizes", 2160);
        values = sizes.map((resolution) => ({ resolution, fps: video["fps"] ?? 30 }));
    } else {
        values = [
            { resolution: 1080, fps: 60 },
            { resolution: 720, fps: 30 },
        ].filter(
            (variant) =>
                available.some((tier) => tier === variant.resolution) &&
                availableRates.some((rate) => rate === variant.fps),
        );
        if (values.length === 0 && available.length > 0 && availableRates.length > 0) {
            values = [
                {
                    resolution: available[0],
                    fps: availableRates.includes(30) ? 30 : availableRates[0],
                },
            ];
        }
    }
    if (values.length === 0) {
        return { ...options, enableConvertToVideo: false };
    }
    const videoVariants = values.map((value) => {
        const entry = object(value, "Video output", ["resolution", "fps"]);
        const size = integer(entry["resolution"], "Video size", 2160);
        const fps = integer(entry["fps"], "Frame rate", 60);
        const resolution = available.find((tier) => tier === size);
        const rate = availableRates.find((tier) => tier === fps);
        if (resolution === undefined || rate === undefined) {
            throw new UploadOptionsError(
                "Choose a resolution and frame rate supported by the service.",
            );
        }
        return { resolution, fps: rate };
    });
    return {
        ...options,
        enableConvertToVideo: true,
        video: { saveOriginal, preserveLossless, variants: videoVariants },
    };
};
