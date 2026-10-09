# Datalith browser demo

Choose a file, wait for processing, then preview or download it.
The page uses simple English.
Its Node.js server uses `node-datalith` to connect to Datalith.
All browser requests for media go through this server.

## Start the demo

Use Node.js 24 or later and a running Datalith service.
Use the full media version of Datalith to process new images, audio, and video.
See the [Datalith service guide](https://github.com/magiclen/datalith/blob/master/datalith/README.md).

Run these commands in the project root:

```sh
pnpm install
npm run demo
```

Open <http://127.0.0.1:1112>.
By default, the demo connects to Datalith at `http://127.0.0.1:1111`.
Use environment variables to change the service URL and the demo port:

```sh
DATALITH_BASE_URL=http://127.0.0.1:1111 DEMO_PORT=1112 npm run demo
```

The service URL can include a path prefix for a reverse proxy.
Set `DEMO_PORT` to use a different port if port 1112 is already in use.
The demo listens only on `127.0.0.1` and has no login.
Use a separate test service when trying it on your computer.

The list includes all media in the connected service.
Deleting an item removes it from that service.
Stopping the demo does not remove files from the service.

## Try four file types

1. **Text or PDF**: Upload a file with the default upload mode. These files stay ordinary files. Download the result and check that the contents are the same.
2. **Image**: Upload a JPG, PNG, or another supported image. Compare the original with a thumbnail or preview. Choose an output size and format, check its file size, and download it. You can also try an animated GIF.
3. **Audio**: Upload a WAV or MP3 file. After processing, play the AAC/M4A version on the page. You can download both the playback version and the original file.
4. **Video**: Start with a short video. After processing, play the HLS stream. Try pausing and moving the playback position. A large enough source can produce several quality levels. The player chooses a level based on the network speed.

The demo uploads one file at a time.
After an upload, it checks the task once per second until the task finishes.
The progress bar shows the current stage only when the service provides a total.
If task checks stop, use the button below the task message to check again.
This does not upload the file again.

Use the second upload mode to keep the original file without media conversion.
The demo enables automatic conversion only for types that the service supports.
Files that do not match an enabled type stay ordinary files.
A service without processing tools can still play media that it already stores.

By default, uploads keep the original file, do not expire, and allow repeated access.
For single-use media, the demo waits for you to download or start playback.
Opening the file details does not use its access.
Reloading the page does not stop tasks on the service.
Completed files appear in the list.

## Try temporary files

Choose `Expire after` under `Storage` and set the number of seconds.
The default is 60 seconds, and the allowed range is 1 to 36,000,000 seconds.
The time starts when processing finishes.
The list and file details show the time left and the expiry time.
At expiry, the page checks Datalith again, updates the list, and stops the selected preview.
New downloads are no longer available.
Files you already downloaded stay on your computer.

Try a small text file with a short expiry to see it leave the list.
Storage settings also work with `Keep original only`.

## Try single use

Check `Single use` before uploading.
It is off by default and works with both upload modes.
You can use it with `Keep forever` or `Expire after`.
With a 60-second expiry, you have until that time to use the one access.

For files and images, choose an original or processed version and press `Download once`.
The demo does not load an image preview first.
The first content request uses the access for the whole media item, including all its versions.
An interrupted download does not restore the access.
After the download starts, the page shows `Access used` and removes the file from the list.
You can still use the copy saved on your computer.

For audio and video, press `Start playback` to claim one playback session.
The session allows seeking, replay, changing playback versions, and downloads until it expires.
It is one session claim, not one viewing.
The page shows the session time left and stops playback when it ends.
The session ends at the earlier of the service's session limit and the file's expiry time.

Claimed media leaves the normal file list.
Use `Active playback sessions` to return to it on the same page.
The demo keeps session tokens in page memory only; reloading or leaving the page clears them.
The claim uses the same `Idempotency-Key` on retries to recover the same session after a connection error.
It does not claim another session or extend the expiry time.

## Media settings and defaults

Open `Media settings` before uploading to change the processing options.
These settings apply to `Detect and process` mode.
`Reset settings` restores the media defaults and keeps your selected file and storage choice.

| Type     | Settings                                               |
| -------- | ------------------------------------------------------ |
| image_1  | Max edge 256 px at 1x, no crop, 1x and 2x outputs.     |
| image_2  | Max edge 960 px at 1x, no crop, 1x and 2x outputs.     |
| Original | Keep the original file.                                |
| Audio    | AAC/M4A. Keep lossless audio is off.                   |
| Video    | 1080p at 60 fps and 720p at 30 fps, with HLS playback. |

Image outputs have equal roles; their names are only labels.
Add, remove, or name rows for the places where you will use the image.
Each image output has its own max edge, crop, and scales.
There is no fixed two-output limit in the demo; Datalith checks its service limit.
Remove all image rows to keep images as ordinary files.
Crop choices are no crop, square (1:1), wide (16:9), and tall (4:5).
Crops use the center of the image.
The max edge sets both the width and height limit at 1x.
For example, a square thumbnail with a 256 px max edge produces 256 × 256 at 1x and 512 × 512 at 2x when the original is large enough.
1x is required; 2x and 3x depend on the service limit.
Small originals are not enlarged, so some requested scales may be skipped.
The image menu shows each returned scale, size, and format.
WebP is the main web output; PNG or JPEG is marked as a still fallback.
An animated input also produces animated GIF as an animation fallback.
Transparent images use PNG for the still fallback; other images use JPEG.
Animated WebP and GIF keep the animation, while the still fallback uses the first frame.

Turn off `Keep original` to keep only processed outputs for images, audio, and video.
Ordinary files always keep their original content.
Turn on `Keep lossless audio (FLAC)` to keep lossless source audio in FLAC, with AAC for playback.
This option also applies to audio in videos.
For standalone audio, use the playback menu to choose AAC or FLAC and download that version.
When FLAC is available, AAC is marked as a fallback for browser support.
FLAC playback depends on the browser; you can still download it.

Each video row is its own resolution and frame-rate pair.
You can add or remove rows, including the same resolution with different frame rates.
Remove all video rows to keep videos as ordinary files.
The demo adds no fixed row count; Datalith checks its own request limits.
The page offers values supported by this demo and the connected service.
The service can adjust sizes and frame rates to fit the source.
The result shows the actual output sizes and frame rates.

The video `p` tier refers to the shorter side of the frame.
This also applies to vertical videos.
The page uses the formats, sizes, and media versions returned by Datalith.

The full `hls.js` 1.7.3 player is served from the local development dependency.
Playback does not need an external CDN.
The player first tries hls.js, then tries native HLS if hls.js does not support the browser.

## Playback choices

Use `Quality (size / FPS)` to choose Auto or an existing video version.
Resolution and FPS switch together; this does not change playback speed.
The choices come from the versions Datalith produced and the playlists the browser can play.
Use `Audio` to choose automatic AAC, a stored AAC version, or FLAC when available.
AAC is marked as a fallback when FLAC is stored, and lower-bitrate AAC is marked as a fallback when higher-bitrate AAC is also stored.
Choices that cannot be used together are disabled.
Changing a choice keeps the playback position and paused state, but may cause a short pause while the new version loads.
With automatic quality, only versions that support the selected audio are used.
Native HLS uses the browser's own quality and audio choices, so manual controls are disabled in that mode.

## Source files

- `server.ts`: Reads environment variables and starts the local server.
- `app.ts`, `createDemoServer()`: Serves uploads, tasks, media lists, playback sessions, deletion, and page files.
- `options.ts`, `createUploadOptions()`: Checks form options and builds SDK upload settings.
- `public/app.js`: Handles the interface, task checks, image comparison, and playback.
- `public/player.js`: Handles HLS quality, FPS pairs, audio selection, and the current playback status.
- `../node-http/app.ts`, `createConsumerHandler()`: Streams content and HLS while keeping Range, cache, and response headers.

The demo uses the existing public SDK API.
The demo page and player are not included in the published npm package.

The upload route accepts an optional `options` JSON query parameter.
It contains `retention.expiresInSeconds`, `retention.singleUse`, `saveOriginal`, `preserveLossless`, `image.variants` (`name`, `maxEdge`, `crop`, `multipliers`), and `video.variants` (`resolution`, `fps`).
Older `thumbnail`/`preview` image settings and the shared video `resolutions`/`fps` settings are still accepted by the demo backend.
The request body remains the file stream.

`POST /api/media/:id/playback-sessions` forwards the `Idempotency-Key` header to the SDK and returns the session token and expiry time.
Media details, content, and HLS routes accept the token in the `session` query parameter.
