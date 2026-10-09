/* global document, window */

import { createVideoPlayer } from "./player.js";

/**
 * @template T
 * @typedef {T extends Date
 *     ? string
 *     : T extends string | number | boolean | null | undefined
 *       ? T
 *       : T extends object
 *         ? { [K in keyof T]: Wire<T[K]> }
 *         : T} Wire
 */
/** @typedef {Wire<import("node-datalith").Media>} Media */
/** @typedef {Wire<import("node-datalith").Page<import("node-datalith").Media>>} MediaPage */
/** @typedef {Wire<import("node-datalith").Task<"resource" | "upload">>} UploadTask */
/** @typedef {Extract<Media, { kind: "audio" | "video" }>} PlaybackMedia */
/** @typedef {Wire<import("node-datalith").PlaybackSession>} PlaybackSession */
/** @typedef {import("node-datalith").Capabilities} Capabilities */
/**
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} type
 * @returns {T}
 */
const element = (id, type) => {
    const result = document.getElementById(id);
    if (!(result instanceof type)) {
        throw new Error("Missing page element: " + id);
    }
    return result;
};
const ui = {
    connection: element("connection", window.HTMLSpanElement),
    refresh: element("refresh", window.HTMLButtonElement),
    error: element("error", window.HTMLParagraphElement),
    "upload-form": element("upload-form", window.HTMLFormElement),
    file: element("file", window.HTMLInputElement),
    "file-name": element("file-name", window.HTMLElement),
    "file-info": element("file-info", window.HTMLSpanElement),
    mode: element("mode", window.HTMLSelectElement),
    "mode-note": element("mode-note", window.HTMLParagraphElement),
    upload: element("upload", window.HTMLButtonElement),
    task: element("task", window.HTMLDivElement),
    "task-status": element("task-status", window.HTMLElement),
    "task-message": element("task-message", window.HTMLParagraphElement),
    "task-progress": element("task-progress", window.HTMLProgressElement),
    resume: element("resume", window.HTMLButtonElement),
    capabilities: element("capabilities", window.HTMLDivElement),
    limit: element("limit", window.HTMLParagraphElement),
    "media-list": element("media-list", window.HTMLTableSectionElement),
    empty: element("empty", window.HTMLParagraphElement),
    total: element("total", window.HTMLSpanElement),
    "page-info": element("page-info", window.HTMLParagraphElement),
    previous: element("previous", window.HTMLButtonElement),
    next: element("next", window.HTMLButtonElement),
    details: element("details", window.HTMLElement),
    "detail-title": element("detail-title", window.HTMLHeadingElement),
    "detail-kind": element("detail-kind", window.HTMLParagraphElement),
    "detail-info": element("detail-info", window.HTMLParagraphElement),
    "download-original": element("download-original", window.HTMLAnchorElement),
    delete: element("delete", window.HTMLButtonElement),
    "detail-note": element("detail-note", window.HTMLParagraphElement),
    preview: element("preview", window.HTMLDivElement),
    retention: element("retention-mode", window.HTMLSelectElement),
    expiryField: element("expiry-field", window.HTMLLabelElement),
    expirySeconds: element("expiry-seconds", window.HTMLInputElement),
    singleUse: element("single-use", window.HTMLInputElement),
    activeSessions: element("active-sessions", window.HTMLDivElement),
    mediaSettings: element("media-settings", window.HTMLFieldSetElement),
    imageSettings: element("image-settings", window.HTMLFieldSetElement),
    videoSettings: element("video-settings", window.HTMLFieldSetElement),
    keepOriginal: element("keep-original", window.HTMLInputElement),
    lossless: element("lossless", window.HTMLInputElement),
    imageOutputs: element("image-outputs", window.HTMLDivElement),
    addImageOutput: element("add-image-output", window.HTMLButtonElement),
    imageLimit: element("image-limit", window.HTMLParagraphElement),
    videoOutputs: element("video-outputs", window.HTMLDivElement),
    addVideoOutput: element("add-video-output", window.HTMLButtonElement),
    resetSettings: element("reset-settings", window.HTMLButtonElement),
    detailExpiry: element("detail-expiry", window.HTMLParagraphElement),
};
class ApiError extends Error {
    /**
     * @param {string} message
     * @param {number} status
     */
    constructor(message, status) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}
const kinds = { resource: "File", image: "Image", audio: "Audio", video: "Video" };
/** @type {readonly import("node-datalith").MediaKind[]} */
const mediaKinds = ["resource", "image", "audio", "video"];
const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short" });
/** @type {Capabilities | null} */
let capabilities = null;
let busy = false;
let currentPage = 1;
let pageCount = 1;
/** @type {Media | null} */
let selected = null;
let selectionVersion = 0;
let listVersion = 0;
/** @type {string | null} */
let taskId = null;
/** @type {number | undefined} */
let pollTimer;
/** @type {HTMLMediaElement | null} */
let player = null;
/** @type {{ destroy: () => void } | null} */
let videoPlayback = null;
let unavailableSelection = false;
/** @type {Map<string, { media: PlaybackMedia; session: PlaybackSession }>} */
const playbackSessions = new Map();
/** @type {Map<string, string>} */
const claimKeys = new Map();
let nextSessionExpiry = Infinity;
let expiryRefreshing = false;
let nextExpiryCheck = 0;
const expiryDateFormat = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
});
const knownResolutions = [144, 240, 360, 432, 480, 540, 576, 720, 900, 1080, 1440, 2160];
const knownFrameRates = [10, 12, 15, 20, 24, 25, 30, 48, 50, 60];
/**
 * @typedef {{
 *     root: HTMLFieldSetElement;
 *     name: HTMLInputElement;
 *     edge: HTMLInputElement;
 *     crop: HTMLSelectElement;
 *     scales: Map<number, HTMLInputElement>;
 * }} ImageOutputRow
 */
