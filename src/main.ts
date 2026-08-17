import {
    UIContainer,
    createCta,
    createSpacer,
    createTextSpan
} from 'browser-scraping-utils';

/**
 * WhatsApp Web group-member exporter.
 * Reads IndexedDB `model-storage` (readonly). No DOM member-modal scraping.
 */

const DB_NAME = 'model-storage';
const DEFAULT_STATUS = 'Choose a group, then Export';
const EXPORT_PREFIX = 'whatsAppExport';
const PREFERRED_GROUP_HINT = 'חסד בישראל';
const PREFERRED_GROUP_TITLE = 'חסד בישראל - עזרה רפואית';
// ASCII hyphen, en-dash, em-dash, Hebrew maqaf
const DASH_CHARS = /[-\u2013\u2014\u05be]/g;

const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const BIDI_AND_SPACE = /[\s\-\(\)\.\u00a0\u202f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

const CHAT_STORE_CANDIDATES = ['chat', 'chats'];
const PARTICIPANT_STORE_CANDIDATES = ['participant', 'participants'];
const CONTACT_STORE_CANDIDATES = ['contact', 'contacts'];
const GROUP_META_STORE_CANDIDATES = [
    'group-metadata',
    'groupMetadata',
    'group_metadata',
    'group-meta'
];

interface MemberRow {
    phoneNumber: string;
    name: string;
    pushname: string;
    source: string;
    id: string;
    isAdmin?: boolean;
}

interface ParticipantRef {
    id: string;
    isAdmin?: boolean;
    name?: string;
}

interface GroupOption {
    id: string;
    name: string;
    memberCount?: number;
}

type IdRecord = Record<string, unknown>;

function stripBidi(text: string): string {
    return text.replace(BIDI_MARKS, '');
}

function normalizeText(text: string): string {
    return stripBidi(text).replace(/\s+/g, ' ').trim();
}

function normalizeDashes(text: string): string {
    return text.replace(DASH_CHARS, '-');
}

function matchKey(text: string): string {
    return normalizeDashes(normalizeText(text)).toLowerCase();
}

function isPhoneNumber(text: string): boolean {
    const stripped = text.replace(BIDI_AND_SPACE, '');
    return /^\+?\d{6,15}$/.test(stripped);
}

function asRecord(value: unknown): IdRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as IdRecord;
}

function asArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    const rec = asRecord(value);
    if (!rec) return [];
    if (Array.isArray(rec._models)) return rec._models;
    if (Array.isArray(rec.models)) return rec.models;
    if (Array.isArray(rec.toArray)) return rec.toArray as unknown[];
    return [];
}

function serializeId(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') {
        return String(value);
    }
    const rec = asRecord(value);
    if (!rec) return '';
    if (typeof rec._serialized === 'string') return rec._serialized;
    if (typeof rec.id === 'string') return rec.id;
    if (rec.user != null && rec.server != null) {
        return `${rec.user}@${rec.server}`;
    }
    if (typeof rec.wid === 'string') return rec.wid;
    if (rec.wid) return serializeId(rec.wid);
    return '';
}

function userPart(wid: string): string {
    const s = normalizeText(wid);
    const at = s.indexOf('@');
    return at >= 0 ? s.slice(0, at) : s;
}

function serverPart(wid: string): string {
    const s = normalizeText(wid);
    const at = s.indexOf('@');
    return at >= 0 ? s.slice(at + 1) : '';
}

function idsEqual(a: string, b: string): boolean {
    const na = normalizeText(a);
    const nb = normalizeText(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const ua = userPart(na);
    const ub = userPart(nb);
    const sa = serverPart(na);
    const sb = serverPart(nb);
    return !!ua && ua === ub && !!sa && sa === sb;
}

function pickStoreName(db: IDBDatabase, candidates: string[]): string | null {
    const names = Array.from(db.objectStoreNames);
    for (const wanted of candidates) {
        if (names.includes(wanted)) return wanted;
    }
    const lower = names.map((n) => n.toLowerCase());
    for (const wanted of candidates) {
        const w = wanted.toLowerCase();
        const exact = lower.indexOf(w);
        if (exact >= 0) return names[exact];
        const idx = lower.findIndex((n) => n.includes(w) || w.includes(n));
        if (idx >= 0) return names[idx];
    }
    return null;
}

function openModelStorage(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        let req: IDBOpenDBRequest;
        try {
            // No version: open the current schema. Never upgrade/delete.
            req = indexedDB.open(DB_NAME);
        } catch (err) {
            reject(err);
            return;
        }
        req.onerror = () => {
            reject(req.error || new Error('Failed to open IndexedDB model-storage'));
        };
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = (ev) => {
            if (ev.oldVersion === 0) {
                try {
                    req.transaction?.abort();
                } catch {
                    // ignore
                }
                reject(new Error('WhatsApp model-storage is missing. Open https://web.whatsapp.com first.'));
            }
        };
    });
}

