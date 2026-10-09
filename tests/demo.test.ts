import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Datalith } from "node-datalith";

import { createDemoServer } from "../examples/demo/app.ts";

const MEDIA_ID = "8131a9c4-7ac2-41b5-8723-139afcc41447";
const TASK_ID = "ebcbf91e-6d57-4a45-bb8c-9e603ac21c19";
const VIDEO_ID = "c3d9b0f1-6a2e-4b7d-8e15-2f4a9c6d7e80";
const SESSION_TOKEN = "b".repeat(64);
const created = "2026-10-09T00:00:00.000Z";
const bytes = Buffer.from("Hello Datalith!\n");
const media = {
    id: MEDIA_ID,
    kind: "resource",
    file_name: "測試.txt",
    created_at: created,
    original: {
        id: MEDIA_ID,
        sha256: "a".repeat(64),
        file_size: String(bytes.length),
        file_type: "text/plain",
        file_name: "測試.txt",
    },
    variants: [],
    expires_at: null,
    single_use: false,
    consumed_at: null,
    animated: false,
    frame_count: 0,
};
const capabilities = {
    api_version: "1",
    version: "0.2.0",
    media: { resource: true, image: true, audio: true, video: true },
    image: {
        engine: "ImageMagick",
        animated_inputs: ["gif", "webp"],
        outputs: ["webp", "png", "jpeg", "gif"],
        apng_requires_ffmpeg: true,
        apng_timing_precision_ms: 1,
        limits: {
            max_pixels: 100_000_000,
            max_frames: 1000,
            max_total_pixels: 1_000_000_000,
            max_variants: 32,
            max_multiplier: 3,
        },
        processing_modes: ["transcode", "trust"],
        save_original_default: true,
    },
    av: {
        available: true,
        minimum_tool_major: 9,
        audio_encoder: true,
        video_encoder: true,
        flac_encoder: true,
        unavailable_reason: null,
    },
    audio: {
        engine: "FFmpeg",
        profiles: ["aac"],
        aac_sample_rate: 48_000,
        aac_bitrates: [128_000, 256_000],
        mp3_fallback: false,
        save_original_default: false,
        processing_modes: ["transcode", "trust"],
        selected_audio_streams: 1,
    },
    video: {
        engine: "FFmpeg",
        codec: "h264",
        pixel_format: "yuv420p",
        delivery: "hls",
        requires_variants: true,
        resolution_tiers: [360, 720, 1080],
        frame_rate_tiers: [24, 30, 60],
        bitrate: 1,
        bitrate_unit: "bits per pixel",
        save_original_default: false,
        processing_modes: ["transcode", "trust"],
        mp4_export: true,
    },
    playback_sessions: { seconds: 3600, single_use_semantics: "claim" },
    max_file_size: "1048576",
    task_retention_seconds: 604800,
    task_notifications: ["poll"],
    cancellation: "cooperative",
    archive_version: 1,
    export_pauses_writes: true,
    mp4_export_retention_seconds: 3600,
};
const videoMedia = {
    ...media,
    id: VIDEO_ID,
    kind: "video",
    file_name: "video.mp4",
    single_use: true,
    video: {
        duration_seconds: 2,
        variants: [
            {
                id: "360p30",
                resolution: 360,
                width: 640,
                height: 360,
                fps: 30,
                frame_rate: { numerator: 30, denominator: 1 },
                codec: "avc1.64001e",
                processing_method: "transcoded",
                playlist_path: "media/" + VIDEO_ID + "/hls/360p30/index.m3u8",
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
const task = (status: string, kind = "upload"): Record<string, unknown> => ({
    id: TASK_ID,
    kind,
    status,
    stage: status,
    completed_units: status === "succeeded" ? 1 : 0,
    total_units: status === "queued" ? null : 1,
    attempt: status === "queued" ? 0 : 1,
    created_at: created,
    updated_at: created,
    result: status === "succeeded" ? media : null,
    error: null,
});
const send = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
};
const listen = async (server: Server): Promise<string> => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    return "http://127.0.0.1:" + address.port;
};
const close = (server: Server): Promise<void> =>
    new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    });

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const json = async (response: Response): Promise<Record<string, unknown>> => {
    const value: unknown = await response.json();
    assert.ok(isRecord(value));
    return value;
};
const playlistUrls = (body: string, base: URL): URL[] =>
    Array.from(
        body.matchAll(/(?:^([^#\r\n][^\r\n]*)$|URI="([^"]+)")/gmu),
        (match) => new URL(match[1] ?? match[2], base),
    );

describe("Datalith browser demo", () => {
    let application: Server;
    let publicUrl: string;
    let polls = 0;
    let saved = false;
    let uploadedOptions: unknown;
    let uploadedKind = "upload";
    let uploadedFile: Buffer;
    let expirySeconds: number | null = null;
    let expiresAt: number | null = null;
    let singleUse = false;
    let consumed = false;
    let playbackClaim: { key: string; expiresAt: string } | null = null;
    const currentMedia = (): Record<string, unknown> => ({
        ...media,
        expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString(),
        single_use: singleUse,
        consumed_at: consumed ? created : null,
    });
    const available = (): boolean =>
        saved && !consumed && (expiresAt === null || expiresAt > Date.now());
    const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const url = new URL(request.url ?? "/", "http://localhost");
        assert.ok(url.pathname.startsWith("/internal/datalith/"));
        const path = url.pathname.slice("/internal/datalith/".length);
        if (path === "capabilities") {
            send(response, 200, capabilities);
        } else if (path === "uploads") {
            assert.equal(request.method, "POST");
            const body = await buffer(request);
            const options =
                /name="options"\r\nContent-Type: application\/json\r\n\r\n([^\r]*)/u.exec(
                    body.toString(),
                );
            assert.ok(options);
            uploadedOptions = JSON.parse(options[1]) as unknown;
            uploadedKind =
                isRecord(uploadedOptions) &&
                (uploadedOptions["enable_convert_to_image"] === true ||
                    uploadedOptions["enable_convert_to_audio"] === true ||
                    uploadedOptions["enable_convert_to_video"] === true)
                    ? "upload"
                    : "resource";
            polls = 0;
            saved = false;
            expiresAt = null;
            consumed = false;
            singleUse =
                isRecord(uploadedOptions) &&
                isRecord(uploadedOptions["retention"]) &&
                uploadedOptions["retention"]["single_use"] === true;
            expirySeconds =
                isRecord(uploadedOptions) &&
                isRecord(uploadedOptions["retention"]) &&
                typeof uploadedOptions["retention"]["expires_in_seconds"] === "number"
                    ? uploadedOptions["retention"]["expires_in_seconds"]
                    : null;
            const prefix = Buffer.from(
                'name="file"\r\nContent-Type: application/octet-stream\r\n\r\n',
            );
            const start = body.indexOf(prefix) + prefix.length;
            uploadedFile = body.subarray(start, body.indexOf("\r\n--", start));
            send(response, 202, task("queued", uploadedKind));
        } else if (path === "tasks/" + TASK_ID) {
            polls++;
            saved = polls > 1;
            if (saved && expirySeconds !== null && expiresAt === null) {
                expiresAt = Date.now() + expirySeconds * 1000;
            }
            send(response, 200, {
                ...task(saved ? "succeeded" : "running", uploadedKind),
                result: saved ? currentMedia() : null,
            });
        } else if (path === "media") {
            assert.equal(url.searchParams.get("page"), "1");
            assert.equal(url.searchParams.get("per_page"), "20");
            send(response, 200, {
                items: available() ? [currentMedia()] : [],
                page: 1,
                per_page: 20,
                total: available() ? "1" : "0",
            });
        } else if (path === "media/" + VIDEO_ID + "/playback-sessions") {
            assert.equal(request.method, "POST");
            assert.equal(request.headers["idempotency-key"], "demo-playback");
            playbackClaim ??= {
                key: "demo-playback",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            };
            send(response, 201, { token: SESSION_TOKEN, expires_at: playbackClaim.expiresAt });
        } else if (path === "media/" + VIDEO_ID) {
            const authorized =
                playbackClaim === null || url.searchParams.get("session") === SESSION_TOKEN;
            send(
                response,
                authorized ? 200 : 404,
                authorized
                    ? { ...videoMedia, consumed_at: playbackClaim === null ? null : created }
                    : { error: { code: "not_found", message: "Not found." } },
            );
        } else if (path === "media/" + MEDIA_ID) {
            if (request.method === "DELETE") {
                saved = false;
                response.writeHead(204);
                response.end();
            } else {
                send(
                    response,
                    available() ? 200 : 404,
                    available()
                        ? currentMedia()
                        : { error: { code: "not_found", message: "Not found." } },
                );
            }
        } else if (path === "media/" + MEDIA_ID + "/content") {
            if (!available()) {
                send(response, 404, { error: { code: "not_found", message: "Not found." } });
                return;
            }
            assert.equal(url.searchParams.get("variant"), "original");
            assert.equal(url.searchParams.get("download"), "true");
            if (singleUse && request.method === "GET") {
                consumed = true;
            }
            response.writeHead(200, {
                "content-type": "text/plain",
                "content-length": bytes.length,
                "content-disposition": "attachment; filename=test.txt",
                "cache-control": singleUse || expiresAt !== null ? "no-store" : "public",
            });
            response.end(bytes);
        } else if (path === "media/" + VIDEO_ID + "/content") {
            assert.equal(url.searchParams.get("session"), SESSION_TOKEN);
            response.writeHead(200, { "content-type": "video/mp4", "cache-control": "no-store" });
            response.end(bytes);
        } else if (path === "media/" + VIDEO_ID + "/hls/master.m3u8") {
            assert.equal(url.searchParams.get("session"), SESSION_TOKEN);
            assert.equal(url.searchParams.get("audio"), "all");
            response.writeHead(200, {
                "content-type": "application/vnd.apple.mpegurl",
                "cache-control": "no-store",
            });
            response.end(
                '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="AAC",URI="aac_low/index.m3u8?session=' +
                    SESSION_TOKEN +
                    '"\n#EXT-X-STREAM-INF:BANDWIDTH=300000,AUDIO="aac"\n360p30/index.m3u8?session=' +
                    SESSION_TOKEN +
                    "\n",
            );
        } else if (/^media\/[^/]+\/hls\/(360p30|aac_low)\/index\.m3u8$/u.test(path)) {
            assert.equal(url.searchParams.get("session"), SESSION_TOKEN);
            response.writeHead(200, {
                "content-type": "application/vnd.apple.mpegurl",
                "cache-control": "no-store",
            });
            response.end(
                '#EXTM3U\n#EXT-X-MAP:URI="init.mp4?session=' +
                    SESSION_TOKEN +
                    '"\n#EXTINF:2,\nsegment-000000.m4s?session=' +
                    SESSION_TOKEN +
                    "\n#EXT-X-ENDLIST\n",
            );
        } else if (
            /^media\/[^/]+\/hls\/(360p30|aac_low)\/(init\.mp4|segment-000000\.m4s)$/u.test(path)
        ) {
            assert.equal(url.searchParams.get("session"), SESSION_TOKEN);
            response.writeHead(200, {
                "content-type": "video/mp4",
                "accept-ranges": "bytes",
                "cache-control": "no-store",
            });
            response.end(Buffer.from([0, 1, 2, 3]));
        } else {
            send(response, 404, { error: { code: "not_found", message: "Not found." } });
        }
    };
    const upstream = createServer((request, response) => {
        void route(request, response).catch((error: unknown) => {
            send(response, 500, { error: { code: "test_error", message: String(error) } });
        });
    });
    before(async () => {
        const serviceUrl = await listen(upstream);
        application = createDemoServer(new Datalith(serviceUrl + "/internal/datalith"));
        publicUrl = await listen(application);
    });
    after(async () => {
        await Promise.all([close(application), close(upstream)]);
    });

    it("uploads a file, follows its task, lists, downloads and deletes it", async () => {
        const page = await fetch(publicUrl);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /lang="en"/u);
        const player = await fetch(publicUrl + "/vendor/hls.mjs", { method: "HEAD" });
        assert.equal(player.status, 200);
        assert.ok(Number(player.headers.get("content-length")) > 0);
        const supported = await json(await fetch(publicUrl + "/api/capabilities"));
        assert.ok(isRecord(supported.media));
        assert.equal(supported.media.video, true);
        const uploaded = await fetch(
            publicUrl +
                "/api/uploads?" +
                new URLSearchParams({ fileName: "測試.txt", mode: "auto" }),
            { method: "POST", headers: { "content-type": "text/plain" }, body: bytes },
        );
        assert.equal(uploaded.status, 202);
        const initial = await json(uploaded);
        assert.equal(initial.status, "queued");
        assert.ok(typeof initial.id === "string");
        assert.deepEqual(uploadedFile, bytes);
        assert.deepEqual(uploadedOptions, {
            file_name: "測試.txt",
            file_type: "text/plain",
            enable_convert_to_image: true,
            enable_convert_to_audio: true,
            enable_convert_to_video: true,
            image: {
                save_original: true,
                variants: [
                    {
                        name: "image_1",
                        max_width: 256,
                        max_height: 256,
                        crop: null,
                        multipliers: [1, 2],
                    },
                    {
                        name: "image_2",
                        max_width: 960,
                        max_height: 960,
                        crop: null,
                        multipliers: [1, 2],
                    },
                ],
            },
            audio: { save_original: true, preserve_lossless: false },
            video: {
                save_original: true,
                preserve_lossless: false,
                variants: [
                    { resolution: 1080, fps: 60 },
                    { resolution: 720, fps: 30 },
                ],
            },
        });
        const running = await json(await fetch(publicUrl + "/api/tasks/" + initial.id));
        assert.equal(running.status, "running");
        const completed = await json(await fetch(publicUrl + "/api/tasks/" + initial.id));
        assert.equal(completed.status, "succeeded");
        assert.ok(isRecord(completed.result));
        assert.equal(completed.result.id, MEDIA_ID);
        const list = await json(await fetch(publicUrl + "/api/media?page=1"));
        assert.equal(list.total, 1);
        assert.ok(Array.isArray(list.items));
        const first: unknown = list.items[0];
        assert.ok(isRecord(first));
        assert.equal(first.id, MEDIA_ID);
        const detail = await json(await fetch(publicUrl + "/api/media/" + MEDIA_ID));
        assert.equal(detail.fileName, "測試.txt");
        const download = await fetch(
            publicUrl + "/files/" + MEDIA_ID + "?variant=original&download=true",
        );
        assert.equal(download.status, 200);
        assert.match(download.headers.get("content-disposition") ?? "", /attachment/u);
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
        assert.equal(
            (await fetch(publicUrl + "/api/media/" + MEDIA_ID, { method: "DELETE" })).status,
            200,
        );
        const empty = await json(await fetch(publicUrl + "/api/media"));
        assert.equal(empty.total, 0);
        assert.deepEqual(empty.items, []);
    });

    it("passes custom media settings and hides a file after its expiry", async () => {
        const settings = {
            retention: { expiresInSeconds: 1 },
            saveOriginal: false,
            preserveLossless: true,
            image: {
                variants: [
                    { name: "card", maxEdge: 320, crop: "tall", multipliers: [1, 2] },
                    { name: "banner", maxEdge: 800, crop: "wide", multipliers: [1] },
                    { name: "icon", maxEdge: 128, crop: "square", multipliers: [1] },
                ],
            },
            video: {
                variants: [
                    { resolution: 1080, fps: 60 },
                    { resolution: 720, fps: 30 },
                ],
            },
        };
        const query = new URLSearchParams({
            fileName: "temporary.txt",
            mode: "auto",
            options: JSON.stringify(settings),
        });
        const uploaded = await fetch(publicUrl + "/api/uploads?" + query, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: bytes,
        });
        assert.equal(uploaded.status, 202);
        assert.deepEqual(uploadedFile, bytes);
        assert.ok(isRecord(uploadedOptions));
        assert.deepEqual(uploadedOptions["retention"], { expires_in_seconds: 1 });
        assert.deepEqual(uploadedOptions["image"], {
            save_original: false,
            variants: [
                {
                    name: "card",
                    max_width: 320,
                    max_height: 320,
                    crop: { width: 4, height: 5 },
                    multipliers: [1, 2],
                },
                {
                    name: "banner",
                    max_width: 800,
                    max_height: 800,
                    crop: { width: 16, height: 9 },
                    multipliers: [1],
                },
                {
                    name: "icon",
                    max_width: 128,
                    max_height: 128,
                    crop: { width: 1, height: 1 },
                    multipliers: [1],
                },
            ],
        });
        assert.deepEqual(uploadedOptions["audio"], {
            save_original: false,
            preserve_lossless: true,
        });
        assert.deepEqual(uploadedOptions["video"], {
            save_original: false,
            preserve_lossless: true,
            variants: [
                { resolution: 1080, fps: 60 },
                { resolution: 720, fps: 30 },
            ],
        });
        await json(await fetch(publicUrl + "/api/tasks/" + TASK_ID));
        const completed = await json(await fetch(publicUrl + "/api/tasks/" + TASK_ID));
        assert.ok(isRecord(completed.result));
        assert.ok(typeof completed.result["expiresAt"] === "string");
        assert.equal((await fetch(publicUrl + "/api/media/" + MEDIA_ID)).status, 200);
        await delay(1100);
        assert.equal((await fetch(publicUrl + "/api/media/" + MEDIA_ID)).status, 404);
        assert.equal((await fetch(publicUrl + "/files/" + MEDIA_ID)).status, 404);
        const list = await json(await fetch(publicUrl + "/api/media"));
        assert.deepEqual(list.items, []);
    });

    it("uploads a single-use file and makes it unavailable after one download", async () => {
        const uploaded = await fetch(
            publicUrl +
                "/api/uploads?" +
                new URLSearchParams({
                    fileName: "once.txt",
                    mode: "resource",
                    options: JSON.stringify({
                        retention: { expiresInSeconds: 60, singleUse: true },
                    }),
                }),
            { method: "POST", headers: { "content-type": "text/plain" }, body: bytes },
        );
        assert.equal(uploaded.status, 202);
        assert.deepEqual(uploadedOptions, {
            file_name: "once.txt",
            file_type: "text/plain",
            retention: { expires_in_seconds: 60, single_use: true },
        });
        await json(await fetch(publicUrl + "/api/tasks/" + TASK_ID));
        const completed = await json(await fetch(publicUrl + "/api/tasks/" + TASK_ID));
        assert.ok(isRecord(completed.result));
        assert.equal(completed.result.singleUse, true);
        assert.equal((await json(await fetch(publicUrl + "/api/media"))).total, 1);
        const contentUrl = publicUrl + "/files/" + MEDIA_ID + "?variant=original&download=true";
        assert.equal((await fetch(contentUrl, { method: "HEAD" })).status, 200);
        assert.equal((await fetch(publicUrl + "/api/media/" + MEDIA_ID)).status, 200);
        const download = await fetch(contentUrl);
        assert.equal(download.status, 200);
        assert.equal(download.headers.get("cache-control"), "no-store");
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
        assert.equal((await fetch(contentUrl)).status, 404);
        assert.equal((await fetch(publicUrl + "/api/media/" + MEDIA_ID)).status, 404);
        assert.deepEqual((await json(await fetch(publicUrl + "/api/media"))).items, []);
    });

    it("claims one playback session and forwards it to content, HLS playlists and assets", async () => {
        const details = await json(await fetch(publicUrl + "/api/media/" + VIDEO_ID));
        assert.equal(details.kind, "video");
        assert.equal(details.singleUse, true);
        const claimUrl = publicUrl + "/api/media/" + VIDEO_ID + "/playback-sessions";
        const options = { method: "POST", headers: { "idempotency-key": "demo-playback" } };
        const claimed = await fetch(claimUrl, options);
        assert.equal(claimed.status, 201);
        assert.equal(claimed.headers.get("cache-control"), "no-store");
        const session = await json(claimed);
        assert.equal(session.token, SESSION_TOKEN);
        assert.deepEqual(await json(await fetch(claimUrl, options)), session);
        assert.equal((await fetch(publicUrl + "/api/media/" + VIDEO_ID)).status, 404);
        const metadata = await json(
            await fetch(publicUrl + "/api/media/" + VIDEO_ID + "?session=" + SESSION_TOKEN),
        );
        assert.equal(metadata.id, VIDEO_ID);
        assert.equal(metadata.consumedAt, created);
        const content = await fetch(
            publicUrl + "/files/" + VIDEO_ID + "?variant=original&session=" + SESSION_TOKEN,
        );
        assert.equal(content.status, 200);
        assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
        const masterUrl = new URL(
            "/watch/" + VIDEO_ID + "/master.m3u8?audio=all&session=" + SESSION_TOKEN,
            publicUrl,
        );
        const master = await fetch(masterUrl);
        assert.equal(master.status, 200);
        const tracks = playlistUrls(await master.text(), masterUrl);
        assert.equal(tracks.length, 2);
        for (const trackUrl of tracks) {
            assert.equal(trackUrl.origin, new URL(publicUrl).origin);
            assert.ok(trackUrl.pathname.startsWith("/watch/" + VIDEO_ID + "/"));
            assert.equal(trackUrl.searchParams.get("session"), SESSION_TOKEN);
            // oxlint-disable-next-line eslint/no-await-in-loop -- Follow each playlist in order.
            const track = await fetch(trackUrl);
            assert.equal(track.status, 200);
            // oxlint-disable-next-line eslint/no-await-in-loop -- Read the playlist before its assets.
            const assets = playlistUrls(await track.text(), trackUrl);
            assert.equal(assets.length, 2);
            for (const assetUrl of assets) {
                assert.equal(assetUrl.searchParams.get("session"), SESSION_TOKEN);
                // oxlint-disable-next-line eslint/no-await-in-loop -- Follow the playback request order.
                const asset = await fetch(assetUrl);
                assert.equal(asset.status, 200);
                assert.equal(asset.headers.get("accept-ranges"), "bytes");
                // oxlint-disable-next-line eslint/no-await-in-loop -- Consume each asset before the next request.
                const data = new Uint8Array(await asset.arrayBuffer());
                assert.deepEqual(data, new Uint8Array([0, 1, 2, 3]));
            }
        }
    });
});
