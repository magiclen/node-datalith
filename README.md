Datalith for Node.js
==========

[![CI](https://github.com/magiclen/node-datalith/actions/workflows/ci.yml/badge.svg)](https://github.com/magiclen/node-datalith/actions/workflows/ci.yml)

[Datalith](https://github.com/magiclen/datalith) stores files and prepares media, using SQLite for metadata and the file system for file storage.
This library helps you use the Datalith service from Node.js.
Requires **Node.js 24 or later**.

## Usage

```sh
npm install node-datalith
```

```typescript
import { createReadStream } from "node:fs";

import { Datalith } from "node-datalith";

const API_PREFIX = "http://127.0.0.1:1111";
const FILE_PATH = "tests/data/image.png";

const datalith = new Datalith(API_PREFIX);

const resource = await datalith.uploadAndWait(createReadStream(FILE_PATH), {
    fileName: "image.png",
});
const response = await datalith.getContent(resource.id);
const data = await response.arrayBuffer();

const image = await datalith.uploadAndWait(createReadStream(FILE_PATH), {
    kind: "image",
    image: {
        variants: [{ name: "thumbnail", maxWidth: 128, multipliers: [1, 2] }],
    },
});

const original = await datalith.getContent(image.id, { variant: "original" });
const originalData = await original.arrayBuffer();

const thumbnail = await datalith.getContent(image.id, {
    variant: "thumbnail",
    multiplier: 1,
    format: "webp",
});
const thumbnailData = await thumbnail.arrayBuffer();
```

Uploads accept Buffer, Uint8Array, Blob, Web ReadableStream, and AsyncIterable, including Node.js Readable.
Stream chunks must be binary data.
You do not need to know the file size before uploading.

Download methods return a Fetch Response with its status, headers, and body stream.
Read or cancel the body, including error responses.
Use streaming for large files.

Use `getMedia` and `listMedia` to read metadata, and `deleteMedia` to delete an item.
Missing items return null from `getMedia` and `getTask`, or false from `deleteMedia`.
Data fields use camelCase and Date objects.
Fields that the service leaves out get their default values, such as an empty `warnings` list.
File sizes and list totals stay decimal strings; use BigInt for large values.

## Tasks

```typescript
const task = await datalith.upload(createReadStream(FILE_PATH));
const completed = await datalith.waitForTask(task, {
    pollInterval: 1000,
    waitTimeout: 60_000,
    onProgress: (current) => {
        console.log(current.stage, current.completedUnits, current.totalUnits);
    },
});
console.log(completed.result);
```

`waitForTask` accepts a Task or task ID and returns the successful Task.
`uploadAndWait` returns the completed Media.
A failed or cancelled task throws `TaskError`, which holds the Task.

Use `cancelTask` to cancel remote work and `retryTask` to retry a failed or cancelled task.
An AbortSignal or `waitTimeout` only stops local waiting.
Keep the task ID if you want to check it later.

Use the same `idempotencyKey` when sending the same operation again, and a new key for each new operation.
The SDK does not replay upload streams.
A custom async iterator must handle its own long waits when a request is stopped.

## Audio and video

```typescript
const audio = await datalith.uploadAndWait(createReadStream("./audio.wav"), {
    kind: "audio",
    audio: { preserveLossless: true },
});

const video = await datalith.uploadAndWait(createReadStream("./video.mp4"), {
    kind: "video",
    video: {
        variants: [
            { resolution: 720, fps: 30 },
            { resolution: 1080, fps: 60 },
        ],
    },
});
```

Video needs a list of sizes and frame rates.
The service may adjust or combine variants to fit the source, so use the returned variant IDs.

Resource uploads can use `enableConvertToImage`, `enableConvertToAudio`, and `enableConvertToVideo` for automatic processing.
Video conversion still needs `video.variants`.
`processingMode: "trust"` lets the service reuse content that meets its output rules.

`processMedia(id, options)` creates a media item from a saved original and leaves the source unchanged.
Images keep the original by default; audio and video do not.
`getCapabilities()` reports processing support and limits.
Existing content can still be read when processing tools are missing.

## HLS

```text
Datalith Service → node-datalith → other Node.js app → nginx → client
```

node-datalith runs inside your application.
Use `getHlsMaster`, `getHlsTrack`, and `getHlsAsset` to read HLS content.
Your application checks access, maps its own IDs to media IDs, and sends HTTP responses.
nginx forwards requests to that application.

Keep the relative paths below the master playlist:

```text
/watch/{slug}/master.m3u8
/watch/{slug}/{track}/index.m3u8
/watch/{slug}/{track}/init.mp4
/watch/{slug}/{track}/segment-000000.m4s
```

The application can use its own slug and send playlists without rewriting them.
The default master uses AAC audio.
Use `audio: "all"` or `"flac"` when the player supports those tracks.

See the [node:http application](examples/node-http/app.ts) and [nginx configuration](examples/node-http/nginx.conf).
The application example takes your ID lookup and access checks as callbacks.
It streams responses, keeps range and cache headers, and stops upstream requests when clients disconnect.
The URL helpers build service URLs; your application builds public URLs.

## Retention and playback sessions

Set `retention.expiresInSeconds` to remove media after a set time, starting when processing finishes.
Set `retention.singleUse` for one access claim.
For resources and images, the first content GET consumes access; HEAD does not.
For audio and video, read metadata first, then claim a playback session.

```typescript
const temporaryVideo = await datalith.uploadAndWait(createReadStream("./video.mp4"), {
    kind: "video",
    video: { variants: [{ resolution: 720, fps: 30 }] },
    retention: { singleUse: true },
});

const metadata = await datalith.getMedia(temporaryVideo.id);
const session = await datalith.claimPlaybackSession(temporaryVideo.id, {
    idempotencyKey: "playback-claim-123",
});
const master = await datalith.getHlsMaster(temporaryVideo.id, { session: session.token });
const playlist = await master.text();
```

The browser may hold the playback token, which protected playlists pass to their child URLs.
A session allows repeated reads and seeking until expiry.
It does not replace your application's access checks.
Deleting the media makes the session invalid.

After a claim, ordinary metadata reads and lists hide the media.
Use `getMedia(id, { session: token })` to read it with the valid token.
Look up media IDs in your application's data instead of calling ordinary `getMedia` before every segment.

## Import, export, and MP4

```typescript
import { writeFile } from "node:fs/promises";

const backup = await datalith.waitForTask(await datalith.exportMedia([resource.id]));
const archive = await datalith.getArtifact(backup.id);
await writeFile("./backup.tar", new Uint8Array(await archive.arrayBuffer()));

const imported = await datalith.waitForTask(
    await datalith.importMedia(createReadStream("./backup.tar")),
);
console.log(imported.result.idMap);

if (video.kind === "video") {
    const task = await datalith.exportMp4(video.id, video.video.variants[0].id);
    const completed = await datalith.waitForTask(task);
    const response = await datalith.getArtifact(completed.id);
    await writeFile("./video.mp4", new Uint8Array(await response.arrayBuffer()));
}
```

The example reads small files into memory; stream large files to storage.
`exportMedia()` without IDs exports all available media.
Import results include `idMap` and `fileIdMap`.
MP4 export uses an existing video variant, and the service chooses its audio track.
For single-use MP4, pass the same session token when submitting, cancelling, retrying, or downloading; reading the Task does not need it.

## Options and errors

Set default headers and timeouts in the client constructor, or override them for each request.
Control requests default to 30 seconds, streaming requests to 24 hours, and stream idle time to 30 seconds.
Use null to turn off a timeout.
`waitTimeout` limits task waiting separately from the HTTP request timeout.

`DatalithError` holds the HTTP status, service code, requestId, and retryAfter.
`TaskError` holds the Task, and `TaskWaitTimeoutError` holds the taskId.
`DatalithProtocolError` means the service data does not match the API; its `path` shows where, such as `items[0].file_name`.
The package also exports `TimeoutError`, `isTimeoutError`, and `isAbortError`.

## Development

```sh
pnpm install
npm run check
npm test
```

Integration tests need Linux, Docker, an nginx image, and an isolated full-feature service:

```sh
DATALITH_BASE_URL=http://127.0.0.1:1111 \
DATALITH_TEST_CONTAINER=datalith-integration \
npm run test:integration
```

Set `DATALITH_TEST_FFMPEG` to choose a host FFmpeg binary, or `NGINX_IMAGE` to choose an nginx image.
Tests create and clean up their application, nginx container, and media.
CI uses Node.js 24.x and 26.x on Linux, macOS, and Windows; Linux also tests the full service path.
The Datalith build follows GitHub master and records its commit SHA.

## License

[MIT](LICENSE)
