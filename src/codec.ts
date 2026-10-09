import { DatalithProtocolError } from "./errors.ts";
import type {
    AudioMedia,
    AudioVariant,
    Capabilities,
    CropRatio,
    ExportResult,
    ImageRecipe,
    ImageVariant,
    ImportResult,
    Media,
    MediaFile,
    MediaKind,
    Mp4ExportResult,
    Page,
    PlaybackSession,
    ProcessingWarning,
    Rational,
    Task,
    TaskFailure,
    TaskStatus,
    VideoMedia,
    VideoVariant,
} from "./types.ts";

/** Decodes a JSON value; `path` tells where the value is, such as `items[0].file_name`. */
type Decoder<T> = (value: unknown, path: string) => T;
/** Decodes one field of a JSON object. */
type Field = <T>(key: string, decode: Decoder<T>) => T;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const child = (path: string, key: string): string => (path === "" ? key : path + "." + key);
const describe = (value: unknown): string =>
    typeof value === "string" ? JSON.stringify(value) : String(value);

const record = (value: unknown, path: string): Record<string, unknown> => {
    if (!isRecord(value)) {
        throw new DatalithProtocolError("Expected a JSON object", { path });
    }
    return value;
};
const fields = (value: unknown, path: string): Field => {
    const input = record(value, path);
    return (key, decode) => decode(input[key], child(path, key));
};
const text = (value: unknown, path: string): string => {
    if (typeof value !== "string") {
        throw new DatalithProtocolError("Expected a string", { path });
    }
    return value;
};
const number = (value: unknown, path: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new DatalithProtocolError("Expected a finite number", { path });
    }
    return value;
};
const boolean = (value: unknown, path: string): boolean => {
    if (typeof value !== "boolean") {
        throw new DatalithProtocolError("Expected a boolean", { path });
    }
    return value;
};
const date = (value: unknown, path: string): Date => {
    const parsed = new Date(text(value, path));
    if (Number.isNaN(parsed.getTime())) {
        throw new DatalithProtocolError("Expected a date", { path });
    }
    return parsed;
};
const decimal = (value: unknown, path: string): string => {
    const parsed = text(value, path);
    if (!/^\d+$/u.test(parsed)) {
        throw new DatalithProtocolError("Expected a decimal string", { path });
    }
    return parsed;
};
const array =
    <T>(decode: Decoder<T>): Decoder<T[]> =>
    (value, path) => {
        if (!isArray(value)) {
            throw new DatalithProtocolError("Expected a JSON array", { path });
        }
        return value.map((entry, index) => decode(entry, path + "[" + index + "]"));
    };
const nullable =
    <T>(decode: Decoder<T>): Decoder<T | null> =>
    (value, path) =>
        value === null ? null : decode(value, path);
// The service leaves out some fields when they have their default values.
const optional =
    <T>(decode: Decoder<T>, fallback: T): Decoder<T> =>
    (value, path) =>
        value === undefined ? fallback : decode(value, path);
const oneOf =
    <T extends string | number>(values: readonly T[]): Decoder<T> =>
    (value, path) => {
        for (const candidate of values) {
            if (value === candidate) {
                return candidate;
            }
        }
        throw new DatalithProtocolError("Unknown value " + describe(value), { path });
    };

const rational = (value: unknown, path: string): Rational => {
    const field = fields(value, path);
    return { numerator: field("numerator", number), denominator: field("denominator", number) };
};
const file = (value: unknown, path: string): MediaFile => {
    const field = fields(value, path);
    return {
        id: field("id", text),
        sha256: field("sha256", text),
        fileSize: field("file_size", decimal),
        fileType: field("file_type", text),
        fileName: field("file_name", text),
    };
};
const crop = (value: unknown, path: string): CropRatio => {
    const field = fields(value, path);
    return { width: field("width", number), height: field("height", number) };
};
const recipe = (value: unknown, path: string): ImageRecipe => {
    const field = fields(value, path);
    return {
        name: field("name", text),
        maxWidth: field("max_width", nullable(number)),
        maxHeight: field("max_height", nullable(number)),
        crop: field("crop", nullable(crop)),
        multipliers: field("multipliers", array(number)),
    };
};
const imageVariant = (value: unknown, path: string): ImageVariant => {
    const field = fields(value, path);
    return {
        processingMethod: field("processing_method", optional(text, "unknown")),
        name: field("name", text),
        multiplier: field("multiplier", number),
        format: field("format", text),
        width: field("width", number),
        height: field("height", number),
        animated: field("animated", boolean),
        file: field("file", file),
        contentPath: field("content_path", text),
        recipe: field("recipe", nullable(recipe)),
    };
};
const audioVariant = (value: unknown, path: string): AudioVariant => {
    const field = fields(value, path);
    return {
        id: field("id", text),
        codec: field("codec", text),
        bitrate: field("bitrate", number),
        sampleRate: field("sample_rate", number),
        channels: field("channels", number),
        bitsPerSample: field("bits_per_sample", nullable(number)),
        processingMethod: field("processing_method", text),
        file: field("file", nullable(file)),
        contentPath: field("content_path", text),
    };
};
const audio = (value: unknown, path: string): AudioMedia => {
    const field = fields(value, path);
    return {
        durationSeconds: field("duration_seconds", number),
        variants: field("variants", array(audioVariant)),
    };
};
const videoVariant = (value: unknown, path: string): VideoVariant => {
    const field = fields(value, path);
    return {
        id: field("id", text),
        resolution: field("resolution", number),
        width: field("width", number),
        height: field("height", number),
        fps: field("fps", number),
        frameRate: field("frame_rate", rational),
        leadingHoldSeconds: field("leading_hold_seconds", optional(number, 0)),
        codec: field("codec", text),
        processingMethod: field("processing_method", text),
        playlistPath: field("playlist_path", text),
        audio: field("audio", array(text)),
    };
};
const video = (value: unknown, path: string): VideoMedia => {
    const field = fields(value, path);
    return {
        durationSeconds: field("duration_seconds", number),
        variants: field("variants", array(videoVariant)),
        audio: field("audio", array(audioVariant)),
        masterPath: field("master_path", text),
    };
};
const warning = (value: unknown, path: string): ProcessingWarning => {
    const field = fields(value, path);
    return { code: field("code", text), message: field("message", text) };
};
const failure = (value: unknown, path: string): TaskFailure => {
    const field = fields(value, path);
    return { code: field("code", text), message: field("message", text) };
};