function getAllFromStore(db: IDBDatabase, storeName: string): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error || new Error(`Failed to read store ${storeName}`));
        } catch (err) {
            reject(err);
        }
    });
}

async function readStore(db: IDBDatabase, candidates: string[]): Promise<unknown[]> {
    const name = pickStoreName(db, candidates);
    if (!name) return [];
    try {
        return await getAllFromStore(db, name);
    } catch {
        return [];
    }
}

function getVisibleGroupTitle(): string | null {
    const selectors = [
        '#main header span[dir="auto"][title]',
        '#main header span[title]',
        '#main header span[dir="auto"]',
        'header span[dir="auto"][title]',
        'header span[title]',
        'header span[dir="auto"]'
    ];
    for (const sel of selectors) {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) continue;
        const raw = el.getAttribute('title') || el.textContent || '';
        const t = normalizeText(raw);
        if (t) return t;
    }
    const styled = document.querySelectorAll("header span[style*='height']:not(.copyable-text)");
    if (styled.length === 1 && styled[0].textContent) {
        const t = normalizeText(styled[0].textContent);
        if (t) return t;
    }
    return null;
}

function chatWid(chat: IdRecord): string {
    return serializeId(chat.id) || serializeId(chat._id) || '';
}

function isGroupChat(chat: IdRecord): boolean {
    const id = chatWid(chat);
    if (id.endsWith('@g.us')) return true;
    if (chat.isGroup === true) return true;
    if (chat.kind === 'group') return true;
    return false;
}

function chatDisplayName(chat: IdRecord): string {
    const fields = [chat.name, chat.formattedTitle, chat.subject, chat.displayedTitle];
    for (const f of fields) {
        if (typeof f === 'string' && normalizeText(f)) return normalizeText(f);
    }
    return '';
}

function titleScore(header: string, name: string): number {
    const h = matchKey(header);
    const n = matchKey(name);
    if (!h || !n) return 0;
    if (h === n) return 1000 + n.length;
    if (n.includes(h) || h.includes(n)) return 100 + Math.min(h.length, n.length);
    return 0;
}

function metaSubject(meta: IdRecord): string {
    const fields = [meta.subject, meta.name, meta.formattedTitle];
    for (const f of fields) {
        if (typeof f === 'string' && normalizeText(f)) return normalizeText(f);
    }
    return '';
}

function metaWid(meta: IdRecord): string {
    return serializeId(meta.id) || serializeId(meta._id) || serializeId(meta.groupId) || '';
}

function cheapMemberCount(chat: IdRecord | undefined, meta: IdRecord | undefined): number | undefined {
    const fromRec = (rec: IdRecord | undefined): number | undefined => {
        if (!rec) return undefined;
        if (typeof rec.size === 'number' && rec.size > 0) return rec.size;
        if (typeof rec.participantsCount === 'number' && rec.participantsCount > 0) {
            return rec.participantsCount;
        }
        const n = asArray(rec.participants).length;
        if (n > 0) return n;
        const n2 = asArray(rec.participantsList).length;
        if (n2 > 0) return n2;
        return undefined;
    };
    return fromRec(meta) || fromRec(chat) || fromRec(asRecord(chat?.groupMetadata) || undefined);
}

