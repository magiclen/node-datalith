import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { Datalith } from "node-datalith";

import { createConsumerServer } from "../../examples/node-http/app.ts";

const run = promisify(execFile);
const serviceUrl = process.env["DATALITH_BASE_URL"];
if (serviceUrl === undefined) {
    throw new Error("Set DATALITH_BASE_URL to an isolated full-feature Datalith service.");
}
const datalith = new Datalith(serviceUrl);
const mediaIds = new Set<string>();
const mediaSlugs = new Map<string, string>();
const artifactSlugs = new Map<string, string>();
const aborted: string[] = [];
const application = createConsumerServer({
    datalith,
    resolveMedia: (slug) => mediaSlugs.get(slug),
    resolveArtifact: (slug) => artifactSlugs.get(slug),
    authorize: (request) => request.headers.cookie === "integration=yes",
    onAbort: (slug) => {
        aborted.push(slug);
    },
});
const nginxName = "node-datalith-" + randomUUID();
const headers = { cookie: "integration=yes" };
let directory: string;
let publicUrl: string;
let nginxStarted = false;
const remember = (id: string, slug: string): void => {
    mediaIds.add(id);
    mediaSlugs.set(slug, id);
};

const fixture = async (args: string[], path: string): Promise<void> => {
    const container = process.env["DATALITH_TEST_CONTAINER"];
    if (container === undefined) {
        await run(process.env["DATALITH_TEST_FFMPEG"] ?? "ffmpeg", [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            ...args,
            path,
        ]);
    } else {
        const remote = "/tmp/" + basename(path);
        await run("docker", [
            "exec",
            container,
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            ...args,
            remote,
        ]);
        await run("docker", ["cp", container + ":" + remote, path]);
    }
};
const request = (path: string | URL, init: RequestInit = {}): Promise<Response> => {
    const merged = new Headers(headers);
    new Headers(init.headers).forEach((value, name) => merged.set(name, value));
    return fetch(new URL(path, publicUrl), { ...init, headers: merged });
};
const playlistUrls = (body: string, base: URL): URL[] =>
    Array.from(
        body.matchAll(/(?:^([^#\r\n][^\r\n]*)$|URI="([^"]+)")/gmu),
        (match) => new URL(match[1] ?? match[2], base),
    );

describe("Datalith service → SDK → application → nginx", () => {
    before(async () => {
        const capabilities = await datalith.getCapabilities();
        assert.equal(capabilities.apiVersion, "1");
        assert.equal(capabilities.media.image, true);
        assert.equal(capabilities.media.audio, true);
        assert.equal(capabilities.media.video, true);
        directory = await mkdtemp(join(tmpdir(), "node-datalith-integration-"));
        application.listen(0, "127.0.0.1");
        await once(application, "listening");
        const applicationAddress = application.address();
        assert.ok(applicationAddress !== null && typeof applicationAddress !== "string");
        const portProbe = createServer();
        portProbe.listen(0, "127.0.0.1");
        await once(portProbe, "listening");
        const proxyAddress = portProbe.address();
        assert.ok(proxyAddress !== null && typeof proxyAddress !== "string");
        await new Promise<void>((resolve, reject) =>
            portProbe.close((error) => (error === undefined ? resolve() : reject(error))),
        );
        publicUrl = "http://127.0.0.1:" + proxyAddress.port;
        const template = await readFile(
            new URL("../../examples/node-http/nginx.conf", import.meta.url),
            "utf8",
        );
        const config = template
            .replace("listen 8090;", "listen " + proxyAddress.port + ";")
            .replace("127.0.0.1:8080", "127.0.0.1:" + applicationAddress.port);
        const configPath = join(directory, "nginx.conf");
        await writeFile(configPath, config);
        await run("docker", [
            "run",
            "--rm",
            "-d",
            "--name",
            nginxName,
            "--network",
            "host",
            "-v",
            configPath + ":/etc/nginx/nginx.conf:ro",
            process.env["NGINX_IMAGE"] ?? "nginx:stable-alpine",
        ]);
        nginxStarted = true;
        let ready = false;
        for (let attempt = 0; attempt < 60; attempt++) {
            try {
                // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for the proxy listener.
                const response = await request("/ready");
                // oxlint-disable-next-line eslint/no-await-in-loop -- Close the response before the next check.
                await response.body?.cancel();
                ready = true;
                break;
            } catch {
                // oxlint-disable-next-line eslint/no-await-in-loop -- Retry after the container starts.
                await delay(100);
            }
        }
        assert.ok(ready, "nginx did not start");
    });
    after(async () => {
        const cleanup = await Promise.allSettled([
            nginxStarted ? run("docker", ["stop", nginxName]) : Promise.resolve(),
            new Promise<void>((resolve, reject) => {
                application.closeAllConnections();
                if (!application.listening) {
                    resolve();
                    return;
                }
                application.close((error) => (error === undefined ? resolve() : reject(error)));
            }),
            ...Array.from(mediaIds, (id) => datalith.deleteMedia(id)),
            directory === undefined
                ? Promise.resolve()
                : rm(directory, { recursive: true, force: true }),
        ]);
        const failures = cleanup.flatMap((result) =>
            result.status === "rejected" ? [result.reason as unknown] : [],
        );
        if (failures.length > 0) {
            throw new AggregateError(failures, "Integration cleanup failed.");
        }
    });

    it("uploads, serves, seeks and exports resources through the application", async () => {
        const saved = await datalith.uploadAndWait(
            Buffer.from("Hello world!"),
            { fileName: "測試.txt", fileType: "text/plain" },
            { pollInterval: 10 },
        );
        remember(saved.id, "document");
        assert.equal(saved.original?.fileSize, 12);
        assert.ok(saved.createdAt instanceof Date);
        assert.ok(
            (await datalith.listMedia({ perPage: 10 })).items.some((item) => item.id === saved.id),
        );
        const content = await request("/files/document");
        assert.equal(content.status, 200);
        assert.equal(await content.text(), "Hello world!");
        const etag = content.headers.get("etag");
        assert.ok(etag !== null);
        const partial = await request("/files/document", {
            headers: { range: "bytes=1-4", "if-range": etag },
        });
        assert.equal(partial.status, 206);
        assert.equal(partial.headers.get("content-range"), "bytes 1-4/12");
        assert.equal(await partial.text(), "ello");
        const head = await request("/files/document", { method: "HEAD" });
        assert.equal(head.status, 200);
        assert.equal(head.body, null);
        assert.equal(head.headers.get("content-length"), "12");
        const cached = await request("/files/document", { headers: { "if-none-match": etag } });
        assert.equal(cached.status, 304);
        assert.equal(cached.body, null);
        const outside = await request("/files/document", { headers: { range: "bytes=100-200" } });
        assert.equal(outside.status, 416);
        assert.equal(outside.headers.get("content-range"), "bytes */12");
        await outside.body?.cancel();
        const exported = await datalith.waitForTask(await datalith.exportMedia([saved.id]), {
            pollInterval: 10,
        });
        artifactSlugs.set("backup", exported.id);
        const archive = await request("/artifacts/backup");
        assert.equal(archive.status, 200);
        const imported = await datalith.waitForTask(
            await datalith.importMedia(new Uint8Array(await archive.arrayBuffer())),
            { pollInterval: 10 },
        );
        assert.equal(imported.result.skipped, 1);
        assert.equal(imported.result.idMap[saved.id], saved.id);
    });

    it("processes images and audio using the new media options", async () => {
        const path = new URL("../data/image.png", import.meta.url);
        const saved = await datalith.uploadAndWait(
            path,
            {
                kind: "image",
                fileName: "image.png",
                image: { variants: [{ name: "small", maxWidth: 128, multipliers: [1] }] },
            },
            { pollInterval: 10 },
        );
        remember(saved.id, "image");
        assert.equal(saved.kind, "image");
        assert.equal(saved.variants[0].width, 128);
        const original = await datalith.getContent(saved.id, { variant: "original" });
        assert.deepEqual(
            new Uint8Array(await original.arrayBuffer()),
            new Uint8Array(await readFile(path)),
        );
        const processed = await datalith.waitForTask(
            await datalith.processMedia(saved.id, {
                kind: "image",
                image: { variants: [{ name: "tiny", maxWidth: 64, multipliers: [1] }] },
            }),
            { pollInterval: 10 },
        );
        remember(processed.result.id, "thumbnail");
        assert.notEqual(processed.result.id, saved.id);
        assert.equal(processed.result.variants[0].width, 64);
        const thumbnail = await request("/files/thumbnail?variant=tiny&multiplier=1&format=webp");
        assert.equal(thumbnail.status, 200);
        assert.equal(thumbnail.headers.get("content-type"), "image/webp");
        assert.ok((await thumbnail.arrayBuffer()).byteLength > 0);

        const sound = join(directory, "sound.wav");
        await fixture(
            ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "pcm_s16le"],
            sound,
        );
        const audio = await datalith.uploadAndWait(
            createReadStream(sound),
            { kind: "audio", fileName: "sound.wav" },
            { pollInterval: 10 },
        );
        remember(audio.id, "sound");
        assert.ok(audio.kind === "audio");
        assert.ok(audio.audio.variants.length > 0);
        const response = await request("/files/sound");
        assert.equal(response.status, 200);
        assert.ok((await response.arrayBuffer()).byteLength > 0);
    });

    it("keeps HEAD from consuming a single-use resource", async () => {
        const saved = await datalith.uploadAndWait(
            Buffer.from("one access"),
            { retention: { singleUse: true } },
            { pollInterval: 10 },
        );
        remember(saved.id, "single-use");
        assert.equal((await request("/files/single-use", { method: "HEAD" })).status, 200);
        const content = await request("/files/single-use");
        assert.equal(content.headers.get("cache-control"), "no-store");
        assert.equal(await content.text(), "one access");
        const consumed = await request("/files/single-use");
        assert.equal(consumed.status, 404);
        await consumed.body?.cancel();
    });

    it("plays HLS with application slugs and a playback session, then downloads MP4", async () => {
        const path = join(directory, "video.mp4");
        await fixture(
            [
                "-f",
                "lavfi",
                "-i",
                "color=c=black:size=256x144:rate=12:duration=2",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-threads",
                "1",
                "-shortest",
            ],
            path,
        );
        const saved = await datalith.uploadAndWait(
            path,
            {
                kind: "video",
                fileName: "video.mp4",
                video: { variants: [{ resolution: 144, fps: 12 }] },
                retention: { singleUse: true },
            },
            { pollInterval: 10 },
        );
        remember(saved.id, "movie");
        assert.ok(saved.kind === "video");
        const session = await datalith.claimPlaybackSession(saved.id, {
            idempotencyKey: randomUUID(),
        });
        assert.equal(await datalith.getMedia(saved.id), null);
        const metadata = await datalith.getMedia(saved.id, { session: session.token });
        assert.ok(metadata?.consumedAt instanceof Date);
        const masterUrl = new URL("/watch/movie/master.m3u8?session=" + session.token, publicUrl);
        const forbidden = await fetch(masterUrl);
        assert.equal(forbidden.status, 403);
        await forbidden.body?.cancel();
        const master = await request(masterUrl);
        assert.equal(master.status, 200);
        assert.equal(master.headers.get("cache-control"), "no-store");
        const etag = master.headers.get("etag");
        assert.ok(etag !== null);
        const masterBody = await master.text();
        const tracks = playlistUrls(masterBody, masterUrl);
        assert.ok(tracks.length >= 2);
        for (const trackUrl of tracks) {
            assert.ok(trackUrl.pathname.startsWith("/watch/movie/"));
            assert.equal(trackUrl.searchParams.get("session"), session.token);
            // oxlint-disable-next-line eslint/no-await-in-loop -- Follow each playlist as a player does.
            const track = await request(trackUrl);
            assert.equal(track.status, 200);
            // oxlint-disable-next-line eslint/no-await-in-loop -- Read the playlist before its assets.
            const assets = playlistUrls(await track.text(), trackUrl);
            assert.ok(assets.some((asset) => asset.pathname.endsWith("/init.mp4")));
            assert.ok(assets.some((asset) => /segment-\d+\.m4s$/u.test(asset.pathname)));
            for (const assetUrl of assets) {
                assert.equal(assetUrl.searchParams.get("session"), session.token);
                // oxlint-disable-next-line eslint/no-await-in-loop -- Read each listed asset.
                const asset = await request(assetUrl);
                assert.equal(asset.status, 200);
                // oxlint-disable-next-line eslint/no-await-in-loop -- Finish reading before the next request.
                assert.ok((await asset.arrayBuffer()).byteLength > 0);
            }
        }
        const cached = await request(masterUrl, { headers: { "if-none-match": etag } });
        assert.equal(cached.status, 304);
        const unauthorized = await request("/watch/movie/master.m3u8", {
            headers: { "if-none-match": "*" },
        });
        assert.equal(unauthorized.status, 404);
        await unauthorized.body?.cancel();
        const task = await datalith.exportMp4(saved.id, saved.video.variants[0].id, {
            session: session.token,
        });
        const exported = await datalith.waitForTask(task, { pollInterval: 10 });
        assert.ok(exported.result.expiresAt instanceof Date);
        artifactSlugs.set("movie-mp4", exported.id);
        const mp4 = await request("/artifacts/movie-mp4?session=" + session.token);
        assert.equal(mp4.status, 200);
        assert.equal(mp4.headers.get("cache-control"), "no-store");
        assert.ok((await mp4.arrayBuffer()).byteLength > 0);
    });

    it("aborts the application upstream when the client stops downloading", async () => {
        const saved = await datalith.uploadAndWait(
            Buffer.alloc(16 * 1024 * 1024, 42),
            { fileName: "large.bin" },
            { pollInterval: 10 },
        );
        remember(saved.id, "large");
        const response = await request("/files/large");
        assert.equal(response.status, 200);
        assert.ok(response.body);
        const reader = response.body.getReader();
        await reader.read();
        await reader.cancel();
        for (let attempt = 0; attempt < 50 && !aborted.includes("large"); attempt++) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for the socket close event.
            await delay(10);
        }
        assert.ok(aborted.includes("large"));
    });
});
