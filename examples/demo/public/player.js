/* global document, window */

import * as hlsLibrary from "hls.js";

const Player = hlsLibrary.default;

/**
 * @param {HTMLSelectElement} select
 * @param {string} value
 * @param {string} text
 * @param {boolean} [disabled]
 */
const option = (select, value, text, disabled = false) => {
    const entry = document.createElement("option");
    entry.value = value;
    entry.textContent = text;
    entry.disabled = disabled;
    select.append(entry);
};
/** @param {import("node-datalith").VideoVariant} variant */
const qualityLabel = (variant) =>
    variant.resolution +
    "p / " +
    (variant.frameRate.numerator / variant.frameRate.denominator).toLocaleString("en-US", {
        maximumFractionDigits: 2,
    }) +
    " fps (" +
    variant.width +
    " × " +
    variant.height +
    ")";
/**
 * @param {HTMLVideoElement} video
 * @param {import("node-datalith").VideoMedia} media
 * @param {string} source
 * @param {HTMLElement} panel
 * @param {(message: string) => void} report
 */
export const createVideoPlayer = (video, media, source, panel, report) => {
    const controls = document.createElement("div");
    controls.className = "playback-controls";
    const quality = document.createElement("select");
    quality.setAttribute("aria-label", "Playback quality");
    const audio = document.createElement("select");
    audio.setAttribute("aria-label", "Playback audio");
    const status = document.createElement("p");
    status.className = "hint playback-status";
    status.setAttribute("role", "status");
    /** @type {[string, HTMLSelectElement][]} */
    const fields = [
        ["Quality (size / FPS)", quality],
        ["Audio", audio],
    ];
    for (const [text, select] of fields) {
        const label = document.createElement("label");
        label.className = "field";
        label.append(document.createTextNode(text), select);
        controls.append(label);
    }
    panel.append(controls, status);
    option(quality, "auto", "Auto");
    option(audio, "auto", media.audio.length === 0 ? "No audio" : "Auto (AAC)");
    if (!Player.isSupported()) {
        quality.disabled = true;
        audio.disabled = true;
        if (video.canPlayType("application/vnd.apple.mpegurl") !== "") {
            video.src = source;
            status.textContent = "Native HLS uses the browser's quality and audio choices.";
        } else {
            report("Your browser cannot play HLS. Download the original or try a recent browser.");
        }
        return { destroy: () => {} };
    }
    /** @type {import("hls.js").default | null} */
    let instance = null;
    let metadataEvents = new AbortController();
    let destroyed = false;
    const hasFlac = media.audio.some((track) => track.codec === "flac");
    /** @param {import("node-datalith").AudioVariant} track */
    const audioLabel = (track) =>
        track.codec === "flac"
            ? "FLAC · Lossless"
            : (track.id === "aac_high"
                  ? "AAC high · "
                  : track.id === "aac_low"
                    ? "AAC low · "
                    : "AAC ") +
              Math.round(track.bitrate / 1000) +
              " kbps" +
              (hasFlac ||
              (track.id === "aac_low" && media.audio.some((entry) => entry.id === "aac_high"))
                  ? " · Fallback"
                  : "");
    /** @param {import("hls.js").Level} level */
    const variantForLevel = (level) => {
        const path = new URL(level.uri, new URL(source, window.location.href)).pathname;
        const id = path.split("/").at(-2);
        return media.variants.find((variant) => variant.id === id);
    };
    /**
     * @param {import("hls.js").Level} level
     * @param {string} group
     */
    const acceptsAudio = (level, group) =>
        media.audio.length === 0 ||
        (group === "auto"
            ? level.audioCodec?.startsWith("mp4a") === true
            : level.hasAudioGroup(group));
    const updateStatus = () => {
        const current = instance;
        if (current === null || current.currentLevel < 0) {
            return;
        }
        const level = current.levels[current.currentLevel];
        if (level === undefined) {
            return;
        }
        const variant = variantForLevel(level);
        const group = current.audioTracks[current.audioTrack]?.groupId;
        const track = media.audio.find((entry) => entry.id === group);
        status.textContent =
            "Playing: " +
            (variant === undefined
                ? level.width + " × " + level.height + " / " + level.frameRate + " fps"
                : qualityLabel(variant)) +
            " · " +
            (track === undefined ? "No audio" : audioLabel(track)) +
            " · " +
            (quality.value === "auto" ? "Auto quality" : "Manual quality");
    };
    const rebuild = () => {
        const savedQuality = quality.value;
        const savedAudio = audio.value;
        const position = video.currentTime;
        const playing = !video.paused;
        video.pause();
        metadataEvents.abort();
        metadataEvents = new AbortController();
        instance?.destroy();
        quality.disabled = true;
        audio.disabled = true;
        status.textContent = "Loading playback choices…";
        const current = new Player({
            autoStartLoad: false,
            capLevelToPlayerSize: true,
            workerPath: "/vendor/hls.worker.js",
            startPosition: position,
            audioPreference:
                savedAudio === "auto" ? { audioCodec: "mp4a.40.2" } : { groupId: savedAudio },
        });
        instance = current;
        const active = () => !destroyed && instance === current;
        video.addEventListener(
            "loadedmetadata",
            () => {
                if (active() && position > 0 && Number.isFinite(video.duration)) {
                    video.currentTime = Math.min(position, Math.max(0, video.duration - 0.05));
                }
            },
            { once: true, signal: metadataEvents.signal },
        );
        current.on(hlsLibrary.Events.MANIFEST_PARSED, () => {
            if (!active()) {
                return;
            }
            const allLevels = current.levels.slice();
            const groups = new Set(current.allAudioTracks.map((track) => track.groupId));
            const available = media.variants.filter((variant) =>
                allLevels.some((level) => variantForLevel(level)?.id === variant.id),
            );
            quality.replaceChildren();
            option(quality, "auto", "Auto");
            for (const variant of available) {
                option(
                    quality,
                    variant.id,
                    qualityLabel(variant),
                    savedAudio !== "auto" && !variant.audio.includes(savedAudio),
                );
            }
            quality.value = available.some(
                (variant) =>
                    variant.id === savedQuality &&
                    (savedAudio === "auto" || variant.audio.includes(savedAudio)),
            )
                ? savedQuality
                : "auto";
            const chosen = available.find((variant) => variant.id === quality.value);
            audio.replaceChildren();
            option(audio, "auto", media.audio.length === 0 ? "No audio" : "Auto (AAC)");
            for (const track of media.audio) {
                const disabled =
                    !groups.has(track.id) ||
                    (chosen !== undefined && !chosen.audio.includes(track.id));
                option(
                    audio,
                    track.id,
                    audioLabel(track) +
                        (!groups.has(track.id) ? " · Not supported by this browser" : ""),
                    disabled,
                );
            }
            audio.value =
                groups.has(savedAudio) &&
                (chosen === undefined || chosen.audio.includes(savedAudio))
                    ? savedAudio
                    : "auto";
            // Keep automatic quality within the selected audio group's compatible versions.
            for (let index = current.levels.length - 1; index >= 0; index--) {
                if (!acceptsAudio(current.levels[index], audio.value)) {
                    current.removeLevel(index);
                }
            }
            if (current.levels.length === 0) {
                report("No playable version supports this audio choice.");
                return;
            }
            if (quality.value !== "auto") {
                const index = current.levels.findIndex(
                    (level) =>
                        variantForLevel(level)?.id === quality.value &&
                        acceptsAudio(level, audio.value),
                );
                current.loadLevel = index;
            } else {
                current.loadLevel = -1;
            }
            if (audio.value !== "auto") {
                current.setAudioOption({ groupId: audio.value });
            }
            current.startLoad(position);
            quality.disabled = false;
            audio.disabled = media.audio.length === 0;
            status.textContent =
                "Quality and FPS switch together. Audio choices depend on the selected version.";
            if (playing) {
                void video.play().catch(() => {
                    report("Press Play to continue after changing the version.");
                });
            }
        });
        current.on(hlsLibrary.Events.LEVEL_SWITCHED, () => {
            if (active()) {
                updateStatus();
            }
        });
        current.on(hlsLibrary.Events.AUDIO_TRACK_SWITCHED, () => {
            if (active()) {
                updateStatus();
            }
        });
        current.on(hlsLibrary.Events.ERROR, (_event, data) => {
            if (active() && data.fatal) {
                report("Could not play this version. Try Auto or AAC audio.");
            }
        });
        const url = new URL(source, window.location.href);
        url.searchParams.set("audio", "all");
        current.loadSource(url.href);
        current.attachMedia(video);
    };
    quality.addEventListener("change", rebuild);
    audio.addEventListener("change", rebuild);
    rebuild();
    return {
        destroy: () => {
            destroyed = true;
            metadataEvents.abort();
            instance?.destroy();
            instance = null;
        },
    };
};