function listGroups(chats: IdRecord[], metas: IdRecord[]): GroupOption[] {
    const metaById = new Map<string, IdRecord>();
    for (const meta of metas) {
        const id = metaWid(meta);
        if (id) metaById.set(id, meta);
    }

    const seen = new Set<string>();
    const out: GroupOption[] = [];
    const add = (id: string, name: string, count?: number) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        out.push({ id, name: name || id, memberCount: count });
    };

    for (const chat of chats) {
        if (!isGroupChat(chat)) continue;
        const id = chatWid(chat);
        const meta = metaById.get(id);
        add(id, chatDisplayName(chat) || (meta ? metaSubject(meta) : ''), cheapMemberCount(chat, meta));
    }

    for (const meta of metas) {
        const id = metaWid(meta);
        if (!id) continue;
        if (!id.endsWith('@g.us')) continue;
        add(id, metaSubject(meta), cheapMemberCount(undefined, meta));
    }

    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

function matchGroupByTitle(groups: GroupOption[], headerTitle: string | null): GroupOption | null {
    if (!headerTitle) return null;
    let best: { group: GroupOption; score: number } | null = null;
    for (const g of groups) {
        const score = titleScore(headerTitle, g.name);
        if (score <= 0) continue;
        if (!best || score > best.score) best = { group: g, score };
    }
    return best ? best.group : null;
}

function groupMatchesFilter(name: string, filter: string): boolean {
    const n = matchKey(name);
    const f = matchKey(filter);
    if (!f) return true;
    return n.includes(f);
}

function findPreferredGroup(groups: GroupOption[]): GroupOption | null {
    const hint = matchKey(PREFERRED_GROUP_HINT);
    const full = matchKey(PREFERRED_GROUP_TITLE);
    let hinted: GroupOption | null = null;
    for (const g of groups) {
        const n = matchKey(g.name);
        if (n === full || n.includes(full)) return g;
        if (!hinted && n.includes(hint)) hinted = g;
    }
    return hinted;
}

function optionLabel(group: GroupOption): string {
    if (group.memberCount != null && group.memberCount > 0) {
        return `${group.name} (${group.memberCount})`;
    }
    return group.name;
}

function extractParticipant(value: unknown): ParticipantRef | null {
    if (typeof value === 'string' || typeof value === 'number') {
        const id = String(value);
        return id ? { id } : null;
    }
    const rec = asRecord(value);
    if (!rec) return null;
    const id =
        serializeId(rec.id) ||
        serializeId(rec.wid) ||
        serializeId(rec.jid) ||
        serializeId(rec.participant) ||
        (typeof rec.user === 'string' && typeof rec.server === 'string'
            ? `${rec.user}@${rec.server}`
            : '');
    if (!id) return null;
    const nameFields = [rec.name, rec.pushname, rec.verifiedName, rec.shortName];
    let name = '';
    for (const f of nameFields) {
        if (typeof f === 'string' && normalizeText(f)) {
            name = normalizeText(f);
            break;
        }
    }
    return {
        id,
        isAdmin: !!(rec.isAdmin || rec.isSuperAdmin),
        name: name || undefined
    };
}

function flattenParticipants(value: unknown): ParticipantRef[] {
    const out: ParticipantRef[] = [];
    const seen = new Set<string>();
    const add = (p: ParticipantRef | null) => {
        if (!p || !p.id || seen.has(p.id)) return;
        seen.add(p.id);
        out.push(p);
    };

    if (typeof value === 'string' || typeof value === 'number') {
        add(extractParticipant(value));
        return out;
    }
    const arr = asArray(value);
    if (arr.length > 0) {
        for (const item of arr) add(extractParticipant(item));
        return out;
    }
    const rec = asRecord(value);
    if (!rec) return out;
    if (rec.participants != null) {
        return flattenParticipants(rec.participants);
    }
    add(extractParticipant(rec));
    return out;
}

