function exportToCsv(filename, rows) {
  var processRow = function(row) {
    var finalVal = "";
    for (var j = 0; j < row.length; j++) {
      var innerValue = row[j] === null || typeof row[j] === "undefined" ? "" : row[j].toString();
      if (row[j] instanceof Date) {
        innerValue = row[j].toLocaleString();
      }
      var result = innerValue.replace(/"/g, '""');
      if (result.search(/("|,|\n)/g) >= 0)
        result = '"' + result + '"';
      if (j > 0)
        finalVal += ",";
      finalVal += result;
    }
    return finalVal + "\n";
  };
  var csvFile = "";
  for (var i = 0; i < rows.length; i++) {
    csvFile += processRow(rows[i]);
  }
  var blob = new Blob([csvFile], { type: "text/csv;charset=utf-8;" });
  var link = document.createElement("a");
  if (link.download !== void 0) {
    var url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}
const instanceOfAny = (object, constructors) => constructors.some((c) => object instanceof c);
let idbProxyableTypes;
let cursorAdvanceMethods;
function getIdbProxyableTypes() {
  return idbProxyableTypes || (idbProxyableTypes = [
    IDBDatabase,
    IDBObjectStore,
    IDBIndex,
    IDBCursor,
    IDBTransaction
  ]);
}
function getCursorAdvanceMethods() {
  return cursorAdvanceMethods || (cursorAdvanceMethods = [
    IDBCursor.prototype.advance,
    IDBCursor.prototype.continue,
    IDBCursor.prototype.continuePrimaryKey
  ]);
}
const transactionDoneMap = /* @__PURE__ */ new WeakMap();
const transformCache = /* @__PURE__ */ new WeakMap();
const reverseTransformCache = /* @__PURE__ */ new WeakMap();
function promisifyRequest(request) {
  const promise = new Promise((resolve, reject) => {
    const unlisten = () => {
      request.removeEventListener("success", success);
      request.removeEventListener("error", error);
    };
    const success = () => {
      resolve(wrap(request.result));
      unlisten();
    };
    const error = () => {
      reject(request.error);
      unlisten();
    };
    request.addEventListener("success", success);
    request.addEventListener("error", error);
  });
  reverseTransformCache.set(promise, request);
  return promise;
}
function cacheDonePromiseForTransaction(tx) {
  if (transactionDoneMap.has(tx))
    return;
  const done = new Promise((resolve, reject) => {
    const unlisten = () => {
      tx.removeEventListener("complete", complete);
      tx.removeEventListener("error", error);
      tx.removeEventListener("abort", error);
    };
    const complete = () => {
      resolve();
      unlisten();
    };
    const error = () => {
      reject(tx.error || new DOMException("AbortError", "AbortError"));
      unlisten();
    };
    tx.addEventListener("complete", complete);
    tx.addEventListener("error", error);
    tx.addEventListener("abort", error);
  });
  transactionDoneMap.set(tx, done);
}
let idbProxyTraps = {
  get(target, prop, receiver) {
    if (target instanceof IDBTransaction) {
      if (prop === "done")
        return transactionDoneMap.get(target);
      if (prop === "store") {
        return receiver.objectStoreNames[1] ? void 0 : receiver.objectStore(receiver.objectStoreNames[0]);
      }
    }
    return wrap(target[prop]);
  },
  set(target, prop, value) {
    target[prop] = value;
    return true;
  },
  has(target, prop) {
    if (target instanceof IDBTransaction && (prop === "done" || prop === "store")) {
      return true;
    }
    return prop in target;
  }
};
function replaceTraps(callback) {
  idbProxyTraps = callback(idbProxyTraps);
}
function wrapFunction(func) {
  if (getCursorAdvanceMethods().includes(func)) {
    return function(...args) {
      func.apply(unwrap(this), args);
      return wrap(this.request);
    };
  }
  return function(...args) {
    return wrap(func.apply(unwrap(this), args));
  };
}
function transformCachableValue(value) {
  if (typeof value === "function")
    return wrapFunction(value);
  if (value instanceof IDBTransaction)
    cacheDonePromiseForTransaction(value);
  if (instanceOfAny(value, getIdbProxyableTypes()))
    return new Proxy(value, idbProxyTraps);
  return value;
}
function wrap(value) {
  if (value instanceof IDBRequest)
    return promisifyRequest(value);
  if (transformCache.has(value))
    return transformCache.get(value);
  const newValue = transformCachableValue(value);
  if (newValue !== value) {
    transformCache.set(value, newValue);
    reverseTransformCache.set(newValue, value);
  }
  return newValue;
}
const unwrap = (value) => reverseTransformCache.get(value);
function openDB(name, version, { blocked, upgrade, blocking, terminated } = {}) {
  const request = indexedDB.open(name, version);
  const openPromise = wrap(request);
  if (upgrade) {
    request.addEventListener("upgradeneeded", (event) => {
      upgrade(wrap(request.result), event.oldVersion, event.newVersion, wrap(request.transaction), event);
    });
  }
  if (blocked) {
    request.addEventListener("blocked", (event) => blocked(
      // Casting due to https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/1405
      event.oldVersion,
      event.newVersion,
      event
    ));
  }
  openPromise.then((db) => {
    if (terminated)
      db.addEventListener("close", () => terminated());
    if (blocking) {
      db.addEventListener("versionchange", (event) => blocking(event.oldVersion, event.newVersion, event));
    }
  }).catch(() => {
  });
  return openPromise;
}
const readMethods = ["get", "getKey", "getAll", "getAllKeys", "count"];
const writeMethods = ["put", "add", "delete", "clear"];
const cachedMethods = /* @__PURE__ */ new Map();
function getMethod(target, prop) {
  if (!(target instanceof IDBDatabase && !(prop in target) && typeof prop === "string")) {
    return;
  }
  if (cachedMethods.get(prop))
    return cachedMethods.get(prop);
  const targetFuncName = prop.replace(/FromIndex$/, "");
  const useIndex = prop !== targetFuncName;
  const isWrite = writeMethods.includes(targetFuncName);
  if (
    // Bail if the target doesn't exist on the target. Eg, getAll isn't in Edge.
    !(targetFuncName in (useIndex ? IDBIndex : IDBObjectStore).prototype) || !(isWrite || readMethods.includes(targetFuncName))
  ) {
    return;
  }
  const method = async function(storeName, ...args) {
    const tx = this.transaction(storeName, isWrite ? "readwrite" : "readonly");
    let target2 = tx.store;
    if (useIndex)
      target2 = target2.index(args.shift());
    return (await Promise.all([
      target2[targetFuncName](...args),
      isWrite && tx.done
    ]))[0];
  };
  cachedMethods.set(prop, method);
  return method;
}
replaceTraps((oldTraps) => ({
  ...oldTraps,
  get: (target, prop, receiver) => getMethod(target, prop) || oldTraps.get(target, prop, receiver),
  has: (target, prop) => !!getMethod(target, prop) || oldTraps.has(target, prop)
}));
const advanceMethodProps = ["continue", "continuePrimaryKey", "advance"];
const methodMap = {};
const advanceResults = /* @__PURE__ */ new WeakMap();
const ittrProxiedCursorToOriginalProxy = /* @__PURE__ */ new WeakMap();
const cursorIteratorTraps = {
  get(target, prop) {
    if (!advanceMethodProps.includes(prop))
      return target[prop];
    let cachedFunc = methodMap[prop];
    if (!cachedFunc) {
      cachedFunc = methodMap[prop] = function(...args) {
        advanceResults.set(this, ittrProxiedCursorToOriginalProxy.get(this)[prop](...args));
      };
    }
    return cachedFunc;
  }
};
async function* iterate(...args) {
  let cursor = this;
  if (!(cursor instanceof IDBCursor)) {
    cursor = await cursor.openCursor(...args);
  }
  if (!cursor)
    return;
  cursor = cursor;
  const proxiedCursor = new Proxy(cursor, cursorIteratorTraps);
  ittrProxiedCursorToOriginalProxy.set(proxiedCursor, cursor);
  reverseTransformCache.set(proxiedCursor, unwrap(cursor));
  while (cursor) {
    yield proxiedCursor;
    cursor = await (advanceResults.get(proxiedCursor) || cursor.continue());
    advanceResults.delete(proxiedCursor);
  }
}
function isIteratorProp(target, prop) {
  return prop === Symbol.asyncIterator && instanceOfAny(target, [IDBIndex, IDBObjectStore, IDBCursor]) || prop === "iterate" && instanceOfAny(target, [IDBIndex, IDBObjectStore]);
}
replaceTraps((oldTraps) => ({
  ...oldTraps,
  get(target, prop, receiver) {
    if (isIteratorProp(target, prop))
      return iterate;
    return oldTraps.get(target, prop, receiver);
  },
  has(target, prop) {
    return isIteratorProp(target, prop) || oldTraps.has(target, prop);
  }
}));
var __awaiter$1 = function(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
};
var __rest = function(s, e) {
  var t = {};
  for (var p in s)
    if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
      t[p] = s[p];
  if (s != null && typeof Object.getOwnPropertySymbols === "function")
    for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
      if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
        t[p[i]] = s[p[i]];
    }
  return t;
};
class ListStorage {
  constructor(options) {
    this.name = "scrape-storage";
    this.persistent = true;
    this.data = /* @__PURE__ */ new Map();
    if (options === null || options === void 0 ? void 0 : options.name)
      this.name = options.name;
    if (options === null || options === void 0 ? void 0 : options.persistent)
      this.persistent = options.persistent;
    this.initDB().then(() => {
    }).catch(() => {
      this.persistent = false;
    });
  }
  get storageKey() {
    return `storage-${this.name}`;
  }
  initDB() {
    return __awaiter$1(this, void 0, void 0, function* () {
      this.db = yield openDB(this.storageKey, 6, {
        upgrade(db, oldVersion, newVersion, transaction) {
          let dataStore;
          if (oldVersion < 5) {
            try {
              db.deleteObjectStore("data");
            } catch (err) {
            }
          }
          if (!db.objectStoreNames.contains("data")) {
            dataStore = db.createObjectStore("data", {
              keyPath: "_id",
              autoIncrement: true
            });
          } else {
            dataStore = transaction.objectStore("data");
          }
          if (dataStore && !dataStore.indexNames.contains("_createdAt")) {
            dataStore.createIndex("_createdAt", "_createdAt");
          }
          if (dataStore && !dataStore.indexNames.contains("_groupId")) {
            dataStore.createIndex("_groupId", "_groupId");
          }
          if (dataStore && !dataStore.indexNames.contains("_pk")) {
            dataStore.createIndex("_pk", "_pk", {
              unique: true
            });
          }
        }
      });
    });
  }
  _dbGetElem(identifier, tx) {
    return __awaiter$1(this, void 0, void 0, function* () {
      if (this.persistent && this.db) {
        if (!tx) {
          tx = this.db.transaction("data", "readonly");
        }
        const store = tx.store;
        const existingValue = yield store.index("_pk").get(identifier);
        return existingValue;
      } else {
        throw new Error("DB doesnt exist");
      }
    });
  }
  getElem(identifier) {
    return __awaiter$1(this, void 0, void 0, function* () {
      if (this.persistent && this.db) {
        try {
          return yield this._dbGetElem(identifier);
        } catch (err) {
          console.error(err);
        }
      } else {
        this.data.get(identifier);
      }
    });
  }
  _dbSetElem(identifier, elem, updateExisting = false, groupId, tx) {
    return __awaiter$1(this, void 0, void 0, function* () {
      if (this.persistent && this.db) {
        let saved = false;
        if (!tx) {
          tx = this.db.transaction("data", "readwrite");
        }
        const store = tx.store;
        const existingValue = yield store.index("_pk").get(identifier);
        if (existingValue) {
          if (updateExisting) {
            yield store.put(Object.assign(Object.assign({}, existingValue), elem));
            saved = true;
          }
        } else {
          const toStore = Object.assign({ "_pk": identifier, "_createdAt": /* @__PURE__ */ new Date() }, elem);
          if (groupId) {
            toStore["_groupId"] = groupId;
          }
          yield store.put(toStore);
          saved = true;
        }
        return saved;
      } else {
        throw new Error("DB doesnt exist");
      }
    });
  }
  addElem(identifier, elem, updateExisting = false, groupId) {
    return __awaiter$1(this, void 0, void 0, function* () {
      if (this.persistent && this.db) {
        try {
          return yield this._dbSetElem(identifier, elem, updateExisting, groupId);
        } catch (err) {
          console.error(err);
        }
      } else {
        this.data.set(identifier, elem);
      }
      return true;
    });
  }
  addElems(elems, updateExisting = false, groupId) {
    return __awaiter$1(this, void 0, void 0, function* () {
      if (this.persistent && this.db) {
        const createPromises = [];
        const tx = this.db.transaction("data", "readwrite");
        const processedIdentifiers = [];
        elems.forEach(([identifier, elem]) => {
          if (processedIdentifiers.indexOf(identifier) === -1) {
            processedIdentifiers.push(identifier);
            createPromises.push(this._dbSetElem(identifier, elem, updateExisting, groupId, tx));
          }
        });
        if (createPromises.length > 0) {
          createPromises.push(tx.done);
          const results = yield Promise.all(createPromises);
          let counter = 0;
          results.forEach((result) => {
            if (typeof result === "boolean" && result) {
              counter += 1;
            }
          });
          return counter;
        }
        return 0;
      } else {
        elems.forEach(([identifier, elem]) => {
          this.addElem(identifier, elem);
        });
        return elems.length;
      }
    });
  }
  deleteFromGroupId(groupId) {
    return __awaiter$1(this, void 0, void 0, function* () {
      if (this.persistent && this.db) {
        let counter = 0;
        const txWrite = this.db.transaction("data", "readwrite");
        let cursor = yield txWrite.store.index("_groupId").openCursor(IDBKeyRange.only(groupId));
        while (cursor) {
          cursor.delete();
          cursor = yield cursor.continue();
          counter += 1;
        }
        return counter;
      } else {
        throw new Error("Not Implemented Error");
      }
    });
  }
  clear() {
    return __awaiter$1(this, void 0, void 0, function* () {
      if (this.persistent && this.db) {
        yield this.db.clear("data");
      } else {
        this.data.clear();
      }
    });
  }
  getCount() {
    return __awaiter$1(this, void 0, void 0, function* () {
      if (this.persistent && this.db) {
        return yield this.db.count("data");
      } else {
        return this.data.size;
      }
    });
  }
  getAll() {
    return __awaiter$1(this, void 0, void 0, function* () {
      if (this.persistent && this.db) {
        const data = /* @__PURE__ */ new Map();
        const dbData = yield this.db.getAll("data");
        if (dbData) {
          dbData.forEach((storageItem) => {
            const { _id } = storageItem, itemData = __rest(storageItem, ["_id"]);
            data.set(_id, itemData);
          });
        }
        return data;
      } else {
        return this.data;
      }
    });
  }
  toCsvData() {
    return __awaiter$1(this, void 0, void 0, function* () {
      const rows = [];
      rows.push(this.headers);
      const data = yield this.getAll();
      data.forEach((item) => {
        try {
          rows.push(this.itemToRow(item));
        } catch (err) {
          console.error(err);
        }
      });
      return rows;
    });
  }
}
const btnStyles = [
  "display: block;",
  "padding: 0px 4px;",
  "cursor: pointer;",
  "text-align: center;"
];
function createCta(main2) {
  const btn = document.createElement("div");
  const styles = [...btnStyles];
  if (main2) {
    styles.push("flex-grow: 1;");
  }
  btn.setAttribute("style", styles.join(""));
  return btn;
}
const spacerStyles = [
  "margin-left: 4px;",
  "margin-right: 4px;",
  "border-left: 1px solid #2e2e2e;"
];
function createSpacer() {
  const spacer = document.createElement("div");
  spacer.innerHTML = "&nbsp;";
  spacer.setAttribute("style", spacerStyles.join(""));
  return spacer;
}
function createTextSpan(content, options) {
  const optionsClean = options || {};
  let textElem;
  const span = document.createElement("span");
  if (optionsClean.bold) {
    const strong = document.createElement("strong");
    span.append(strong);
    textElem = strong;
  } else {
    textElem = span;
  }
  textElem.textContent = content;
  if (optionsClean.idAttribute) {
    textElem.setAttribute("id", optionsClean.idAttribute);
  }
  return span;
}
const canvasStyles = [
  "position: fixed;",
  "top: 0;",
  "left: 0;",
  "z-index: 10000;",
  "width: 100%;",
  "height: 100%;",
  "pointer-events: none;"
];
const innerStyles = [
  "position: absolute;",
  "bottom: 30px;",
  "right: 30px;",
  "width: auto;",
  "pointer-events: auto;"
];
const ctaContainerStyles = [
  "align-items: center;",
  "appearance: none;",
  "background-color: #EEE;",
  "border-radius: 4px;",
  "border-width: 0;",
  "box-shadow: rgba(45, 35, 66, 0.4) 0 2px 4px,rgba(45, 35, 66, 0.3) 0 7px 13px -3px,#D6D6E7 0 -3px 0 inset;",
  "box-sizing: border-box;",
  "color: #36395A;",
  "display: flex;",
  "font-family: monospace;",
  "height: 38px;",
  "justify-content: space-between;",
  "line-height: 1;",
  "list-style: none;",
  "overflow: hidden;",
  "padding-left: 16px;",
  "padding-right: 16px;",
  "position: relative;",
  "text-align: left;",
  "text-decoration: none;",
  "user-select: none;",
  "white-space: nowrap;",
  "font-size: 18px;"
];
class UIContainer {
  constructor() {
    this.ctas = [];
    this.canva = document.createElement("div");
    this.canva.setAttribute("style", canvasStyles.join(""));
    this.inner = document.createElement("div");
    this.inner.setAttribute("style", innerStyles.join(""));
    this.canva.appendChild(this.inner);
    this.history = document.createElement("div");
    this.inner.appendChild(this.history);
    this.container = document.createElement("div");
    this.container.setAttribute("style", ctaContainerStyles.join(""));
    this.inner.appendChild(this.container);
  }
  makeItDraggable() {
    let posX = 0, posY = 0, mouseX = 0, mouseY = 0;
    const moveElement = (e) => {
      mouseX = e.clientX - posX;
      mouseY = e.clientY - posY;
      this.inner.style.right = window.innerWidth - mouseX - this.inner.offsetWidth + "px";
      this.inner.style.bottom = window.innerHeight - mouseY - this.inner.offsetHeight + "px";
    };
    const mouseDown = (e) => {
      e.preventDefault();
      posX = e.clientX - this.inner.offsetLeft;
      posY = e.clientY - this.inner.offsetTop;
      window.addEventListener("mousemove", moveElement, false);
    };
    const mouseUp = () => {
      window.removeEventListener("mousemove", moveElement, false);
    };
    this.inner.addEventListener("mousedown", mouseDown, false);
    window.addEventListener("mouseup", mouseUp, false);
    const draggableIcon = `<svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" height="18px" width="18px" xmlns="http://www.w3.org/2000/svg"><polyline points="5 9 2 12 5 15"></polyline><polyline points="9 5 12 2 15 5"></polyline><polyline points="15 19 12 22 9 19"></polyline><polyline points="19 9 22 12 19 15"></polyline><line x1="2" y1="12" x2="22" y2="12"></line><line x1="12" y1="2" x2="12" y2="22"></line></svg>`;
    const draggableIconElem = document.createElement("div");
    draggableIconElem.style.cursor = "move";
    draggableIconElem.innerHTML = draggableIcon;
    this.addCta(createSpacer());
    this.addCta(draggableIconElem);
  }
  render() {
    document.body.appendChild(this.canva);
  }
  // CTA
  addCta(cta, index) {
    if (typeof index === "undefined") {
      this.ctas.push(cta);
    } else {
      this.ctas.splice(index, 0, cta);
    }
    this.container.innerHTML = "";
    this.ctas.forEach((cta2) => {
      this.container.appendChild(cta2);
    });
  }
}
var __awaiter = function(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
};
var LogCategory;
(function(LogCategory2) {
  LogCategory2["ADD"] = "add";
  LogCategory2["LOG"] = "log";
})(LogCategory || (LogCategory = {}));
const historyPanelStyles = [
  "text-align: right;",
  "background: #f5f5fa;",
  "padding: 8px;",
  "margin-bottom: 8px;",
  "border-radius: 8px;",
  "font-family: monospace;",
  "font-size: 16px;",
  "box-shadow: rgba(42, 35, 66, 0.2) 0 2px 2px,rgba(45, 35, 66, 0.2) 0 7px 13px -4px;",
  "color: #2f2f2f;"
];
const historyUlStyles = [
  "list-style: none;",
  "margin: 0;"
];
const historyLiStyles = [
  "line-height: 30px;",
  "display: flex;",
  "align-items: center;",
  "justify-content: right;"
];
const deleteIconStyles = [
  "display: flex;",
  "align-items: center;",
  "padding: 4px 12px;",
  "cursor: pointer;"
];
const deleteIconSvg = `<svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" height="16px" width="16px" xmlns="http://www.w3.org/2000/svg"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
class HistoryTracker {
  constructor({ onDelete, divContainer, maxLogs }) {
    this.maxLogs = 5;
    this.logs = [];
    this.panelRef = null;
    this.counter = 0;
    this.onDelete = onDelete;
    this.container = divContainer;
    if (maxLogs) {
      this.maxLogs = maxLogs;
    }
  }
  renderPanel() {
    const panel = document.createElement("div");
    panel.setAttribute("style", historyPanelStyles.join(""));
    return panel;
  }
  renderLogs() {
    if (this.panelRef) {
      this.panelRef.remove();
    }
    if (this.logs.length === 0)
      return;
    const listOutter = document.createElement("ul");
    listOutter.setAttribute("style", historyUlStyles.join(""));
    this.logs.forEach((log) => {
      const listElem = document.createElement("li");
      listElem.setAttribute("style", historyLiStyles.join(""));
      let logHtml;
      if (log.category === LogCategory.ADD) {
        logHtml = `<div>#${log.index} ${log.label} (${log.numberItems})</div>`;
      } else {
        logHtml = `<div>#${log.index} ${log.label}</div>`;
      }
      listElem.innerHTML = logHtml;
      if (log.category === LogCategory.ADD && log.cancellable) {
        const deleteIcon = document.createElement("div");
        deleteIcon.setAttribute("style", deleteIconStyles.join(""));
        deleteIcon.innerHTML = deleteIconSvg;
        deleteIcon.addEventListener("click", () => __awaiter(this, void 0, void 0, function* () {
          yield this.onDelete(log.groupId);
          const logIndex = this.logs.findIndex((loopLog) => loopLog.index === log.index);
          if (logIndex !== -1) {
            this.logs.splice(logIndex, 1);
            this.renderLogs();
          }
        }));
        listElem.append(deleteIcon);
      }
      listOutter.prepend(listElem);
    });
    const panel = this.renderPanel();
    panel.appendChild(listOutter);
    this.panelRef = panel;
    this.container.appendChild(panel);
  }
  addHistoryLog(data) {
    this.counter += 1;
    let log;
    if (data.category === LogCategory.ADD) {
      log = {
        index: this.counter,
        label: data.label,
        groupId: data.groupId,
        numberItems: data.numberItems,
        cancellable: data.cancellable,
        createdAt: /* @__PURE__ */ new Date(),
        category: LogCategory.ADD
      };
    } else if (data.category === LogCategory.LOG) {
      log = {
        index: this.counter,
        label: data.label,
        createdAt: /* @__PURE__ */ new Date(),
        category: LogCategory.LOG
      };
    } else {
      console.error("Missing category");
      return;
    }
    this.logs.unshift(log);
    if (this.logs.length > this.maxLogs) {
      this.logs.splice(this.maxLogs);
    }
    this.renderLogs();
  }
  cleanLogs() {
    this.logs = [];
    this.counter = 0;
    this.renderLogs();
  }
}
function cleanName(name) {
  const nameClean = name.trim();
  return nameClean.replace("~ ", "");
}
function cleanDescription(description) {
  const descriptionClean = description.trim();
  if (!descriptionClean.match(/Loading About/i) && !descriptionClean.match(/I am using WhatsApp/i) && !descriptionClean.match(/Available/i)) {
    return descriptionClean;
  }
  return null;
}
class WhatsAppStorage extends ListStorage {
  get headers() {
    return [
      "Phone Number",
      "Name",
      "Description",
      "Source"
    ];
  }
  itemToRow(item) {
    return [
      item.phoneNumber ? item.phoneNumber : "",
      item.name ? item.name : "",
      item.description ? item.description : "",
      item.source ? item.source : ""
    ];
  }
}
const memberListStore = new WhatsAppStorage({
  name: "whatsapp-scraper"
});
const counterId = "scraper-number-tracker";
const exportName = "whatsAppExport";
let logsTracker;
async function updateConter() {
  const tracker = document.getElementById(counterId);
  if (tracker) {
    const countValue = await memberListStore.getCount();
    tracker.textContent = countValue.toString();
  }
}
const uiWidget = new UIContainer();
function buildCTABtns() {
  logsTracker = new HistoryTracker({
    onDelete: async (groupId) => {
      console.log(`Delete ${groupId}`);
      await memberListStore.deleteFromGroupId(groupId);
      await updateConter();
    },
    divContainer: uiWidget.history,
    maxLogs: 4
  });
  const btnDownload = createCta();
  btnDownload.appendChild(createTextSpan("Download "));
  btnDownload.appendChild(createTextSpan("0", {
    bold: true,
    idAttribute: counterId
  }));
  btnDownload.appendChild(createTextSpan(" users"));
  btnDownload.addEventListener("click", async function() {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const data = await memberListStore.toCsvData();
    try {
      exportToCsv(`${exportName}-${timestamp}.csv`, data);
    } catch (err) {
      console.error("Error while generating export");
      console.log(err.stack);
    }
  });
  uiWidget.addCta(btnDownload);
  uiWidget.addCta(createSpacer());
  const btnReinit = createCta();
  btnReinit.appendChild(createTextSpan("Reset"));
  btnReinit.addEventListener("click", async function() {
    await memberListStore.clear();
    logsTracker.cleanLogs();
    await updateConter();
  });
  uiWidget.addCta(btnReinit);
  uiWidget.makeItDraggable();
  uiWidget.render();
  window.setTimeout(() => {
    updateConter();
  }, 1e3);
}
let modalObserver;
function listenModalChanges() {
  const groupNameNode = document.querySelectorAll("header span[style*='height']:not(.copyable-text)");
  let source;
  if (groupNameNode.length == 1) {
    source = groupNameNode[0].textContent;
  }
  const modalElems = document.querySelectorAll('[data-animate-modal-body="true"]');
  const modalElem = modalElems[0];
  const targetNode = modalElem.querySelectorAll("div[style*='height']")[1];
  const config = { attributes: true, childList: true, subtree: true };
  const callback = (mutationList) => {
    for (const mutation of mutationList) {
      if (mutation.type === "childList") {
        if (mutation.addedNodes.length > 0) {
          const node = mutation.addedNodes[0];
          const text = node.textContent;
          if (text) {
            const textClean = text.trim();
            if (textClean.length > 0) {
              if (!textClean.match(/Loading About/i) && !textClean.match(/I am using WhatsApp/i) && !textClean.match(/Available/i))
                ;
            }
          }
        }
      } else if (mutation.type === "attributes") {
        const target = mutation.target;
        const tagName = target.tagName;
        if (["div"].indexOf(tagName.toLowerCase()) === -1 || target.getAttribute("role") !== "listitem") {
          continue;
        }
        const listItem = target;
        window.setTimeout(async () => {
          let profileName = "";
          let profileDescription = "";
          let profilePhone = "";
          const titleElems = listItem.querySelectorAll("span[title]:not(.copyable-text)");
          if (titleElems.length > 0) {
            const text = titleElems[0].textContent;
            if (text) {
              const name = cleanName(text);
              if (name && name.length > 0) {
                profileName = name;
              }
            }
          }
          if (profileName.length === 0) {
            return;
          }
          const descriptionElems = listItem.querySelectorAll("span[title].copyable-text");
          if (descriptionElems.length > 0) {
            const text = descriptionElems[0].textContent;
            if (text) {
              const description = cleanDescription(text);
              if (description && description.length > 0) {
                profileDescription = description;
              }
            }
          }
          const phoneElems = listItem.querySelectorAll("span[style*='height']:not([title])");
          if (phoneElems.length > 0) {
            const text = phoneElems[0].textContent;
            if (text) {
              const textClean = text.trim();
              if (textClean && textClean.length > 0) {
                profilePhone = textClean;
              }
            }
          }
          if (profileName) {
            const identifier = profilePhone ? profilePhone : profileName;
            console.log(identifier);
            const data = {};
            if (source) {
              data.source = source;
            }
            if (profileDescription) {
              data.description = profileDescription;
            }
            if (profilePhone) {
              data.phoneNumber = profilePhone;
              if (profileName) {
                data.name = profileName;
              }
            } else {
              if (profileName) {
                data.phoneNumber = profileName;
              }
            }
            await memberListStore.addElem(
              identifier,
              {
                profileId: identifier,
                ...data
              },
              true
              // Update
            );
            logsTracker.addHistoryLog({
              label: `Scraping ${profileName}`,
              category: LogCategory.LOG
            });
            updateConter();
          }
        }, 10);
      }
    }
  };
  modalObserver = new MutationObserver(callback);
  modalObserver.observe(targetNode, config);
}
function stopListeningModalChanges() {
  if (modalObserver) {
    modalObserver.disconnect();
  }
}
function main() {
  buildCTABtns();
  logsTracker.addHistoryLog({
    label: "Wait for modal",
    category: LogCategory.LOG
  });
  function bodyCallback(mutationList) {
    for (const mutation of mutationList) {
      if (mutation.type === "childList") {
        if (mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach((node) => {
            const htmlNode = node;
            const modalElems = htmlNode.querySelectorAll('[data-animate-modal-body="true"]');
            if (modalElems.length > 0) {
              window.setTimeout(() => {
                listenModalChanges();
                logsTracker.addHistoryLog({
                  label: "Modal found - Scroll to scrape",
                  category: LogCategory.LOG
                });
              }, 10);
            }
          });
        }
        if (mutation.removedNodes.length > 0) {
          mutation.removedNodes.forEach((node) => {
            const htmlNode = node;
            const modalElems = htmlNode.querySelectorAll('[data-animate-modal-body="true"]');
            if (modalElems.length > 0) {
              stopListeningModalChanges();
              logsTracker.addHistoryLog({
                label: "Modal Removed - Scraping Stopped",
                category: LogCategory.LOG
              });
            }
          });
        }
      }
    }
  }
  const bodyConfig = { attributes: true, childList: true, subtree: true };
  const bodyObserver = new MutationObserver(bodyCallback);
  const app = document.getElementById("app");
  if (app) {
    bodyObserver.observe(app, bodyConfig);
  }
}
main();
