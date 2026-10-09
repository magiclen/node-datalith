export type MediaKind = "resource" | "image" | "audio" | "video";
export type ProcessingMode = "transcode" | "trust";
/** How an output was made; newer services can send other values. */
export type ProcessingMethod = "unknown" | "copied" | "remuxed" | "transcoded" | (string & {});
export type ImageFormat = "webp" | "png" | "jpeg" | "gif";
export type VideoResolution =
    | 144
    | 240
    | 360
    | 432
    | 480
    | 540
    | 576
    | 720
    | 900
    | 1080
    | 1440
    | 2160;
export type VideoFrameRate = 10 | 12 | 15 | 20 | 24 | 25 | 30 | 48 | 50 | 60;
export type HlsAudio = "aac" | "all" | "flac";
export type ContentFormat = ImageFormat | "m4a" | "aac" | "flac";

export interface Retention {
    expiresInSeconds?: number | null;
    singleUse?: boolean;
}
export interface CropRatio {
    width: number;
    height: number;
}
export interface ImageVariantSpec {
    name?: string;
    maxWidth?: number | null;
    maxHeight?: number | null;
    crop?: CropRatio | null;
    multipliers?: readonly number[];
}
export interface ImageOptions {
    processingMode?: ProcessingMode;
    variants?: readonly ImageVariantSpec[];
    saveOriginal?: boolean;
}
export interface AudioOptions {
    processingMode?: ProcessingMode;
    saveOriginal?: boolean;
    preserveLossless?: boolean;
    audioStream?: number | null;
}
export interface VideoVariantSpec {
    /** The tier of the shorter canvas side, such as 1080 for 1920x1080 or 1080x1920. */
    resolution: VideoResolution;
    fps: VideoFrameRate;
}
export interface VideoOptions extends AudioOptions {
    /** Set the video sizes and frame rates; the service has no defaults. */
    variants: readonly VideoVariantSpec[];
}
interface UploadBase {
    fileName?: string;
    fileType?: string;
    retention?: Retention;
}
interface AutomaticOptions {
    enableConvertToImage?: boolean;
    enableConvertToAudio?: boolean;
    image?: ImageOptions;
    audio?: AudioOptions;
}
/** Keeps the upload as a resource, or converts it to an enabled kind that matches its contents. */
export type ResourceUploadOptions = UploadBase &
    AutomaticOptions & { kind?: "resource" } & (
        | { enableConvertToVideo?: false; video?: VideoOptions }
        | { enableConvertToVideo: true; video: VideoOptions }
    );
export interface ImageUploadOptions extends UploadBase {
    kind: "image";
    image?: ImageOptions;
}
export interface AudioUploadOptions extends UploadBase {
    kind: "audio";
    audio?: AudioOptions;
}
export interface VideoUploadOptions extends UploadBase {
    kind: "video";
    video: VideoOptions;
}
export type UploadOptions =
    | ResourceUploadOptions
    | ImageUploadOptions
    | AudioUploadOptions
    | VideoUploadOptions;
export interface ImageProcessOptions {
    kind: "image";
    image?: ImageOptions;
}
export interface AudioProcessOptions {
    kind: "audio";
    audio?: AudioOptions;
}
export interface VideoProcessOptions {
    kind: "video";
    video: VideoOptions;
}
export type ProcessOptions = ImageProcessOptions | AudioProcessOptions | VideoProcessOptions;
/** Accepts binary data from memory or a stream, including Node.js Readable. */
export type UploadSource =
    | Blob
    | Uint8Array
    | ReadableStream<Uint8Array>
    | AsyncIterable<Uint8Array>;

