import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

import { DatalithError } from "node-datalith";
import type { Datalith } from "node-datalith";

import { createConsumerHandler } from "../node-http/app.ts";
import { createUploadOptions, UploadOptionsError } from "./options.ts";

class RequestError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "RequestError";
    }
}

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
    });
    response.end(JSON.stringify(value));
};
const allowMethod = (
    request: IncomingMessage,
    response: ServerResponse,
    methods: readonly string[],
): boolean => {
    if (methods.includes(request.method ?? "")) {
        return true;
    }
    response.setHeader("allow", methods.join(", "));
    sendJson(response, 405, { error: "This request method is not allowed." });
    return false;
};
const readUpload = async function* (
    request: IncomingMessage,
    maxFileSize: number,
): AsyncGenerator<Uint8Array> {
    let size = 0;
    // Keep the socket open so upload errors can reach the browser.
    const chunks: AsyncIterable<unknown> = request.iterator({ destroyOnReturn: false });
    for await (const chunk of chunks) {
        if (!(chunk instanceof Uint8Array)) {
            throw new RequestError(400, "File content must be binary data.");
        }
        size += chunk.byteLength;
        if (size > maxFileSize) {
            throw new RequestError(413, "The file is larger than the Datalith upload limit.");
        }
        yield chunk;
    }
};

export const createDemoServer = (datalith: Datalith): Server => {
    const content = createConsumerHandler({
        datalith,
        resolveMedia: (id) => id,
        authorize: () => true,
    });
    const assets = new Map([
        ["/", { path: new URL("./public/index.html", import.meta.url), type: "text/html" }],
        ["/app.js", { path: new URL("./public/app.js", import.meta.url), type: "text/javascript" }],
        [
            "/player.js",
            { path: new URL("./public/player.js", import.meta.url), type: "text/javascript" },
        ],
        ["/style.css", { path: new URL("./public/style.css", import.meta.url), type: "text/css" }],
        [
            "/vendor/hls.mjs",
            {
                path: new URL(import.meta.resolve("hls.js/dist/hls.min.mjs")),
                type: "text/javascript",
            },
        ],
        [
            "/vendor/hls.worker.js",
            {
                path: new URL(import.meta.resolve("hls.js/dist/hls.worker.js")),
                type: "text/javascript",
            },
        ],
    ]);
    return createServer((request, response) => {
        response.setHeader("x-content-type-options", "nosniff");
        const controller = new AbortController();
        request.once("aborted", () => controller.abort());
        response.once("close", () => {
            if (!response.writableFinished) {
                controller.abort();
            }
        });
        const options = { signal: controller.signal };
        const serve = async (): Promise<void> => {
            const url = new URL(request.url ?? "/", "http://localhost");
            if (url.pathname.startsWith("/files/") || url.pathname.startsWith("/watch/")) {
                content(request, response);
                return;
            }
            const asset = assets.get(url.pathname);
            if (asset !== undefined) {
                if (!allowMethod(request, response, ["GET", "HEAD"])) {
                    return;
                }
                const info = await stat(asset.path);
                response.writeHead(200, {
                    "content-type": asset.type + "; charset=utf-8",
                    "content-length": info.size,
                    "cache-control": "no-cache",
                });
                if (request.method === "HEAD") {
                    response.end();
                } else {
                    await pipeline(createReadStream(asset.path), response, options);
                }
                return;
            }
            if (url.pathname === "/api/capabilities") {
                if (allowMethod(request, response, ["GET"])) {
                    sendJson(response, 200, await datalith.getCapabilities(options));
                }
                return;
            }
            if (url.pathname === "/api/uploads") {
                if (!allowMethod(request, response, ["POST"])) {
                    return;
                }
                const fileName = url.searchParams.get("fileName");
                if (fileName === null || fileName.trim() === "" || /[/\\\0]/u.test(fileName)) {
                    throw new RequestError(400, "Please provide a valid file name.");
                }
                const mode = url.searchParams.get("mode") ?? "auto";
                if (mode !== "auto" && mode !== "resource") {
                    throw new RequestError(
                        400,
                        "Choose automatic processing or keep the original only.",
                    );
                }
                const capabilities = await datalith.getCapabilities(options);
                const processing = createUploadOptions(
                    url.searchParams.get("options"),
                    mode,
                    capabilities,
                );
                const length = request.headers["content-length"];
                if (length !== undefined && Number(length) > capabilities.maxFileSize) {
                    throw new RequestError(
                        413,
                        "The file is larger than the Datalith upload limit.",
                    );
                }
                const task = await datalith.upload(
                    readUpload(request, capabilities.maxFileSize),
                    {
                        ...processing,
                        fileName,
                        fileType: request.headers["content-type"] ?? "application/octet-stream",
                    },
                    options,
                );
                sendJson(response, 202, task);
                return;
            }
            if (url.pathname === "/api/media") {
                if (!allowMethod(request, response, ["GET"])) {
                    return;
                }
                const page = Number(url.searchParams.get("page") ?? "1");
                if (!Number.isSafeInteger(page) || page < 1) {
                    throw new RequestError(400, "The page number must be a positive integer.");
                }
                sendJson(
                    response,
                    200,
                    await datalith.listMedia({ ...options, page, perPage: 20 }),
                );
                return;
            }
            const claim = /^\/api\/media\/([0-9a-f-]+)\/playback-sessions$/iu.exec(url.pathname);
            if (claim !== null) {
                if (!allowMethod(request, response, ["POST"])) {
                    return;
                }
                const key = request.headers["idempotency-key"];
                if (typeof key !== "string" || key.trim() === "") {
                    throw new RequestError(
                        400,
                        "A playback claim needs an Idempotency-Key header.",
                    );
                }
                sendJson(
                    response,
                    201,
                    await datalith.claimPlaybackSession(claim[1], {
                        ...options,
                        idempotencyKey: key,
                    }),
                );
                return;
            }
            const route = /^\/api\/(media|tasks)\/([0-9a-f-]+)$/iu.exec(url.pathname);
            if (route !== null) {
                const [, kind, id] = route;
                if (
                    !allowMethod(request, response, kind === "media" ? ["GET", "DELETE"] : ["GET"])
                ) {
                    return;
                }
                if (request.method === "DELETE") {
                    const deleted = await datalith.deleteMedia(id, options);
                    sendJson(
                        response,
                        deleted ? 200 : 404,
                        deleted ? { deleted } : { error: "Item not found." },
                    );
                } else {
                    const result =
                        kind === "media"
                            ? await datalith.getMedia(id, {
                                  ...options,
                                  session: url.searchParams.get("session") ?? undefined,
                              })
                            : await datalith.getTask(id, options);
                    sendJson(
                        response,
                        result === null ? 404 : 200,
                        result ?? { error: "Item not found." },
                    );
                }
                return;
            }
            sendJson(response, 404, { error: "Page not found." });
        };
        void serve().catch((error: unknown) => {
            if (response.destroyed) {
                return;
            }
            if (response.headersSent) {
                response.destroy(error instanceof Error ? error : undefined);
                return;
            }
            const status =
                error instanceof UploadOptionsError
                    ? 400
                    : error instanceof RequestError || error instanceof DatalithError
                      ? error.status
                      : 502;
            sendJson(response, status, {
                error:
                    error instanceof UploadOptionsError ||
                    error instanceof RequestError ||
                    error instanceof DatalithError
                        ? error.message
                        : "Could not connect to Datalith. Check the service URL and make sure it is running.",
                code: error instanceof DatalithError ? error.code : undefined,
            });
            request.resume();
        });
    });
};
