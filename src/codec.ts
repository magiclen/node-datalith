import { DatalithProtocolError } from "./errors.ts";
import type {
    AudioMedia,
    AudioVariant,
    Capabilities,
    ExportResult,
    ImageVariant,
    ImageVariantSpec,
    ImportResult,
    Media,
    MediaFile,
    Mp4ExportResult,
    Page,
    PlaybackSession,
    ProcessingWarning,
    Rational,
    Task,
    VideoMedia,
    VideoVariant,
} from "./types.ts";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> => {
    if (!isRecord(value)) {
        throw new DatalithProtocolError("Expected a JSON object.");
    }
    return value;
};
const text = (value: unknown): string => {
    if (typeof value !== "string") {
        throw new DatalithProtocolError("Expected a string.");
    }
    return value;
};
const number = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new DatalithProtocolError("Expected a finite number.");
    }
    return value;
};
const boolean = (value: unknown): boolean => {
    if (typeof value !== "boolean") {
        throw new DatalithProtocolError("Expected a boolean.");
    }
    return value;
};
const date = (value: unknown): Date => {
    const parsed = new Date(text(value));
    if (Number.isNaN(parsed.getTime())) {
        throw new DatalithProtocolError("Invalid date from Datalith.");
    }
    return parsed;
};
const decimal = (value: unknown): string => {
    const parsed = text(value);
    if (!/^\d+$/u.test(parsed)) {
        throw new DatalithProtocolError("Expected a decimal string.");
    }
    return parsed;
};
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const array = <T>(value: unknown, decode: (entry: unknown) => T): T[] => {
    if (!isArray(value)) {
        throw new DatalithProtocolError("Expected a JSON array.");
    }
    return value.map(decode);
};
const nullable = <T>(value: unknown, decode: (entry: unknown) => T): T | null =>
    value === null ? null : decode(value);
const oneOf = <T extends string | number>(value: unknown, values: readonly T[]): T => {
    for (const candidate of values) {
        if (value === candidate) {
            return candidate;
        }
    }
    throw new DatalithProtocolError("Unknown API value: " + String(value));
};
const method = (value: unknown): "unknown" | "copied" | "remuxed" | "transcoded" =>
    oneOf(value, ["unknown", "copied", "remuxed", "transcoded"]);
const modes = (entry: unknown): "transcode" | "trust" => oneOf(entry, ["transcode", "trust"]);
const format = (value: unknown): "webp" | "png" | "jpeg" | "gif" =>
    oneOf(value, ["webp", "png", "jpeg", "gif"]);
const resolution = (value: unknown): VideoVariant["resolution"] =>
    oneOf(value, [144, 240, 360, 432, 480, 540, 576, 720, 900, 1080, 1440, 2160]);
const fps = (value: unknown): VideoVariant["fps"] =>
    oneOf(value, [10, 12, 15, 20, 24, 25, 30, 48, 50, 60]);
const rational = (value: unknown): Rational => {
    const input = record(value);
    return { numerator: number(input["numerator"]), denominator: number(input["denominator"]) };
};
const file = (value: unknown): MediaFile => {
    const input = record(value);
    return {
        id: text(input["id"]),
        sha256: text(input["sha256"]),
        fileSize: decimal(input["file_size"]),
        fileType: text(input["file_type"]),
        fileName: text(input["file_name"]),
    };
};
const recipe = (value: unknown): ImageVariantSpec => {
    const input = record(value);
    return {
        name: text(input["name"]),
        maxWidth: nullable(input["max_width"], number),
        maxHeight: nullable(input["max_height"], number),
        crop: nullable(input["crop"], (entry) => {
            const crop = record(entry);
            return { width: number(crop["width"]), height: number(crop["height"]) };
        }),
        multipliers: array(input["multipliers"], number),
    };
};
const imageVariant = (value: unknown): ImageVariant => {
    const input = record(value);
    return {
        ...(input["processing_method"] === undefined
            ? {}
            : { processingMethod: method(input["processing_method"]) }),
        name: text(input["name"]),
        multiplier: number(input["multiplier"]),
        format: format(input["format"]),
        width: number(input["width"]),
        height: number(input["height"]),
        animated: boolean(input["animated"]),
        file: file(input["file"]),
        contentPath: text(input["content_path"]),
        recipe: nullable(input["recipe"], recipe),
    };
};
const audioVariant = (value: unknown): AudioVariant => {
    const input = record(value);
    return {
        id: text(input["id"]),
        codec: oneOf(input["codec"], ["aac", "flac"]),
        bitrate: number(input["bitrate"]),
        sampleRate: number(input["sample_rate"]),
        channels: number(input["channels"]),
        bitsPerSample: nullable(input["bits_per_sample"], number),
        processingMethod: method(input["processing_method"]),
        file: nullable(input["file"], file),
        contentPath: text(input["content_path"]),
    };
};
const audio = (value: unknown): AudioMedia => {
    const input = record(value);
    return {
        durationSeconds: number(input["duration_seconds"]),
        variants: array(input["variants"], audioVariant),
    };
};
const videoVariant = (value: unknown): VideoVariant => {
    const input = record(value);
    return {
        id: text(input["id"]),
        resolution: resolution(input["resolution"]),
        width: number(input["width"]),
        height: number(input["height"]),
        fps: fps(input["fps"]),
        frameRate: rational(input["frame_rate"]),
        ...(input["leading_hold_seconds"] === undefined
            ? {}
            : { leadingHoldSeconds: number(input["leading_hold_seconds"]) }),
        codec: text(input["codec"]),
        processingMethod: method(input["processing_method"]),
        playlistPath: text(input["playlist_path"]),
        audio: array(input["audio"], text),
    };
};
const video = (value: unknown): VideoMedia => {
    const input = record(value);
    return {
        durationSeconds: number(input["duration_seconds"]),
        variants: array(input["variants"], videoVariant),
        audio: array(input["audio"], audioVariant),
        masterPath: text(input["master_path"]),
    };
};
const warning = (value: unknown): ProcessingWarning => {
    const input = record(value);
    return { code: text(input["code"]), message: text(input["message"]) };
};