export const decodeMedia = (value: unknown, path = ""): Media => {
    const field = fields(value, path);
    const base = {
        id: field("id", text),
        createdAt: field("created_at", date),
        fileName: field("file_name", text),
        original: field("original", nullable(file)),
        variants: field("variants", array(imageVariant)),
        warnings: field("warnings", optional(array(warning), [])),
        expiresAt: field("expires_at", nullable(date)),
        singleUse: field("single_use", boolean),
        consumedAt: field("consumed_at", nullable(date)),
        animated: field("animated", boolean),
        frameCount: field("frame_count", number),
    };
    const kind = field("kind", text);
    switch (kind) {
        case "resource":
            return { ...base, kind };
        case "image":
            return { ...base, kind };
        case "audio":
            return { ...base, kind, audio: field("audio", audio) };
        case "video":
            return { ...base, kind, video: field("video", video) };
        default:
            throw new DatalithProtocolError("Unknown media kind " + describe(kind), {
                path: child(path, "kind"),
            });
    }
};
const isKind = <K extends MediaKind>(media: Media, kind: K): media is Extract<Media, { kind: K }> =>
    media.kind === kind;
// A task for one media kind must create media of that kind.
const mediaOf =
    <K extends MediaKind>(kind: K): Decoder<Extract<Media, { kind: K }>> =>
    (value, path) => {
        const media = decodeMedia(value, path);
        if (!isKind(media, kind)) {
            throw new DatalithProtocolError("Expected " + kind + " media", {
                path: child(path, "kind"),
            });
        }
        return media;
    };
const dictionary = (value: unknown, path: string): Record<string, string> =>
    Object.fromEntries(
        Object.entries(record(value, path)).map(([key, entry]) => [
            key,
            text(entry, child(path, key)),
        ]),
    );
const imported = (value: unknown, path: string): ImportResult => {
    const field = fields(value, path);
    return {
        archiveId: field("archive_id", text),
        imported: field("imported", number),
        skipped: field("skipped", number),
        idMap: field("id_map", dictionary),
        fileIdMap: field("file_id_map", dictionary),
    };
};
const exported = (value: unknown, path: string): ExportResult => {
    const field = fields(value, path);
    return {
        artifactPath: field("artifact_path", text),
        mediaCount: field("media_count", number),
        artifact: field("artifact", file),
    };
};
const mp4 = (value: unknown, path: string): Mp4ExportResult => {
    const field = fields(value, path);
    return {
        mediaId: field("media_id", text),
        variant: field("variant", text),
        audio: field("audio", nullable(text)),
        artifact: field("artifact", file),
        artifactPath: field("artifact_path", text),
        expiresAt: field("expires_at", date),
    };
};
export const decodeTask = (value: unknown, path = ""): Task => {
    const field = fields(value, path);
    const base = {
        id: field("id", text),
        status: field(
            "status",
            oneOf<TaskStatus>([
                "queued",
                "running",
                "cancelling",
                "succeeded",
                "failed",
                "cancelled",
            ]),
        ),
        stage: field("stage", text),
        completedUnits: field("completed_units", number),
        totalUnits: field("total_units", nullable(number)),
        attempt: field("attempt", number),
        createdAt: field("created_at", date),
        updatedAt: field("updated_at", date),
        error: field("error", nullable(failure)),
    };
    const result = <T>(decode: Decoder<T>): T | null => {
        const decoded = field("result", nullable(decode));
        if (decoded === null && base.status === "succeeded") {
            throw new DatalithProtocolError("Expected the result of a successful task", {
                path: child(path, "result"),
            });
        }
        return decoded;
    };
    const kind = field("kind", text);
    switch (kind) {
        case "upload":
            return { ...base, kind, result: result(decodeMedia) };
        case "import":
            return { ...base, kind, result: result(imported) };
        case "export":
            return { ...base, kind, result: result(exported) };
        case "mp4_export":
            return { ...base, kind, result: result(mp4) };
        case "resource":
            return { ...base, kind, result: result(mediaOf(kind)) };
        case "image":
            return { ...base, kind, result: result(mediaOf(kind)) };
        case "audio":
            return { ...base, kind, result: result(mediaOf(kind)) };
        case "video":
            return { ...base, kind, result: result(mediaOf(kind)) };
        default:
            throw new DatalithProtocolError("Unknown task kind " + describe(kind), {
                path: child(path, "kind"),
            });
    }
};
export const decodePage = (value: unknown, path = ""): Page<Media> => {
    const field = fields(value, path);
    return {
        items: field("items", array(decodeMedia)),
        page: field("page", number),
        perPage: field("per_page", number),
        total: field("total", decimal),
    };
};
export const decodeSession = (value: unknown, path = ""): PlaybackSession => {
    const field = fields(value, path);
    return { token: field("token", text), expiresAt: field("expires_at", date) };
};