function collectParticipants(
    groupId: string,
    chats: IdRecord[],
    participantRows: IdRecord[],
    metas: IdRecord[]
): ParticipantRef[] {
    const out: ParticipantRef[] = [];
    const seen = new Set<string>();
    const addAll = (items: ParticipantRef[]) => {
        for (const p of items) {
            if (!p.id || seen.has(p.id)) continue;
            seen.add(p.id);
            out.push(p);
        }
    };

    for (const row of participantRows) {
        const rowGroup =
            serializeId(row.groupId) ||
            (serializeId(row.id).endsWith('@g.us') ? serializeId(row.id) : '');
        if (rowGroup && idsEqual(rowGroup, groupId)) {
            if (row.participants != null) {
                addAll(flattenParticipants(row.participants));
            } else {
                // inverted membership row: groupId + one participant
                const one = extractParticipant(row);
                if (one && !idsEqual(one.id, groupId)) addAll([one]);
            }
            continue;
        }
        // Some schemas key the row by group id
        if (idsEqual(serializeId(row.id), groupId) && row.participants != null) {
            addAll(flattenParticipants(row.participants));
        }
    }

    for (const chat of chats) {
        if (!idsEqual(chatWid(chat), groupId)) continue;
        if (chat.participants != null) addAll(flattenParticipants(chat.participants));
        if (chat.groupMetadata != null) {
            const gm = asRecord(chat.groupMetadata);
            if (gm && gm.participants != null) addAll(flattenParticipants(gm.participants));
        }
    }

    for (const meta of metas) {
        if (!idsEqual(metaWid(meta), groupId)) continue;
        if (meta.participants != null) addAll(flattenParticipants(meta.participants));
        if (meta.participantsList != null) addAll(flattenParticipants(meta.participantsList));
    }

    return out;
}

function contactKeys(contact: IdRecord): string[] {
    const keys: string[] = [];
    const add = (v: unknown) => {
        const s = serializeId(v);
        if (!s) return;
        keys.push(s);
        const u = userPart(s);
        if (u) keys.push(u);
    };
    add(contact.id);
    add(contact._id);
    add(contact.wid);
    add(contact.jid);
    add(contact.phoneNumber);
    add(contact.lid);
    add(contact.lidJid);
    add(contact.pnJid);
    if (typeof contact.user === 'string') keys.push(contact.user);
    return keys;
}

function buildContactIndex(contacts: IdRecord[]): Map<string, IdRecord> {
    const index = new Map<string, IdRecord>();
    for (const contact of contacts) {
        for (const key of contactKeys(contact)) {
            const existing = index.get(key);
            if (!existing) {
                index.set(key, contact);
            } else {
                // Prefer the record that has a phoneNumber / name
                const existingPhone = serializeId(existing.phoneNumber);
                const nextPhone = serializeId(contact.phoneNumber);
                const existingName = typeof existing.name === 'string' ? existing.name : '';
                const nextName = typeof contact.name === 'string' ? contact.name : '';
                if ((!existingPhone && nextPhone) || (!existingName && nextName)) {
                    index.set(key, { ...existing, ...contact });
                }
            }
        }
    }
    return index;
}

function lookupContact(index: Map<string, IdRecord>, participantId: string): IdRecord | undefined {
    const id = normalizeText(participantId);
    if (!id) return undefined;
    return index.get(id) || index.get(userPart(id));
}

function plusFromContact(contact: IdRecord | undefined): boolean {
    if (!contact) return false;
    const fields = [contact.phoneNumber, contact.e164, contact.number, contact.formattedPhone];
    for (const f of fields) {
        if (typeof f === 'string' && f.includes('+')) return true;
    }
    return false;
}

function digitsFromCus(wid: string): string {
    const user = userPart(wid);
    const cleaned = user.replace(BIDI_AND_SPACE, '');
    if (/^\+?\d{6,15}$/.test(cleaned)) {
        return cleaned.replace(/^\+/, '');
    }
    const only = user.replace(/\D/g, '');
    return only.length >= 6 && only.length <= 15 ? only : '';
}

function phoneFromContactField(value: unknown): string {
    const s = serializeId(value);
    if (!s) return '';
    if (s.endsWith('@c.us')) return digitsFromCus(s);
    if (s.endsWith('@lid') || s.endsWith('@g.us') || s.endsWith('@s.whatsapp.net')) return '';
    if (isPhoneNumber(s)) return s.replace(BIDI_AND_SPACE, '').replace(/^\+/, '');
    return '';
}

