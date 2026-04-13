const SUPPORTED_FORMATS = {
  jpg: { mime: "image/jpeg", extension: ".jpg", qualityType: "lossy" },
  jpeg: { mime: "image/jpeg", extension: ".jpeg", qualityType: "lossy" },
  png: { mime: "image/png", extension: ".png", qualityType: "lossless" },
  webp: { mime: "image/webp", extension: ".webp", qualityType: "lossy" },
};

const state = {
  selectedItems: [],
  busy: false,
  plan: [],
  sourceSizeById: new Map(),
  lastSelectionRefreshAt: 0,
  dimensionLocked: true,
  picaInstance: null,
  dialogResolver: null,
  dialogCancellable: false,
};

function getEl(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const el = getEl(id);
  if (el) {
    el.textContent = value;
  }
}

function setDisabled(id, disabled) {
  const el = getEl(id);
  if (el) {
    el.disabled = disabled;
  }
}

function getSelectedResultMode() {
  const activeButton = document.querySelector(".segmented-button[data-result-mode].active");
  const mode = String(activeButton?.getAttribute("data-result-mode") || "replace");
  return ["replace", "duplicate"].includes(mode) ? mode : "replace";
}

function setResultMode(mode) {
  const nextMode = ["replace", "duplicate"].includes(mode) ? mode : "replace";
  const buttons = document.querySelectorAll(".segmented-button[data-result-mode]");

  buttons.forEach((button) => {
    const isActive = button.getAttribute("data-result-mode") === nextMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function isDialogOpen() {
  const root = getEl("dialogRoot");
  return Boolean(root && !root.hidden);
}

function closeDialog(result) {
  const root = getEl("dialogRoot");
  if (!root || root.hidden) {
    return;
  }

  root.hidden = true;
  const resolver = state.dialogResolver;
  state.dialogResolver = null;
  state.dialogCancellable = false;

  if (resolver) {
    resolver(result);
  }
}

function showDialog({ title, message, variant = "info", confirmText = "确认", cancelText = "取消", cancellable = false }) {
  const root = getEl("dialogRoot");
  const titleEl = getEl("dialogTitle");
  const messageEl = getEl("dialogMessage");
  const iconEl = getEl("dialogIcon");
  const actionsEl = getEl("dialogActions");
  const confirmButton = getEl("dialogConfirmButton");
  const cancelButton = getEl("dialogCancelButton");

  if (!root || !titleEl || !messageEl || !iconEl || !actionsEl || !confirmButton || !cancelButton) {
    return Promise.resolve(true);
  }

  titleEl.textContent = title;
  messageEl.textContent = message;
  confirmButton.textContent = confirmText;
  cancelButton.textContent = cancelText;
  cancelButton.hidden = !cancellable;
  actionsEl.classList.toggle("single", !cancellable);
  iconEl.className = `dialog-icon ${variant}`;
  iconEl.textContent = variant === "success" ? "✓" : variant === "error" ? "!" : variant === "confirm" ? "?" : "i";

  root.hidden = false;
  state.dialogCancellable = cancellable;

  return new Promise((resolve) => {
    state.dialogResolver = resolve;
    window.setTimeout(() => {
      confirmButton.focus();
    }, 0);
  });
}

function showNotice(message, options = {}) {
  return showDialog({
    title: options.title || "提示",
    message,
    variant: options.variant || "info",
    confirmText: options.confirmText || "确认",
    cancellable: false,
  });
}

function showConfirm(message, options = {}) {
  return showDialog({
    title: options.title || "确认操作",
    message,
    variant: options.variant || "confirm",
    confirmText: options.confirmText || "确认",
    cancelText: options.cancelText || "取消",
    cancellable: true,
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getNodeModule(name) {
  try {
    if (window.require) {
      return window.require(name);
    }
  } catch (error) {
    return null;
  }

  try {
    return require(name);
  } catch (error) {
    return null;
  }
}

function toFiniteByteSize(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return null;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }

  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const fractionDigits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`;
}

function getKnownItemSizeBytes(item) {
  const candidates = [item?.size, item?.bytes, item?.byteSize, item?.fileSize];

  for (const candidate of candidates) {
    const normalized = toFiniteByteSize(candidate);
    if (normalized !== null) {
      return normalized;
    }
  }

  return null;
}

function getOptionalNodeRuntimeForStats() {
  const fs = getNodeModule("fs");
  if (!fs?.promises?.stat) {
    return null;
  }

  return { fs };
}

async function resolveSourceSizeBytes(item, nodeRuntime) {
  const knownSize = getKnownItemSizeBytes(item);
  if (knownSize !== null) {
    return knownSize;
  }

  if (item?.filePath && nodeRuntime?.fs?.promises?.stat) {
    try {
      const stat = await nodeRuntime.fs.promises.stat(item.filePath);
      const normalized = toFiniteByteSize(stat?.size);
      if (normalized !== null) {
        return normalized;
      }
    } catch (error) {
      return null;
    }
  }

  return null;
}

async function hydrateSourceSizes(items) {
  state.sourceSizeById.clear();

  if (!Array.isArray(items) || !items.length) {
    return;
  }

  const nodeRuntime = getOptionalNodeRuntimeForStats();
  await Promise.all(
    items.map(async (item) => {
      const itemId = item?.id;
      if (!itemId) {
        return;
      }

      const sizeBytes = await resolveSourceSizeBytes(item, nodeRuntime);
      if (sizeBytes !== null) {
        state.sourceSizeById.set(itemId, sizeBytes);
      }
    })
  );
}

function toPositiveNumberOrNull(raw) {
  if (!raw) {
    return null;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("宽度和高度必须是大于 0 的数字。");
  }
  return Math.round(value);
}

function readSettings() {
  const maxWidth = toPositiveNumberOrNull(getEl("maxWidthInput")?.value?.trim());
  const maxHeight = toPositiveNumberOrNull(getEl("maxHeightInput")?.value?.trim());
  const qualityValue = Number(getEl("qualityInput")?.value ?? "100");
  const convertFormat = String(getEl("outputFormatSelect")?.value ?? "keep");
  const resultMode = getSelectedResultMode();

  if (!Number.isFinite(qualityValue) || qualityValue < 1 || qualityValue > 100) {
    throw new Error("压缩质量必须在 1 到 100 之间。");
  }

  if (!["keep", "jpg", "webp"].includes(convertFormat)) {
    throw new Error("输出格式选项无效。");
  }

  if (!["replace", "duplicate"].includes(resultMode)) {
    throw new Error("输出方式选项无效。");
  }

  if (!maxWidth && !maxHeight && convertFormat === "keep" && Math.round(qualityValue) === 100) {
    throw new Error("请至少设置尺寸限制、压缩质量或输出格式中的一项。");
  }

  return {
    maxWidth,
    maxHeight,
    keepAspect: Boolean(getEl("keepAspectCheckbox")?.checked),
    onlyShrink: Boolean(getEl("onlyShrinkCheckbox")?.checked),
    qualityPercent: Math.round(qualityValue),
    convertFormat,
    resultMode,
  };
}

function normalizeExtension(item) {
  const candidates = [item?.ext, item?.extension, item?.name, item?.filename, item?.filePath];

  for (const candidate of candidates) {
    const value = String(candidate || "");
    const match = value.match(/\.?([a-zA-Z0-9]+)$/);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }
  }

  return "";
}

function buildDisplayName(item) {
  const baseName = String(item?.name || item?.filename || item?.id || "未命名项目").trim();
  const extension = normalizeExtension(item);
  if (!extension) {
    return baseName;
  }

  const suffix = `.${extension}`;
  if (baseName.toLowerCase().endsWith(suffix.toLowerCase())) {
    return baseName;
  }

  return `${baseName}${suffix}`;
}

function getPicaInstance() {
  if (state.picaInstance) {
    return state.picaInstance;
  }

  if (typeof window.pica === "function") {
    state.picaInstance = window.pica();
    return state.picaInstance;
  }

  return null;
}

function updateQualityLabel() {
  const qualityInput = getEl("qualityInput");
  const qualityValueLabel = getEl("qualityValueLabel");
  if (!qualityInput || !qualityValueLabel) {
    return;
  }

  qualityValueLabel.textContent = String(qualityInput.value || "100");
}

function applyDimensionLockVisual() {
  const lockButton = getEl("dimensionLockButton");
  if (!lockButton) {
    return;
  }

  lockButton.classList.toggle("locked", state.dimensionLocked);
  lockButton.setAttribute("aria-pressed", state.dimensionLocked ? "true" : "false");
}

function syncDimensionInputs(changedInputId) {
  if (!state.dimensionLocked) {
    return;
  }

  const widthInput = getEl("maxWidthInput");
  const heightInput = getEl("maxHeightInput");
  if (!widthInput || !heightInput) {
    return;
  }

  if (changedInputId === "maxWidthInput") {
    heightInput.value = widthInput.value;
    return;
  }

  if (changedInputId === "maxHeightInput") {
    widthInput.value = heightInput.value;
  }
}

function enableDimensionLock() {
  state.dimensionLocked = true;
  const widthInput = getEl("maxWidthInput");
  const heightInput = getEl("maxHeightInput");
  if (widthInput && heightInput) {
    if (widthInput.value) {
      heightInput.value = widthInput.value;
    } else if (heightInput.value) {
      widthInput.value = heightInput.value;
    }
  }
  applyDimensionLockVisual();
}

function toggleDimensionLock() {
  state.dimensionLocked = !state.dimensionLocked;
  if (state.dimensionLocked) {
    enableDimensionLock();
  } else {
    applyDimensionLockVisual();
  }
  derivePlan();
}

function formatSize(width, height) {
  if (!width || !height) {
    return "未知尺寸";
  }
  return `${width} x ${height}`;
}

function resolveOutputFormat(item, settings) {
  if (settings.convertFormat === "jpg") {
    return SUPPORTED_FORMATS.jpg;
  }

  if (settings.convertFormat === "webp") {
    return SUPPORTED_FORMATS.webp;
  }

  const extension = normalizeExtension(item);
  return SUPPORTED_FORMATS[extension] || null;
}

function describeFormatConversion(item, settings, outputFormat) {
  const sourceExtension = normalizeExtension(item);
  const sourceLabel = sourceExtension ? sourceExtension.toUpperCase() : "原格式";
  const outputLabel = outputFormat.extension.replace(".", "").toUpperCase();

  if (settings.convertFormat === "keep") {
    return `对应格式如（${outputLabel}）`;
  }

  if (sourceLabel === outputLabel) {
    return `统一输出为 ${outputLabel}`;
  }

  return `${sourceLabel} -> ${outputLabel}`;
}

function describeResultMode(settings) {
  return settings.resultMode === "duplicate" ? "创建副本" : "替换原图";
}

function computeTargetSize(item, settings) {
  const width = Number(item.width);
  const height = Number(item.height);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      status: "skip",
      message: "无法读取原图尺寸",
      targetWidth: null,
      targetHeight: null,
    };
  }

  let targetWidth = width;
  let targetHeight = height;

  if (settings.keepAspect) {
    const widthScale = settings.maxWidth ? settings.maxWidth / width : Number.POSITIVE_INFINITY;
    const heightScale = settings.maxHeight ? settings.maxHeight / height : Number.POSITIVE_INFINITY;
    let scale = Math.min(widthScale, heightScale);

    if (!Number.isFinite(scale)) {
      scale = 1;
    }

    if (settings.onlyShrink) {
      scale = Math.min(scale, 1);
    }

    targetWidth = Math.max(1, Math.round(width * scale));
    targetHeight = Math.max(1, Math.round(height * scale));
  } else {
    targetWidth = settings.maxWidth ?? width;
    targetHeight = settings.maxHeight ?? height;

    if (settings.onlyShrink) {
      targetWidth = Math.min(targetWidth, width);
      targetHeight = Math.min(targetHeight, height);
    }
  }

  if (targetWidth === width && targetHeight === height) {
    return {
      status: "skip",
      message: settings.onlyShrink ? "尺寸已在限制范围内" : "目标尺寸与原图一致",
      targetWidth,
      targetHeight,
    };
  }

  return {
    status: "ready",
    message: `${formatSize(width, height)} -> ${formatSize(targetWidth, targetHeight)}`,
    targetWidth,
    targetHeight,
  };
}

function createPlanEntry(item, settings) {
  const extension = normalizeExtension(item);
  const outputFormat = resolveOutputFormat(item, settings);
  const sourceSizeBytes = state.sourceSizeById.get(item?.id) ?? getKnownItemSizeBytes(item);

  if (!outputFormat) {
    return {
      item,
      status: "skip",
      message: `暂不支持 ${extension || "未知"} 格式`,
      outputFormat: null,
      targetWidth: null,
      targetHeight: null,
      sourceSizeBytes,
      outputSizeBytes: null,
    };
  }

  if (!item?.filePath && !item?.fileURL) {
    return {
      item,
      status: "skip",
      message: "没有可用的原图路径",
      outputFormat: null,
      targetWidth: null,
      targetHeight: null,
      sourceSizeBytes,
      outputSizeBytes: null,
    };
  }

  const resizeResult = computeTargetSize(item, settings);
  const needsFormatConversion = settings.convertFormat !== "keep";
  const needsRecompression = outputFormat.qualityType === "lossy" && settings.qualityPercent < 100;
  const shouldProcess = resizeResult.status === "ready" || needsFormatConversion || needsRecompression;
  const qualityDescription =
    outputFormat.qualityType === "lossless"
      ? "保持原格式无损输出"
      : `质量 ${settings.qualityPercent}`;
  const formatDescription = describeFormatConversion(item, settings, outputFormat);
  const resultModeDescription = describeResultMode(settings);
  const operationDescription =
    resizeResult.status === "ready" ? resizeResult.message : `尺寸保持 ${formatSize(item.width, item.height)}`;

  return {
    item,
    status: shouldProcess ? "ready" : resizeResult.status,
    message: `${operationDescription} | ${formatDescription} | ${qualityDescription} | ${resultModeDescription}`,
    outputFormat,
    targetWidth: resizeResult.targetWidth,
    targetHeight: resizeResult.targetHeight,
    qualityPercent: settings.qualityPercent,
    resultMode: settings.resultMode,
    sourceSizeBytes,
    outputSizeBytes: null,
  };
}

function derivePlan() {
  let settings = null;

  try {
    settings = readSettings();
  } catch (error) {
    state.plan = state.selectedItems.map((item) => ({
      item,
      status: "skip",
      message: error.message || String(error),
      outputFormat: null,
      targetWidth: null,
      targetHeight: null,
      sourceSizeBytes: state.sourceSizeById.get(item?.id) ?? getKnownItemSizeBytes(item),
      outputSizeBytes: null,
    }));
    renderSelectionList();
    updateActionState();
    return;
  }

  state.plan = state.selectedItems.map((item) => createPlanEntry(item, settings));
  renderSelectionList();
  updateActionState();
}

function getStatusLabel(status) {
  switch (status) {
    case "ready":
      return "将处理";
    case "processing":
      return "处理中";
    case "done":
      return "已完成";
    case "error":
      return "失败";
    default:
      return "跳过";
  }
}

function renderOutputSizeCell(entry) {
  if (entry.status === "done" && Number.isFinite(entry.outputSizeBytes)) {
    return `<span class="selection-size-value">${escapeHtml(formatBytes(entry.outputSizeBytes))}</span>`;
  }

  return `<span class="status-badge ${escapeHtml(entry.status)} selection-size-badge">${escapeHtml(
    getStatusLabel(entry.status)
  )}</span>`;
}

function renderSelectionList() {
  const container = getEl("selectionList");
  if (!container) {
    return;
  }

  setText("selectedCount", String(state.selectedItems.length));
  const processableCount = state.plan.filter((entry) => entry.status === "ready" || entry.status === "done").length;
  setText("processableCount", String(processableCount));

  if (!state.selectedItems.length) {
    container.innerHTML =
      '<div class="selection-empty">还没有读取到已选图片。请先在 Eagle 中选中需要处理的图片，再点击“刷新已选项目”。</div>';
    return;
  }

  const listHead = `
    <div class="selection-list-head" aria-hidden="true">
      <div class="selection-list-head-main"></div>
      <div class="selection-list-head-sizes">
        <span>原大小</span>
        <span>压缩后</span>
      </div>
    </div>
  `;

  container.innerHTML =
    listHead +
    state.plan
    .map((entry) => {
      const item = entry.item;
      const title = buildDisplayName(item);
      return `
        <div class="selection-item">
          <div class="selection-item-main">
            <div class="selection-item-title">${escapeHtml(title)}</div>
            <div class="selection-item-note">${escapeHtml(entry.message || "")}</div>
          </div>
          <div class="selection-item-sizes">
            <div class="selection-size-cell">
              <span class="selection-size-value">${escapeHtml(formatBytes(entry.sourceSizeBytes))}</span>
            </div>
            <div class="selection-size-cell">
              ${renderOutputSizeCell(entry)}
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

function updateActionState() {
  const hasReadyItems = state.plan.some((entry) => entry.status === "ready");
  setDisabled("refreshSelectionButton", state.busy);
  setDisabled("runButton", state.busy || !hasReadyItems || !window.eagle?.item?.getSelected);
  setDisabled("dimensionLockButton", state.busy);
  setDisabled("resultModeReplaceButton", state.busy);
  setDisabled("resultModeDuplicateButton", state.busy);
}

async function readSelectedItems() {
  if (!window.eagle?.item?.getSelected) {
    setText("selectionHint", "");
    setText("listHint", "浏览器预览模式下不会真的处理图片。");
    state.selectedItems = [];
    state.plan = [];
    state.sourceSizeById.clear();
    renderSelectionList();
    updateActionState();
    return;
  }

  try {
    const items = await window.eagle.item.getSelected();
    state.selectedItems = Array.isArray(items) ? items : [];
    await hydrateSourceSizes(state.selectedItems);
    state.lastSelectionRefreshAt = Date.now();
    setText("selectionHint", "");
    setText("listHint", "仅处理 JPG / JPEG / PNG / WEBP 静态图片；支持尺寸调整、压缩质量调节和输出格式转换。");
    derivePlan();
  } catch (error) {
    state.selectedItems = [];
    state.plan = [];
    state.sourceSizeById.clear();
    renderSelectionList();
    updateActionState();
    showNotice(`读取已选项目失败：${error?.message || error}`, {
      title: "读取失败",
      variant: "error",
    });
  }
}

async function refreshSelectionWithRetry(delays = [0, 120, 320]) {
  for (const waitMs of delays) {
    if (waitMs > 0) {
      await delay(waitMs);
    }

    await readSelectedItems();
    if (state.selectedItems.length) {
      return;
    }
  }
}

function updatePlanEntryStatus(itemId, status, message, options = {}) {
  const entry = state.plan.find((candidate) => candidate.item?.id === itemId);
  if (!entry) {
    return;
  }
  entry.status = status;
  entry.message = message;
  if (Object.prototype.hasOwnProperty.call(options, "outputSizeBytes")) {
    entry.outputSizeBytes = options.outputSizeBytes;
  }
}

function ensureNodeRuntime() {
  const fs = getNodeModule("fs");
  const path = getNodeModule("path");
  const os = getNodeModule("os");
  const url = getNodeModule("url");

  if (!fs || !path || !os || !url) {
    throw new Error("当前 Eagle 运行环境未提供文件系统能力，无法写入临时文件。");
  }

  return { fs, path, os, url };
}

function resolveSourceUrl(item, nodeRuntime) {
  if (item.fileURL) {
    return item.fileURL;
  }

  if (item.filePath) {
    return nodeRuntime.url.pathToFileURL(item.filePath).href;
  }

  return "";
}

async function loadSourceBlob(item, nodeRuntime) {
  if (item.filePath) {
    const fileBytes = await nodeRuntime.fs.promises.readFile(item.filePath);
    const extension = normalizeExtension(item);
    const mime = SUPPORTED_FORMATS[extension]?.mime || "application/octet-stream";
    return new Blob([fileBytes], { type: mime });
  }

  const sourceUrl = resolveSourceUrl(item, nodeRuntime);
  if (!sourceUrl) {
    throw new Error("缺少原图路径");
  }

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`读取原图失败（${response.status}）`);
  }

  return response.blob();
}

function createWorkingCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function getCanvasContext(canvas) {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("无法创建画布上下文");
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return context;
}

function drawSourceToCanvas(source, width, height) {
  const canvas = createWorkingCanvas(width, height);
  const context = getCanvasContext(canvas);
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

function resizeCanvasProgressively(source, targetWidth, targetHeight) {
  let currentCanvas = drawSourceToCanvas(source, source.width, source.height);
  let currentWidth = source.width;
  let currentHeight = source.height;

  while (currentWidth / 2 >= targetWidth && currentHeight / 2 >= targetHeight) {
    const nextWidth = Math.max(targetWidth, Math.round(currentWidth / 2));
    const nextHeight = Math.max(targetHeight, Math.round(currentHeight / 2));
    const nextCanvas = createWorkingCanvas(nextWidth, nextHeight);
    const nextContext = getCanvasContext(nextCanvas);
    nextContext.drawImage(currentCanvas, 0, 0, nextWidth, nextHeight);
    currentCanvas = nextCanvas;
    currentWidth = nextWidth;
    currentHeight = nextHeight;
  }

  if (currentWidth !== targetWidth || currentHeight !== targetHeight) {
    currentCanvas = drawSourceToCanvas(currentCanvas, targetWidth, targetHeight);
  }

  return currentCanvas;
}

async function exportCanvasBlob(canvas, entry) {
  const picaInstance = getPicaInstance();
  const qualityValue = entry.outputFormat.qualityType === "lossy" ? entry.qualityPercent / 100 : undefined;
  if (picaInstance?.toBlob) {
    return picaInstance.toBlob(canvas, entry.outputFormat.mime, qualityValue);
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (nextBlob) => {
        if (!nextBlob) {
          reject(new Error("生成输出图片失败"));
          return;
        }
        resolve(nextBlob);
      },
      entry.outputFormat.mime,
      qualityValue
    );
  });
}

function prepareCanvasForExport(canvas, entry) {
  if (entry.outputFormat.mime !== "image/jpeg") {
    return canvas;
  }

  const flattenedCanvas = createWorkingCanvas(canvas.width, canvas.height);
  const context = getCanvasContext(flattenedCanvas);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, flattenedCanvas.width, flattenedCanvas.height);
  context.drawImage(canvas, 0, 0);
  return flattenedCanvas;
}

async function drawResizedBlob(blob, entry) {
  const bitmap = await createImageBitmap(blob);

  try {
    const resizedCanvas = createWorkingCanvas(entry.targetWidth, entry.targetHeight);
    const picaInstance = getPicaInstance();

    if (picaInstance?.resize) {
      await picaInstance.resize(bitmap, resizedCanvas, {
        filter: "mks2013",
      });
      return exportCanvasBlob(prepareCanvasForExport(resizedCanvas, entry), entry);
    }

    const fallbackCanvas = resizeCanvasProgressively(bitmap, entry.targetWidth, entry.targetHeight);
    return exportCanvasBlob(prepareCanvasForExport(fallbackCanvas, entry), entry);
  } finally {
    bitmap.close?.();
  }
}

async function writeTempFile(outputBlob, entry, nodeRuntime) {
  const { fs, path, os } = nodeRuntime;
  const tempRoot = path.join(os.tmpdir(), "eagle-plugin-image-size-batch-resizer");
  await fs.promises.mkdir(tempRoot, { recursive: true });

  const fileName = `${entry.item.id || Date.now()}-${Date.now()}${entry.outputFormat.extension}`;
  const tempPath = path.join(tempRoot, fileName);
  const fileBytes = new Uint8Array(await outputBlob.arrayBuffer());
  await fs.promises.writeFile(tempPath, fileBytes);
  return tempPath;
}

async function resolveWorkingItem(item) {
  if (typeof item?.replaceFile === "function") {
    return item;
  }

  const result = await window.eagle?.item?.get?.({ id: item.id });
  return Array.isArray(result) ? result[0] : result;
}

async function createDuplicateItem(entry, tempPath) {
  if (typeof window.eagle?.item?.addFromPath !== "function") {
    throw new Error("当前 Eagle 版本未提供 addFromPath()，无法创建副本。");
  }

  const originalItem = entry.item || {};
  const options = {
    name: originalItem.name || originalItem.filename || "未命名项目",
  };

  if (Array.isArray(originalItem.tags) && originalItem.tags.length) {
    options.tags = [...originalItem.tags];
  }

  if (Array.isArray(originalItem.folders) && originalItem.folders.length) {
    options.folders = [...originalItem.folders];
  }

  if (typeof originalItem.annotation === "string" && originalItem.annotation.trim()) {
    options.annotation = originalItem.annotation;
  }

  if (typeof originalItem.url === "string" && originalItem.url.trim()) {
    options.website = originalItem.url;
  } else if (typeof originalItem.website === "string" && originalItem.website.trim()) {
    options.website = originalItem.website;
  }

  return window.eagle.item.addFromPath(tempPath, options);
}

async function processEntry(entry, nodeRuntime) {
  const sourceBlob = await loadSourceBlob(entry.item, nodeRuntime);
  const outputBlob = await drawResizedBlob(sourceBlob, entry);
  const tempPath = await writeTempFile(outputBlob, entry, nodeRuntime);

  try {
    if (entry.resultMode === "duplicate") {
      await createDuplicateItem(entry, tempPath);
      return { mode: "duplicate", outputSizeBytes: outputBlob.size };
    }

    const workingItem = await resolveWorkingItem(entry.item);
    if (!workingItem || typeof workingItem.replaceFile !== "function") {
      throw new Error("当前项目不支持 replaceFile()");
    }

    await workingItem.replaceFile(tempPath);
    return { mode: "replace", outputSizeBytes: outputBlob.size };
  } finally {
    try {
      await nodeRuntime.fs.promises.unlink(tempPath);
    } catch (error) {
      // Ignore temp cleanup failures.
    }
  }
}

async function handleRun() {
  let settings = null;
  try {
    settings = readSettings();
  } catch (error) {
    derivePlan();
    showNotice(error?.message || String(error), {
      title: "参数错误",
      variant: "error",
    });
    return;
  }

  const readyEntries = state.plan.filter((entry) => entry.status === "ready");
  if (!readyEntries.length) {
    showNotice("当前没有可处理的图片。请先选择图片，并确认宽高限制、压缩质量或格式转换能产生实际处理。", {
      title: "没有可处理项",
      variant: "info",
    });
    return;
  }

  const confirmed = await showConfirm(
    settings.resultMode === "duplicate"
      ? `将批量处理 ${readyEntries.length} 张图片，并创建新的处理结果副本。`
      : `将批量处理 ${readyEntries.length} 张图片，并直接替换 Eagle 项目中的原文件。`,
    {
      title: "确认开始处理",
      confirmText: "确认",
      cancelText: "取消",
      variant: "confirm",
    }
  );
  if (!confirmed) {
    return;
  }

  let doneCount = 0;
  let errorCount = 0;
  let duplicateCount = 0;
  state.busy = true;
  updateActionState();

  try {
    const nodeRuntime = ensureNodeRuntime();

    for (const entry of readyEntries) {
      updatePlanEntryStatus(entry.item.id, "processing", entry.message, {
        outputSizeBytes: null,
      });
      renderSelectionList();

      try {
        const result = await processEntry(entry, nodeRuntime);
        doneCount += 1;
        if (result?.mode === "duplicate") {
          duplicateCount += 1;
        }
        updatePlanEntryStatus(entry.item.id, "done", entry.message, {
          outputSizeBytes: result?.outputSizeBytes ?? null,
        });
      } catch (error) {
        errorCount += 1;
        updatePlanEntryStatus(entry.item.id, "error", `处理失败：${error?.message || error}`, {
          outputSizeBytes: null,
        });
      }

      renderSelectionList();
    }

    const resultLines = [];
    if (duplicateCount > 0) {
      resultLines.push(`已成功处理 ${doneCount} 张图片，并创建 ${duplicateCount} 个副本。`);
    } else {
      resultLines.push(`已成功处理 ${doneCount} 张图片。`);
    }
    if (errorCount > 0) {
      resultLines.push(`失败 ${errorCount} 张。`);
    }
    showNotice(resultLines.join("\n"), {
      title: "处理完成！",
      variant: "success",
    });
  } catch (error) {
    showNotice(`执行失败：${error?.message || error}`, {
      title: "执行失败",
      variant: "error",
    });
  } finally {
    state.busy = false;
    updateActionState();
  }
}

function bindEvents() {
  getEl("refreshSelectionButton")?.addEventListener("click", () => {
    readSelectedItems();
  });

  getEl("runButton")?.addEventListener("click", () => {
    handleRun();
  });

  getEl("dimensionLockButton")?.addEventListener("click", () => {
    toggleDimensionLock();
  });

  for (const id of ["maxWidthInput", "maxHeightInput", "keepAspectCheckbox", "onlyShrinkCheckbox"]) {
    getEl(id)?.addEventListener("input", () => {
      if (id === "maxWidthInput" || id === "maxHeightInput") {
        syncDimensionInputs(id);
      }
      derivePlan();
    });
    getEl(id)?.addEventListener("change", () => {
      if (id === "maxWidthInput" || id === "maxHeightInput") {
        syncDimensionInputs(id);
      }
      derivePlan();
    });
  }

  getEl("qualityInput")?.addEventListener("input", () => {
    updateQualityLabel();
    derivePlan();
  });

  getEl("qualityInput")?.addEventListener("change", () => {
    updateQualityLabel();
    derivePlan();
  });

  getEl("outputFormatSelect")?.addEventListener("change", () => {
    derivePlan();
  });

  document.querySelectorAll(".segmented-button[data-result-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextMode = button.getAttribute("data-result-mode") || "replace";
      if (getSelectedResultMode() === nextMode) {
        return;
      }

      setResultMode(nextMode);
      derivePlan();
    });
  });

  getEl("dialogConfirmButton")?.addEventListener("click", () => {
    closeDialog(true);
  });

  getEl("dialogCancelButton")?.addEventListener("click", () => {
    closeDialog(false);
  });

  getEl("dialogBackdrop")?.addEventListener("click", () => {
    if (state.dialogCancellable) {
      closeDialog(false);
      return;
    }
    closeDialog(true);
  });

  document.addEventListener("keydown", (event) => {
    if (!isDialogOpen()) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog(state.dialogCancellable ? false : true);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      closeDialog(true);
    }
  });
}

function registerEagleEvents() {
  if (!window.eagle) {
    return;
  }

  window.eagle.onPluginCreate(async () => {
    await refreshSelectionWithRetry([0, 120, 320, 640]);
  });

  window.eagle.onPluginRun(async () => {
    await refreshSelectionWithRetry([0, 120, 320]);
  });

  window.eagle.onPluginShow(async () => {
    const elapsed = Date.now() - state.lastSelectionRefreshAt;
    if (elapsed < 150) {
      return;
    }
    await refreshSelectionWithRetry([0, 120]);
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  setResultMode("replace");
  applyDimensionLockVisual();
  updateQualityLabel();
  renderSelectionList();
  updateActionState();
  if (window.eagle) {
    registerEagleEvents();
    await refreshSelectionWithRetry([0, 120, 320, 640]);
    return;
  }

  await readSelectedItems();
});