const mediaCapabilities = (value: unknown, path: string): Capabilities["media"] => {
    const field = fields(value, path);
    return {
        resource: field("resource", boolean),
        image: field("image", boolean),
        audio: field("audio", boolean),
        video: field("video", boolean),
    };
};
const imageLimits = (value: unknown, path: string): Capabilities["image"]["limits"] => {
    const field = fields(value, path);
    return {
        maxPixels: field("max_pixels", number),
        maxFrames: field("max_frames", number),
        maxTotalPixels: field("max_total_pixels", number),
        maxVariants: field("max_variants", number),
        maxMultiplier: field("max_multiplier", number),
    };
};
const imageCapabilities = (value: unknown, path: string): Capabilities["image"] => {
    const field = fields(value, path);
    return {
        engine: field("engine", text),
        animatedInputs: field("animated_inputs", array(text)),
        outputs: field("outputs", array(text)),
        apngRequiresFfmpeg: field("apng_requires_ffmpeg", boolean),
        apngTimingPrecisionMs: field("apng_timing_precision_ms", number),
        limits: field("limits", imageLimits),
        processingModes: field("processing_modes", array(text)),
        saveOriginalDefault: field("save_original_default", boolean),
    };
};
const avCapabilities = (value: unknown, path: string): Capabilities["av"] => {
    const field = fields(value, path);
    return {
        available: field("available", boolean),
        minimumToolMajor: field("minimum_tool_major", number),
        audioEncoder: field("audio_encoder", boolean),
        videoEncoder: field("video_encoder", boolean),
        flacEncoder: field("flac_encoder", boolean),
        unavailableReason: field("unavailable_reason", nullable(text)),
    };
};
const audioCapabilities = (value: unknown, path: string): Capabilities["audio"] => {
    const field = fields(value, path);
    return {
        engine: field("engine", text),
        profiles: field("profiles", array(text)),
        aacSampleRate: field("aac_sample_rate", number),
        aacBitrates: field("aac_bitrates", array(number)),
        mp3Fallback: field("mp3_fallback", boolean),
        saveOriginalDefault: field("save_original_default", boolean),
        processingModes: field("processing_modes", array(text)),
        selectedAudioStreams: field("selected_audio_streams", number),
    };
};
const videoCapabilities = (value: unknown, path: string): Capabilities["video"] => {
    const field = fields(value, path);
    return {
        engine: field("engine", text),
        codec: field("codec", text),
        pixelFormat: field("pixel_format", text),
        delivery: field("delivery", text),
        requiresVariants: field("requires_variants", boolean),
        resolutionTiers: field("resolution_tiers", array(number)),
        frameRateTiers: field("frame_rate_tiers", array(number)),
        bitrate: field("bitrate", number),
        bitrateUnit: field("bitrate_unit", text),
        saveOriginalDefault: field("save_original_default", boolean),
        processingModes: field("processing_modes", array(text)),
        mp4Export: field("mp4_export", boolean),
    };
};
const sessionCapabilities = (value: unknown, path: string): Capabilities["playbackSessions"] => {
    const field = fields(value, path);
    return {
        seconds: field("seconds", number),
        singleUseSemantics: field("single_use_semantics", text),
    };
};
export const decodeCapabilities = (value: unknown, path = ""): Capabilities => {
    const field = fields(value, path);
    return {
        apiVersion: field("api_version", text),
        version: field("version", text),
        media: field("media", mediaCapabilities),
        image: field("image", imageCapabilities),
        av: field("av", avCapabilities),
        audio: field("audio", audioCapabilities),
        video: field("video", videoCapabilities),
        playbackSessions: field("playback_sessions", sessionCapabilities),
        maxFileSize: field("max_file_size", decimal),
        taskRetentionSeconds: field("task_retention_seconds", number),
        taskNotifications: field("task_notifications", array(text)),
        cancellation: field("cancellation", text),
        archiveVersion: field("archive_version", number),
        exportPausesWrites: field("export_pauses_writes", boolean),
        mp4ExportRetentionSeconds: field("mp4_export_retention_seconds", number),
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
