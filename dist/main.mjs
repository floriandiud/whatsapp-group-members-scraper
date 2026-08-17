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
(function(thisArg, _arguments, P, generator) {
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
});
(function(s, e) {
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
});
const btnStyles = [
  "display: block;",
  "padding: 0px 4px;",
  "cursor: pointer;",
  "text-align: center;"
];
function createCta(main) {
  const btn = document.createElement("div");
  const styles = [...btnStyles];
  if (main) {
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
(function(thisArg, _arguments, P, generator) {
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
});
var LogCategory;
(function(LogCategory2) {
  LogCategory2["ADD"] = "add";
  LogCategory2["LOG"] = "log";
})(LogCategory || (LogCategory = {}));
const DB_NAME = "model-storage";
const DEFAULT_STATUS = "Choose a group, then Export";
const EXPORT_PREFIX = "whatsAppExport";
const PREFERRED_GROUP_HINT = "חסד בישראל";
const PREFERRED_GROUP_TITLE = "חסד בישראל - עזרה רפואית";
const DASH_CHARS = /[-\u2013\u2014\u05be]/g;
const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const BIDI_AND_SPACE = /[\s\-\(\)\.\u00a0\u202f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const CHAT_STORE_CANDIDATES = ["chat", "chats"];
const PARTICIPANT_STORE_CANDIDATES = ["participant", "participants"];
const CONTACT_STORE_CANDIDATES = ["contact", "contacts"];
const GROUP_META_STORE_CANDIDATES = [
  "group-metadata",
  "groupMetadata",
  "group_metadata",
  "group-meta"
];
function stripBidi(text) {
  return text.replace(BIDI_MARKS, "");
}
function normalizeText(text) {
  return stripBidi(text).replace(/\s+/g, " ").trim();
}
function normalizeDashes(text) {
  return text.replace(DASH_CHARS, "-");
}
function matchKey(text) {
  return normalizeDashes(normalizeText(text)).toLowerCase();
}
function isPhoneNumber(text) {
  const stripped = text.replace(BIDI_AND_SPACE, "");
  return /^\+?\d{6,15}$/.test(stripped);
}
function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  return value;
}
function asArray(value) {
  if (Array.isArray(value))
    return value;
  const rec = asRecord(value);
  if (!rec)
    return [];
  if (Array.isArray(rec._models))
    return rec._models;
  if (Array.isArray(rec.models))
    return rec.models;
  if (Array.isArray(rec.toArray))
    return rec.toArray;
  return [];
}
function serializeId(value) {
  if (value == null)
    return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  const rec = asRecord(value);
  if (!rec)
    return "";
  if (typeof rec._serialized === "string")
    return rec._serialized;
  if (typeof rec.id === "string")
    return rec.id;
  if (rec.user != null && rec.server != null) {
    return `${rec.user}@${rec.server}`;
  }
  if (typeof rec.wid === "string")
    return rec.wid;
  if (rec.wid)
    return serializeId(rec.wid);
  return "";
}
function userPart(wid) {
  const s = normalizeText(wid);
  const at = s.indexOf("@");
  return at >= 0 ? s.slice(0, at) : s;
}
function serverPart(wid) {
  const s = normalizeText(wid);
  const at = s.indexOf("@");
  return at >= 0 ? s.slice(at + 1) : "";
}
function idsEqual(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb)
    return false;
  if (na === nb)
    return true;
  const ua = userPart(na);
  const ub = userPart(nb);
  const sa = serverPart(na);
  const sb = serverPart(nb);
  return !!ua && ua === ub && !!sa && sa === sb;
}
function pickStoreName(db, candidates) {
  const names = Array.from(db.objectStoreNames);
  for (const wanted of candidates) {
    if (names.includes(wanted))
      return wanted;
  }
  const lower = names.map((n) => n.toLowerCase());
  for (const wanted of candidates) {
    const w = wanted.toLowerCase();
    const exact = lower.indexOf(w);
    if (exact >= 0)
      return names[exact];
    const idx = lower.findIndex((n) => n.includes(w) || w.includes(n));
    if (idx >= 0)
      return names[idx];
  }
  return null;
}
function openModelStorage() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME);
    } catch (err) {
      reject(err);
      return;
    }
    req.onerror = () => {
      reject(req.error || new Error("Failed to open IndexedDB model-storage"));
    };
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (ev) => {
      var _a;
      if (ev.oldVersion === 0) {
        try {
          (_a = req.transaction) == null ? void 0 : _a.abort();
        } catch {
        }
        reject(new Error("WhatsApp model-storage is missing. Open https://web.whatsapp.com first."));
      }
    };
  });
}
function getAllFromStore(db, storeName) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error(`Failed to read store ${storeName}`));
    } catch (err) {
      reject(err);
    }
  });
}
async function readStore(db, candidates) {
  const name = pickStoreName(db, candidates);
  if (!name)
    return [];
  try {
    return await getAllFromStore(db, name);
  } catch {
    return [];
  }
}
function getVisibleGroupTitle() {
  const selectors = [
    '#main header span[dir="auto"][title]',
    "#main header span[title]",
    '#main header span[dir="auto"]',
    'header span[dir="auto"][title]',
    "header span[title]",
    'header span[dir="auto"]'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el)
      continue;
    const raw = el.getAttribute("title") || el.textContent || "";
    const t = normalizeText(raw);
    if (t)
      return t;
  }
  const styled = document.querySelectorAll("header span[style*='height']:not(.copyable-text)");
  if (styled.length === 1 && styled[0].textContent) {
    const t = normalizeText(styled[0].textContent);
    if (t)
      return t;
  }
  return null;
}
function chatWid(chat) {
  return serializeId(chat.id) || serializeId(chat._id) || "";
}
function isGroupChat(chat) {
  const id = chatWid(chat);
  if (id.endsWith("@g.us"))
    return true;
  if (chat.isGroup === true)
    return true;
  if (chat.kind === "group")
    return true;
  return false;
}
function chatDisplayName(chat) {
  const fields = [chat.name, chat.formattedTitle, chat.subject, chat.displayedTitle];
  for (const f of fields) {
    if (typeof f === "string" && normalizeText(f))
      return normalizeText(f);
  }
  return "";
}
function titleScore(header, name) {
  const h = matchKey(header);
  const n = matchKey(name);
  if (!h || !n)
    return 0;
  if (h === n)
    return 1e3 + n.length;
  if (n.includes(h) || h.includes(n))
    return 100 + Math.min(h.length, n.length);
  return 0;
}
function metaSubject(meta) {
  const fields = [meta.subject, meta.name, meta.formattedTitle];
  for (const f of fields) {
    if (typeof f === "string" && normalizeText(f))
      return normalizeText(f);
  }
  return "";
}
function metaWid(meta) {
  return serializeId(meta.id) || serializeId(meta._id) || serializeId(meta.groupId) || "";
}
function cheapMemberCount(chat, meta) {
  const fromRec = (rec) => {
    if (!rec)
      return void 0;
    if (typeof rec.size === "number" && rec.size > 0)
      return rec.size;
    if (typeof rec.participantsCount === "number" && rec.participantsCount > 0) {
      return rec.participantsCount;
    }
    const n = asArray(rec.participants).length;
    if (n > 0)
      return n;
    const n2 = asArray(rec.participantsList).length;
    if (n2 > 0)
      return n2;
    return void 0;
  };
  return fromRec(meta) || fromRec(chat) || fromRec(asRecord(chat == null ? void 0 : chat.groupMetadata) || void 0);
}
function listGroups(chats, metas) {
  const metaById = /* @__PURE__ */ new Map();
  for (const meta of metas) {
    const id = metaWid(meta);
    if (id)
      metaById.set(id, meta);
  }
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  const add = (id, name, count) => {
    if (!id || seen.has(id))
      return;
    seen.add(id);
    out.push({ id, name: name || id, memberCount: count });
  };
  for (const chat of chats) {
    if (!isGroupChat(chat))
      continue;
    const id = chatWid(chat);
    const meta = metaById.get(id);
    add(id, chatDisplayName(chat) || (meta ? metaSubject(meta) : ""), cheapMemberCount(chat, meta));
  }
  for (const meta of metas) {
    const id = metaWid(meta);
    if (!id)
      continue;
    if (!id.endsWith("@g.us"))
      continue;
    add(id, metaSubject(meta), cheapMemberCount(void 0, meta));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
function matchGroupByTitle(groups, headerTitle) {
  if (!headerTitle)
    return null;
  let best = null;
  for (const g of groups) {
    const score = titleScore(headerTitle, g.name);
    if (score <= 0)
      continue;
    if (!best || score > best.score)
      best = { group: g, score };
  }
  return best ? best.group : null;
}
function groupMatchesFilter(name, filter) {
  const n = matchKey(name);
  const f = matchKey(filter);
  if (!f)
    return true;
  return n.includes(f);
}
function findPreferredGroup(groups) {
  const hint = matchKey(PREFERRED_GROUP_HINT);
  const full = matchKey(PREFERRED_GROUP_TITLE);
  let hinted = null;
  for (const g of groups) {
    const n = matchKey(g.name);
    if (n === full || n.includes(full))
      return g;
    if (!hinted && n.includes(hint))
      hinted = g;
  }
  return hinted;
}
function optionLabel(group) {
  if (group.memberCount != null && group.memberCount > 0) {
    return `${group.name} (${group.memberCount})`;
  }
  return group.name;
}
function extractParticipant(value) {
  if (typeof value === "string" || typeof value === "number") {
    const id2 = String(value);
    return id2 ? { id: id2 } : null;
  }
  const rec = asRecord(value);
  if (!rec)
    return null;
  const id = serializeId(rec.id) || serializeId(rec.wid) || serializeId(rec.jid) || serializeId(rec.participant) || (typeof rec.user === "string" && typeof rec.server === "string" ? `${rec.user}@${rec.server}` : "");
  if (!id)
    return null;
  const nameFields = [rec.name, rec.pushname, rec.verifiedName, rec.shortName];
  let name = "";
  for (const f of nameFields) {
    if (typeof f === "string" && normalizeText(f)) {
      name = normalizeText(f);
      break;
    }
  }
  return {
    id,
    isAdmin: !!(rec.isAdmin || rec.isSuperAdmin),
    name: name || void 0
  };
}
function flattenParticipants(value) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (p) => {
    if (!p || !p.id || seen.has(p.id))
      return;
    seen.add(p.id);
    out.push(p);
  };
  if (typeof value === "string" || typeof value === "number") {
    add(extractParticipant(value));
    return out;
  }
  const arr = asArray(value);
  if (arr.length > 0) {
    for (const item of arr)
      add(extractParticipant(item));
    return out;
  }
  const rec = asRecord(value);
  if (!rec)
    return out;
  if (rec.participants != null) {
    return flattenParticipants(rec.participants);
  }
  add(extractParticipant(rec));
  return out;
}
function collectParticipants(groupId, chats, participantRows, metas) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const addAll = (items) => {
    for (const p of items) {
      if (!p.id || seen.has(p.id))
        continue;
      seen.add(p.id);
      out.push(p);
    }
  };
  for (const row of participantRows) {
    const rowGroup = serializeId(row.groupId) || (serializeId(row.id).endsWith("@g.us") ? serializeId(row.id) : "");
    if (rowGroup && idsEqual(rowGroup, groupId)) {
      if (row.participants != null) {
        addAll(flattenParticipants(row.participants));
      } else {
        const one = extractParticipant(row);
        if (one && !idsEqual(one.id, groupId))
          addAll([one]);
      }
      continue;
    }
    if (idsEqual(serializeId(row.id), groupId) && row.participants != null) {
      addAll(flattenParticipants(row.participants));
    }
  }
  for (const chat of chats) {
    if (!idsEqual(chatWid(chat), groupId))
      continue;
    if (chat.participants != null)
      addAll(flattenParticipants(chat.participants));
    if (chat.groupMetadata != null) {
      const gm = asRecord(chat.groupMetadata);
      if (gm && gm.participants != null)
        addAll(flattenParticipants(gm.participants));
    }
  }
  for (const meta of metas) {
    if (!idsEqual(metaWid(meta), groupId))
      continue;
    if (meta.participants != null)
      addAll(flattenParticipants(meta.participants));
    if (meta.participantsList != null)
      addAll(flattenParticipants(meta.participantsList));
  }
  return out;
}
function contactKeys(contact) {
  const keys = [];
  const add = (v) => {
    const s = serializeId(v);
    if (!s)
      return;
    keys.push(s);
    const u = userPart(s);
    if (u)
      keys.push(u);
  };
  add(contact.id);
  add(contact._id);
  add(contact.wid);
  add(contact.jid);
  add(contact.phoneNumber);
  add(contact.lid);
  add(contact.lidJid);
  add(contact.pnJid);
  if (typeof contact.user === "string")
    keys.push(contact.user);
  return keys;
}
function buildContactIndex(contacts) {
  const index = /* @__PURE__ */ new Map();
  for (const contact of contacts) {
    for (const key of contactKeys(contact)) {
      const existing = index.get(key);
      if (!existing) {
        index.set(key, contact);
      } else {
        const existingPhone = serializeId(existing.phoneNumber);
        const nextPhone = serializeId(contact.phoneNumber);
        const existingName = typeof existing.name === "string" ? existing.name : "";
        const nextName = typeof contact.name === "string" ? contact.name : "";
        if (!existingPhone && nextPhone || !existingName && nextName) {
          index.set(key, { ...existing, ...contact });
        }
      }
    }
  }
  return index;
}
function lookupContact(index, participantId) {
  const id = normalizeText(participantId);
  if (!id)
    return void 0;
  return index.get(id) || index.get(userPart(id));
}
function plusFromContact(contact) {
  if (!contact)
    return false;
  const fields = [contact.phoneNumber, contact.e164, contact.number, contact.formattedPhone];
  for (const f of fields) {
    if (typeof f === "string" && f.includes("+"))
      return true;
  }
  return false;
}
function digitsFromCus(wid) {
  const user = userPart(wid);
  const cleaned = user.replace(BIDI_AND_SPACE, "");
  if (/^\+?\d{6,15}$/.test(cleaned)) {
    return cleaned.replace(/^\+/, "");
  }
  const only = user.replace(/\D/g, "");
  return only.length >= 6 && only.length <= 15 ? only : "";
}
function phoneFromContactField(value) {
  const s = serializeId(value);
  if (!s)
    return "";
  if (s.endsWith("@c.us"))
    return digitsFromCus(s);
  if (s.endsWith("@lid") || s.endsWith("@g.us") || s.endsWith("@s.whatsapp.net"))
    return "";
  if (isPhoneNumber(s))
    return s.replace(BIDI_AND_SPACE, "").replace(/^\+/, "");
  return "";
}
function resolvePhone(participantId, contact) {
  const id = normalizeText(participantId);
  let phone = "";
  if (id.endsWith("@c.us")) {
    phone = digitsFromCus(id);
  } else if (id.endsWith("@lid")) {
    if (contact) {
      phone = phoneFromContactField(contact.phoneNumber) || phoneFromContactField(contact.id) || phoneFromContactField(contact.pnJid) || phoneFromContactField(contact.e164);
      const pn = serializeId(contact.phoneNumber);
      const cid = serializeId(contact.id);
      if (!pn.endsWith("@c.us") && !cid.endsWith("@c.us") && !serializeId(contact.pnJid).endsWith("@c.us")) {
        if (!phoneFromContactField(contact.phoneNumber) && !phoneFromContactField(contact.e164)) {
          phone = "";
        }
      }
    }
  } else {
    phone = digitsFromCus(id) || phoneFromContactField(id);
  }
  if (!phone && contact) {
    phone = phoneFromContactField(contact.phoneNumber) || (serializeId(contact.id).endsWith("@c.us") ? digitsFromCus(serializeId(contact.id)) : "");
  }
  if (!phone)
    return "";
  if (plusFromContact(contact))
    return `+${phone.replace(/^\+/, "")}`;
  return phone.replace(/^\+/, "");
}
function contactName(contact, fallback) {
  if (contact) {
    const fields = [contact.name, contact.pushname, contact.verifiedName, contact.shortName];
    for (const f of fields) {
      if (typeof f === "string" && normalizeText(f))
        return normalizeText(f);
    }
  }
  return fallback ? normalizeText(fallback) : "";
}
function contactPushname(contact) {
  if (contact && typeof contact.pushname === "string") {
    return normalizeText(contact.pushname);
  }
  return "";
}
function joinMembers(participants, contacts, source) {
  const index = buildContactIndex(contacts);
  const rows = [];
  const seen = /* @__PURE__ */ new Set();
  for (const p of participants) {
    const contact = lookupContact(index, p.id);
    const phone = resolvePhone(p.id, contact);
    const name = contactName(contact, p.name);
    const pushname = contactPushname(contact);
    const id = normalizeText(p.id);
    const key = phone || id;
    if (!key || seen.has(key)) {
      if (phone && id && seen.has(id)) {
        const existing = rows.find((r) => r.id === id && !r.phoneNumber);
        if (existing) {
          existing.phoneNumber = phone;
          seen.add(phone);
        }
      }
      continue;
    }
    seen.add(key);
    if (phone)
      seen.add(phone);
    if (id)
      seen.add(id);
    rows.push({
      phoneNumber: phone,
      name,
      pushname,
      source,
      id,
      isAdmin: p.isAdmin
    });
  }
  return rows;
}
function rowToCsvLine(row) {
  let line = "";
  for (let i = 0; i < row.length; i++) {
    const cell = row[i];
    let value = cell === null || cell === void 0 ? "" : cell.toString();
    value = value.replace(/"/g, '""');
    if (value.search(/("|,|\n)/g) >= 0) {
      value = '"' + value + '"';
    }
    if (i > 0)
      line += ",";
    line += value;
  }
  return line + "\n";
}
function exportToCsvWithBom(filename, rows) {
  let csvFile = "";
  for (let i = 0; i < rows.length; i++) {
    csvFile += rowToCsvLine(rows[i]);
  }
  const blob = new Blob(["\uFEFF" + csvFile], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  if (link.download !== void 0) {
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}
function membersToCsv(rows) {
  const out = [
    ["Phone Number", "Name", "Pushname", "Source", "Id"]
  ];
  for (const row of rows) {
    out.push([
      row.phoneNumber,
      row.name,
      row.pushname,
      row.source,
      row.id
    ]);
  }
  return out;
}
async function readChatsAndMetas(db) {
  const [chatRows, metaRows] = await Promise.all([
    readStore(db, CHAT_STORE_CANDIDATES),
    readStore(db, GROUP_META_STORE_CANDIDATES)
  ]);
  return {
    chats: chatRows.map(asRecord).filter((r) => !!r),
    metas: metaRows.map(asRecord).filter((r) => !!r)
  };
}
async function loadGroupCatalog() {
  const db = await openModelStorage();
  try {
    const { chats, metas } = await readChatsAndMetas(db);
    return { groups: listGroups(chats, metas), headerTitle: getVisibleGroupTitle() };
  } finally {
    try {
      db.close();
    } catch {
    }
  }
}
async function exportGroupMembers(groupId) {
  if (!groupId) {
    throw new Error(DEFAULT_STATUS);
  }
  const db = await openModelStorage();
  try {
    const [chatRows, participantRows, contactRows, metaRows] = await Promise.all([
      readStore(db, CHAT_STORE_CANDIDATES),
      readStore(db, PARTICIPANT_STORE_CANDIDATES),
      readStore(db, CONTACT_STORE_CANDIDATES),
      readStore(db, GROUP_META_STORE_CANDIDATES)
    ]);
    const chats = chatRows.map(asRecord).filter((r) => !!r);
    const participantsStore = participantRows.map(asRecord).filter((r) => !!r);
    const contacts = contactRows.map(asRecord).filter((r) => !!r);
    const metas = metaRows.map(asRecord).filter((r) => !!r);
    const groups = listGroups(chats, metas);
    const group = groups.find((g) => idsEqual(g.id, groupId));
    if (!group) {
      throw new Error("Selected group was not found in model-storage.");
    }
    const participants = collectParticipants(group.id, chats, participantsStore, metas);
    const members = joinMembers(participants, contacts, group.name);
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    exportToCsvWithBom(`${EXPORT_PREFIX}-${timestamp}.csv`, membersToCsv(members));
    return { name: group.name, count: members.length };
  } finally {
    try {
      db.close();
    } catch {
    }
  }
}
function stopBubble(el) {
  el.addEventListener("mousedown", (e) => e.stopPropagation());
  el.addEventListener("click", (e) => e.stopPropagation());
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
}
function overlayChromeStyle() {
  return [
    "position: fixed;",
    "bottom: 24px;",
    "right: 24px;",
    "z-index: 2147483647;",
    "pointer-events: auto;",
    "width: min(420px, calc(100vw - 48px));",
    "box-sizing: border-box;"
  ].join("");
}
function fieldStyle() {
  return [
    "display: block;",
    "width: 100%;",
    "max-width: 420px;",
    "box-sizing: border-box;",
    "font-family: monospace;",
    "font-size: 13px;",
    "line-height: 1.35;",
    "margin-bottom: 6px;",
    "padding: 6px 8px;",
    "pointer-events: auto;"
  ].join("");
}
function listStyle() {
  return [
    "display: block;",
    "width: 100%;",
    "max-width: 420px;",
    "max-height: 240px;",
    "overflow: auto;",
    "pointer-events: auto;",
    "box-sizing: border-box;",
    "font-family: monospace;",
    "font-size: 13px;",
    "line-height: 1.45;",
    "margin-bottom: 6px;",
    "border: 1px solid #c8c8d6;",
    "border-radius: 6px;",
    "background: #fff;"
  ].join("");
}
function rowStyle(selected) {
  return [
    "display: block;",
    "width: 100%;",
    "text-align: start;",
    "white-space: normal;",
    "overflow-wrap: break-word;",
    "word-break: normal;",
    "pointer-events: auto;",
    "cursor: pointer;",
    "border: none;",
    "border-bottom: 1px solid #eee;",
    "padding: 8px 10px;",
    "box-sizing: border-box;",
    "font: inherit;",
    `background: ${selected ? "#dbeafe" : "transparent"};`,
    "color: #2f2f2f;"
  ].join("");
}
let dismissWidget = null;
function buildWidget() {
  if (dismissWidget) {
    dismissWidget();
    dismissWidget = null;
  }
  const uiWidget = new UIContainer();
  const statusEl = document.createElement("div");
  statusEl.setAttribute("style", [
    "text-align: left;",
    "background: #f5f5fa;",
    "padding: 8px 10px;",
    "margin-bottom: 8px;",
    "border-radius: 8px;",
    "font-family: monospace;",
    "font-size: 14px;",
    "line-height: 1.35;",
    "max-width: 420px;",
    "white-space: normal;",
    "overflow-wrap: break-word;",
    "word-break: normal;",
    "color: #2f2f2f;",
    "box-shadow: rgba(42, 35, 66, 0.2) 0 2px 2px, rgba(45, 35, 66, 0.2) 0 7px 13px -4px;"
  ].join(""));
  statusEl.textContent = DEFAULT_STATUS;
  uiWidget.history.appendChild(statusEl);
  const filterInput = document.createElement("input");
  filterInput.type = "search";
  filterInput.placeholder = "Filter groups…";
  filterInput.setAttribute("dir", "auto");
  filterInput.setAttribute("style", fieldStyle());
  stopBubble(filterInput);
  uiWidget.history.appendChild(filterInput);
  const listEl = document.createElement("div");
  listEl.setAttribute("style", listStyle());
  stopBubble(listEl);
  uiWidget.history.appendChild(listEl);
  const setStatus = (text) => {
    statusEl.textContent = text;
  };
  let allGroups = [];
  let selectedId = "";
  const renderOptions = () => {
    const filter = filterInput.value;
    const visible = allGroups.filter((g) => groupMatchesFilter(g.name, filter));
    listEl.innerHTML = "";
    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.setAttribute("dir", "auto");
      empty.setAttribute("style", [
        "padding: 8px 10px;",
        "color: #666;",
        "white-space: normal;",
        "overflow-wrap: break-word;",
        "word-break: normal;"
      ].join(""));
      empty.textContent = allGroups.length ? "No matching groups" : "Choose a group";
      listEl.appendChild(empty);
      return;
    }
    for (const g of visible) {
      const row = document.createElement("button");
      row.type = "button";
      row.setAttribute("dir", "auto");
      row.setAttribute("style", rowStyle(g.id === selectedId));
      row.textContent = optionLabel(g);
      stopBubble(row);
      row.addEventListener("click", () => {
        selectedId = g.id;
        renderOptions();
        setStatus(`Selected ${g.name}`);
      });
      listEl.appendChild(row);
    }
  };
  const applySelection = (id) => {
    selectedId = id;
    renderOptions();
  };
  filterInput.addEventListener("input", () => {
    renderOptions();
  });
  let exporting = false;
  const runExport = async () => {
    if (exporting)
      return;
    if (!selectedId) {
      setStatus(DEFAULT_STATUS);
      return;
    }
    exporting = true;
    setStatus("Reading IndexedDB…");
    try {
      const { name, count } = await exportGroupMembers(selectedId);
      setStatus(`Found ${count} members in ${name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(message || "Export failed");
      console.error(err);
    } finally {
      exporting = false;
    }
  };
  const destroyWidget = () => {
    document.removeEventListener("keydown", onEscapeKey);
    uiWidget.inner.remove();
    if (uiWidget.canva) {
      uiWidget.canva.remove();
    }
    document.querySelectorAll("[data-wa-scraper-widget]").forEach((node) => {
      node.remove();
    });
    if (dismissWidget === destroyWidget) {
      dismissWidget = null;
    }
  };
  const onEscapeKey = (event) => {
    if (event.key === "Escape") {
      destroyWidget();
    }
  };
  const btnExport = createCta();
  btnExport.appendChild(createTextSpan("Export"));
  btnExport.addEventListener("click", () => {
    void runExport();
  });
  uiWidget.addCta(btnExport);
  uiWidget.addCta(createSpacer());
  const btnReset = createCta();
  btnReset.appendChild(createTextSpan("Reset"));
  btnReset.addEventListener("click", () => {
    filterInput.value = "";
    applySelection("");
    setStatus(DEFAULT_STATUS);
  });
  uiWidget.addCta(btnReset);
  uiWidget.addCta(createSpacer());
  const btnClose = createCta();
  btnClose.appendChild(createTextSpan("Close"));
  btnClose.addEventListener("click", () => {
    destroyWidget();
  });
  uiWidget.addCta(btnClose);
  uiWidget.inner.setAttribute("dir", "ltr");
  uiWidget.inner.setAttribute("style", overlayChromeStyle());
  uiWidget.inner.setAttribute("data-wa-scraper-widget", "");
  if (uiWidget.canva) {
    uiWidget.canva.setAttribute("data-wa-scraper-widget", "");
  }
  document.body.appendChild(uiWidget.inner);
  document.addEventListener("keydown", onEscapeKey);
  dismissWidget = destroyWidget;
  const loadList = async () => {
    setStatus("Reading IndexedDB…");
    try {
      const { groups, headerTitle } = await loadGroupCatalog();
      allGroups = groups;
      if (groups.length === 0) {
        applySelection("");
        setStatus("No group chats found in model-storage.");
        return;
      }
      const preferred = findPreferredGroup(groups);
      const matched = preferred || matchGroupByTitle(groups, headerTitle);
      if (matched) {
        applySelection(matched.id);
        setStatus(`${groups.length} groups found. Selected ${matched.name}`);
      } else {
        applySelection("");
        setStatus(`${groups.length} groups found. Pick a group to export.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(message || "Failed to list groups");
      console.error(err);
    }
  };
  void loadList();
}
buildWidget();