export const decodeMedia = (value: unknown): Media => {
    const input = record(value);
    const base = {
        id: text(input["id"]),
        createdAt: date(input["created_at"]),
        fileName: text(input["file_name"]),
        original: nullable(input["original"], file),
        variants: array(input["variants"], imageVariant),
        ...(input["audio"] === undefined ? {} : { audio: audio(input["audio"]) }),
        ...(input["video"] === undefined ? {} : { video: video(input["video"]) }),
        ...(input["warnings"] === undefined ? {} : { warnings: array(input["warnings"], warning) }),
        expiresAt: nullable(input["expires_at"], date),
        singleUse: boolean(input["single_use"]),
        consumedAt: nullable(input["consumed_at"], date),
        animated: boolean(input["animated"]),
        frameCount: number(input["frame_count"]),
    };
    switch (input["kind"]) {
        case "resource":
            return { ...base, kind: "resource" };
        case "image":
            return { ...base, kind: "image" };
        case "audio":
            return { ...base, kind: "audio", audio: audio(input["audio"]) };
        case "video":
            return { ...base, kind: "video", video: video(input["video"]) };
        default:
            throw new DatalithProtocolError("Unknown media kind.");
    }
};
const dictionary = (value: unknown): Record<string, string> =>
    Object.fromEntries(Object.entries(record(value)).map(([key, entry]) => [key, text(entry)]));
