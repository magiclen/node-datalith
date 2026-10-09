import { ReadStream } from "node:fs";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { isTimeoutError, timeoutFetch } from "fetch-helper-x";
import type { TimeoutRequestInit } from "fetch-helper-x";

import {
    decodeCapabilities,
    decodeMedia,
    decodePage,
    decodeSession,
    decodeTask,
    encodeOptions,
} from "./codec.ts";
import { DatalithError, DatalithProtocolError, TaskError, TaskWaitTimeoutError } from "./errors.ts";
import { multipart } from "./multipart.ts";
import type {
    AudioProcessOptions,
    AudioUploadOptions,
    Capabilities,
    ContentFormat,
    HlsAudio,
    HlsVideoMedia,
    ImageMedia,
    ImageProcessOptions,
    ImageUploadOptions,
    Media,
    MediaKind,
    Page,
    PlaybackSession,
    ProcessOptions,
    ResourceUploadOptions,
    StandaloneAudioMedia,
    SuccessfulTask,
    Task,
    TaskKind,
    UploadOptions,
    UploadSource,
    VideoProcessOptions,
    VideoUploadOptions,
} from "./types.ts";

export * from "./errors.ts";
export type * from "./types.ts";
export { TimeoutError, isAbortError, isTimeoutError } from "fetch-helper-x";

const DAY = 86_400_000;
const SHORT_TIMEOUT = 30_000;
// The longest delay that `setTimeout` accepts; a longer one becomes 1 ms.
const MAX_DELAY = 2_147_483_647;
const MAX_RETRY_DELAY = 30_000;
// The service checks and stores an upload before it answers, which can take longer than the idle timeout for a large file.
// Node.js `fetch` also stops waiting for the response after 5 minutes.
const UPLOAD_RESPONSE_TIMEOUT = 300_000;

export interface RequestOptions {
    headers?: HeadersInit;
    signal?: AbortSignal;
    /** The limit in milliseconds for the whole request; null removes the limit. */
    requestTimeout?: number | null;
    /**
     * The longest time in milliseconds without progress while sending or receiving; null removes
     * the limit.
     */
    idleTimeout?: number | null;
    /**
     * The longest wait in milliseconds for the response after the request is sent; null removes the
     * limit.
     */
    responseTimeout?: number | null;
}
/** Default headers and timeouts for the requests of a client. */
export interface DatalithOptions {
    headers?: HeadersInit;
    /**
     * The limit in milliseconds for control requests, such as reading metadata, 30 seconds by
     * default.
     */
    requestTimeout?: number | null;
    /** The limit in milliseconds for uploads, imports, and downloads, 24 hours by default. */
    transferTimeout?: number | null;
    /** The longest time in milliseconds without progress, 30 seconds by default. */
    idleTimeout?: number | null;
    /**
     * The longest wait in milliseconds for the response after the request is sent; uploads and
     * imports wait 5 minutes by default, and other requests use `idleTimeout`.
     */
    responseTimeout?: number | null;
}
export interface MutationOptions extends RequestOptions {
    idempotencyKey?: string;
}
export interface SessionOptions extends RequestOptions {
    session?: string;
}
export interface DownloadOptions extends SessionOptions {
    method?: "GET" | "HEAD";
    range?: string;
    ifRange?: string;
    ifNoneMatch?: string;
}
export interface ContentOptions extends DownloadOptions {
    variant?: string;
    multiplier?: number;
    format?: ContentFormat;
    download?: boolean;
}
export interface HlsMasterOptions extends DownloadOptions {
    audio?: HlsAudio;
}
export type MediaOptions = SessionOptions;
export interface ListMediaOptions extends RequestOptions {
    page?: number;
    perPage?: number;
}
export type IterateMediaOptions = Omit<ListMediaOptions, "page">;
export interface Mp4ExportOptions extends MutationOptions {
    session?: string;
}
export interface WaitOptions extends RequestOptions {
    /** Polls run one at a time. */
    pollInterval?: number;
    /** The local wait limit in milliseconds; null removes the limit. */
    waitTimeout?: number | null;
    /**
     * How many polls in a row can fail with a temporary error, such as while the service restarts,
     * 10 by default.
     */
    maxPollRetries?: number;
    /** The first call gets the task that the wait starts with, so you can keep its ID. */
    onProgress?: (task: Task) => void;
}
type Query = Record<string, string | number | boolean | null | undefined>;
type RequestKind = "control" | "download" | "upload";

