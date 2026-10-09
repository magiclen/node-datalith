import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Datalith, DatalithError, TaskError, TaskWaitTimeoutError } from "../src/index.ts";
import type { ExportResult, ResourceMedia, ResourceUploadOptions, Task } from "../src/index.ts";

const ID = "ab975c7a-f924-4415-a312-772f4fc61b71";
const SECOND_ID = "0e4f6a1d-8b2c-4d3e-9f5a-6b7c8d9e0f1a";
const IMAGE_ID = "5a0c2e77-1f43-4c55-9a51-0d3f6c8e2b14";
const VIDEO_ID = "c3d9b0f1-6a2e-4b7d-8e15-2f4a9c6d7e80";
const created = "2026-10-08T00:00:00.000Z";
const file = {
    id: ID,
    sha256: "a".repeat(64),
    file_size: "12",
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
// The service leaves out `processing_method` for older outputs.
const imageMedia = {
    ...media,
    id: IMAGE_ID,
    kind: "image",
    variants: [
        {
            name: "small",
            multiplier: 1,
            format: "webp",
            width: 128,
            height: 96,
            animated: false,
            file,
            content_path: "media/" + IMAGE_ID + "/content?variant=small&multiplier=1&format=webp",
            recipe: {
                name: "small",
                max_width: 128,
                max_height: null,
                crop: null,
                multipliers: [1],
            },
        },
        // A newer service can send an output format that this package does not know yet.
        {
            name: "small",
            multiplier: 1,
            format: "avif",
            width: 128,
            height: 96,
            animated: false,
            file,
            content_path: "media/" + IMAGE_ID + "/content?variant=small&multiplier=1&format=avif",
            recipe: null,
        },
    ],
};
// The service leaves out `leading_hold_seconds` when it is zero.
const videoMedia = {
    ...media,
    id: VIDEO_ID,
    kind: "video",
    original: null,
    video: {
        duration_seconds: 2,
        variants: [
            {
                id: "144p12",
                resolution: 144,
                width: 256,
                height: 144,
                fps: 12,
                frame_rate: { numerator: 12, denominator: 1 },
                codec: "avc1.64000c",
                processing_method: "transcoded",
                playlist_path: "media/" + VIDEO_ID + "/hls/144p12/index.m3u8",
                audio: ["aac_low"],
            },
        ],
        audio: [
            {
                id: "aac_low",
                codec: "aac",
                bitrate: 128000,
                sample_rate: 48000,
                channels: 2,
                bits_per_sample: null,
                processing_method: "transcoded",
                file: null,
                content_path: "media/" + VIDEO_ID + "/hls/aac_low/index.m3u8",
            },
        ],
        master_path: "media/" + VIDEO_ID + "/hls/master.m3u8",
    },
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
    let uploadedKind = "resource";
    let failingPolls = 0;
    let failingStatus = 503;
    let retryAfter: string | undefined;
    let requests = 0;
    let uploadedOptions: unknown;
    let uploadedFile = "";
    let lastHeaders: IncomingMessage["headers"];

    const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        requests++;
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
        } else if (path === "uploads" || path === "imports") {
            assert.equal(request.method, "POST");
            assert.equal(request.headers["content-length"], undefined);
            const body = (await buffer(request)).toString();
            const options =
                /name="options"\r\nContent-Type: application\/json\r\n\r\n([^\r]*)/u.exec(body);
            const content =
                /name="file"\r\nContent-Type: application\/octet-stream\r\n\r\n([\s\S]*?)\r\n--/u.exec(
                    body,
                );
            assert.ok(content);
            uploadedFile = content[1];
            if (path === "imports") {
                assert.equal(options, null);
                send(response, 202, task("queued", null, "import"));
                return;
            }
            assert.ok(options);
            uploadedOptions = JSON.parse(options[1]) as unknown;
            // Like the service, an automatic conversion creates an `upload` task.
            uploadedKind = /"enable_convert_to_\w+":true/u.test(options[1]) ? "upload" : "resource";
            polls = 0;
            if (request.headers["idempotency-key"] === "slow-answer") {
                // The service checks and stores the file before it answers.
                await delay(400);
            }
            send(response, 202, task("queued", null, uploadedKind));
        } else if (path === "tasks/" + ID && failingPolls > 0) {
            failingPolls--;
            if (retryAfter !== undefined) {
                response.setHeader("retry-after", retryAfter);
            }
            send(response, failingStatus, {
                error: { code: "http_error", message: "Try again later." },
            });
        } else if (path === "tasks/" + ID) {
            polls++;
            send(
                response,
                200,
                task(
                    polls === 1 ? "running" : state,
                    state === "succeeded" && polls > 1 ? media : null,
                    uploadedKind,
                ),
            );
        } else if (path === "tasks/" + ID + "/cancel") {
            send(response, 202, task("cancelled"));
        } else if (path === "tasks/" + ID + "/retry") {
            send(response, 202, task());
        } else if (path === "media/" + IMAGE_ID) {
            send(response, 200, imageMedia);
        } else if (path === "media/" + VIDEO_ID) {
            send(response, 200, videoMedia);
        } else if (path === "media/" + ID) {
            if (request.method === "DELETE") {
                response.writeHead(204);
                response.end();
            } else {
                send(response, 200, media);
            }
        } else if (path === "media") {
            const page = Number(url.searchParams.get("page") ?? "1");
            const perPage = Number(url.searchParams.get("per_page") ?? "50");
            const items = [media, { ...media, id: SECOND_ID }];
            send(response, 200, {
                items: items.slice((page - 1) * perPage, page * perPage),
                page,
                per_page: perPage,
                total: String(items.length),
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
                    if (current.status === "succeeded" && current.kind === "upload") {
                        assert.equal(current.result.id, ID);
                    }
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
        assert.equal(saved.original?.fileSize, 12);
        assert.ok(saved.createdAt instanceof Date);
        assert.equal(saved.expiresAt, null);
        assert.deepEqual(await datalith.getMedia(ID), saved);
        const page = await datalith.listMedia({ perPage: 10 });
        assert.equal(page.total, 2);
        assert.equal(page.perPage, 10);
        assert.equal(page.items[0].id, ID);
        assert.equal(await datalith.deleteMedia(ID), true);
        assert.equal(await datalith.deleteMedia("missing"), false);
        assert.equal(await datalith.getMedia("missing"), null);
        assert.equal(await datalith.getTask("missing"), null);
    });

    it("iterates over every page of media", async () => {
        for (const [perPage, expectedRequests] of [
            [1, 2],
            [3, 1],
        ]) {
            requests = 0;
            const ids: string[] = [];
            // oxlint-disable-next-line eslint/no-await-in-loop -- Read each page size before checking the next one.
            for await (const item of datalith.iterateMedia({ perPage })) {
                ids.push(item.id);
            }
            assert.deepEqual(ids, [ID, SECOND_ID]);
            assert.equal(requests, expectedRequests);
        }
    });

    it("waits for the service to store an upload after the idle timeout", async () => {
        const uploaded = await datalith.upload(
            Buffer.from("Hello"),
            {},
            { idempotencyKey: "slow-answer", idleTimeout: 100 },
        );
        assert.equal(uploaded.status, "queued");
    });

    it("names an upload after its source file", async () => {
        await datalith.upload(new File(["Hello world!"], "hello.txt"));
        assert.deepEqual(uploadedOptions, { file_name: "hello.txt" });
        assert.equal(uploadedFile, "Hello world!");
    });

    it("infers resource and automatic upload kinds", async () => {
        const resource: Task<"resource"> = await datalith.upload(Buffer.from("Hello"), {
            enableConvertToImage: false,
        });
        assert.equal(resource.kind, "resource");
        const automatic: Task<"upload"> = await datalith.upload(Buffer.from("Hello"), {
            enableConvertToAudio: true,
        });
        assert.equal(automatic.kind, "upload");
        const processing: ResourceUploadOptions = { enableConvertToImage: Boolean(1) };
        const dynamic: Task<"resource" | "upload"> = await datalith.upload(
            Buffer.from("Hello"),
            processing,
        );
        assert.equal(dynamic.kind, "upload");
    });

    it("uploads and imports local paths and file URLs", async () => {
        const url = new URL("./data/image.png", import.meta.url);
        const content = await readFile(url, "utf8");
        for (const source of ["tests/data/image.png", url]) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Check each supported file source.
            const uploaded: Task<"resource"> = await datalith.upload(source);
            assert.equal(uploaded.kind, "resource");
            assert.deepEqual(uploadedOptions, { file_name: "image.png" });
            assert.equal(uploadedFile, content);
        }
        const saved: ResourceMedia = await datalith.uploadAndWait(
            url,
            { fileName: "renamed.png" },
            { pollInterval: 1 },
        );
        assert.equal(saved.kind, "resource");
        assert.deepEqual(uploadedOptions, { file_name: "renamed.png" });
        const imported = await datalith.importMedia("tests/data/image.png");
        assert.equal(imported.kind, "import");
        assert.equal(uploadedFile, content);
    });

    it("rejects a missing local file before sending it", async () => {
        requests = 0;
        await assert.rejects(datalith.upload("tests/data/missing.png"), { code: "ENOENT" });
        assert.equal(requests, 0);
    });

    it("fills in fields that the service leaves out", async () => {
        const image = await datalith.getMedia(IMAGE_ID);
        assert.ok(image?.kind === "image");
        assert.deepEqual(image.warnings, []);
        assert.equal(image.variants[0].processingMethod, "unknown");
        assert.equal(image.variants[1].format, "avif");
        assert.equal(
            datalith
                .getContentUrl(image.id, { format: image.variants[1].format })
                .searchParams.get("format"),
            "avif",
        );
        assert.deepEqual(image.variants[0].recipe, {
            name: "small",
            maxWidth: 128,
            maxHeight: null,
            crop: null,
            multipliers: [1],
        });
        const video = await datalith.getMedia(VIDEO_ID);
        assert.ok(video?.kind === "video");
        assert.equal(video.video.variants[0].leadingHoldSeconds, 0);
        assert.equal(video.audio, undefined);
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
        const missing = await datalith.getContent("missing");
        assert.equal(missing.status, 404);
        assert.equal((await DatalithError.fromResponse(missing)).code, "not_found");
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
        assert.ok(exported.status === "succeeded");
        assert.equal(exported.result.artifact.fileSize, 12);
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

    it("keeps waiting through temporary poll failures", async () => {
        state = "succeeded";
        polls = 1;
        failingPolls = 2;
        const completed = await datalith.waitForTask(ID, { pollInterval: 1 });
        assert.equal(completed.status, "succeeded");
        assert.equal(failingPolls, 0);
    });

    it("honors Retry-After when the service is rate-limited", async () => {
        try {
            state = "succeeded";
            polls = 1;
            failingPolls = 1;
            failingStatus = 429;
            retryAfter = "1";
            const started = performance.now();
            const completed = await datalith.waitForTask(ID, { pollInterval: 1 });
            assert.equal(completed.status, "succeeded");
            assert.ok(performance.now() - started >= 950);
            assert.equal(failingPolls, 0);
        } finally {
            failingPolls = 0;
            failingStatus = 503;
            retryAfter = undefined;
        }
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