function resolvePhone(participantId: string, contact: IdRecord | undefined): string {
    const id = normalizeText(participantId);
    let phone = '';
    if (id.endsWith('@c.us')) {
        phone = digitsFromCus(id);
    } else if (id.endsWith('@lid')) {
        if (contact) {
            phone =
                phoneFromContactField(contact.phoneNumber) ||
                phoneFromContactField(contact.id) ||
                phoneFromContactField(contact.pnJid) ||
                phoneFromContactField(contact.e164);
            // Only accept @c.us-backed phones for LID rows
            const pn = serializeId(contact.phoneNumber);
            const cid = serializeId(contact.id);
            if (!pn.endsWith('@c.us') && !cid.endsWith('@c.us') && !serializeId(contact.pnJid).endsWith('@c.us')) {
                if (!phoneFromContactField(contact.phoneNumber) && !phoneFromContactField(contact.e164)) {
                    phone = '';
                }
            }
        }
    } else {
        phone = digitsFromCus(id) || phoneFromContactField(id);
    }

    if (!phone && contact) {
        phone =
            phoneFromContactField(contact.phoneNumber) ||
            (serializeId(contact.id).endsWith('@c.us') ? digitsFromCus(serializeId(contact.id)) : '');
    }

    if (!phone) return '';
    if (plusFromContact(contact)) return `+${phone.replace(/^\+/, '')}`;
    return phone.replace(/^\+/, '');
}

function contactName(contact: IdRecord | undefined, fallback?: string): string {
    if (contact) {
        const fields = [contact.name, contact.pushname, contact.verifiedName, contact.shortName];
        for (const f of fields) {
            if (typeof f === 'string' && normalizeText(f)) return normalizeText(f);
        }
    }
    return fallback ? normalizeText(fallback) : '';
}

function contactPushname(contact: IdRecord | undefined): string {
    if (contact && typeof contact.pushname === 'string') {
        return normalizeText(contact.pushname);
    }
    return '';
}