const segment = (value: string): string => {
    if (value.length === 0 || value === "." || value === ".." || /[/\\]/u.test(value)) {
        throw new TypeError("Expected a single non-empty path segment.");
    }
    return encodeURIComponent(value);
};

const hasKind = <K extends TaskKind>(task: Task, kinds: readonly K[]): task is Task<K> =>
    kinds.some((kind) => task.kind === kind);
const expectKind = <K extends TaskKind>(task: Task, kinds: readonly K[]): Task<K> => {
    if (!hasKind(task, kinds)) {
        throw new DatalithProtocolError("Unexpected task kind " + JSON.stringify(task.kind), {
            path: "kind",
        });
    }
    return task;
};
// Name the media after a file source, unless the service would reject the name.
const sourceName = (source: UploadSource): string | undefined => {
    let name: string | undefined;
    if (source instanceof File) {
        name = source.name;
    } else if (source instanceof ReadStream) {
        // A stream from a file handle has no path.
        const path: unknown = source.path;
        if (typeof path === "string" || path instanceof Buffer) {
            name = basename(path.toString());
        }
    }
    if (
        name === undefined ||
        name.trim() === "" ||
        Buffer.byteLength(name) > 512 ||
        /\p{Cc}/u.test(name)
    ) {
        return undefined;
    }
    return name;
};
// The service creates an `upload` task when any automatic conversion is enabled.
const uploadKind = (processing: UploadOptions): MediaKind | "upload" => {
    if (processing.kind === "image" || processing.kind === "audio" || processing.kind === "video") {
        return processing.kind;
    }
    return processing.enableConvertToImage === true ||
        processing.enableConvertToAudio === true ||
        processing.enableConvertToVideo === true
        ? "upload"
        : "resource";
};
const isSuccessful = (task: Task): task is SuccessfulTask =>
    task.status === "succeeded" && task.result !== null;
// Network failures, timeouts, and server errors can be temporary, such as while the service restarts.
const isTemporary = (error: unknown): boolean =>
    (error instanceof TypeError && error.cause !== undefined) ||
    isTimeoutError(error) ||
    (error instanceof DatalithError && error.status >= 500);
// `undefined` means that a timeout is not set, while `null` removes the limit.
const firstTimeout = (...timeouts: (number | null | undefined)[]): number | null | undefined =>
    timeouts.find((timeout) => timeout !== undefined);

const json = async <T>(
    response: Response,
    expected: number,
    decode: (value: unknown) => T,
): Promise<T> => {
    try {
        if (response.status !== expected) {
            throw await DatalithError.fromResponse(response);
        }
        let data: unknown;
        try {
            data = await response.json();
        } catch (error) {
            // Only report invalid JSON as a protocol error; keep stream and timeout errors.
            if (error instanceof SyntaxError) {
                throw new DatalithProtocolError("Expected a JSON response", { cause: error });
            }
            throw error;
        }
        return decode(data);
    } finally {
        if (!response.bodyUsed) {
            await response.body?.cancel();
        }
    }
};

/** Calls Datalith while the app handles its own routes and access checks. */
export class Datalith {
    readonly #baseUrl: URL;
    readonly #defaults: DatalithOptions;

