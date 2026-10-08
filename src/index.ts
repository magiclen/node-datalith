import { setTimeout as delay } from "node:timers/promises";

import { timeoutFetch } from "fetch-helper-x";
import type { TimeoutRequestInit } from "fetch-helper-x";

import {
    decodeCapabilities,
    decodeMedia,
    decodePage,
    decodeSession,
    decodeTask,
    encodeOptions,
    isRecord,
} from "./codec.ts";
import { DatalithError, DatalithProtocolError, TaskError, TaskWaitTimeoutError } from "./errors.ts";
import { multipart } from "./multipart.ts";
import type {
    Capabilities,
    ContentFormat,
    HlsAudio,
    Media,
    MediaKind,
    Page,
    PlaybackSession,
    ProcessOptions,
    SuccessfulTask,
    Task,
    TaskKind,
    UploadOptions,
    UploadSource,
} from "./types.ts";

export * from "./errors.ts";
export type * from "./types.ts";
export { TimeoutError, isAbortError, isTimeoutError } from "fetch-helper-x";

const DAY = 86_400_000;
const SHORT_TIMEOUT = 30_000;

export interface RequestOptions {
    headers?: HeadersInit;
    signal?: AbortSignal;
    requestTimeout?: number | null;
    idleTimeout?: number | null;
}
export type DatalithOptions = Omit<RequestOptions, "signal">;
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
export interface Mp4ExportOptions extends MutationOptions {
    session?: string;
}
export interface WaitOptions extends RequestOptions {
    /** Polls run one at a time. */
    pollInterval?: number;
    /** The local wait limit in milliseconds; null removes the limit. */
    waitTimeout?: number | null;
    onProgress?: (task: Task) => void;
}
type Query = Record<string, string | number | boolean | null | undefined>;

const segment = (value: string): string => {
    if (value.length === 0 || value === "." || value === ".." || /[/\\]/u.test(value)) {
        throw new TypeError("Expected a single non-empty path segment.");
    }
    return encodeURIComponent(value);
};
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    isRecord(value) ? value : undefined;

const hasKind = <K extends TaskKind>(task: Task, kinds: readonly K[]): task is Task<K> =>
    kinds.some((kind) => task.kind === kind);
const expectKind = <K extends TaskKind>(task: Task, kinds: readonly K[]): Task<K> => {
    if (!hasKind(task, kinds)) {
        throw new DatalithProtocolError("Unexpected task kind.");
    }
    return task;
};
const isSuccessful = (task: Task): task is SuccessfulTask =>
    task.status === "succeeded" && task.result !== null;

const httpError = async (response: Response): Promise<DatalithError> => {
    let data: Record<string, unknown> | undefined;
    try {
        data = asRecord(await response.json());
    } catch (error) {
        // Only ignore invalid JSON; keep stream and timeout errors.
        if (!(error instanceof SyntaxError)) {
            throw error;
        }
    }
    const error = asRecord(data?.["error"]);
    return new DatalithError(
        response.status,
        typeof error?.["code"] === "string" ? error["code"] : "http_error",
        typeof error?.["message"] === "string"
            ? error["message"]
            : "Datalith returned HTTP " + response.status + ".",
        response.headers.get("x-request-id") ??
            (typeof data?.["request_id"] === "string" ? data["request_id"] : null),
        response.headers.get("retry-after"),
    );
};
const json = async <T>(
    response: Response,
    expected: number,
    decode: (value: unknown) => T,
): Promise<T> => {
    try {
        if (response.status !== expected) {
            throw await httpError(response);
        }
        return decode(await response.json());
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
        streaming = false,
    ): Promise<Response> {
        const headers = new Headers(this.#defaults.headers);
        new Headers(options.headers).forEach((value, name) => headers.set(name, value));
        new Headers(init.headers).forEach((value, name) => headers.set(name, value));
        return timeoutFetch(url, {
            ...init,
            headers,
            redirect: "error",
            signal: options.signal,
            requestTimeout:
                options.requestTimeout !== undefined
                    ? options.requestTimeout
                    : this.#defaults.requestTimeout !== undefined
                      ? this.#defaults.requestTimeout
                      : streaming
                        ? DAY
                        : SHORT_TIMEOUT,
            idleTimeout:
                options.idleTimeout !== undefined
                    ? options.idleTimeout
                    : this.#defaults.idleTimeout !== undefined
                      ? this.#defaults.idleTimeout
                      : SHORT_TIMEOUT,
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
                    true,
                ),
                202,
                decodeTask,
            );
        } finally {
            form.close();
        }
    }

    async upload(
        source: UploadSource,
        processing: UploadOptions = {},
        options: MutationOptions = {},
    ): Promise<Task<MediaKind | "upload">> {
        return expectKind(await this.#upload("uploads", source, processing, options), [
            "resource",
            "image",
            "audio",
            "video",
            "upload",
        ]);
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
    async processMedia(
        id: string,
        processing: ProcessOptions,
        options: MutationOptions = {},
    ): Promise<Task<"image" | "audio" | "video">> {
        return expectKind(
            await this.#submit("media/" + segment(id) + "/tasks", processing, options),
            ["image", "audio", "video"],
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
        if (!Number.isFinite(interval) || interval <= 0) {
            throw new RangeError("pollInterval must be positive.");
        }
        if (
            timeout !== null &&
            (!Number.isInteger(timeout) || timeout < 0 || timeout > 2_147_483_647)
        ) {
            throw new RangeError("Invalid waitTimeout.");
        }
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
                // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for each poll request to finish.
                task ??= await this.getTask(id, { ...options, signal });
                if (task === null) {
                    throw new DatalithError(404, "not_found", "Task " + id + " was not found.");
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
            throw await httpError(response);
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
        return this.#request(url, { method: options.method ?? "GET", headers }, options, true);
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