function joinMembers(
    participants: ParticipantRef[],
    contacts: IdRecord[],
    source: string
): MemberRow[] {
    const index = buildContactIndex(contacts);
    const rows: MemberRow[] = [];
    const seen = new Set<string>();

    for (const p of participants) {
        const contact = lookupContact(index, p.id);
        const phone = resolvePhone(p.id, contact);
        const name = contactName(contact, p.name);
        const pushname = contactPushname(contact);
        const id = normalizeText(p.id);
        const key = phone || id;
        if (!key || seen.has(key)) {
            // If we already stored a LID-only row and now have a phone, upgrade it
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
        if (phone) seen.add(phone);
        if (id) seen.add(id);
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

function rowToCsvLine(row: Array<string | number | null | undefined>): string {
    let line = '';
    for (let i = 0; i < row.length; i++) {
        const cell = row[i];
        let value = (cell === null || cell === undefined) ? '' : cell.toString();
        value = value.replace(/"/g, '""');
        if (value.search(/("|,|\n)/g) >= 0) {
            value = '"' + value + '"';
        }
        if (i > 0) line += ',';
        line += value;
    }
    return line + '\n';
}

function exportToCsvWithBom(filename: string, rows: Array<Array<string | number | null | undefined>>): void {
    let csvFile = '';
    for (let i = 0; i < rows.length; i++) {
        csvFile += rowToCsvLine(rows[i]);
    }
    const blob = new Blob(['\uFEFF' + csvFile], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    if (link.download !== undefined) {
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }
}

function membersToCsv(rows: MemberRow[]): Array<Array<string>> {
    const out: Array<Array<string>> = [
        ['Phone Number', 'Name', 'Pushname', 'Source', 'Id']
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

async function readChatsAndMetas(db: IDBDatabase): Promise<{ chats: IdRecord[]; metas: IdRecord[] }> {
    const [chatRows, metaRows] = await Promise.all([
        readStore(db, CHAT_STORE_CANDIDATES),
        readStore(db, GROUP_META_STORE_CANDIDATES)
    ]);
    return {
        chats: chatRows.map(asRecord).filter((r): r is IdRecord => !!r),
        metas: metaRows.map(asRecord).filter((r): r is IdRecord => !!r)
    };
}

async function loadGroupCatalog(): Promise<{ groups: GroupOption[]; headerTitle: string | null }> {
    const db = await openModelStorage();
    try {
        const { chats, metas } = await readChatsAndMetas(db);
        return { groups: listGroups(chats, metas), headerTitle: getVisibleGroupTitle() };
    } finally {
        try {
            db.close();
        } catch {
            // ignore
        }
    }
}

async function exportGroupMembers(groupId: string): Promise<{ name: string; count: number }> {
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

        const chats = chatRows.map(asRecord).filter((r): r is IdRecord => !!r);
        const participantsStore = participantRows.map(asRecord).filter((r): r is IdRecord => !!r);
        const contacts = contactRows.map(asRecord).filter((r): r is IdRecord => !!r);
        const metas = metaRows.map(asRecord).filter((r): r is IdRecord => !!r);

        const groups = listGroups(chats, metas);
        const group = groups.find((g) => idsEqual(g.id, groupId));
        if (!group) {
            throw new Error('Selected group was not found in model-storage.');
        }

        const participants = collectParticipants(group.id, chats, participantsStore, metas);
        const members = joinMembers(participants, contacts, group.name);
        const timestamp = new Date().toISOString();
        exportToCsvWithBom(`${EXPORT_PREFIX}-${timestamp}.csv`, membersToCsv(members));
        return { name: group.name, count: members.length };
    } finally {
        try {
            db.close();
        } catch {
            // ignore
        }
    }
}

function stopBubble(el: HTMLElement): void {
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => e.stopPropagation());
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
}

function overlayChromeStyle(): string {
    return [
        'position: fixed;',
        'bottom: 24px;',
        'right: 24px;',
        'z-index: 2147483647;',
        'pointer-events: auto;',
        'width: min(420px, calc(100vw - 48px));',
        'box-sizing: border-box;'
    ].join('');
}

function fieldStyle(): string {
    return [
        'display: block;',
        'width: 100%;',
        'max-width: 420px;',
        'box-sizing: border-box;',
        'font-family: monospace;',
        'font-size: 13px;',
        'line-height: 1.35;',
        'margin-bottom: 6px;',
        'padding: 6px 8px;',
        'pointer-events: auto;'
    ].join('');
}

function listStyle(): string {
    return [
        'display: block;',
        'width: 100%;',
        'max-width: 420px;',
        'max-height: 240px;',
        'overflow: auto;',
        'pointer-events: auto;',
        'box-sizing: border-box;',
        'font-family: monospace;',
        'font-size: 13px;',
        'line-height: 1.45;',
        'margin-bottom: 6px;',
        'border: 1px solid #c8c8d6;',
        'border-radius: 6px;',
        'background: #fff;'
    ].join('');
}

function rowStyle(selected: boolean): string {
    return [
        'display: block;',
        'width: 100%;',
        'text-align: start;',
        'white-space: normal;',
        'overflow-wrap: break-word;',
        'word-break: normal;',
        'pointer-events: auto;',
        'cursor: pointer;',
        'border: none;',
        'border-bottom: 1px solid #eee;',
        'padding: 8px 10px;',
        'box-sizing: border-box;',
        'font: inherit;',
        `background: ${selected ? '#dbeafe' : 'transparent'};`,
        'color: #2f2f2f;'
    ].join('');
}

let dismissWidget: (() => void) | null = null;

function buildWidget(): void {
    if (dismissWidget) {
        dismissWidget();
        dismissWidget = null;
    }

    const uiWidget = new UIContainer();
    const statusEl = document.createElement('div');
    statusEl.setAttribute('style', [
        'text-align: left;',
        'background: #f5f5fa;',
        'padding: 8px 10px;',
        'margin-bottom: 8px;',
        'border-radius: 8px;',
        'font-family: monospace;',
        'font-size: 14px;',
        'line-height: 1.35;',
        'max-width: 420px;',
        'white-space: normal;',
        'overflow-wrap: break-word;',
        'word-break: normal;',
        'color: #2f2f2f;',
        'box-shadow: rgba(42, 35, 66, 0.2) 0 2px 2px, rgba(45, 35, 66, 0.2) 0 7px 13px -4px;'
    ].join(''));
    statusEl.textContent = DEFAULT_STATUS;
    uiWidget.history.appendChild(statusEl);

    const filterInput = document.createElement('input');
    filterInput.type = 'search';
    filterInput.placeholder = 'Filter groups…';
    filterInput.setAttribute('dir', 'auto');
    filterInput.setAttribute('style', fieldStyle());
    stopBubble(filterInput);
    uiWidget.history.appendChild(filterInput);

    const listEl = document.createElement('div');
    listEl.setAttribute('style', listStyle());
    stopBubble(listEl);
    uiWidget.history.appendChild(listEl);

    const setStatus = (text: string) => {
        statusEl.textContent = text;
    };

    let allGroups: GroupOption[] = [];
    let selectedId = '';

    const renderOptions = () => {
        const filter = filterInput.value;
        const visible = allGroups.filter((g) => groupMatchesFilter(g.name, filter));
        listEl.innerHTML = '';

        if (visible.length === 0) {
            const empty = document.createElement('div');
            empty.setAttribute('dir', 'auto');
            empty.setAttribute('style', [
                'padding: 8px 10px;',
                'color: #666;',
                'white-space: normal;',
                'overflow-wrap: break-word;',
                'word-break: normal;'
            ].join(''));
            empty.textContent = allGroups.length ? 'No matching groups' : 'Choose a group';
            listEl.appendChild(empty);
            return;
        }

        for (const g of visible) {
            const row = document.createElement('button');
            row.type = 'button';
            row.setAttribute('dir', 'auto');
            row.setAttribute('style', rowStyle(g.id === selectedId));
            row.textContent = optionLabel(g);
            stopBubble(row);
            row.addEventListener('click', () => {
                selectedId = g.id;
                renderOptions();
                setStatus(`Selected ${g.name}`);
            });
            listEl.appendChild(row);
        }
    };

    const applySelection = (id: string) => {
        selectedId = id;
        renderOptions();
    };

    filterInput.addEventListener('input', () => {
        renderOptions();
    });

    let exporting = false;
    const runExport = async () => {
        if (exporting) return;
        if (!selectedId) {
            setStatus(DEFAULT_STATUS);
            return;
        }
        exporting = true;
        setStatus('Reading IndexedDB…');
        try {
            const { name, count } = await exportGroupMembers(selectedId);
            setStatus(`Found ${count} members in ${name}`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setStatus(message || 'Export failed');
            console.error(err);
        } finally {
            exporting = false;
        }
    };

    const destroyWidget = () => {
        document.removeEventListener('keydown', onEscapeKey);
        uiWidget.inner.remove();
        if (uiWidget.canva) {
            uiWidget.canva.remove();
        }
        document.querySelectorAll('[data-wa-scraper-widget]').forEach((node) => {
            node.remove();
        });
        if (dismissWidget === destroyWidget) {
            dismissWidget = null;
        }
    };

    const onEscapeKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            destroyWidget();
        }
    };

    const btnExport = createCta();
    btnExport.appendChild(createTextSpan('Export'));
    btnExport.addEventListener('click', () => {
        void runExport();
    });
    uiWidget.addCta(btnExport);

    uiWidget.addCta(createSpacer());

    const btnReset = createCta();
    btnReset.appendChild(createTextSpan('Reset'));
    btnReset.addEventListener('click', () => {
        filterInput.value = '';
        applySelection('');
        setStatus(DEFAULT_STATUS);
    });
    uiWidget.addCta(btnReset);

    uiWidget.addCta(createSpacer());

    const btnClose = createCta();
    btnClose.appendChild(createTextSpan('Close'));
    btnClose.addEventListener('click', () => {
        destroyWidget();
    });
    uiWidget.addCta(btnClose);

    // Do not call makeItDraggable() — it preventDefault()s mousedown on the whole panel
    // and blocks <input>/<button> clicks. Mount a small custom overlay instead of the
    // full-screen pointer-events canvas.
    uiWidget.inner.setAttribute('dir', 'ltr');
    uiWidget.inner.setAttribute('style', overlayChromeStyle());
    uiWidget.inner.setAttribute('data-wa-scraper-widget', '');
    if (uiWidget.canva) {
        uiWidget.canva.setAttribute('data-wa-scraper-widget', '');
    }
    document.body.appendChild(uiWidget.inner);
    document.addEventListener('keydown', onEscapeKey);
    dismissWidget = destroyWidget;

    const loadList = async () => {
        setStatus('Reading IndexedDB…');
        try {
            const { groups, headerTitle } = await loadGroupCatalog();
            allGroups = groups;
            if (groups.length === 0) {
                applySelection('');
                setStatus('No group chats found in model-storage.');
                return;
            }
            const preferred = findPreferredGroup(groups);
            const matched = preferred || matchGroupByTitle(groups, headerTitle);
            if (matched) {
                applySelection(matched.id);
                setStatus(`${groups.length} groups found. Selected ${matched.name}`);
            } else {
                applySelection('');
                setStatus(`${groups.length} groups found. Pick a group to export.`);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setStatus(message || 'Failed to list groups');
            console.error(err);
        }
    };

    void loadList();
}

buildWidget();