const imported = (value: unknown): ImportResult => {
    const input = record(value);
    return {
        archiveId: text(input["archive_id"]),
        imported: number(input["imported"]),
        skipped: number(input["skipped"]),
        idMap: dictionary(input["id_map"]),
        fileIdMap: dictionary(input["file_id_map"]),
    };
};
const exported = (value: unknown): ExportResult => {
    const input = record(value);
    return {
        artifactPath: text(input["artifact_path"]),
        mediaCount: number(input["media_count"]),
        artifact: file(input["artifact"]),
    };
};
const mp4 = (value: unknown): Mp4ExportResult => {
    const input = record(value);
    return {
        mediaId: text(input["media_id"]),
        variant: text(input["variant"]),
        audio: nullable(input["audio"], (entry) => oneOf(entry, ["aac_low", "aac_high", "flac"])),
        artifact: file(input["artifact"]),
        artifactPath: text(input["artifact_path"]),
        expiresAt: date(input["expires_at"]),
    };
};
export const decodeTask = (value: unknown): Task => {
    const input = record(value);
    const base = {
        id: text(input["id"]),
        status: oneOf(input["status"], [
            "queued",
            "running",
            "cancelling",
            "succeeded",
            "failed",
            "cancelled",
        ]),
        stage: text(input["stage"]),
        completedUnits: number(input["completed_units"]),
        totalUnits: nullable(input["total_units"], number),
        attempt: number(input["attempt"]),
        createdAt: date(input["created_at"]),
        updatedAt: date(input["updated_at"]),
        error: nullable(input["error"], warning),
    };
    if (base.status === "succeeded" && input["result"] === null) {
        throw new DatalithProtocolError("A successful task has no result.");
    }
    switch (input["kind"]) {
        case "upload":
            return { ...base, kind: "upload", result: nullable(input["result"], decodeMedia) };
        case "import":
            return { ...base, kind: "import", result: nullable(input["result"], imported) };
        case "export":
            return { ...base, kind: "export", result: nullable(input["result"], exported) };
        case "mp4_export":
            return { ...base, kind: "mp4_export", result: nullable(input["result"], mp4) };
        case "resource": {
            const result = nullable(input["result"], decodeMedia);
            if (result !== null && result.kind !== "resource") {
                throw new DatalithProtocolError("Unexpected resource result.");
            }
            return { ...base, kind: "resource", result };
        }
        case "image": {
            const result = nullable(input["result"], decodeMedia);
            if (result !== null && result.kind !== "image") {
                throw new DatalithProtocolError("Unexpected image result.");
            }
            return { ...base, kind: "image", result };
        }
        case "audio": {
            const result = nullable(input["result"], decodeMedia);
            if (result !== null && result.kind !== "audio") {
                throw new DatalithProtocolError("Unexpected audio result.");
            }
            return { ...base, kind: "audio", result };
        }
        case "video": {
            const result = nullable(input["result"], decodeMedia);
            if (result !== null && result.kind !== "video") {
                throw new DatalithProtocolError("Unexpected video result.");
            }
            return { ...base, kind: "video", result };
        }
        default:
            throw new DatalithProtocolError("Unknown task kind.");
    }
};
export const decodePage = (value: unknown): Page<Media> => {
    const input = record(value);
    return {
        items: array(input["items"], decodeMedia),
        page: number(input["page"]),
        perPage: number(input["per_page"]),
        total: decimal(input["total"]),
    };
};
export const decodeSession = (value: unknown): PlaybackSession => {
    const input = record(value);
    return { token: text(input["token"]), expiresAt: date(input["expires_at"]) };
};
export const decodeCapabilities = (value: unknown): Capabilities => {
    const input = record(value);
    const media = record(input["media"]);
    const image = record(input["image"]);
    const limits = record(image["limits"]);
    const av = record(input["av"]);
    const sound = record(input["audio"]);
    const movie = record(input["video"]);
    const session = record(input["playback_sessions"]);
    return {
        apiVersion: text(input["api_version"]),
        version: text(input["version"]),
        media: {
            resource: boolean(media["resource"]),
            image: boolean(media["image"]),
            audio: boolean(media["audio"]),
            video: boolean(media["video"]),
        },
        image: {
            engine: text(image["engine"]),
            animatedInputs: array(image["animated_inputs"], text),
            outputs: array(image["outputs"], format),
            apngRequiresFfmpeg: boolean(image["apng_requires_ffmpeg"]),
            apngTimingPrecisionMs: number(image["apng_timing_precision_ms"]),
            limits: {
                maxPixels: number(limits["max_pixels"]),
                maxFrames: number(limits["max_frames"]),
                maxTotalPixels: number(limits["max_total_pixels"]),
                maxVariants: number(limits["max_variants"]),
                maxMultiplier: number(limits["max_multiplier"]),
            },
            processingModes: array(image["processing_modes"], modes),
            saveOriginalDefault: boolean(image["save_original_default"]),
        },
        av: {
            available: boolean(av["available"]),
            minimumToolMajor: number(av["minimum_tool_major"]),
            audioEncoder: boolean(av["audio_encoder"]),
            videoEncoder: boolean(av["video_encoder"]),
            flacEncoder: boolean(av["flac_encoder"]),
            unavailableReason: nullable(av["unavailable_reason"], text),
        },
        audio: {
            engine: text(sound["engine"]),
            profiles: array(sound["profiles"], text),
            aacSampleRate: number(sound["aac_sample_rate"]),
            aacBitrates: array(sound["aac_bitrates"], number),
            mp3Fallback: boolean(sound["mp3_fallback"]),
            saveOriginalDefault: boolean(sound["save_original_default"]),
            processingModes: array(sound["processing_modes"], modes),
            selectedAudioStreams: number(sound["selected_audio_streams"]),
        },
        video: {
            engine: text(movie["engine"]),
            codec: text(movie["codec"]),
            pixelFormat: text(movie["pixel_format"]),
            delivery: text(movie["delivery"]),
            requiresVariants: boolean(movie["requires_variants"]),
            resolutionTiers: array(movie["resolution_tiers"], resolution),
            frameRateTiers: array(movie["frame_rate_tiers"], fps),
            bitrate: number(movie["bitrate"]),
            bitrateUnit: text(movie["bitrate_unit"]),
            saveOriginalDefault: boolean(movie["save_original_default"]),
            processingModes: array(movie["processing_modes"], modes),
            mp4Export: boolean(movie["mp4_export"]),
        },
        playbackSessions: {
            seconds: number(session["seconds"]),
            singleUseSemantics: text(session["single_use_semantics"]),
        },
        maxFileSize: decimal(input["max_file_size"]),
        taskRetentionSeconds: number(input["task_retention_seconds"]),
        taskNotifications: array(input["task_notifications"], text),
        cancellation: text(input["cancellation"]),
        archiveVersion: number(input["archive_version"]),
        exportPausesWrites: boolean(input["export_pauses_writes"]),
        mp4ExportRetentionSeconds: number(input["mp4_export_retention_seconds"]),
    };
};

/** Converts option keys to snake_case without changing text values. */
export const encodeOptions = (value: unknown): unknown => {
    if (isArray(value)) {
        return value.map(encodeOptions);
    }
    if (!isRecord(value)) {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
            key.replace(/[A-Z]/gu, (letter) => "_" + letter.toLowerCase()),
            encodeOptions(entry),
        ]),
    );
};
