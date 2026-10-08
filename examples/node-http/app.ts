import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { ContentFormat, Datalith, DownloadOptions } from "node-datalith";

class BadRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BadRequestError";
    }
}

export interface ConsumerOptions {
    datalith: Datalith;
    /** Look up the media ID in app data, even after a playback session is claimed. */
    resolveMedia: (slug: string) => string | undefined | Promise<string | undefined>;
    resolveArtifact?: (slug: string) => string | undefined | Promise<string | undefined>;
    authorize: (request: IncomingMessage, slug: string) => boolean | Promise<boolean>;
    /** Called when the client disconnects before the response is complete. */
    onAbort?: (slug: string) => void;
}

const responseHeaders = [
    "content-type",
    "content-length",
    "content-disposition",
    "content-range",
    "accept-ranges",
    "cache-control",
    "etag",
    "last-modified",
    "date",
    "x-request-id",
    "x-content-type-options",
    "content-security-policy",
    "retry-after",
];
const header = (request: IncomingMessage, name: string): string | undefined => {
    const value = request.headers[name];
    return typeof value === "string" ? value : undefined;
};
const decodeSegment = (value: string): string => {
    let decoded: string;
    try {
        decoded = decodeURIComponent(value);
    } catch {
        throw new BadRequestError("Invalid path encoding.");
    }
    if (decoded === "." || decoded === ".." || /[/\\]/u.test(decoded) || decoded.includes("\0")) {
        throw new BadRequestError("Invalid application path.");
    }
    return decoded;
};
const contentFormat = (value: string | null): ContentFormat | undefined => {
    if (value === null) {
        return undefined;
    }
    const formats: readonly ContentFormat[] = ["webp", "png", "jpeg", "gif", "aac", "m4a", "flac"];
    for (const format of formats) {
        if (value === format) {
            return format;
        }
    }
    throw new BadRequestError("Invalid content format.");
};

const streamResponse = async (
    upstream: Response,
    downstream: ServerResponse,
    signal: AbortSignal,
): Promise<void> => {
    // Fetch unpacks compressed bodies but keeps the original length headers.
    const encoding = upstream.headers.get("content-encoding");
    if (encoding !== null && encoding !== "identity") {
        throw new Error("Unexpected upstream content encoding.");
    }
    downstream.statusCode = upstream.status;
    for (const name of responseHeaders) {
        const value = upstream.headers.get(name);
        if (value !== null) {
            downstream.setHeader(name, value);
        }
    }
    if (upstream.body === null) {
        downstream.end();
    } else {
        if (!(upstream.body instanceof NodeReadableStream)) {
            throw new Error("Expected a Node.js Web stream.");
        }
        await pipeline(Readable.fromWeb(upstream.body), downstream, { signal });
    }
};

/** Creates example app routes that call the SDK after access checks. */
export const createConsumerServer = (options: ConsumerOptions): Server =>
    createServer((request, response) => {
        const controller = new AbortController();
        let slug = "";
        let upstream: Response | undefined;
        response.once("close", () => {
            if (!response.writableFinished) {
                controller.abort(new Error("The downstream client disconnected."));
                options.onAbort?.(slug);
            }
        });
        const serve = async (): Promise<void> => {
            const method = request.method;
            if (method !== "GET" && method !== "HEAD") {
                response.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" });
                response.end();
                return;
            }
            const url = new URL(request.url ?? "/", "http://localhost");
            const watch =
                /^\/watch\/([^/]+)\/(master\.m3u8|[A-Za-z0-9_-]+\/(?:index\.m3u8|init\.mp4|segment-\d+\.m4s))$/u.exec(
                    url.pathname,
                );
            const file = /^\/files\/([^/]+)$/u.exec(url.pathname);
            const artifact = /^\/artifacts\/([^/]+)$/u.exec(url.pathname);
            const route = watch ?? file ?? artifact;
            if (route === null) {
                response.writeHead(404);
                response.end();
                return;
            }
            slug = decodeSegment(route[1]);
            if (!(await options.authorize(request, slug))) {
                response.writeHead(403, { "cache-control": "no-store" });
                response.end();
                return;
            }
            const id =
                artifact === null
                    ? await options.resolveMedia(slug)
                    : await options.resolveArtifact?.(slug);
            if (id === undefined) {
                response.writeHead(404);
                response.end();
                return;
            }
            const download: DownloadOptions = {
                method,
                signal: controller.signal,
                session: url.searchParams.get("session") ?? undefined,
                range: header(request, "range"),
                ifRange: header(request, "if-range"),
                ifNoneMatch: header(request, "if-none-match"),
            };
            if (artifact !== null) {
                upstream = await options.datalith.getArtifact(id, download);
            } else if (watch !== null) {
                const resource = watch[2];
                if (resource === "master.m3u8") {
                    const audio = url.searchParams.get("audio");
                    if (audio !== null && audio !== "aac" && audio !== "all" && audio !== "flac") {
                        throw new BadRequestError("Invalid HLS audio filter.");
                    }
                    upstream = await options.datalith.getHlsMaster(id, {
                        ...download,
                        audio: audio ?? undefined,
                    });
                } else {
                    const [track, name] = resource.split("/");
                    upstream =
                        name === "index.m3u8"
                            ? await options.datalith.getHlsTrack(id, track, download)
                            : await options.datalith.getHlsAsset(id, track, name, download);
                }
            } else {
                const multiplier = url.searchParams.get("multiplier");
                upstream = await options.datalith.getContent(id, {
                    ...download,
                    variant: url.searchParams.get("variant") ?? undefined,
                    multiplier: multiplier === null ? undefined : Number(multiplier),
                    format: contentFormat(url.searchParams.get("format")),
                    download: url.searchParams.get("download") === "true",
                });
            }
            await streamResponse(upstream, response, controller.signal);
        };
        void serve()
            .catch((error: unknown) => {
                if (response.destroyed) {
                    return;
                }
                if (response.headersSent) {
                    response.destroy(error instanceof Error ? error : new Error(String(error)));
                    return;
                }
                for (const name of response.getHeaderNames()) {
                    response.removeHeader(name);
                }
                response.writeHead(error instanceof BadRequestError ? 400 : 502, {
                    "content-type": "application/json",
                    "cache-control": "no-store",
                });
                response.end(
                    JSON.stringify({ error: "The application could not serve this request." }),
                );
            })
            .finally(() => {
                if (
                    upstream?.body !== null &&
                    upstream?.body !== undefined &&
                    !upstream.body.locked &&
                    !upstream.bodyUsed
                ) {
                    void upstream.body.cancel().catch(() => {});
                }
            });
    });