/** @typedef {{ root: HTMLFieldSetElement; resolution: HTMLSelectElement; fps: HTMLSelectElement }} VideoOutputRow */
/** @type {ImageOutputRow[]} */
let imageRows = [];
/** @type {VideoOutputRow[]} */
let videoRows = [];
let rowSequence = 0;
let settingsInitialized = false;

/**
 * @template {keyof HTMLElementTagNameMap} T
 * @param {T} tag
 * @param {string} [text]
 * @param {string} [className]
 */
const node = (tag, text = "", className = "") => {
    const result = document.createElement(tag);
    result.textContent = text;
    result.className = className;
    return result;
};
/** @param {number} bytes */
const formatBytes = (bytes) => {
    if (bytes < 1024) {
        return bytes + " B";
    }
    const units = ["KB", "MB", "GB", "TB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1);
    return (
        (bytes / 1024 ** (index + 1)).toLocaleString("en-US", { maximumFractionDigits: 1 }) +
        " " +
        units[index]
    );
};
/** @param {unknown} error */
const showError = (error) => {
    ui.error.textContent = error instanceof Error ? error.message : String(error);
    ui.error.hidden = false;
};
const clearError = () => {
    ui.error.hidden = true;
};
/**
 * @template T
 * @param {string} path
 * @param {RequestInit} [options]
 * @returns {Promise<T>}
 */
const request = async (path, options = {}) => {
    const response = await fetch(path, { cache: "no-store", ...options });
    /** @type {unknown} */
    const data = await response.json();
    if (!response.ok) {
        const detail =
            typeof data === "object" && data !== null && "error" in data ? data.error : undefined;
        throw new ApiError(
            typeof detail === "string" ? detail : "Request failed (HTTP " + response.status + ").",
            response.status,
        );
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The backend returns data checked by the SDK.
    return /** @type {T} */ (data);
};
/**
 * @param {Media} media
 * @param {Record<string, string>} [options]
 */
const contentUrl = (media, options = {}) => {
    const query = new URLSearchParams(options);
    const session = playbackSessions.get(media.id)?.session;
    if (session !== undefined) {
        query.set("session", session.token);
    }
    return "/files/" + encodeURIComponent(media.id) + (query.size === 0 ? "" : "?" + query);
};
/**
 * @param {Media} media
 * @param {Record<string, string>} options
 * @param {string} text
 */
const downloadLink = (media, options, text) => {
    const link = node("a", text, "button secondary");
    link.href = contentUrl(media, { ...options, download: "true" });
    return link;
};
const collectSettings = () => {
    const retention = {
        expiresInSeconds:
            ui.retention.value === "temporary" ? ui.expirySeconds.valueAsNumber : null,
        singleUse: ui.singleUse.checked,
    };
    if (ui.mode.value === "resource" || capabilities === null) {
        return { retention };
    }
    return {
        retention,
        saveOriginal: ui.keepOriginal.checked,
        preserveLossless: ui.lossless.checked && !ui.lossless.disabled,
        image: capabilities.media.image
            ? {
                  variants: imageRows.map((row) => ({
                      name: row.name.value,
                      maxEdge: row.edge.valueAsNumber,
                      crop: row.crop.value,
                      multipliers: [...row.scales]
                          .filter(
                              ([scale, input]) => scale === 1 || (input.checked && !input.disabled),
                          )
                          .map(([scale]) => scale),
                  })),
              }
            : undefined,
        video: capabilities.media.video
            ? {
                  variants: videoRows.map((row) => ({
                      resolution: Number(row.resolution.value),
                      fps: Number(row.fps.value),
                  })),
              }
            : undefined,
    };
};
const updateUpload = () => {
    const file = ui.file.files?.[0];
    const tooLarge =
        file !== undefined && capabilities !== null && file.size > capabilities.maxFileSize;
    const automatic = ui.mode.value === "auto";
    ui.upload.disabled = busy || capabilities === null || file === undefined || tooLarge;
    ui.file.disabled = busy;
    ui.mode.disabled = busy;
    ui.retention.disabled = busy;
    ui.singleUse.disabled = busy;
    ui.expiryField.hidden = ui.retention.value !== "temporary";
    ui.expirySeconds.disabled = busy || ui.retention.value !== "temporary";
    ui.mediaSettings.disabled = busy || !automatic || capabilities === null;
    ui.imageSettings.disabled = capabilities?.media.image !== true;
    ui.videoSettings.disabled = capabilities?.media.video !== true;
    ui.lossless.disabled =
        capabilities?.av.flacEncoder !== true ||
        (!capabilities.media.audio && !capabilities.media.video);
    for (const row of imageRows) {
        for (const [scale, input] of row.scales) {
            input.disabled =
                scale === 1 ||
                capabilities === null ||
                scale > capabilities.image.limits.maxMultiplier;
        }
    }
    ui.imageLimit.textContent =
        capabilities === null
            ? ""
            : "Service limit: " +
              capabilities.image.limits.maxVariants +
              " image outputs per upload.";
    ui["file-name"].textContent = file?.name ?? "Click to choose a file";
    ui["file-info"].textContent =
        file === undefined
            ? "Images, audio, video, or other files"
            : formatBytes(file.size) + (tooLarge ? " · Above upload limit" : " · Ready to upload");
    ui["mode-note"].textContent =
        ui.mode.value === "resource"
            ? "Keep the file as it is, without thumbnails or media conversion."
            : "Datalith detects supported images, audio, and video and prepares versions for the web.";
};
/** @param {boolean} value */
const setBusy = (value) => {
    busy = value;
    updateUpload();
};
/**
 * @param {string} title
 * @param {HTMLInputElement | HTMLSelectElement} input
 */
const field = (title, input) => {
    const label = node("label", "", "field");
    label.append(node("span", title), input);
    return label;
};
/**
 * @param {HTMLSelectElement} select
 * @param {readonly number[]} values
 * @param {number} preferred
 * @param {string} suffix
 */
const fillSelect = (select, values, preferred, suffix) => {
    const current = Number(select.value);
    select.replaceChildren(
        ...values.map((value) => {
            const option = node("option", value + suffix);
            option.value = String(value);
            return option;
        }),
    );
    select.value = String(
        values.includes(current) ? current : values.includes(preferred) ? preferred : values[0],
    );
};
/**
 * @param {string} name
 * @param {number} edge
 */
const addImageRow = (name, edge) => {
    const root = node("fieldset", "", "recipe image-output-row");
    const nameInput = node("input");
    nameInput.type = "text";
    nameInput.value = name;
    nameInput.pattern = "[A-Za-z0-9_\\-]{1,64}";
    nameInput.maxLength = 64;
    nameInput.required = true;
    nameInput.dataset.field = "name";
    const edgeInput = node("input");
    edgeInput.type = "number";
    edgeInput.min = "1";
    edgeInput.max = "4294967295";
    edgeInput.step = "1";
    edgeInput.required = true;
    edgeInput.value = String(edge);
    edgeInput.dataset.field = "edge";
    const crop = node("select");
    crop.dataset.field = "crop";
    for (const [value, title] of [
        ["none", "No crop"],
        ["square", "Square (1:1)"],
        ["wide", "Wide (16:9)"],
        ["tall", "Tall (4:5)"],
    ]) {
        const option = node("option", title);
        option.value = value;
        crop.append(option);
    }
    const choices = node("div", "", "choices");
    /** @type {Map<number, HTMLInputElement>} */
    const scales = new Map();
    for (const scale of [1, 2, 3]) {
        const input = node("input");
        input.type = "checkbox";
        input.checked = scale <= 2;
        input.dataset.scale = String(scale);
        scales.set(scale, input);
        const label = node("label", "", "check");
        label.append(input, node("span", scale + "x" + (scale === 1 ? " (required)" : "")));
        choices.append(label);
    }
    const remove = node("button", "Remove output", "button subtle");
    remove.type = "button";
    const row = { root, name: nameInput, edge: edgeInput, crop, scales };
    remove.addEventListener("click", () => {
        root.remove();
        imageRows = imageRows.filter((entry) => entry !== row);
        updateUpload();
    });
    root.append(
        field("Output name", nameInput),
        field("Max edge at 1x (px)", edgeInput),
        field("Crop", crop),
        choices,
        remove,
    );
    imageRows.push(row);
    ui.imageOutputs.append(root);
    updateUpload();
};
/**
 * @param {number} resolution
 * @param {number} fps
 */
const addVideoRow = (resolution, fps) => {
    const root = node("fieldset", "", "recipe video-output-row");
    const size = node("select");
    size.dataset.field = "resolution";
    const rate = node("select");
    rate.dataset.field = "fps";
    fillSelect(
        size,
        knownResolutions.filter(
            (value) => capabilities?.video.resolutionTiers.includes(value) === true,
        ),
        resolution,
        "p",
    );
    fillSelect(
        rate,
        knownFrameRates.filter(
            (value) => capabilities?.video.frameRateTiers.includes(value) === true,
        ),
        fps,
        " fps",
    );
    const remove = node("button", "Remove output", "button subtle");
    remove.type = "button";
    const row = { root, resolution: size, fps: rate };
    remove.addEventListener("click", () => {
        root.remove();
        videoRows = videoRows.filter((entry) => entry !== row);
        updateUpload();
    });
    root.append(field("Resolution", size), field("Frame rate (fps)", rate), remove);
    videoRows.push(row);
    ui.videoOutputs.append(root);
    updateUpload();
};
const resetMediaSettings = () => {
    ui.keepOriginal.checked = true;
    ui.lossless.checked = false;
    imageRows = [];
    videoRows = [];
    rowSequence = 0;
    ui.imageOutputs.replaceChildren();
    ui.videoOutputs.replaceChildren();
    for (const edge of [256, 960].slice(0, capabilities?.image.limits.maxVariants ?? 2)) {
        addImageRow("image_" + ++rowSequence, edge);
    }
    const sizes = capabilities?.video.resolutionTiers ?? [];
    const rates = capabilities?.video.frameRateTiers ?? [];
    const defaults = [
        { resolution: 1080, fps: 60 },
        { resolution: 720, fps: 30 },
    ].filter((entry) => sizes.includes(entry.resolution) && rates.includes(entry.fps));
    for (const entry of defaults) {
        addVideoRow(entry.resolution, entry.fps);
    }
    if (defaults.length === 0 && capabilities?.media.video === true) {
        addVideoRow(720, 30);
    }
    settingsInitialized = true;
    updateUpload();
};
const initializeOutputSettings = () => {
    if (!settingsInitialized) {
        resetMediaSettings();
        return;
    }
    for (const row of videoRows) {
        fillSelect(
            row.resolution,
            knownResolutions.filter(
                (value) => capabilities?.video.resolutionTiers.includes(value) === true,
            ),
            Number(row.resolution.value),
            "p",
        );
        fillSelect(
            row.fps,
            knownFrameRates.filter(
                (value) => capabilities?.video.frameRateTiers.includes(value) === true,
            ),
            Number(row.fps.value),
            " fps",
        );
    }
    updateUpload();
};
const loadCapabilities = async () => {
    try {
        /** @type {Capabilities} */
        const supported = await request("/api/capabilities");
        capabilities = supported;
        initializeOutputSettings();
        ui.connection.textContent = "Connected";
        ui.connection.className = "badge connected";
        ui.capabilities.replaceChildren(
            ...mediaKinds.map((kind) =>
                node(
                    "span",
                    kinds[kind] + (supported.media[kind] ? "" : " (cannot process)"),
                    "capability" + (supported.media[kind] ? "" : " unavailable"),
                ),
            ),
        );
        ui.limit.textContent = "File size limit: " + formatBytes(capabilities.maxFileSize);
        updateUpload();
    } catch (error) {
        capabilities = null;
        ui.connection.textContent = "Not connected";
        ui.connection.className = "badge offline";
        ui.capabilities.replaceChildren(node("span", "Service details are not available", "hint"));
        ui.limit.textContent = "";
        updateUpload();
        throw error;
    }
};
const stopPlayback = () => {
    videoPlayback?.destroy();
    videoPlayback = null;
    if (player !== null) {
        player.pause();
        player.removeAttribute("src");
        player.load();
        player = null;
    }
};
/** @param {Wire<import("node-datalith").ImageVariant>} variant */
const imageVariantLabel = (variant) =>
    variant.name +
    " · " +
    variant.multiplier +
    "x · " +
    variant.width +
    " × " +
    variant.height +
    " · " +
    variant.format.toUpperCase() +
    " · " +
    (variant.animated
        ? variant.format === "gif"
            ? "Animated fallback"
            : "Animated"
        : variant.format === "webp"
          ? "Still image"
          : "Still fallback");
/**
 * @param {string} message
 * @param {string} status
 */
const closeSelection = (message, status) => {
    unavailableSelection = true;
    stopPlayback();
    ui.preview.replaceChildren();
    ui["download-original"].removeAttribute("href");
    ui["download-original"].setAttribute("aria-disabled", "true");
    ui.delete.disabled = true;
    ui["detail-note"].textContent = message;
    ui["detail-note"].hidden = false;
    ui.detailExpiry.dataset.accessState = status;
    ui.detailExpiry.dataset.verifiedExpired = "true";
    ui.detailExpiry.textContent = status;
};
const renderSessionLinks = () => {
    const active = [...playbackSessions.values()].filter(
        (entry) => new Date(entry.session.expiresAt).getTime() > Date.now(),
    );
    nextSessionExpiry = Math.min(
        ...active.map((entry) => new Date(entry.session.expiresAt).getTime()),
    );
    ui.activeSessions.hidden = active.length === 0;
    ui.activeSessions.replaceChildren(
        node("strong", "Active playback sessions"),
        node("p", "Return to a session here. Reloading the page clears these sessions.", "hint"),
        ...active.map(({ media }) => {
            const button = node("button", media.fileName, "button secondary");
            button.type = "button";
            button.dataset.mediaId = media.id;
            return button;
        }),
    );
};
/**
 * @param {Extract<Media, { kind: "resource" | "image" }>} media
 * @param {() => Promise<void>} refresh
 */
const renderSingleUseDownload = (media, refresh) => {
    const panel = node("div", "", "player-panel");
    const choice = node("select");
    choice.setAttribute("aria-label", "Single-use file version");
    /** @type {{ label: string; options: Record<string, string> }[]} */
    const versions = [];
    if (media.original !== null) {
        versions.push({
            label: "Original · " + formatBytes(media.original.fileSize),
            options: { variant: "original" },
        });
    }
    if (media.kind === "image") {
        versions.push(
            ...media.variants.map((variant) => ({
                label: imageVariantLabel(variant) + " · " + formatBytes(variant.file.fileSize),
                options: {
                    variant: variant.name,
                    multiplier: String(variant.multiplier),
                    format: variant.format,
                },
            })),
        );
    }
    if (versions.length === 0) {
        panel.append(node("p", "No file version is available to download.", "hint"));
        ui.preview.append(panel);
        return;
    }
    choice.append(
        ...versions.map((version, index) => {
            const option = node("option", version.label);
            option.value = String(index);
            return option;
        }),
    );
    const download = node("a", "Download once", "button primary");
    const note = node(
        "p",
        "Choose one version. Starting the download uses this file's one access, including all its versions. An interrupted download cannot be tried again.",
        "hint",
    );
    const updateDownload = () => {
        download.href = contentUrl(media, {
            ...versions[Number(choice.value)].options,
            download: "true",
        });
    };
    let pending = false;
    const version = selectionVersion;
    download.addEventListener("click", (event) => {
        if (pending || unavailableSelection || selected?.id !== media.id) {
            event.preventDefault();
            return;
        }
        pending = true;
        choice.disabled = true;
        download.setAttribute("aria-disabled", "true");
        note.textContent = "Waiting for the download to start…";
        const started = Date.now();
        const check = async () => {
            try {
                await request("/api/media/" + encodeURIComponent(media.id));
                if (Date.now() - started < 10_000) {
                    window.setTimeout(() => {
                        void check().catch(showError);
                    }, 1000);
                } else {
                    pending = false;
                    choice.disabled = false;
                    download.setAttribute("aria-disabled", "false");
                    note.textContent = "The download has not started. You can try again.";
                }
            } catch (error) {
                if (!(error instanceof ApiError) || error.status !== 404) {
                    note.textContent =
                        "Could not check the download status. Refresh the file list.";
                    throw error;
                }
                if (selected?.id === media.id && selectionVersion === version) {
                    const expired =
                        media.expiresAt !== null &&
                        new Date(media.expiresAt).getTime() <= Date.now();
                    closeSelection(
                        expired
                            ? "This file has expired."
                            : "This file's one access has been used.",
                        expired ? "Expired" : "Access used",
                    );
                }
                await refresh();
            }
        };
        window.setTimeout(() => {
            void check().catch(showError);
        }, 500);
    });
    choice.addEventListener("change", updateDownload);
    updateDownload();
    panel.append(field("File version", choice), note, download);
    ui.preview.append(panel);
};
/**
 * @param {PlaybackMedia} media
 * @param {() => Promise<void>} open
 * @param {() => Promise<void>} refresh
 */
const renderSingleUsePlayback = (media, open, refresh) => {
    const panel = node("div", "", "player-panel");
    const start = node("button", "Start playback", "button primary");
    start.type = "button";
    panel.append(
        node(
            "p",
            "Starting playback claims this file's one session. You can seek, replay, switch versions, and download until the session expires.",
            "hint",
        ),
        start,
    );
    const version = selectionVersion;
    const claim = async () => {
        start.disabled = true;
        clearError();
        let key = claimKeys.get(media.id);
        if (key === undefined) {
            key = window.crypto.randomUUID();
            claimKeys.set(media.id, key);
        }
        try {
            /** @type {PlaybackSession} */
            const session = await request(
                "/api/media/" + encodeURIComponent(media.id) + "/playback-sessions",
                { method: "POST", headers: { "idempotency-key": key } },
            );
            playbackSessions.set(media.id, { media, session });
            renderSessionLinks();
            if (selected?.id === media.id && selectionVersion === version) {
                await open();
                void player?.play().catch(() => {});
            }
            await refresh();
        } finally {
            start.disabled = false;
        }
    };
    start.addEventListener("click", () => {
        void claim().catch(showError);
    });
    ui.preview.append(panel);
};
/** @param {Extract<Media, { kind: "image" }>} media */
const renderImage = (media) => {
    const grid = node("div", "", "image-grid");
    const originalPane = node("div", "", "image-pane");
    originalPane.append(node("div", "Original image", "pane-heading"));
    const originalStage = node("div", "", "image-stage");
    const originalCaption = node("div", "Original not saved", "image-caption");
    const originalFile = media.original;
    if (originalFile !== null) {
        const original = node("img");
        original.alt = "Original image: " + media.fileName;
        original.addEventListener("load", () => {
            originalCaption.textContent =
                original.naturalWidth +
                " × " +
                original.naturalHeight +
                " px · " +
                formatBytes(originalFile.fileSize) +
                (media.animated ? " · Animated source · " + media.frameCount + " frames" : "");
        });
        original.src = contentUrl(media, { variant: "original" });
        originalStage.append(original);
        originalCaption.textContent = formatBytes(originalFile.fileSize);
        if (media.animated) {
            originalCaption.append(node("p", "Animated source · " + media.frameCount + " frames"));
        }
    } else {
        originalStage.append(node("p", "Original not saved.", "hint"));
    }
    originalPane.append(originalStage, originalCaption);
    const outputPane = node("div", "", "image-pane");
    const heading = node("div", "", "pane-heading");
    heading.append(node("strong", "Processed image"));
    const choice = node("select");
    choice.setAttribute("aria-label", "Image size and format");
    choice.append(
        ...media.variants.map((variant, index) => {
            const option = node("option", imageVariantLabel(variant));
            option.value = String(index);
            return option;
        }),
    );
    heading.append(choice);
    const stage = node("div", "", "image-stage");
    const image = node("img");
    image.alt = "Processed image: " + media.fileName;
    stage.append(image);
    const caption = node("div", "", "image-caption");
    const showVariant = () => {
        const variant = media.variants[Number(choice.value)];
        if (variant === undefined) {
            stage.replaceChildren(node("p", "No processed images.", "hint"));
            choice.disabled = true;
            return;
        }
        const options = {
            variant: variant.name,
            multiplier: String(variant.multiplier),
            format: variant.format,
        };
        image.src = contentUrl(media, options);
        let comparison = "";
        if (media.original !== null && media.original.fileSize > 0) {
            const change = Math.round((1 - variant.file.fileSize / media.original.fileSize) * 100);
            comparison =
                " · " +
                Math.abs(change) +
                "% " +
                (change >= 0 ? "smaller" : "larger") +
                " than original";
        }
        caption.replaceChildren(
            node(
                "p",
                variant.width +
                    " × " +
                    variant.height +
                    " px · " +
                    formatBytes(variant.file.fileSize) +
                    comparison,
            ),
            downloadLink(media, options, "Download this version"),
        );
    };
    choice.addEventListener("change", showVariant);
    outputPane.append(heading, stage, caption);
    grid.append(originalPane, outputPane);
    ui.preview.append(grid);
    showVariant();
};
/** @param {PlaybackMedia} media */
const startPlayback = (media) => {
    const panel = node("div", "", "player-panel");
    const note = node("p", "", "hint");
    if (media.kind === "audio") {
        const variants = media.audio.variants.filter(
            (item) => item.codec === "aac" || item.codec === "flac",
        );
        const bitrate = Math.max(
            ...variants.map((item) => (item.codec === "aac" ? item.bitrate : 0)),
        );
        const defaultIndex = variants.findIndex(
            (item) => item.codec === "aac" && item.bitrate === bitrate,
        );
        if (variants.length === 0) {
            panel.append(node("p", "No supported audio version to play.", "hint"));
        } else {
            const choice = node("select");
            choice.setAttribute("aria-label", "Audio version");
            choice.append(
                ...variants.map((variant, index) => {
                    const option = node(
                        "option",
                        variant.codec === "aac"
                            ? "AAC / M4A · " +
                                  Math.round(variant.bitrate / 1000) +
                                  " kbps" +
                                  (variants.some((entry) => entry.codec === "flac")
                                      ? " · Fallback"
                                      : "")
                            : "FLAC · Lossless",
                    );
                    option.value = String(index);
                    return option;
                }),
            );
            choice.value = String(Math.max(0, defaultIndex));
            player = node("audio");
            const audio = player;
            audio.controls = true;
            audio.preload = "metadata";
            audio.addEventListener("error", () => {
                note.textContent = "Could not load audio. Check the service or download the file.";
            });
            const download = node("div");
            const changeVersion = () => {
                const variant = variants[Number(choice.value)];
                const options = {
                    variant: variant.id,
                    format: variant.codec === "aac" ? "m4a" : "flac",
                };
                audio.pause();
                audio.src = contentUrl(media, options);
                note.textContent =
                    variant.codec.toUpperCase() +
                    (variant.codec === "aac" && variants.some((entry) => entry.codec === "flac")
                        ? " · Fallback"
                        : "") +
                    " · " +
                    media.audio.durationSeconds.toFixed(1) +
                    " s";
                if (audio.canPlayType(variant.file?.fileType ?? "audio/flac") === "") {
                    note.textContent += ". If playback is not supported, download this version.";
                }
                download.replaceChildren(downloadLink(media, options, "Download playback version"));
            };
            choice.addEventListener("change", changeVersion);
            panel.append(choice, audio, note, download);
            changeVersion();
        }
    } else {
        const video = node("video");
        player = video;
        player.controls = true;
        video.playsInline = true;
        player.preload = "metadata";
        const session = playbackSessions.get(media.id)?.session;
        const source =
            "/watch/" +
            encodeURIComponent(media.id) +
            "/master.m3u8" +
            (session === undefined ? "" : "?session=" + encodeURIComponent(session.token));
        const outputs = media.video.variants
            .map(
                (variant) =>
                    variant.width +
                    " × " +
                    variant.height +
                    " / " +
                    (variant.frameRate.numerator / variant.frameRate.denominator).toLocaleString(
                        "en-US",
                        { maximumFractionDigits: 2 },
                    ) +
                    " fps",
            )
            .join(", ");
        note.textContent =
            "HLS stream · " +
            media.video.durationSeconds.toFixed(1) +
            " s · Sizes: " +
            outputs +
            (media.video.variants.length > 1
                ? ". Quality adjusts to network speed."
                : ". Output size depends on the source.");
        panel.append(player, note);
        videoPlayback = createVideoPlayer(video, media.video, source, panel, (message) => {
            note.textContent = message;
        });
        player.addEventListener("error", () => {
            note.textContent = "Could not play this video. You can download the original.";
        });
    }
    ui.preview.append(panel);
};
/**
 * @param {HTMLElement} target
 * @param {Media} media
 */
const setExpiry = (target, media) => {
    const session =
        target === ui.detailExpiry ? playbackSessions.get(media.id)?.session : undefined;
    target.classList.add("expiry");
    target.dataset.expiresAt = session?.expiresAt ?? media.expiresAt ?? "";
    target.dataset.verifiedExpired = "false";
    target.dataset.singleUse = String(media.singleUse);
    target.dataset.playbackSession = String(session !== undefined);
    target.dataset.accessState = "";
    target.title =
        session !== undefined
            ? "Playback session ends " + expiryDateFormat.format(new Date(session.expiresAt))
            : media.expiresAt === null
              ? media.singleUse
                  ? "One download or playback session"
                  : "Kept until you delete it"
              : expiryDateFormat.format(new Date(media.expiresAt));
};
const updateExpiry = () => {
    let due = false;
    for (const target of document.querySelectorAll(".expiry")) {
        if (!(target instanceof window.HTMLElement)) {
            continue;
        }
        if (target.dataset.accessState !== undefined && target.dataset.accessState !== "") {
            target.textContent = target.dataset.accessState;
            continue;
        }
        const time = target.dataset.expiresAt;
        if (time === undefined || time === "") {
            target.textContent = target.dataset.singleUse === "true" ? "Single use" : "Permanent";
            continue;
        }
        const seconds = Math.max(0, Math.ceil((new Date(time).getTime() - Date.now()) / 1000));
        target.textContent =
            seconds === 0
                ? target.dataset.playbackSession === "true"
                    ? "Session expired"
                    : "Expired"
                : (target.dataset.playbackSession === "true" ? "Session ends in " : "Expires in ") +
                  Math.floor(seconds / 60) +
                  ":" +
                  String(seconds % 60).padStart(2, "0");
        if (target.dataset.singleUse === "true" && seconds > 0) {
            target.textContent += " · Single use";
        }
        if (target === ui.detailExpiry) {
            target.textContent += " · " + target.title;
        }
        due ||= seconds === 0 && target.dataset.verifiedExpired !== "true";
    }
    return due;
};
/** @param {MediaPage} page */
const renderMediaList = (page) => {
    currentPage = page.page;
    pageCount = Math.max(1, Math.ceil(page.total / page.perPage));
    ui["media-list"].replaceChildren(
        ...page.items.map((media) => {
            const row = node("tr");
            row.classList.toggle("selected", selected?.id === media.id);
            row.dataset.id = media.id;
            const name = node("td");
            const button = node("button", media.fileName, "file-link");
            button.type = "button";
            name.append(button);
            const type = node("td");
            type.append(node("span", kinds[media.kind], "kind " + media.kind));
            const storage = node("td");
            const expiry = node("span", "", "expiry");
            setExpiry(expiry, media);
            storage.append(expiry);
            row.append(
                name,
                type,
                node(
                    "td",
                    media.original === null ? "Not saved" : formatBytes(media.original.fileSize),
                ),
                node("td", dateFormat.format(new Date(media.createdAt))),
                storage,
            );
            return row;
        }),
    );
    ui.empty.hidden = page.items.length !== 0;
    ui.empty.textContent = "No files yet. Upload a file to get started!";
    ui.total.textContent = page.total + (page.total === 1 ? " file" : " files");
    ui["page-info"].textContent = "Page " + currentPage + " of " + pageCount;
    ui.previous.disabled = currentPage <= 1;
    ui.next.disabled = currentPage >= pageCount;
    renderSessionLinks();
    updateExpiry();
};
const loadList = async (page = currentPage) => {
    const version = ++listVersion;
    ui.previous.disabled = true;
    ui.next.disabled = true;
    try {
        /** @type {MediaPage} */
        const data = await request("/api/media?page=" + page);
        if (version !== listVersion) {
            return;
        }
        if (data.items.length === 0 && page > 1) {
            await loadList(Math.max(1, Math.ceil(data.total / data.perPage)));
            return;
        }
        renderMediaList(data);
    } catch (error) {
        if (version === listVersion) {
            ui.previous.disabled = currentPage <= 1;
            ui.next.disabled = currentPage >= pageCount;
            ui.empty.textContent = "Could not load the list. Check the service and refresh.";
        }
        throw error;
    }
};
/** @param {string} id */
const openMedia = async (id) => {
    const version = ++selectionVersion;
    clearError();
    // Use saved metadata after a claim hides the file from normal reads.
    const claimed = playbackSessions.get(id);
    /** @type {Media} */
    const media = claimed?.media ?? (await request("/api/media/" + encodeURIComponent(id)));
    if (version !== selectionVersion) {
        return;
    }
    stopPlayback();
    selected = media;
    unavailableSelection = false;
    ui.delete.disabled = false;
    ui.details.hidden = false;
    ui["detail-title"].textContent = media.fileName;
    ui["detail-kind"].textContent = kinds[media.kind];
    ui["detail-info"].textContent =
        "Created " +
        dateFormat.format(new Date(media.createdAt)) +
        (media.original === null
            ? " · Original not saved"
            : " · Original: " + formatBytes(media.original.fileSize));
    setExpiry(ui.detailExpiry, media);
    const allowOriginal = media.original !== null && (!media.singleUse || claimed !== undefined);
    ui["download-original"].removeAttribute("href");
    ui["download-original"].setAttribute("aria-disabled", String(!allowOriginal));
    if (allowOriginal) {
        ui["download-original"].href = contentUrl(media, { variant: "original", download: "true" });
    }
    ui["detail-note"].hidden = true;
    ui.preview.replaceChildren();
    if (claimed !== undefined && new Date(claimed.session.expiresAt).getTime() <= Date.now()) {
        closeSelection("This playback session has expired.", "Session expired");
    } else if (media.singleUse && (media.kind === "resource" || media.kind === "image")) {
        renderSingleUseDownload(media, loadList);
    } else if (
        media.singleUse &&
        claimed === undefined &&
        (media.kind === "audio" || media.kind === "video")
    ) {
        renderSingleUsePlayback(media, () => openMedia(media.id), loadList);
    } else if (media.kind === "image") {
        renderImage(media);
    } else if (media.kind === "audio" || media.kind === "video") {
        startPlayback(media);
    } else {
        const preview = node("div", "", "resource-preview");
        preview.append(node("span", "↓", "file-symbol"));
        const description = node("div");
        description.append(
            node("strong", "Original file saved"),
            node("p", "Download the file to use its original contents.", "hint"),
        );
        preview.append(description);
        ui.preview.append(preview);
    }
    if (media.warnings.length > 0 && !unavailableSelection) {
        ui["detail-note"].textContent =
            "Processing notes: " + media.warnings.map((warning) => warning.message).join("; ");
        ui["detail-note"].hidden = false;
    }
    for (const row of ui["media-list"].children) {
        if (row instanceof window.HTMLElement) {
            row.classList.toggle("selected", row.dataset.id === media.id);
        }
    }
    updateExpiry();
};
const refreshExpiry = async () => {
    expiryRefreshing = true;
    nextExpiryCheck = Date.now() + 3000;
    try {
        const media = selected;
        if (media !== null && !unavailableSelection) {
            const session = playbackSessions.get(media.id)?.session;
            if (session !== undefined && new Date(session.expiresAt).getTime() <= Date.now()) {
                closeSelection("This playback session has expired.", "Session expired");
            } else if (
                media.expiresAt !== null &&
                new Date(media.expiresAt).getTime() <= Date.now()
            ) {
                try {
                    await request("/api/media/" + encodeURIComponent(media.id));
                } catch (error) {
                    if (!(error instanceof ApiError) || error.status !== 404) {
                        throw error;
                    }
                    if (selected?.id === media.id) {
                        closeSelection("This file has expired.", "Expired");
                    }
                }
            }
        }
        await loadList();
    } finally {
        expiryRefreshing = false;
    }
};
/** @param {UploadTask} task */
const renderTask = (task) => {
    ui.task.hidden = false;
    const statuses = {
        queued: "Uploaded, waiting to start",
        running: "Processing file",
        cancelling: "Stopping task",
        succeeded: "Processing complete",
        failed: "Processing failed",
        cancelled: "Processing cancelled",
    };
    ui["task-status"].textContent = statuses[task.status];
    ui["task-message"].textContent =
        task.error?.message ??
        (task.status === "succeeded"
            ? "Added to the list. You can preview or download it now."
            : "Processing time depends on the file size and contents.");
    ui["task-progress"].hidden = ["failed", "cancelled"].includes(task.status);
    if (task.status === "succeeded") {
        ui["task-progress"].value = 1;
    } else if (task.totalUnits !== null && task.totalUnits > 0 && task.status === "running") {
        ui["task-progress"].value = Math.min(1, task.completedUnits / task.totalUnits);
        ui["task-message"].textContent +=
            " This stage: " + task.completedUnits + " / " + task.totalUnits + ".";
    } else {
        ui["task-progress"].removeAttribute("value");
    }
};
const pollTask = async () => {
    const id = taskId;
    if (id === null) {
        return;
    }
    window.clearTimeout(pollTimer);
    ui.resume.hidden = true;
    try {
        /** @type {UploadTask} */
        const task = await request("/api/tasks/" + encodeURIComponent(id));
        renderTask(task);
        if (task.status === "succeeded") {
            taskId = null;
            setBusy(false);
            await loadList(1);
            await openMedia(task.result.id);
            ui.details.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } else if (task.status === "failed" || task.status === "cancelled") {
            taskId = null;
            setBusy(false);
        } else {
            pollTimer = window.setTimeout(() => {
                void pollTask();
            }, 1000);
        }
    } catch (error) {
        if (taskId !== null) {
            ui["task-status"].textContent = "Could not get task status";
            ui["task-message"].textContent = "The task may still be running. You can check again.";
            ui["task-progress"].hidden = true;
            ui.resume.hidden = false;
        }
        showError(error);
    }
};

ui.file.addEventListener("change", updateUpload);
ui["media-list"].addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof window.HTMLElement && target.closest(".file-link") !== null) {
        const id = target.closest("tr")?.dataset.id;
        if (id !== undefined) {
            void openMedia(id).catch(showError);
        }
    }
});
ui.activeSessions.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof window.HTMLElement) {
        const id = target.closest("button")?.dataset.mediaId;
        if (id !== undefined) {
            void openMedia(id).catch(showError);
        }
    }
});
ui.mode.addEventListener("change", updateUpload);
ui.retention.addEventListener("change", updateUpload);
ui.resetSettings.addEventListener("click", resetMediaSettings);
ui.addImageOutput.addEventListener("click", () => {
    let name = "";
    do {
        name = "image_" + ++rowSequence;
    } while (imageRows.some((row) => row.name.value === name));
    addImageRow(name, 960);
});
ui.addVideoOutput.addEventListener("click", () => {
    addVideoRow(720, 30);
});
ui["upload-form"].addEventListener("submit", (event) => {
    event.preventDefault();
    const file = ui.file.files?.[0];
    if (busy || file === undefined || capabilities === null) {
        return;
    }
    const upload = async () => {
        const settings = collectSettings();
        clearError();
        setBusy(true);
        ui.task.hidden = false;
        ui.resume.hidden = true;
        ui["task-status"].textContent = "Uploading file";
        ui["task-message"].textContent = "Saving the file before media processing starts.";
        ui["task-progress"].hidden = false;
        ui["task-progress"].removeAttribute("value");
        try {
            /** @type {UploadTask} */
            const task = await request(
                "/api/uploads?" +
                    new URLSearchParams({
                        fileName: file.name,
                        mode: ui.mode.value,
                        options: JSON.stringify(settings),
                    }),
                {
                    method: "POST",
                    headers: { "content-type": file.type || "application/octet-stream" },
                    body: file,
                },
            );
            taskId = task.id;
            renderTask(task);
            pollTimer = window.setTimeout(() => {
                void pollTask();
            }, 1000);
        } catch (error) {
            setBusy(false);
            ui["task-status"].textContent = "Upload did not finish";
            ui["task-message"].textContent = "Check the service and the file, then try again.";
            ui["task-progress"].hidden = true;
            showError(error);
        }
    };
    void upload();
});
ui.resume.addEventListener("click", () => {
    clearError();
    void pollTask();
});
ui.previous.addEventListener("click", () => {
    clearError();
    void loadList(currentPage - 1).catch(showError);
});
ui.next.addEventListener("click", () => {
    clearError();
    void loadList(currentPage + 1).catch(showError);
});
ui.refresh.addEventListener("click", () => {
    clearError();
    void Promise.all([loadCapabilities(), loadList()]).catch(showError);
});
ui.delete.addEventListener("click", () => {
    const media = selected;
    if (
        media === null ||
        !window.confirm(`Delete "${media.fileName}" from Datalith? This cannot be undone.`)
    ) {
        return;
    }
    const remove = async () => {
        const id = media.id;
        ui.delete.disabled = true;
        clearError();
        try {
            await request("/api/media/" + encodeURIComponent(id), { method: "DELETE" });
            playbackSessions.delete(id);
            claimKeys.delete(id);
            if (selected?.id === id) {
                selectionVersion++;
                stopPlayback();
                selected = null;
                ui.details.hidden = true;
            }
            await loadList();
        } finally {
            ui.delete.disabled = false;
        }
    };
    void remove().catch(showError);
});
void Promise.all([loadCapabilities(), loadList(1)]).catch(showError);
updateUpload();
window.setInterval(() => {
    if (Date.now() >= nextSessionExpiry) {
        renderSessionLinks();
    }
    if (updateExpiry() && !expiryRefreshing && Date.now() >= nextExpiryCheck) {
        void refreshExpiry().catch(showError);
    }
}, 1000);