// Output types also accept values that this package does not know yet, such as a newer image format.
export interface MediaFile {
    readonly id: string;
    readonly sha256: string;
    /** The size in bytes. */
    readonly fileSize: number;
    readonly fileType: string;
    readonly fileName: string;
}
/** The recipe that created an image output, with every setting filled in. */
export interface ImageRecipe {
    readonly name: string;
    readonly maxWidth: number | null;
    readonly maxHeight: number | null;
    readonly crop: Readonly<CropRatio> | null;
    readonly multipliers: readonly number[];
}
export interface ImageVariant {
    /** Older stored outputs use `unknown`. */
    readonly processingMethod: ProcessingMethod;
    readonly name: string;
    readonly multiplier: number;
    readonly format: ImageFormat | (string & {});
    readonly width: number;
    readonly height: number;
    readonly animated: boolean;
    readonly file: MediaFile;
    readonly contentPath: string;
    readonly recipe: ImageRecipe | null;
}
export interface Rational {
    readonly numerator: number;
    readonly denominator: number;
}
export interface AudioVariant {
    readonly id: string;
    readonly codec: "aac" | "flac" | (string & {});
    readonly bitrate: number;
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitsPerSample: number | null;
    readonly processingMethod: ProcessingMethod;
    readonly file: MediaFile | null;
    readonly contentPath: string;
}
export interface AudioMedia {
    readonly durationSeconds: number;
    readonly variants: readonly AudioVariant[];
}
export interface VideoVariant {
    readonly id: string;
    readonly resolution: VideoResolution | (number & {});
    readonly width: number;
    readonly height: number;
    readonly fps: VideoFrameRate | (number & {});
    readonly frameRate: Rational;
    readonly leadingHoldSeconds: number;
    readonly codec: string;
    readonly processingMethod: ProcessingMethod;
    readonly playlistPath: string;
    readonly audio: readonly string[];
}
export interface VideoMedia {
    readonly durationSeconds: number;
    readonly variants: readonly VideoVariant[];
    readonly audio: readonly AudioVariant[];
    readonly masterPath: string;
}
export interface ProcessingWarning {
    readonly code: string;
    readonly message: string;
}
interface MediaBase {
    readonly id: string;
    readonly createdAt: Date;
    readonly fileName: string;
    readonly original: MediaFile | null;
    readonly variants: readonly ImageVariant[];
    readonly warnings: readonly ProcessingWarning[];
    readonly expiresAt: Date | null;
    readonly singleUse: boolean;
    readonly consumedAt: Date | null;
    readonly animated: boolean;
    readonly frameCount: number;
}
export interface ResourceMedia extends MediaBase {
    readonly kind: "resource";
    readonly audio?: undefined;
    readonly video?: undefined;
}
export interface ImageMedia extends MediaBase {
    readonly kind: "image";
    readonly audio?: undefined;
    readonly video?: undefined;
}
export interface StandaloneAudioMedia extends MediaBase {
    readonly kind: "audio";
    readonly audio: AudioMedia;
    readonly video?: undefined;
}
export interface HlsVideoMedia extends MediaBase {
    readonly kind: "video";
    readonly audio?: undefined;
    readonly video: VideoMedia;
}
export type Media = ResourceMedia | ImageMedia | StandaloneAudioMedia | HlsVideoMedia;
export type TaskKind = MediaKind | "upload" | "import" | "export" | "mp4_export";
export type TaskStatus = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export interface ImportResult {
    readonly archiveId: string;
    readonly imported: number;
    readonly skipped: number;
    readonly idMap: Readonly<Record<string, string>>;
    readonly fileIdMap: Readonly<Record<string, string>>;
}
export interface ExportResult {
    readonly artifactPath: string;
    readonly mediaCount: number;
    readonly artifact: MediaFile;
}
export interface Mp4ExportResult {
    readonly mediaId: string;
    readonly variant: string;
    readonly audio: "aac_low" | "aac_high" | "flac" | (string & {}) | null;
    readonly artifact: MediaFile;
    readonly artifactPath: string;
    readonly expiresAt: Date;
}
export interface TaskResults {
    resource: ResourceMedia;
    image: ImageMedia;
    audio: StandaloneAudioMedia;
    video: HlsVideoMedia;
    upload: Media;
    import: ImportResult;
    export: ExportResult;
    mp4_export: Mp4ExportResult;
}
/** Why a task failed or was cancelled. */
export interface TaskFailure {
    readonly code: string;
    readonly message: string;
}
interface TaskBase {
    readonly id: string;
    readonly status: TaskStatus;
    readonly stage: string;
    readonly completedUnits: number;
    readonly totalUnits: number | null;
    readonly attempt: number;
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly error: TaskFailure | null;
}
export type Task<K extends TaskKind = TaskKind> = K extends TaskKind
    ? TaskBase & { readonly kind: K; readonly result: TaskResults[K] | null }
    : never;
export type SuccessfulTask<K extends TaskKind = TaskKind> = Task<K> & {
    readonly status: "succeeded";
    readonly result: TaskResults[K];
};
export interface Page<T> {
    readonly items: readonly T[];
    readonly page: number;
    readonly perPage: number;
    readonly total: number;
}
export interface PlaybackSession {
    readonly token: string;
    readonly expiresAt: Date;
}
export interface Capabilities {
    readonly apiVersion: string;
    readonly version: string;
    /** These flags show processing support and do not limit reads of stored content. */
    readonly media: Readonly<Record<MediaKind, boolean>>;
    readonly image: {
        readonly engine: string;
        readonly animatedInputs: readonly string[];
        readonly outputs: readonly (ImageFormat | (string & {}))[];
        readonly apngRequiresFfmpeg: boolean;
        readonly apngTimingPrecisionMs: number;
        readonly limits: {
            readonly maxPixels: number;
            readonly maxFrames: number;
            readonly maxTotalPixels: number;
            readonly maxVariants: number;
            readonly maxMultiplier: number;
        };
        readonly processingModes: readonly (ProcessingMode | (string & {}))[];
        readonly saveOriginalDefault: boolean;
    };
    readonly av: {
        readonly available: boolean;
        readonly minimumToolMajor: number;
        readonly audioEncoder: boolean;
        readonly videoEncoder: boolean;
        readonly flacEncoder: boolean;
        readonly unavailableReason: string | null;
    };
    readonly audio: {
        readonly engine: string;
        readonly profiles: readonly string[];
        readonly aacSampleRate: number;
        readonly aacBitrates: readonly number[];
        readonly mp3Fallback: boolean;
        readonly saveOriginalDefault: boolean;
        readonly processingModes: readonly (ProcessingMode | (string & {}))[];
        readonly selectedAudioStreams: number;
    };
    readonly video: {
        readonly engine: string;
        readonly codec: string;
        readonly pixelFormat: string;
        readonly delivery: string;
        readonly requiresVariants: boolean;
        readonly resolutionTiers: readonly (VideoResolution | (number & {}))[];
        readonly frameRateTiers: readonly (VideoFrameRate | (number & {}))[];
        readonly bitrate: number;
        readonly bitrateUnit: string;
        readonly saveOriginalDefault: boolean;
        readonly processingModes: readonly (ProcessingMode | (string & {}))[];
        readonly mp4Export: boolean;
    };
    readonly playbackSessions: { readonly seconds: number; readonly singleUseSemantics: string };
    /** The upload limit in bytes; a very large limit can be rounded. */
    readonly maxFileSize: number;
    readonly taskRetentionSeconds: number;
    readonly taskNotifications: readonly string[];
    readonly cancellation: string;
    readonly archiveVersion: number;
    readonly exportPausesWrites: boolean;
    readonly mp4ExportRetentionSeconds: number;
}