    constructor(baseUrl: string | URL, options: DatalithOptions = {}) {
        this.#baseUrl = new URL(baseUrl);
        if (!["http:", "https:"].includes(this.#baseUrl.protocol)) {
            throw new TypeError("Expected an HTTP or HTTPS service URL.");
        }
        if (!this.#baseUrl.pathname.endsWith("/")) {
            this.#baseUrl.pathname += "/";
        }
        this.#baseUrl.search = "";
        this.#baseUrl.hash = "";
        this.#defaults = { ...options, headers: new Headers(options.headers) };
    }

    #url(path: string, query: Query = {}): URL {
        const url = new URL(path, this.#baseUrl);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined && value !== null) {
                url.searchParams.set(key, String(value));
            }
        }
        return url;
    }

    #request(
        url: URL,
        init: TimeoutRequestInit,
        options: RequestOptions = {},
        kind: RequestKind = "control",
    ): Promise<Response> {
        const defaults = this.#defaults;
        const headers = new Headers(defaults.headers);
        new Headers(options.headers).forEach((value, name) => headers.set(name, value));
        new Headers(init.headers).forEach((value, name) => headers.set(name, value));
        return timeoutFetch(url, {
            ...init,
            headers,
            redirect: "error",
            signal: options.signal,
            requestTimeout:
                kind === "control"
                    ? firstTimeout(options.requestTimeout, defaults.requestTimeout, SHORT_TIMEOUT)
                    : firstTimeout(options.requestTimeout, defaults.transferTimeout, DAY),
            idleTimeout: firstTimeout(options.idleTimeout, defaults.idleTimeout, SHORT_TIMEOUT),
            responseTimeout: firstTimeout(
                options.responseTimeout,
                defaults.responseTimeout,
                kind === "upload" ? UPLOAD_RESPONSE_TIMEOUT : undefined,
            ),
        });
    }

    async #submit(
        path: string,
        value: unknown,
        options: MutationOptions,
        query: Query = {},
    ): Promise<Task> {
        const headers = new Headers({ "content-type": "application/json" });
        if (options.idempotencyKey !== undefined) {
            headers.set("idempotency-key", options.idempotencyKey);
        }
        return await json(
            await this.#request(
                this.#url(path, query),
                { method: "POST", headers, body: JSON.stringify(encodeOptions(value)) },
                options,
            ),
            202,
            decodeTask,
        );
    }

    async #upload(
        path: string,
        source: UploadSource,
        processing: UploadOptions | undefined,
        options: MutationOptions,
    ): Promise<Task> {
        options.signal?.throwIfAborted();
        const headers = new Headers();
        if (options.idempotencyKey !== undefined) {
            headers.set("idempotency-key", options.idempotencyKey);
        }
        const form = multipart(source, processing, options.signal);
        headers.set("content-type", form.contentType);
        try {
            return await json(
                await this.#request(
                    this.#url(path),
                    { method: "POST", headers, body: form.body },
                    options,
                    "upload",
                ),
                202,
                decodeTask,
            );
        } finally {
            form.close();
        }
    }

    upload(
        source: UploadSource,
        processing: ImageUploadOptions,
        options?: MutationOptions,
    ): Promise<Task<"image">>;
    upload(
        source: UploadSource,
        processing: AudioUploadOptions,
        options?: MutationOptions,
    ): Promise<Task<"audio">>;
    upload(
        source: UploadSource,
        processing: VideoUploadOptions,
        options?: MutationOptions,
    ): Promise<Task<"video">>;
    upload(
        source: UploadSource,
        processing?: ResourceUploadOptions,
        options?: MutationOptions,
    ): Promise<Task<"resource" | "upload">>;
    upload(
        source: UploadSource,
        processing?: UploadOptions,
        options?: MutationOptions,
    ): Promise<Task<MediaKind | "upload">>;
    async upload(
        source: UploadSource,
        processing: UploadOptions = {},
        options: MutationOptions = {},
    ): Promise<Task<MediaKind | "upload">> {
        const fileName = processing.fileName ?? sourceName(source);
        return expectKind(
            await this.#upload(
                "uploads",
                source,
                fileName === undefined ? processing : { ...processing, fileName },
                options,
            ),
            [uploadKind(processing)],
        );
    }
    async importMedia(
        source: UploadSource,
        options: MutationOptions = {},
    ): Promise<Task<"import">> {
        return expectKind(await this.#upload("imports", source, undefined, options), ["import"]);
    }
    async exportMedia(
        ids?: readonly string[],
        options: MutationOptions = {},
    ): Promise<Task<"export">> {
        return expectKind(
            await this.#submit("exports", ids === undefined ? {} : { ids }, options),
            ["export"],
        );
    }
    processMedia(
        id: string,
        processing: ImageProcessOptions,
        options?: MutationOptions,
    ): Promise<Task<"image">>;
    processMedia(
        id: string,
        processing: AudioProcessOptions,
        options?: MutationOptions,
    ): Promise<Task<"audio">>;
    processMedia(
        id: string,
        processing: VideoProcessOptions,
        options?: MutationOptions,
    ): Promise<Task<"video">>;
    processMedia(
        id: string,
        processing: ProcessOptions,
        options?: MutationOptions,
    ): Promise<Task<"image" | "audio" | "video">>;
    async processMedia(
        id: string,
        processing: ProcessOptions,
        options: MutationOptions = {},
    ): Promise<Task<"image" | "audio" | "video">> {
        return expectKind(
            await this.#submit("media/" + segment(id) + "/tasks", processing, options),
            [processing.kind],
        );
    }
    async exportMp4(
        id: string,
        variant: string,
        options: Mp4ExportOptions = {},
    ): Promise<Task<"mp4_export">> {
        return expectKind(
            await this.#submit("media/" + segment(id) + "/mp4-exports", { variant }, options, {
                session: options.session,
            }),
            ["mp4_export"],
        );
    }
    async getTask(id: string, options: RequestOptions = {}): Promise<Task | null> {
        const response = await this.#request(
            this.#url("tasks/" + segment(id)),
            { method: "GET" },
            options,
        );
        if (response.status === 404) {
            await response.body?.cancel();
            return null;
        }
        return json(response, 200, decodeTask);
    }
    cancelTask(id: string, options: SessionOptions = {}): Promise<Task> {
        return this.#taskAction(id, "cancel", options);
    }
    retryTask(id: string, options: SessionOptions = {}): Promise<Task> {
        return this.#taskAction(id, "retry", options);
    }
    async #taskAction(id: string, action: string, options: SessionOptions): Promise<Task> {
        return json(
            await this.#request(
                this.#url("tasks/" + segment(id) + "/" + action, { session: options.session }),
                { method: "POST" },
                options,
            ),
            202,
            decodeTask,
        );
    }

    waitForTask<K extends TaskKind>(
        input: Task<K>,
        options?: WaitOptions,
    ): Promise<SuccessfulTask<K>>;
    waitForTask(input: string, options?: WaitOptions): Promise<SuccessfulTask>;
    async waitForTask(input: Task | string, options: WaitOptions = {}): Promise<SuccessfulTask> {
        const id = typeof input === "string" ? input : input.id;
        const interval = options.pollInterval ?? 1000;
        const timeout = options.waitTimeout === undefined ? DAY : options.waitTimeout;
        const retries = options.maxPollRetries ?? 10;
        if (!Number.isFinite(interval) || interval <= 0 || interval > MAX_DELAY) {
            throw new RangeError("pollInterval must be greater than 0 and at most 2147483647.");
        }
        if (
            timeout !== null &&
            (!Number.isInteger(timeout) || timeout < 0 || timeout > MAX_DELAY)
        ) {
            throw new RangeError("Invalid waitTimeout.");
        }
        if (!Number.isInteger(retries) || retries < 0) {
            throw new RangeError("maxPollRetries must be a non-negative integer.");
        }
        // Check the ID before polling, because a poll would retry a TypeError like a network failure.
        segment(id);
        const controller = new AbortController();
        const timer =
            timeout === null
                ? undefined
                : setTimeout(() => controller.abort(new TaskWaitTimeoutError(id)), timeout);
        const signal =
            options.signal === undefined
                ? controller.signal
                : AbortSignal.any([options.signal, controller.signal]);
        let task: Task | null = typeof input === "string" ? null : input;
        try {
            while (true) {
                signal.throwIfAborted();
                if (task === null) {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for each poll request to finish.
                    const polled = await this.#pollTask(
                        id,
                        { ...options, signal },
                        interval,
                        retries,
                    );
                    // A task keeps its kind, which the return type relies on.
                    task = typeof input === "string" ? polled : expectKind(polled, [input.kind]);
                }
                options.onProgress?.(task);
                signal.throwIfAborted();
                if (isSuccessful(task)) {
                    return task;
                }
                if (task.status === "failed" || task.status === "cancelled") {
                    throw new TaskError(task);
                }
                // oxlint-disable-next-line eslint/no-await-in-loop -- Wait before the next poll.
                await delay(interval, undefined, { signal });
                task = null;
            }
        } catch (error) {
            if (signal.aborted) {
                throw signal.reason as unknown;
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    // Read the task, and retry temporary failures with a delay that doubles each time.
    async #pollTask(
        id: string,
        options: RequestOptions & { signal: AbortSignal },
        interval: number,
        retries: number,
    ): Promise<Task> {
        let failures = 0;
        while (true) {
            let task: Task | null;
            try {
                // oxlint-disable-next-line eslint/no-await-in-loop -- Retry one poll at a time.
                task = await this.getTask(id, options);
            } catch (error) {
                if (failures >= retries || options.signal.aborted || !isTemporary(error)) {
                    throw error;
                }
                // oxlint-disable-next-line eslint/no-await-in-loop -- Wait before the next try.
                await delay(Math.min(interval * 2 ** failures, MAX_RETRY_DELAY), undefined, {
                    signal: options.signal,
                });
                failures++;
                continue;
            }
            if (task === null) {
                throw new DatalithError(404, "not_found", "Task " + id + " was not found.");
            }
            return task;
        }
    }

    uploadAndWait(
        source: UploadSource,
        processing: ImageUploadOptions,
        options?: MutationOptions & WaitOptions,
    ): Promise<ImageMedia>;
    uploadAndWait(
        source: UploadSource,
        processing: AudioUploadOptions,
        options?: MutationOptions & WaitOptions,
    ): Promise<StandaloneAudioMedia>;
    uploadAndWait(
        source: UploadSource,
        processing: VideoUploadOptions,
        options?: MutationOptions & WaitOptions,
    ): Promise<HlsVideoMedia>;
    uploadAndWait(
        source: UploadSource,
        processing?: UploadOptions,
        options?: MutationOptions & WaitOptions,
    ): Promise<Media>;
    async uploadAndWait(
        source: UploadSource,
        processing: UploadOptions = {},
        options: MutationOptions & WaitOptions = {},
    ): Promise<Media> {
        const task = await this.upload(source, processing, options);
        return (await this.waitForTask(task, options)).result;
    }
    async getMedia(id: string, options: MediaOptions = {}): Promise<Media | null> {
        const response = await this.#request(
            this.#url("media/" + segment(id), { session: options.session }),
            { method: "GET" },
            options,
        );
        if (response.status === 404) {
            await response.body?.cancel();
            return null;
        }
        return json(response, 200, decodeMedia);
    }
    async listMedia(options: ListMediaOptions = {}): Promise<Page<Media>> {
        return json(
            await this.#request(
                this.#url("media", { page: options.page, per_page: options.perPage }),
                { method: "GET" },
                options,
            ),
            200,
            decodePage,
        );
    }
    /**
     * Reads every page of media; media added or deleted meanwhile can be missed.
     *
     * @yields Each available media once.
     */
    async *iterateMedia(options: IterateMediaOptions = {}): AsyncGenerator<Media> {
        const seen = new Set<string>();
        let page = 1;
        while (true) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Read one page at a time.
            const result = await this.listMedia({ ...options, page });
            for (const item of result.items) {
                // New media move older media to later pages, so a page can repeat them.
                if (!seen.has(item.id)) {
                    seen.add(item.id);
                    yield item;
                }
            }
            if (result.items.length < result.perPage) {
                return;
            }
            page++;
        }
    }
    async deleteMedia(id: string, options: RequestOptions = {}): Promise<boolean> {
        const response = await this.#request(
            this.#url("media/" + segment(id)),
            { method: "DELETE" },
            options,
        );
        try {
            if (response.status === 204) {
                return true;
            }
            if (response.status === 404) {
                return false;
            }
            throw await DatalithError.fromResponse(response);
        } finally {
            if (!response.bodyUsed) {
                await response.body?.cancel();
            }
        }
    }
    async getCapabilities(options: RequestOptions = {}): Promise<Capabilities> {
        return json(
            await this.#request(this.#url("capabilities"), { method: "GET" }, options),
            200,
            decodeCapabilities,
        );
    }
    async claimPlaybackSession(
        id: string,
        options: MutationOptions = {},
    ): Promise<PlaybackSession> {
        const headers = new Headers();
        if (options.idempotencyKey !== undefined) {
            headers.set("idempotency-key", options.idempotencyKey);
        }
        return json(
            await this.#request(
                this.#url("media/" + segment(id) + "/playback-sessions"),
                { method: "POST", headers },
                options,
            ),
            201,
            decodeSession,
        );
    }

    getContentUrl(id: string, options: ContentOptions = {}): URL {
        return this.#url("media/" + segment(id) + "/content", {
            variant: options.variant,
            multiplier: options.multiplier,
            format: options.format,
            download: options.download,
            session: options.session,
        });
    }
    getArtifactUrl(id: string, options: SessionOptions = {}): URL {
        return this.#url("tasks/" + segment(id) + "/artifact", { session: options.session });
    }
    getHlsMasterUrl(id: string, options: HlsMasterOptions = {}): URL {
        return this.#url("media/" + segment(id) + "/hls/master.m3u8", {
            audio: options.audio,
            session: options.session,
        });
    }
    getHlsTrackUrl(id: string, track: string, options: SessionOptions = {}): URL {
        return this.#url("media/" + segment(id) + "/hls/" + segment(track) + "/index.m3u8", {
            session: options.session,
        });
    }
    getHlsAssetUrl(id: string, track: string, name: string, options: SessionOptions = {}): URL {
        if (!/^(?:init\.mp4|segment-\d+\.m4s)$/u.test(name)) {
            throw new TypeError("Invalid HLS asset name.");
        }
        return this.#url("media/" + segment(id) + "/hls/" + segment(track) + "/" + name, {
            session: options.session,
        });
    }
    #download(url: URL, options: DownloadOptions): Promise<Response> {
        const headers = new Headers({ "accept-encoding": "identity" });
        if (options.range !== undefined) {
            headers.set("range", options.range);
        }
        if (options.ifRange !== undefined) {
            headers.set("if-range", options.ifRange);
        }
        if (options.ifNoneMatch !== undefined) {
            headers.set("if-none-match", options.ifNoneMatch);
        }
        return this.#request(
            url,
            { method: options.method ?? "GET", headers },
            options,
            "download",
        );
    }
    /** Returns the service Response; read or cancel its body, even after an HTTP error. */
    getContent(id: string, options: ContentOptions = {}): Promise<Response> {
        return this.#download(this.getContentUrl(id, options), options);
    }
    getArtifact(id: string, options: DownloadOptions = {}): Promise<Response> {
        return this.#download(this.getArtifactUrl(id, options), options);
    }
    getHlsMaster(id: string, options: HlsMasterOptions = {}): Promise<Response> {
        return this.#download(this.getHlsMasterUrl(id, options), options);
    }
    getHlsTrack(id: string, track: string, options: DownloadOptions = {}): Promise<Response> {
        return this.#download(this.getHlsTrackUrl(id, track, options), options);
    }
    getHlsAsset(
        id: string,
        track: string,
        name: string,
        options: DownloadOptions = {},
    ): Promise<Response> {
        return this.#download(this.getHlsAssetUrl(id, track, name, options), options);
    }
}
