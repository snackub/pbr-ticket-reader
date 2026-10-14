(() => {
  "use strict";

  const STORAGE_KEY = "ticket-reader-poc.v1";
  const SCHEMA_VERSION = 1;
  const countFormatter = new Intl.NumberFormat("ja-JP");
  const byId = (id) => document.getElementById(id);
  const ui = {
    date: byId("event-date"), addDate: byId("add-date"),
    dateDialog: byId("date-dialog"), dateForm: byId("date-form"),
    newDate: byId("new-event-date"), cancelDate: byId("cancel-date"),
    status: byId("app-status"), message: byId("app-message"),
    start: byId("start-scan"), stop: byId("stop-scan"), retryOut: byId("retry-out"),
    modes: Array.from(document.querySelectorAll('input[name="scan-mode"]')),
    camera: byId("camera-preview"), reader: byId("qr-reader"),
    cameraLabel: byId("camera-status-label"),
    zoom: byId("scan-zoom"),
    zoomButtons: Array.from(document.querySelectorAll("button[data-scan-zoom]")),
    peoplePanel: document.querySelector(".people-panel"),
    ticket: byId("pending-ticket"), people: byId("people-input"),
    keypad: document.querySelector(".keypad"),
    register: byId("register-in"), cancel: byId("cancel-in"),
    totalVehicles: byId("total-vehicles"), totalPeople: byId("total-people"),
    inCount: byId("in-count"), outCount: byId("out-count"),
    outstandingVehicles: byId("outstanding-vehicles"),
    outstandingPeople: byId("outstanding-people"),
    outstandingList: byId("outstanding-list"), history: byId("history-list"),
    recordCount: byId("record-count"), csv: byId("export-csv"), json: byId("export-json"),
    deleteDay: byId("delete-day"), deleteDayTarget: byId("delete-day-target"),
    confirmDeleteAll: byId("confirm-delete-all"), deleteAll: byId("delete-all")
  };
  const emptyOutstanding = ui.outstandingList.firstElementChild.cloneNode(true);
  const emptyHistory = Array.from(ui.history.children, (node) => node.cloneNode(true));
  const emptyStore = () => ({ schemaVersion: SCHEMA_VERSION, eventDates: [], selectedDate: null, records: [] });
  let store = emptyStore();
  let lastSavedRaw = null;
  let storageReady = false;
  let busy = false;
  let externalSync = false;
  let pending = null;
  let peopleDraft = "";
  let cameraSession = null;
  let scanPhase = "idle";
  let scanZoom = 1;
  let readLatch = false;
  let lastRejected = { key: "", at: 0 };
  let cooldown = { key: "", until: 0 };
  let idSerial = 0;

  class StorageConflict extends Error {}

  const formatDate = (date) => date.replace(/-/g, "/");
  const recordKey = (record) => `${record.eventDate}|${record.ticket}`;
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

  function isEventDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    if (year < 1 || month < 1 || month > 12 || day < 1) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  }

  function isTicket(value) {
    return typeof value === "string" && /^\d{5}$/.test(value)
      && Number(value.slice(0, 2)) >= 1 && Number(value.slice(0, 2)) <= 31
      && Number(value.slice(2)) >= 1;
  }

  function isTimestamp(value) {
    if (typeof value !== "string") return false;
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match || !isEventDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return false;
    if (match[5] !== "Z" && (Number(match[5].slice(1, 3)) > 23 || Number(match[5].slice(4)) > 59)) return false;
    return Number.isFinite(Date.parse(value));
  }

  function localTimestamp(date = new Date()) {
    const offset = -date.getTimezoneOffset();
    const zone = `${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
    return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${zone}`;
  }

  function newId() {
    let id;
    do {
      id = typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${(++idSerial).toString(36)}-${Math.random().toString(36).slice(2)}`;
    } while (store.records.some((record) => record.id === id));
    return id;
  }

  function validateStore(value) {
    const invalid = () => { throw new Error("Invalid saved data"); };
    if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION
      || !Array.isArray(value.eventDates) || !Array.isArray(value.records)) invalid();
    const dates = new Set();
    for (const date of value.eventDates) {
      if (!isEventDate(date) || dates.has(date)) invalid();
      dates.add(date);
    }
    if (value.selectedDate !== null && !dates.has(value.selectedDate)) invalid();
    const ids = new Set();
    const operations = new Set();
    const ins = new Map();
    const outs = [];
    const peopleTotals = new Map();
    const records = value.records.map((record) => {
      if (!isObject(record) || typeof record.id !== "string" || !record.id || record.id.length > 128
        || ids.has(record.id) || !dates.has(record.eventDate) || !isTicket(record.ticket)
        || record.ticket.slice(0, 2) !== record.eventDate.slice(8)
        || !["IN", "OUT"].includes(record.type) || !isTimestamp(record.timestamp)) invalid();
      if (record.type === "IN" && (!Number.isSafeInteger(record.people) || record.people < 1)) invalid();
      if (record.type === "OUT" && record.people !== null) invalid();
      const key = recordKey(record);
      const operation = `${record.type}|${key}`;
      if (operations.has(operation)) invalid();
      operations.add(operation);
      ids.add(record.id);
      if (record.type === "IN") {
        ins.set(key, record);
        const total = (peopleTotals.get(record.eventDate) || 0) + record.people;
        if (!Number.isSafeInteger(total)) invalid();
        peopleTotals.set(record.eventDate, total);
      } else outs.push(key);
      return {
        id: record.id, eventDate: record.eventDate, ticket: record.ticket,
        type: record.type, people: record.people, timestamp: record.timestamp
      };
    });
    if (outs.some((key) => !ins.has(key))) invalid();
    return { schemaVersion: SCHEMA_VERSION, eventDates: [...dates].sort(), selectedDate: value.selectedDate, records };
  }

  function showMessage(message, tone = "info") {
    ui.status.dataset.tone = tone;
    ui.message.textContent = message;
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const loaded = raw === null ? emptyStore() : validateStore(JSON.parse(raw));
      store = loaded;
      lastSavedRaw = raw;
      storageReady = true;
      return true;
    } catch {
      storageReady = false;
      showMessage("保存データを読み込めません。データを保全し、ブラウザの保存設定を確認してください。", "error");
      return false;
    }
  }

  // setItemだけで成功にせず、保存した文字列を読み直して確認する。
  function persist(next) {
    if (!storageReady || busy || externalSync) return false;
    busy = true;
    renderControls();
    let wrote = false;
    try {
      const checked = validateStore(next);
      const serialized = JSON.stringify(checked);
      if (localStorage.getItem(STORAGE_KEY) !== lastSavedRaw) throw new StorageConflict();
      localStorage.setItem(STORAGE_KEY, serialized);
      wrote = true;
      if (localStorage.getItem(STORAGE_KEY) !== serialized) throw new Error("Unconfirmed write");
      store = checked;
      lastSavedRaw = serialized;
      return true;
    } catch (error) {
      if (error instanceof StorageConflict) {
        void reconcileExternalChange();
      } else if (wrote) {
        storageReady = false;
        showMessage("保存結果を確認できません。二重登録を避けるため、再読み込みして保存状態を確認してください。", "error");
        void stopCamera({ discardPending: false, announce: false });
      } else {
        showMessage("保存できませんでした。空き容量やブラウザの保存設定を確認し、再度登録してください。", "error");
      }
      return false;
    } finally {
      busy = false;
      if (storageReady) renderControls();
      else renderAll();
    }
  }

  function selectedRecords() {
    return store.records.filter((record) => record.eventDate === store.selectedDate);
  }

  function summarize(records) {
    const ins = new Map();
    const outs = new Set();
    for (const record of records) {
      if (record.type === "IN") ins.set(record.ticket, record);
      else outs.add(record.ticket);
    }
    const outstanding = [...ins.values()].filter((record) => !outs.has(record.ticket));
    return {
      ins, outs, outstanding,
      totalPeople: [...ins.values()].reduce((total, record) => total + record.people, 0),
      outstandingPeople: outstanding.reduce((total, record) => total + record.people, 0)
    };
  }

  const cameraActive = () => scanPhase !== "idle";
  const locked = () => cameraActive() || pending !== null || busy || externalSync || ui.dateDialog.open;
  const canManage = () => storageReady && !locked();
  const hasDate = () => store.selectedDate !== null;
  const peopleValue = () => /^\d+$/.test(peopleDraft) && Number.isSafeInteger(Number(peopleDraft)) && Number(peopleDraft) >= 1 ? Number(peopleDraft) : null;

  function renderControls() {
    const transition = ["starting", "stopping", "stop-error"].includes(scanPhase);
    const inputEnabled = pending?.type === "IN" && storageReady && !busy && !externalSync && !transition;
    ui.date.disabled = !storageReady || locked() || store.eventDates.length === 0;
    ui.addDate.disabled = !canManage();
    ui.modes.forEach((mode) => { mode.disabled = !storageReady || pending !== null || busy || externalSync || transition || ui.dateDialog.open; });
    ui.start.disabled = !canManage() || !hasDate() || document.hidden;
    ui.stop.disabled = busy || externalSync || scanPhase === "stopping" || (!cameraActive() && !pending);
    ui.retryOut.hidden = pending?.type !== "OUT";
    ui.retryOut.disabled = !storageReady || busy || externalSync || transition;
    ui.people.value = peopleDraft;
    ui.people.disabled = !inputEnabled;
    ui.keypad.querySelectorAll("button").forEach((button) => { button.disabled = !inputEnabled; });
    ui.register.disabled = !inputEnabled || peopleValue() === null;
    ui.cancel.disabled = pending?.type !== "IN" || busy || externalSync || transition;
    ui.ticket.textContent = pending?.type === "IN" ? pending.ticket : "— — — — —";
    ui.csv.disabled = !canManage() || !hasDate();
    ui.json.disabled = !canManage() || !hasDate();
    ui.deleteDay.disabled = !canManage() || !hasDate() || selectedRecords().length === 0;
    ui.confirmDeleteAll.disabled = !canManage() || store.records.length === 0;
    ui.deleteAll.disabled = !canManage() || store.records.length === 0 || !ui.confirmDeleteAll.checked;
    ui.camera.classList.toggle("is-active", cameraActive());
    ui.reader.hidden = !cameraActive();
    ui.zoom.hidden = !cameraActive() || !cameraSession?.detailedScan;
    ui.zoomButtons.forEach((button) => {
      button.disabled = !storageReady || scanPhase !== "scanning" || pending !== null || busy || externalSync;
      button.setAttribute("aria-pressed", String(Number(button.dataset.scanZoom) === scanZoom));
    });
    const video = ui.reader.querySelector("video");
    if (video) video.style.transform = cameraSession?.detailedScan ? `scale(${scanZoom})` : "";
    const labels = { idle: "カメラ停止中", starting: "カメラ起動中", scanning: "読取中", paused: "読取一時停止", stopping: "カメラ停止中…", "stop-error": "カメラ停止エラー" };
    ui.cameraLabel.textContent = labels[scanPhase];
    ui.camera.setAttribute("aria-label", `カメラ表示領域。${labels[scanPhase]}`);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clockText(timestamp) {
    const clock = timestamp.slice(11, 19);
    return timestamp.slice(0, 10) === store.selectedDate ? clock : `${formatDate(timestamp.slice(0, 10))} ${clock}`;
  }

  function timeElement(timestamp) {
    const time = element("time", "event-time", clockText(timestamp));
    time.dateTime = timestamp;
    time.title = timestamp;
    return time;
  }

  function renderAll() {
    const options = document.createDocumentFragment();
    const placeholder = element("option", "", store.eventDates.length ? "実験日を選択" : "実験日を追加");
    placeholder.value = "";
    placeholder.disabled = true;
    options.append(placeholder);
    [...store.eventDates].reverse().forEach((date) => {
      const option = element("option", "", formatDate(date));
      option.value = date;
      options.append(option);
    });
    ui.date.replaceChildren(options);
    ui.date.value = store.selectedDate || "";
    const records = selectedRecords();
    const summary = summarize(records);
    const display = (value) => storageReady ? countFormatter.format(value) : "—";
    ui.totalVehicles.textContent = display(summary.ins.size);
    ui.totalPeople.textContent = display(summary.totalPeople);
    ui.inCount.textContent = display(summary.ins.size);
    ui.outCount.textContent = display(summary.outs.size);
    ui.outstandingVehicles.textContent = display(summary.outstanding.length);
    ui.outstandingPeople.textContent = display(summary.outstandingPeople);
    ui.recordCount.textContent = `${display(records.length)}件`;
    ui.deleteDayTarget.textContent = !storageReady ? "対象：保存データを確認できません"
      : hasDate() ? `対象：${formatDate(store.selectedDate)} · ${countFormatter.format(records.length)}件`
        : "対象：実験日未選択";
    ui.confirmDeleteAll.checked = false;

    const rows = document.createDocumentFragment();
    if (!storageReady || summary.outstanding.length === 0) {
      const row = emptyOutstanding.cloneNode(true);
      if (!storageReady) row.querySelector(".empty-state p").textContent = "保存データを表示できません";
      rows.append(row);
    } else {
      summary.outstanding.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).forEach((record) => {
        const row = element("tr", "record-row");
        const ticket = element("td", "ticket-cell", record.ticket);
        const people = element("td", "people-cell", countFormatter.format(record.people));
        const time = element("td", "time-cell");
        time.append(timeElement(record.timestamp));
        row.append(ticket, people, time);
        rows.append(row);
      });
    }
    ui.outstandingList.replaceChildren(rows);

    if (!storageReady || records.length === 0) {
      ui.history.className = "empty-state";
      ui.history.removeAttribute("role");
      ui.history.replaceChildren(...emptyHistory.map((node) => node.cloneNode(true)));
      if (!storageReady) ui.history.querySelector("p").textContent = "保存データを表示できません";
    } else {
      ui.history.className = "history-list";
      ui.history.setAttribute("role", "list");
      const entries = document.createDocumentFragment();
      records.map((record, index) => ({ record, index }))
        .sort((a, b) => Date.parse(b.record.timestamp) - Date.parse(a.record.timestamp) || b.index - a.index)
        .forEach(({ record }) => {
          const row = element("div", "history-record");
          row.setAttribute("role", "listitem");
          const badge = element("span", `event-type event-type-${record.type.toLowerCase()}`, record.type);
          badge.setAttribute("aria-label", record.type === "IN" ? "IN（乗車）" : "OUT（帰着）");
          const body = element("div", "history-record-body");
          const heading = element("div", "history-record-heading");
          const people = summary.ins.get(record.ticket).people;
          heading.append(element("strong", "ticket-cell", record.ticket), element("span", "history-people", `${countFormatter.format(people)}人`));
          body.append(heading, timeElement(record.timestamp));
          row.append(badge, body);
          entries.append(row);
        });
      ui.history.replaceChildren(entries);
    }
    renderControls();
  }

  function selectDate() {
    const date = ui.date.value;
    if (!canManage() || !store.eventDates.includes(date)) {
      ui.date.value = store.selectedDate || "";
      return;
    }
    if (persist({ ...store, selectedDate: date })) {
      renderAll();
      showMessage(`${formatDate(date)}を選択しました。`);
    } else ui.date.value = store.selectedDate || "";
  }

  function addEventDate(date) {
    if (!storageReady || cameraActive() || pending || busy || externalSync) return false;
    if (!isEventDate(date)) {
      byId("date-error").textContent = "年月日を正しく入力してください。";
      return false;
    }
    const exists = store.eventDates.includes(date);
    const dates = exists ? store.eventDates : [...store.eventDates, date];
    if (!persist({ ...store, eventDates: dates, selectedDate: date })) {
      byId("date-error").textContent = "日付を保存できませんでした。ブラウザの保存設定を確認してください。";
      return false;
    }
    if (ui.dateDialog.open) ui.dateDialog.close();
    renderAll();
    showMessage(`${formatDate(date)}を${exists ? "選択" : "追加"}しました。`);
    return true;
  }

  function openDateDialog() {
    if (!canManage()) return;
    byId("date-error").textContent = "";
    ui.newDate.value = localTimestamp().slice(0, 10);
    if (typeof ui.dateDialog.showModal === "function") {
      ui.dateDialog.showModal();
      renderControls();
      ui.newDate.focus();
    } else {
      const date = window.prompt("追加する実験日を YYYY-MM-DD で入力してください。", ui.newDate.value);
      if (date !== null && !addEventDate(date.trim())) showMessage("日付を追加できませんでした。年月日と保存設定を確認してください。", "error");
    }
  }

  function enterPeople(key) {
    if (pending?.type !== "IN" || !storageReady || busy || externalSync
      || ["starting", "stopping", "stop-error"].includes(scanPhase)) return;
    if (key === "clear") peopleDraft = "";
    else if (key === "backspace") peopleDraft = peopleDraft.slice(0, -1);
    else if (/^\d$/.test(key)) {
      const next = (peopleDraft === "0" ? "" : peopleDraft) + key;
      if (!Number.isSafeInteger(Number(next))) {
        showMessage("人数が大きすぎます。入力内容を確認してください。", "error");
        return;
      }
      peopleDraft = next;
    }
    renderControls();
  }

  function clearPending() {
    pending = null;
    peopleDraft = "";
    ui.peoplePanel.open = false;
    renderControls();
  }

  function registerPending() {
    if (!pending || !storageReady || busy || externalSync
      || ["starting", "stopping", "stop-error"].includes(scanPhase)) return;
    const candidate = pending;
    if (candidate.eventDate !== store.selectedDate) {
      showMessage("実験日が変更されています。停止して券を読み直してください。", "error");
      return;
    }
    const records = selectedRecords();
    const summary = summarize(records);
    if (records.some((record) => record.ticket === candidate.ticket && record.type === candidate.type)) {
      showMessage(`券 ${candidate.ticket} の${candidate.type}は登録済みです。`, "error");
      return;
    }
    const people = candidate.type === "IN" ? peopleValue() : null;
    if (candidate.type === "IN" && people === null) {
      showMessage("人数を1人以上の整数で入力してください。", "error");
      return;
    }
    if (candidate.type === "IN" && !Number.isSafeInteger(summary.totalPeople + people)) {
      showMessage("合計人数が大きすぎます。入力内容を確認してください。", "error");
      return;
    }
    if (candidate.type === "OUT" && !summary.ins.has(candidate.ticket)) {
      showMessage(`券 ${candidate.ticket} のINが選択日にありません。`, "error");
      return;
    }
    const record = {
      id: candidate.id, eventDate: candidate.eventDate, ticket: candidate.ticket,
      type: candidate.type, people, timestamp: candidate.timestamp
    };
    if (!persist({ ...store, records: [...store.records, record] })) return;
    const registeredPeople = candidate.type === "IN" ? people : summary.ins.get(candidate.ticket).people;
    cooldown = { key: `${recordKey(candidate)}|${candidate.type}`, until: performance.now() + 2000 };
    clearPending();
    renderAll();
    showMessage(`券 ${candidate.ticket} · ${registeredPeople}人の${candidate.type}を登録しました。`, "success");
    resumeCamera(true);
  }

  function cancelPending() {
    if (!pending || busy || externalSync) return;
    clearPending();
    if (storageReady) showMessage("登録をキャンセルしました。"); else showMessage("人数入力を閉じました。再読み込みして保存状態を確認してください。", "warning");
    resumeCamera(false);
  }

  function download(kind) {
    if (!canManage() || !hasDate()) return;
    const date = store.selectedDate;
    const records = selectedRecords();
    const exportedAt = localTimestamp();
    let content;
    if (kind === "json") {
      content = JSON.stringify({ schemaVersion: SCHEMA_VERSION, eventDate: date, exportedAt, records }, null, 2) + "\n";
    } else {
      const fields = ["id", "eventDate", "ticket", "type", "people", "timestamp"];
      const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
      content = "\uFEFF" + [fields.map(quote).join(","), ...records.map((record) => fields.map((field) => quote(record[field])).join(","))].join("\r\n") + "\r\n";
    }
    let url = null;
    let link = null;
    try {
      const blob = new Blob([content], { type: kind === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8" });
      url = URL.createObjectURL(blob);
      link = element("a");
      link.href = url;
      link.download = `ticket-reader-${date}-${new Date().toISOString().replace(/[-:.]/g, "")}.${kind}`;
      link.hidden = true;
      document.body.append(link);
      link.click();
      showMessage(`${kind.toUpperCase()}の出力を開始しました。ファイルの保存先を確認してください。`);
    } catch {
      showMessage("ファイルを出力できませんでした。ブラウザのダウンロード設定を確認してください。", "error");
    } finally {
      link?.remove();
      if (url) window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }

  function deleteSelectedDay() {
    if (!canManage() || !hasDate()) return;
    const date = store.selectedDate;
    const count = selectedRecords().length;
    if (!count || !window.confirm(`${formatDate(date)} の記録 ${count}件を削除します。\nCSV／JSONを出力済みか確認してください。\n削除してよいですか？`)) return;
    if (persist({ ...store, records: store.records.filter((record) => record.eventDate !== date) })) {
      renderAll();
      showMessage(`${formatDate(date)} の記録 ${count}件を削除しました。`);
    }
  }

  function deleteEveryDay() {
    if (!canManage() || !ui.confirmDeleteAll.checked || !store.records.length) return;
    const count = store.records.length;
    const days = new Set(store.records.map((record) => record.eventDate)).size;
    if (!window.confirm(`全実験日（${days}日）の記録 ${count}件を削除します。\nすべてのCSV／JSONを出力済みか、もう一度確認してください。\n全記録を削除してよいですか？`)) return;
    if (persist({ ...store, records: [] })) {
      renderAll();
      showMessage(`全実験日の記録 ${count}件を削除しました。`);
    }
  }

  let selectedMode = ui.modes.find((mode) => mode.checked)?.value || "IN";

  function cameraErrorText(error) {
    const text = `${error?.name || ""} ${error?.message || error || ""}`;
    if (/NotAllowed|Permission|denied/i.test(text)) return "カメラの使用が許可されていません。ブラウザのカメラ設定を確認してください。";
    if (/NotFound|DevicesNotFound/i.test(text)) return "利用できるカメラが見つかりません。";
    if (/NotReadable|TrackStart/i.test(text)) return "カメラを起動できません。他のアプリでカメラを使用していないか確認してください。";
    return "カメラを起動できませんでした。カメラ設定を確認し、読取開始を押してください。";
  }

  function releaseVideoTracks() {
    ui.reader.querySelectorAll("video").forEach((video) => {
      const stream = video.srcObject;
      if (stream && typeof stream.getTracks === "function") stream.getTracks().forEach((track) => track.stop());
    });
  }

  // 同梱するhtml5-qrcode 2.3.8は、解析キャンバスをCSS表示サイズに縮小する。
  // 映像の元画素を使い、読取倍率を映像と解析画像の両方に反映する。
  // ライブラリ内部が変わった場合は通常の読取を続け、倍率操作を表示しない。
  function enableDetailedScan(session) {
    const context = session.reader.context;
    const video = ui.reader.querySelector("video");
    if (!context || !session.reader.qrRegion || !video) return false;
    const drawImage = context.drawImage.bind(context);
    context.drawImage = (...args) => {
      if (args.length !== 9 || args[0] !== video) return drawImage(...args);
      const sourceWidth = args[3] / scanZoom;
      const sourceHeight = args[4] / scanZoom;
      if (!(sourceWidth > 0 && sourceHeight > 0)) return drawImage(...args);
      const sourceX = args[1] + (args[3] - sourceWidth) / 2;
      const sourceY = args[2] + (args[4] - sourceHeight) / 2;
      // 端末負荷を抑え、元映像より大きい画像には引き伸ばさない。
      const scale = Math.min(1, 1280 / sourceWidth, 960 / sourceHeight);
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      if (context.canvas.width !== width) context.canvas.width = width;
      if (context.canvas.height !== height) context.canvas.height = height;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.imageSmoothingEnabled = false;
      return drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
    };
    return true;
  }

  function changeScanZoom(value) {
    if (!cameraSession?.detailedScan || scanPhase !== "scanning" || pending || busy || externalSync || !storageReady) return;
    const zoom = Number(value);
    if (![1, 2, 3].includes(zoom)) return;
    scanZoom = zoom;
    renderControls();
    showMessage(`読取倍率を${zoom}倍にしました。ピントの合う距離で券全体を枠内に収めてください。`);
  }

  async function startCamera() {
    if (!canManage() || !hasDate()) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      showMessage("カメラ読取にはHTTPSまたはlocalhostで開いてください。", "error");
      return;
    }
    if (typeof window.Html5Qrcode !== "function" || !window.Html5QrcodeSupportedFormats) {
      showMessage("読取ライブラリを読み込めませんでした。ページを再読み込みしてください。", "error");
      return;
    }
    let reader;
    try {
      reader = new window.Html5Qrcode("qr-reader", {
        formatsToSupport: [window.Html5QrcodeSupportedFormats.CODE_128, window.Html5QrcodeSupportedFormats.QR_CODE],
        useBarCodeDetectorIfSupported: false,
        verbose: false
      });
    } catch (error) {
      showMessage(cameraErrorText(error), "error");
      return;
    }
    const session = { reader, cancelled: false, startPromise: null, stopPromise: null, detailedScan: false };
    cameraSession = session;
    scanPhase = "starting";
    readLatch = false;
    renderControls();
    showMessage("カメラの起動を待っています。");
    session.startPromise = (async () => {
      try {
        const scanConfig = {
          fps: 6,
          aspectRatio: 4 / 3,
          qrbox: (width, height) => ({
            width: Math.floor(Math.min(420, width * 0.9)),
            height: Math.floor(Math.min(180, height * 0.7))
          })
        };
        const onDecoded = (text) => handleDecoded(text, session);
        try {
          await reader.start({ facingMode: "environment" }, {
            ...scanConfig,
            videoConstraints: {
              facingMode: "environment",
              width: { ideal: 1920 }, height: { ideal: 1440 },
              aspectRatio: { ideal: 4 / 3 }
            }
          }, onDecoded, () => {});
        } catch (error) {
          // 撮影設定に対応しない端末は、従来のカメラ設定で起動する。
          if (session.cancelled || !/Overconstrained|ConstraintNotSatisfied|Invalid constraint/i.test(String(error))) throw error;
          await reader.start({ facingMode: "environment" }, scanConfig, onDecoded, () => {});
        }
        if (session.cancelled || cameraSession !== session) return;
        session.detailedScan = enableDetailedScan(session);
        try {
          const capabilities = reader.getRunningTrackCapabilities();
          if (capabilities.focusMode?.includes("continuous")) {
            await reader.applyVideoConstraints({ advanced: [{ focusMode: "continuous" }] });
          }
        } catch { /* フォーカス設定に非対応でも読取を続ける。 */ }
        if (session.cancelled || cameraSession !== session) return;
        ui.reader.querySelectorAll("div").forEach((node) => {
          if (!node.firstElementChild && /^Scanner paused\.?$/i.test(node.textContent.trim())) node.textContent = "読取一時停止";
        });
        scanPhase = "scanning";
        renderControls();
        showMessage(`${selectedMode}の券を枠内に合わせてください。`);
      } catch (error) {
        if (session.cancelled) return;
        try {
          if (reader.isScanning) await reader.stop();
          reader.clear();
        } catch {
          releaseVideoTracks();
        }
        if (cameraSession === session) {
          cameraSession = null;
          scanPhase = "idle";
          readLatch = false;
          ui.reader.replaceChildren();
          renderControls();
          showMessage(cameraErrorText(error), "error");
        }
      }
    })();
    await session.startPromise;
  }

  async function stopCamera({ discardPending = true, announce = true } = {}) {
    if (discardPending) clearPending();
    const session = cameraSession;
    if (!session) {
      scanPhase = "idle";
      readLatch = false;
      renderControls();
      if (announce && storageReady) showMessage("読み取りを停止しました。");
      return true;
    }
    if (session.stopPromise) return session.stopPromise;
    session.cancelled = true;
    readLatch = true;
    scanPhase = "stopping";
    renderControls();
    session.stopPromise = (async () => {
      try {
        await session.startPromise;
        if (session.reader.isScanning) await session.reader.stop();
        session.reader.clear();
        if (cameraSession === session) {
          cameraSession = null;
          scanPhase = "idle";
          readLatch = false;
          ui.reader.replaceChildren();
        }
        renderControls();
        if (announce && storageReady) showMessage("読み取りを停止しました。");
        return true;
      } catch {
        releaseVideoTracks();
        scanPhase = "stop-error";
        renderControls();
        showMessage("カメラを停止できませんでした。停止を再度押すか、ページを閉じてください。", "error");
        return false;
      } finally {
        session.stopPromise = null;
      }
    })();
    return session.stopPromise;
  }

  function resumeCamera(afterSave) {
    if (cameraSession && scanPhase === "paused" && storageReady && !pending && !externalSync && !document.hidden) {
      try {
        cameraSession.reader.resume();
        scanPhase = "scanning";
        readLatch = false;
        renderControls();
      } catch {
        void stopCamera({ discardPending: false, announce: false }).then((stopped) => {
          if (stopped) showMessage(afterSave ? "記録は保存済みです。カメラの再開に失敗したため停止しました。" : "カメラの再開に失敗したため停止しました。", "warning");
        });
      }
    } else if (scanPhase === "idle") {
      readLatch = false;
      renderControls();
    }
  }

  function rejectRead(ticket, message) {
    const key = `${ticket}|${message}`;
    const now = performance.now();
    if (lastRejected.key === key && now - lastRejected.at < 2500) return;
    lastRejected = { key, at: now };
    showMessage(message, "warning");
  }

  function handleDecoded(text, session) {
    if (cameraSession !== session || session.cancelled || scanPhase !== "scanning"
      || readLatch || pending || busy || externalSync || !storageReady) return;
    const timestamp = localTimestamp();
    const ticket = typeof text === "string" ? text.trim() : "";
    const date = store.selectedDate;
    const type = selectedMode;
    const key = `${date}|${ticket}|${type}`;
    if (cooldown.key === key && performance.now() < cooldown.until) return;
    if (!isTicket(ticket)) {
      rejectRead(ticket, "券番号は日2桁＋連番3桁（001～999）の5桁です。");
      return;
    }
    if (!date || ticket.slice(0, 2) !== date.slice(8)) {
      rejectRead(ticket, `券の日（${ticket.slice(0, 2)}日）と選択中の実験日が一致しません。`);
      return;
    }
    const records = selectedRecords();
    if (records.some((record) => record.ticket === ticket && record.type === type)) {
      rejectRead(ticket, `券 ${ticket} の${type}は登録済みです。`);
      return;
    }
    if (type === "OUT" && !records.some((record) => record.ticket === ticket && record.type === "IN")) {
      rejectRead(ticket, `選択日に券 ${ticket} のINがありません。`);
      return;
    }
    readLatch = true;
    try {
      session.reader.pause(false);
      scanPhase = "paused";
    } catch {
      void stopCamera({ discardPending: true, announce: false }).then((stopped) => {
        if (stopped) showMessage("読取を一時停止できなかったため、登録せずカメラを停止しました。", "error");
      });
      return;
    }
    pending = { id: newId(), eventDate: date, ticket, type, timestamp };
    peopleDraft = "";
    renderControls();
    if (type === "IN") {
      ui.peoplePanel.open = true;
      ui.people.focus({ preventScroll: true });
      showMessage(`券 ${ticket} の人数を入力し、登録を押してください。`);
      const pendingId = pending.id;
      window.requestAnimationFrame(() => {
        if (pending?.id === pendingId) ui.peoplePanel.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      });
    } else registerPending();
  }

  async function reconcileExternalChange() {
    if (externalSync) return;
    externalSync = true;
    renderControls();
    try {
      const stopped = await stopCamera({ discardPending: true, announce: false });
      const loaded = loadStore();
      renderAll();
      if (loaded && stopped) showMessage("別のタブで保存データが変更されました。内容を確認してから再開してください。", "warning");
    } finally {
      externalSync = false;
      renderControls();
    }
  }

  function refreshIfChanged() {
    if (!storageReady || externalSync || busy) return;
    try {
      if (localStorage.getItem(STORAGE_KEY) !== lastSavedRaw) void reconcileExternalChange();
    } catch {
      storageReady = false;
      void stopCamera({ discardPending: false, announce: false });
      renderAll();
      showMessage("保存データにアクセスできません。ブラウザの保存設定を確認してください。", "error");
    }
  }

  ui.date.addEventListener("change", selectDate);
  ui.addDate.addEventListener("click", openDateDialog);
  ui.dateForm.addEventListener("submit", (event) => {
    event.preventDefault();
    addEventDate(ui.newDate.value);
  });
  ui.cancelDate.addEventListener("click", () => ui.dateDialog.close());
  ui.dateDialog.addEventListener("close", renderControls);
  ui.start.addEventListener("click", () => { void startCamera(); });
  ui.stop.addEventListener("click", () => { void stopCamera(); });
  ui.retryOut.addEventListener("click", registerPending);
  ui.zoomButtons.forEach((button) => button.addEventListener("click", () => {
    if (!button.disabled) changeScanZoom(button.dataset.scanZoom);
  }));
  ui.register.addEventListener("click", registerPending);
  ui.cancel.addEventListener("click", cancelPending);
  ui.keypad.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-key]");
    if (button && !button.disabled) enterPeople(button.dataset.key);
  });
  ui.peoplePanel.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || pending?.type !== "IN") return;
    if (/^\d$/.test(event.key)) { event.preventDefault(); enterPeople(event.key); }
    else if (event.key === "Backspace") { event.preventDefault(); enterPeople("backspace"); }
    else if (event.key === "Delete") { event.preventDefault(); enterPeople("clear"); }
    else if (event.key === "Escape") { event.preventDefault(); cancelPending(); }
  });
  ui.peoplePanel.addEventListener("toggle", () => {
    if (!ui.peoplePanel.open && pending?.type === "IN" && !busy) cancelPending();
  });
  ui.modes.forEach((mode) => mode.addEventListener("change", () => {
    if (!mode.checked) return;
    if (mode.disabled) ui.modes.forEach((input) => { input.checked = input.value === selectedMode; });
    else { selectedMode = mode.value; if (scanPhase === "scanning") showMessage(`${selectedMode}の券を枠内に合わせてください。`); }
  }));
  ui.csv.addEventListener("click", () => download("csv"));
  ui.json.addEventListener("click", () => download("json"));
  ui.deleteDay.addEventListener("click", deleteSelectedDay);
  ui.deleteAll.addEventListener("click", deleteEveryDay);
  ui.confirmDeleteAll.addEventListener("change", renderControls);
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) refreshIfChanged();
  });
  window.addEventListener("pageshow", refreshIfChanged);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && cameraActive()) {
      void stopCamera({ discardPending: false, announce: false }).then((stopped) => {
        if (stopped && storageReady && !externalSync) showMessage(pending ? "カメラを停止しました。保留中の登録を確定またはキャンセルしてください。" : "カメラを停止しました。");
      });
    } else {
      refreshIfChanged();
      renderControls();
    }
  });
  window.addEventListener("pagehide", () => {
    if (cameraActive()) { void stopCamera({ discardPending: false, announce: false }); releaseVideoTracks(); }
  });

  const loaded = loadStore();
  renderAll();
  if (loaded) {
    if (!hasDate()) showMessage("実験日を追加してください。");
    else if (typeof window.Html5Qrcode !== "function") showMessage("読取ライブラリを読み込めませんでした。ページを再読み込みしてください。", "error");
    else if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) showMessage("カメラ読取にはHTTPSまたはlocalhostで開いてください。", "warning");
    else showMessage(`${formatDate(store.selectedDate)} · ${selectedMode}の読取開始を押してください。`);
  }
})();
