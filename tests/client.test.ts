import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { after, before, describe, it } from "node:test";

import { Datalith, DatalithError, TaskError, TaskWaitTimeoutError } from "../src/index.ts";
import type { ExportResult } from "../src/index.ts";

const ID = "ab975c7a-f924-4415-a312-772f4fc61b71";
const created = "2026-10-08T00:00:00.000Z";
const file = {
    id: ID,
    sha256: "a".repeat(64),
    file_size: "9007199254740993",
    file_type: "text/plain",
    file_name: "測試.txt",
};
const media = {
    id: ID,
    kind: "resource",
    created_at: created,
    file_name: "測試.txt",
    original: file,
    variants: [],
    expires_at: null,
    single_use: false,
    consumed_at: null,
    animated: false,
    frame_count: 0,
};
const task = (
    status = "queued",
    result: unknown = null,
    kind = "resource",
): Record<string, unknown> => ({
    id: ID,
    kind,
    status,
    stage: status,
    completed_units: 0,
    total_units: null,
    attempt: 0,
    created_at: created,
    updated_at: created,
    result,
    error: null,
});
const send = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
};

describe("Datalith client", () => {
    let datalith: Datalith;
    let baseUrl: URL;
    let polls = 0;
    let state = "succeeded";
    let uploadedOptions: unknown;
    let uploadedFile = "";
    let lastHeaders: IncomingMessage["headers"];

    const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const url = new URL(request.url ?? "/", "http://localhost");
        assert.ok(url.pathname.startsWith("/internal/datalith/"));
        assert.equal(request.headers["x-default"], "yes");
        const path = url.pathname.slice("/internal/datalith/".length);
        lastHeaders = request.headers;
        if (path === "uploads" && request.headers["idempotency-key"] === "pending") {
            request.resume();
            response.on("close", () => request.destroy());
        } else if (path === "media/slow/tasks") {
            response.writeHead(503, { "content-type": "application/json" });
            response.write('{"error":');
        } else if (path === "uploads") {
            assert.equal(request.method, "POST");
            assert.equal(request.headers["content-length"], undefined);
            const body = (await buffer(request)).toString();
            const options =
                /name="options"\r\nContent-Type: application\/json\r\n\r\n([^\r]*)/u.exec(body);
            assert.ok(options);
            uploadedOptions = JSON.parse(options[1]) as unknown;
            const content =
                /name="file"\r\nContent-Type: application\/octet-stream\r\n\r\n([\s\S]*?)\r\n--/u.exec(
                    body,
                );
            assert.ok(content);
            uploadedFile = content[1];
            polls = 0;
            send(response, 202, task());
        } else if (path === "tasks/" + ID) {
            polls++;
            send(
                response,
                200,
                task(
                    polls === 1 ? "running" : state,
                    state === "succeeded" && polls > 1 ? media : null,
                ),
            );
        } else if (path === "tasks/" + ID + "/cancel") {
            send(response, 202, task("cancelled"));
        } else if (path === "tasks/" + ID + "/retry") {
            send(response, 202, task());
        } else if (path === "media/" + ID) {
            if (request.method === "DELETE") {
                response.writeHead(204);
                response.end();
            } else {
                send(response, 200, media);
            }
        } else if (path === "media") {
            assert.equal(url.searchParams.get("per_page"), "10");
            send(response, 200, {
                items: [media],
                page: 1,
                per_page: 10,
                total: "9007199254740993",
            });
        } else if (path === "exports") {
            send(
                response,
                202,
                task(
                    "succeeded",
                    { artifact_path: "tasks/" + ID + "/artifact", media_count: 1, artifact: file },
                    "export",
                ),
            );
        } else if (path === "media/" + ID + "/mp4-exports") {
            assert.equal(url.searchParams.get("session"), "secret");
            send(
                response,
                202,
                task(
                    "succeeded",
                    {
                        media_id: ID,
                        variant: "144p12",
                        audio: null,
                        artifact: file,
                        artifact_path: "tasks/" + ID + "/artifact",
                        expires_at: created,
                    },
                    "mp4_export",
                ),
            );
        } else if (path === "media/" + ID + "/playback-sessions") {
            assert.equal(request.headers["idempotency-key"], "claim");
            send(response, 201, { token: "f".repeat(64), expires_at: created });
        } else if (path === "media/" + ID + "/content") {
            assert.match(
                String(request.headers["accept-encoding"]),
                /^identity(?:,\s*identity)*$/u,
            );
            assert.equal(url.searchParams.get("download"), "true");
            if (request.headers["if-none-match"] === '"etag"') {
                response.writeHead(304, { etag: '"etag"' });
                response.end();
            } else {
                response.writeHead(206, {
                    "content-range": "bytes 1-4/12",
                    "content-length": "4",
                    etag: '"etag"',
                    "cache-control": "no-store",
                });
                response.end("ello");
            }
        } else if (path === "media/error/tasks") {
            response.setHeader("x-request-id", "request-123");
            response.setHeader("retry-after", "1");
            send(response, 503, {
                error: { code: "writes_paused", message: "Writes are paused." },
                request_id: "request-123",
            });
        } else {
            send(response, 404, { error: { code: "not_found", message: "Not found." } });
        }
    };
    const server = createServer((request, response) => {
        void route(request, response).catch((error: unknown) =>
            response.destroy(error instanceof Error ? error : new Error(String(error))),
        );
    });
    before(async () => {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address !== null && typeof address !== "string");
        baseUrl = new URL("http://127.0.0.1:" + address.port + "/internal/datalith");
        datalith = new Datalith(baseUrl, { headers: { "x-default": "yes" } });
        assert.equal(baseUrl.pathname, "/internal/datalith");
    });
    after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
        );
    });

    it("streams an upload, waits for its task, and reads typed metadata", async () => {
        const progress: string[] = [];
        state = "succeeded";
        const saved = await datalith.uploadAndWait(
            Readable.from([Buffer.from("Hello "), Buffer.from("world!")]),
            {
                fileName: "測試.txt",
                retention: { expiresInSeconds: 60 },
                enableConvertToImage: true,
            },
            {
                idempotencyKey: "upload",
                pollInterval: 1,
                onProgress: (current) => {
                    progress.push(current.status);
                },
            },
        );
        assert.equal(uploadedFile, "Hello world!");
        assert.deepEqual(uploadedOptions, {
            file_name: "測試.txt",
            retention: { expires_in_seconds: 60 },
            enable_convert_to_image: true,
        });
        assert.deepEqual(progress, ["queued", "running", "succeeded"]);
        assert.equal(saved.original?.fileSize, "9007199254740993");
        assert.ok(saved.createdAt instanceof Date);
        assert.equal(saved.expiresAt, null);
        assert.deepEqual(await datalith.getMedia(ID), saved);
        const page = await datalith.listMedia({ perPage: 10 });
        assert.equal(page.total, "9007199254740993");
        assert.equal(page.perPage, 10);
        assert.equal(page.items[0].id, ID);
        assert.equal(await datalith.deleteMedia(ID), true);
        assert.equal(await datalith.deleteMedia("missing"), false);
        assert.equal(await datalith.getMedia("missing"), null);
        assert.equal(await datalith.getTask("missing"), null);
    });

    it("preserves download responses, ranges, conditions and upstream URLs", async () => {
        const response = await datalith.getContent(ID, {
            download: true,
            range: "bytes=1-4",
            ifRange: '"etag"',
        });
        assert.ok(response instanceof Response);
        assert.equal(response.status, 206);
        assert.equal(response.headers.get("content-range"), "bytes 1-4/12");
        assert.equal(await response.text(), "ello");
        assert.equal(lastHeaders["range"], "bytes=1-4");
        const cached = await datalith.getContent(ID, { download: true, ifNoneMatch: '"etag"' });
        assert.equal(cached.status, 304);
        assert.equal(cached.body, null);
        const head = await datalith.getContent(ID, { method: "HEAD", download: true });
        assert.equal(head.body, null);
        assert.equal(head.headers.get("content-length"), "4");
        const master = datalith.getHlsMasterUrl(ID, { session: "secret", audio: "all" });
        assert.equal(master.pathname, "/internal/datalith/media/" + ID + "/hls/master.m3u8");
        assert.equal(master.searchParams.get("session"), "secret");
        assert.equal(
            datalith.getHlsAssetUrl(ID, "aac_low", "init.mp4").pathname,
            "/internal/datalith/media/" + ID + "/hls/aac_low/init.mp4",
        );
    });

    it("decodes archive and MP4 task results and playback sessions", async () => {
        const exported = await datalith.exportMedia([ID]);
        assert.equal(exported.result?.artifact.fileSize, file.file_size);
        const completed = await datalith.waitForTask(exported);
        const result: ExportResult = completed.result;
        assert.equal(result.mediaCount, 1);
        const mp4 = await datalith.exportMp4(ID, "144p12", { session: "secret" });
        assert.ok(mp4.result?.expiresAt instanceof Date);
        assert.equal(mp4.result?.artifactPath, "tasks/" + ID + "/artifact");
        const session = await datalith.claimPlaybackSession(ID, { idempotencyKey: "claim" });
        assert.ok(session.expiresAt instanceof Date);
        assert.equal(session.token, "f".repeat(64));
    });

    it("handles cancellation without an error and allows explicit retry", async () => {
        const cancelled = await datalith.cancelTask(ID);
        assert.equal(cancelled.error, null);
        await assert.rejects(
            datalith.waitForTask(cancelled),
            (error: unknown) => error instanceof TaskError && error.task.id === ID,
        );
        assert.equal((await datalith.retryTask(ID)).status, "queued");
        state = "failed";
        polls = 1;
        await assert.rejects(datalith.waitForTask(ID, { pollInterval: 1 }), TaskError);
        state = "running";
        await assert.rejects(
            datalith.waitForTask(ID, { pollInterval: 1, waitTimeout: 20 }),
            TaskWaitTimeoutError,
        );
        const controller = new AbortController();
        const reason = new Error("Stop local waiting.");
        await assert.rejects(
            datalith.waitForTask(ID, {
                pollInterval: 1,
                signal: controller.signal,
                onProgress: () => controller.abort(reason),
            }),
            (error: unknown) => error === reason,
        );
        state = "succeeded";
    });

    it("keeps service error codes and request metadata", async () => {
        await assert.rejects(
            datalith.processMedia("error", { kind: "image" }),
            (error: unknown) =>
                error instanceof DatalithError &&
                error.status === 503 &&
                error.code === "writes_paused" &&
                error.requestId === "request-123" &&
                error.retryAfter === "1",
        );
    });

    it(
        "stops a pending upload and an unfinished error response promptly",
        { timeout: 2_000 },
        async () => {
            let release: (() => void) | undefined;
            const pending = new Promise<void>((resolve) => {
                release = resolve;
            });
            const source = (async function* (): AsyncGenerator<Uint8Array> {
                await pending;
                yield Buffer.from("after cancellation");
            })();
            const reason = new Error("Stop the upload.");
            const controller = new AbortController();
            const upload = datalith.upload(
                source,
                {},
                { idempotencyKey: "pending", signal: controller.signal },
            );
            const timer = setTimeout(() => controller.abort(reason), 20);
            try {
                await assert.rejects(upload, (error: unknown) => error === reason);
            } finally {
                clearTimeout(timer);
                release?.();
            }
            const errorController = new AbortController();
            const responseReason = new Error("Stop the error response.");
            const request = datalith.processMedia(
                "slow",
                { kind: "image" },
                { signal: errorController.signal },
            );
            const errorTimer = setTimeout(() => errorController.abort(responseReason), 20);
            try {
                await assert.rejects(request, (error: unknown) => error === responseReason);
            } finally {
                clearTimeout(errorTimer);
            }
        },
    );
});
