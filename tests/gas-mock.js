/**
 * gas-mock.js
 * ---------------------------------------------------------------------------
 * A small in-memory emulator of the Google Apps Script services used by the
 * project (SpreadsheetApp, Utilities, PropertiesService, CacheService,
 * LockService, UrlFetchApp, ScriptApp, DriveApp, HtmlService ...).
 *
 * It loads every src/*.gs file into one VM context (file by file, in
 * alphabetical order, like Apps Script) so the real server code can be
 * executed and tested with Node.js — no Google account required.
 *
 * Sheets semantics that matter for correctness are emulated:
 *   - cells formatted '@' keep strings; other formats auto-convert strings
 *     that look like numbers/dates (like real Sheets would)
 *   - a leading apostrophe forces text
 *   - getLastRow() ignores trailing empty rows
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');
const RealDate = Date;

function createGasEnv(options = {}) {
  let nowMs = null; // null = real time
  let flowStart = null; // when set, the mock clock advances with real time
  const current = () => (nowMs === null ? RealDate.now() : (flowStart === null ? nowMs : nowMs + (RealDate.now() - flowStart)));
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(current()); else super(...a); }
    static now() { return current(); }
  }

  /* ---------------- Utilities ---------------- */
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  function formatDate(date, tz, pattern) {
    // Asia/Bangkok = UTC+7 without DST
    const offset = tz === 'Asia/Bangkok' ? 7 * 3600000 : 0;
    const d = new RealDate(date.getTime() + offset);
    const map = {
      yyyy: d.getUTCFullYear(), yy: pad(d.getUTCFullYear() % 100), MM: pad(d.getUTCMonth() + 1), M: d.getUTCMonth() + 1,
      dd: pad(d.getUTCDate()), d: d.getUTCDate(), HH: pad(d.getUTCHours()), mm: pad(d.getUTCMinutes()), ss: pad(d.getUTCSeconds()),
      u: d.getUTCDay() === 0 ? 7 : d.getUTCDay()
    };
    return pattern.replace(/yyyy|yy|MM|M|dd|d|HH|mm|ss|u/g, (t) => String(map[t]));
  }
  const Utilities = {
    formatDate,
    getUuid: () => crypto.randomUUID(),
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest(alg, str) {
      const buf = crypto.createHash(alg).update(String(str), 'utf8').digest();
      return Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
    },
    base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
    newBlob: (data, mime, name) => ({ data, mime, name, getName: () => name }),
    sleep: () => {}
  };

  /* ---------------- Spreadsheet ---------------- */
  let idSeq = 0;
  class Sheet {
    constructor(ss, name) { this.ss = ss; this.name = name; this.data = []; this.formats = {}; this.maxRows = 1000; this.maxCols = 26; }
    getName() { return this.name; }
    getLastRow() {
      for (let r = this.data.length - 1; r >= 0; r--) {
        if ((this.data[r] || []).some((v) => v !== '' && v !== null && v !== undefined)) return r + 1;
      }
      return 0;
    }
    getLastColumn() {
      let max = 0;
      this.data.forEach((row) => { (row || []).forEach((v, i) => { if (v !== '' && v !== null && v !== undefined) max = Math.max(max, i + 1); }); });
      return max;
    }
    getMaxRows() { return Math.max(this.maxRows, this.data.length); }
    getMaxColumns() { return this.maxCols; }
    insertColumnsAfter(after, n) { this.maxCols += n; }
    getRange(r, c, nr = 1, nc = 1) {
      if (typeof r === 'string') throw new Error('A1 notation not supported in mock');
      if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error(`Invalid range ${r},${c},${nr},${nc}`);
      return new Range(this, r, c, nr, nc);
    }
    deleteRows(start, n) { this.data.splice(start - 1, n); }
    setFrozenRows() {}
    cell(r, c) { const row = this.data[r - 1]; return row ? (row[c - 1] === undefined ? '' : row[c - 1]) : ''; }
    setCell(r, c, v) {
      while (this.data.length < r) this.data.push([]);
      const row = this.data[r - 1];
      while (row.length < c) row.push('');
      row[c - 1] = v;
      if (c > this.maxCols) this.maxCols = c;
    }
  }
  function convertForFormat(v, fmt) {
    if (typeof v === 'string') {
      if (v.startsWith("'")) return v.substring(1);
      if (v.startsWith('=')) throw new Error('Formula written to sheet: ' + v);
      if (fmt === '@') return v;
      if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
      if (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(v)) return new FakeDate(v.replace(' ', 'T') + '+07:00');
      if (/^\d{1,2}:\d{2}$/.test(v)) return new FakeDate('1899-12-30T' + v.padStart(5, '0') + ':00+07:00');
      if (v === 'TRUE') return true;
      if (v === 'FALSE') return false;
    }
    return v;
  }
  class Range {
    constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
    getRow() { return this.r; }
    getValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = [];
        for (let j = 0; j < this.nc; j++) row.push(this.sheet.cell(this.r + i, this.c + j));
        out.push(row);
      }
      return out;
    }
    setValues(values) {
      if (values.length !== this.nr || values.some((row) => row.length !== this.nc)) {
        throw new Error(`setValues dimension mismatch: range ${this.nr}x${this.nc}, data ${values.length}x${values[0] && values[0].length}`);
      }
      values.forEach((row, i) => row.forEach((v, j) => {
        const fmt = this.sheet.formats[(this.r + i) + ':' + (this.c + j)] || this.sheet.formats['col:' + (this.c + j)] || '';
        this.sheet.setCell(this.r + i, this.c + j, convertForFormat(v, fmt));
      }));
      return this;
    }
    setNumberFormat(f) {
      for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.formats[(this.r + i) + ':' + (this.c + j)] = f;
      return this;
    }
    setNumberFormats(fs2) {
      fs2.forEach((row, i) => row.forEach((f, j) => { this.sheet.formats[(this.r + i) + ':' + (this.c + j)] = f; }));
      return this;
    }
    setFontWeight() { return this; }
    setBackground() { return this; }
    setFontColor() { return this; }
    createTextFinder(text) {
      const self = this;
      let entire = false;
      const tf = {
        matchEntireCell(b) { entire = b; return tf; },
        matchCase() { return tf; },
        findAll() {
          const res = [];
          for (let i = 0; i < self.nr; i++) for (let j = 0; j < self.nc; j++) {
            const v = self.sheet.cell(self.r + i, self.c + j);
            const s = v instanceof RealDate ? formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd') : String(v);
            if (entire ? s === text : s.includes(text)) res.push(new Range(self.sheet, self.r + i, self.c + j, 1, 1));
          }
          return res;
        }
      };
      return tf;
    }
  }
  class Spreadsheet {
    constructor(name) { this.id = 'ss_' + (++idSeq); this.name = name; this.sheets = [new Sheet(this, 'Sheet1')]; }
    getId() { return this.id; }
    getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
    getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
    getSheets() { return this.sheets.slice(); }
    insertSheet(n) { const s = new Sheet(this, n); this.sheets.push(s); return s; }
    deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
    setSpreadsheetTimeZone() {}
  }
  const spreadsheets = {};
  const db = new Spreadsheet('DB');
  spreadsheets[db.id] = db;
  const SpreadsheetApp = {
    openById: (id) => { if (!spreadsheets[id]) throw new Error('Spreadsheet not found ' + id); return spreadsheets[id]; },
    getActiveSpreadsheet: () => db,
    create: (name) => { const s = new Spreadsheet(name); spreadsheets[s.id] = s; return s; },
    flush: () => {},
    getUi: () => { throw new Error('No UI'); }
  };

  /* ---------------- Properties / Cache / Lock ---------------- */
  const props = Object.assign({}, options.props || {});
  const scriptProps = {
    getProperty: (k) => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = String(v); return scriptProps; },
    deleteProperty: (k) => { delete props[k]; return scriptProps; },
    getKeys: () => Object.keys(props),
    getProperties: () => Object.assign({}, props)
  };
  const PropertiesService = { getScriptProperties: () => scriptProps };
  const cache = {};
  const scriptCache = {
    get: (k) => { const e = cache[k]; if (!e) return null; if (e.exp < FakeDate.now()) { delete cache[k]; return null; } return e.v; },
    put: (k, v, ttl = 600) => { if (String(v).length > 100000) throw new Error('cache value too large'); cache[k] = { v: String(v), exp: FakeDate.now() + ttl * 1000 }; },
    remove: (k) => { delete cache[k]; }
  };
  const CacheService = { getScriptCache: () => scriptCache };
  const lockState = { held: false, count: 0, failNext: false };
  const LockService = {
    getScriptLock: () => ({
      tryLock: () => {
        if (lockState.failNext) { lockState.failNext = false; return false; }
        if (lockState.held) throw new Error('Nested lock acquisition detected');
        lockState.held = true; lockState.count++; return true;
      },
      waitLock: () => { lockState.held = true; },
      releaseLock: () => { lockState.held = false; }
    })
  };

  /* ---------------- UrlFetch (LINE) ---------------- */
  const fetchLog = [];
  const fetchBehaviour = { mode: 'ok' }; // ok | fail | error
  const UrlFetchApp = {
    fetch: (url, opts) => {
      fetchLog.push({ url, opts, body: opts && opts.payload ? JSON.parse(opts.payload) : null });
      if (fetchBehaviour.mode === 'error') throw new Error('Network error');
      const code = fetchBehaviour.mode === 'fail' ? 500 : 200;
      return { getResponseCode: () => code, getContentText: () => (code === 200 ? '{}' : '{"message":"server error"}') };
    }
  };

  /* ---------------- ScriptApp ---------------- */
  let triggers = [];
  const ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (t) => { triggers = triggers.filter((x) => x !== t); },
    newTrigger: (handler) => {
      const b = {
        timeBased: () => b, everyMinutes: () => b, everyDays: () => b, atHour: () => b, nearMinute: () => b, inTimezone: () => b,
        create: () => { const id = 't' + triggers.length + Math.random(); const t = { getHandlerFunction: () => handler, getUniqueId: () => id }; triggers.push(t); return t; }
      };
      return b;
    },
    getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/MOCK/exec' })
  };

  /* ---------------- DriveApp ---------------- */
  let fileSeq = 0;
  function makeIter(arr) { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; }
  class File {
    constructor(name) { this.id = 'file_' + (++fileSeq); this.name = name; this.created = new FakeDate(); }
    getId() { return this.id; }
    getName() { return this.name; }
    getUrl() { return 'https://drive.google.com/file/d/' + this.id; }
    getDateCreated() { return this.created; }
    getSize() { return 1024; }
    setSharing() {}
    setTrashed(b) { this.trashed = b; }
    makeCopy(name, folder) { const f = new File(name); folder.files.push(f); return f; }
    moveTo(folder) { folder.files.push(this); }
  }
  class Folder {
    constructor(name) { this.id = 'folder_' + (++fileSeq); this.name = name; this.folders = []; this.files = []; }
    getId() { return this.id; }
    getName() { return this.name; }
    getUrl() { return 'https://drive.google.com/drive/folders/' + this.id; }
    getFoldersByName(n) { return makeIter(this.folders.filter((f) => f.name === n)); }
    getFolders() { return makeIter(this.folders.slice()); }
    getFiles() { return makeIter(this.files.filter((f) => !f.trashed)); }
    createFolder(n) { const f = new Folder(n); this.folders.push(f); allFolders.push(f); return f; }
    createFile(blob) { const f = new File(blob.name || blob.getName()); this.files.push(f); return f; }
  }
  const root = new Folder('root');
  const allFolders = [root];
  const DriveApp = {
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
    Permission: { VIEW: 'VIEW' },
    getFileById: (id) => new File('copy-of-' + id),
    getFolderById: (id) => { const f = allFolders.find((x) => x.id === id); if (!f) throw new Error('no folder'); return f; },
    getFoldersByName: (n) => root.getFoldersByName(n),
    createFolder: (n) => root.createFolder(n)
  };

  /* ---------------- HtmlService ---------------- */
  function readHtml(name) { return fs.readFileSync(path.join(SRC, name + '.html'), 'utf8'); }
  const HtmlService = {
    XFrameOptionsMode: { DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL' },
    createHtmlOutputFromFile: (name) => ({ getContent: () => readHtml(name) }),
    createTemplateFromFile: (name) => {
      const tpl = { vars: {} };
      const proxy = new Proxy(tpl, {
        set(t, k, v) { t.vars[k] = v; return true; },
        get(t, k) {
          if (k === 'evaluate') {
            return () => {
              let html = readHtml(name);
              html = html.replace(/<\?!=\s*include\('([\w-]+)'\)\s*;?\s*\?>/g, (m, f) => readHtml(f));
              html = html.replace(/<\?=\s*([\w]+)\s*;?\s*\?>/g, (m, v) => String(t.vars[v] === undefined ? '' : t.vars[v])
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
              const out = {
                html, setTitle: () => out, addMetaTag: () => out, setFaviconUrl: () => out, setXFrameOptionsMode: () => out,
                getContent: () => html
              };
              return out;
            };
          }
          return t.vars[k];
        }
      });
      return proxy;
    }
  };
  const ContentService = {
    MimeType: { JSON: 'json' },
    createTextOutput: (s) => { const o = { s, setMimeType: () => o, getContent: () => s }; return o; }
  };
  const logs = [];
  const Logger = { log: (m) => { logs.push(String(m)); if (options.verbose) console.log('[Logger]', m); } };

  const context = vm.createContext({
    Date: FakeDate, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, TypeError, isNaN, isFinite, parseInt, parseFloat,
    Proxy, Buffer,
    console: options.quiet ? { log() {}, error() {}, warn() {} } : console,
    Utilities, SpreadsheetApp, PropertiesService, CacheService, LockService, UrlFetchApp, ScriptApp, DriveApp,
    HtmlService, ContentService, Logger
  });
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort();
  files.forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), context, { filename: f });
  });

  return {
    ctx: context,
    db,
    props,
    cache,
    logs,
    fetchLog,
    fetchBehaviour,
    lockState,
    triggers: () => triggers,
    root,
    /** Sets the mock clock to a Bangkok local time "yyyy-MM-dd HH:mm[:ss]" (or null for real time). */
    setNow(local, flowing) {
      nowMs = local === null ? null : new RealDate(local.replace(' ', 'T') + (local.length === 16 ? ':00' : '') + '+07:00').getTime();
      flowStart = flowing ? RealDate.now() : null;
    },
    /** Overrides 01_CONFIG values (after setupDatabase) and clears the config cache. */
    setConfig(values) {
      const sh = db.getSheetByName('01_CONFIG');
      Object.keys(values).forEach((k) => {
        const row = sh.data.find((r, i) => i > 0 && r[0] === k);
        if (row) row[1] = String(values[k]); else sh.data.push([k, String(values[k]), '', '', '']);
      });
      delete cache.cfg_v1;
      vm.runInContext('CONFIG_MEMO = null;', context);
    },
    /** Resets per-execution memory (simulates a new Apps Script execution). */
    newExecution() {
      vm.runInContext('DB_STATE.memo = {}; DB_STATE.sheets = {}; DB_STATE.headers = {}; DB_STATE.ss = null; CONFIG_MEMO = null; REQUEST_CTX.user = null;', context);
    },
    /** Calls the public API as the web client would (fresh execution each time). */
    api(action, payload, token) {
      this.newExecution();
      return JSON.parse(JSON.stringify(context.api(action, payload, token)));
    },
    sheetRows(name) { const s = db.getSheetByName(name); return s ? s.data.slice(1).filter((r) => r.some((v) => v !== '')) : []; },
    sheetHeader(name) { const s = db.getSheetByName(name); return s ? s.data[0] : []; }
  };
}

module.exports = { createGasEnv };
