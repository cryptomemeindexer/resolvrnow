/**
 * JavaScript evaluated inside every sandbox context before a user script runs.
 *
 * It implements the server-side scripting API (GlideRecord, GlideElement, GlideAggregate,
 * gs, GlideDateTime, GlideDuration, Class...) on top of one host bridge function that
 * exchanges JSON strings with the platform. The host stays authoritative for record data:
 * the sandbox only holds handles to host-side cursors.
 *
 * Written as plain ES2020 inside a raw string: it must not contain backticks or
 * template placeholders. The completion value is the { setup, finish, errinfo } object the
 * worker keeps privately; nothing here is reachable from user code except the public API.
 */
export const PRELUDE = String.raw`
(function (host, globalEval) {
  'use strict';
  var G = globalThis;
  delete G.__host;

  var JSONparse = JSON.parse;
  var JSONstringify = JSON.stringify;
  var defineProp = Object.defineProperty;
  var createObj = Object.create;
  var objectKeys = Object.keys;
  var getOwnDesc = Object.getOwnPropertyDescriptor;
  var hasOwn = Object.prototype.hasOwnProperty;
  var isArray = Array.isArray;
  var ProxyCtor = Proxy;
  var reflectConstruct = Reflect.construct;
  var RealDate = Date;
  var DAY = 86400000;

  var env = { user: { id: null, name: 'system', display: 'System' }, offset: 0, readOnly: false };
  var liveCurrent = null;

  // ------------------------------------------------------------------ bridge

  function call(fn, args) {
    var raw = host(fn, JSONstringify(args || []));
    var r = JSONparse(raw);
    if (!r.ok) {
      var err = new Error(r.e);
      if (r.n) err.name = r.n;
      throw err;
    }
    return r.v === undefined ? null : r.v;
  }

  function hidden(o, k, v) {
    defineProp(o, k, { value: v, writable: true, configurable: true, enumerable: false });
  }

  function str(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  /** Converts a script value to something the host can store (string, number, boolean or null). */
  function plain(v) {
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === 'string' || t === 'boolean') return v;
    if (t === 'number') return isFinite(v) ? v : null;
    if (v instanceof GlideElement) {
      var s = v.toString();
      return s === '' ? null : s;
    }
    if (v instanceof GlideRecord) return v.getUniqueValue();
    if (v instanceof GlideDateTime || v instanceof GlideDate) return v.getValue();
    if (v instanceof GlideDuration) return v.getNumericValue();
    if (isArray(v)) return v.map(function (x) { return str(plain(x)); }).join(',');
    return String(v);
  }

  var FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  var PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

  function fieldName(f) {
    var s = str(f);
    if (!FIELD_RE.test(s)) throw new Error('Invalid field name: ' + s);
    return s;
  }

  function fieldPath(f) {
    var s = str(f);
    if (!PATH_RE.test(s)) throw new Error('Invalid field name: ' + s);
    return s;
  }

  var metaCache = {};
  function meta(table) {
    var key = str(table);
    var m = metaCache[key];
    if (!m) {
      m = call('meta', [key]);
      metaCache[key] = m;
    }
    return m;
  }

  // ------------------------------------------------------------- query terms

  var OPS = {
    '=': 1, '!=': 1, '>': 1, '>=': 1, '<': 1, '<=': 1, 'IN': 1, 'NOT IN': 1, 'STARTSWITH': 1, 'ENDSWITH': 1,
    'LIKE': 1, 'NOT LIKE': 1, 'INSTANCEOF': 1, 'SAMEAS': 1, 'NSAMEAS': 1, 'ISEMPTY': 1, 'ISNOTEMPTY': 1,
    'BETWEEN': 1, 'ANYTHING': 1, 'EMPTYSTRING': 1, 'DYNAMIC': 1, 'MORETHAN': 1, 'LESSTHAN': 1, 'GT_FIELD': 1,
    'LT_FIELD': 1, 'GT_OR_EQUALS_FIELD': 1, 'LT_OR_EQUALS_FIELD': 1, 'ON': 1, 'NOTON': 1, 'VALCHANGES': 1,
    'CHANGESFROM': 1, 'CHANGESTO': 1,
    'CONTAINS': 'LIKE', 'DOES NOT CONTAIN': 'NOT LIKE', 'NOTLIKE': 'NOT LIKE', 'NOTIN': 'NOT IN', '==': '=', '<>': '!='
  };
  var NO_VALUE_OPS = { 'ISEMPTY': 1, 'ISNOTEMPTY': 1, 'ANYTHING': 1, 'EMPTYSTRING': 1, 'VALCHANGES': 1 };

  function operator(o) {
    var k = str(o).trim().toUpperCase();
    var m = OPS[k];
    if (!m) throw new Error('Invalid query operator: ' + str(o));
    return m === 1 ? k : m;
  }

  function encodeValue(v) {
    if (isArray(v)) v = v.map(function (x) { return str(plain(x)); }).join(',');
    var p = plain(v);
    if (typeof p === 'boolean') p = p ? 'true' : 'false';
    return str(p).replace(/\^/g, '^^');
  }

  function term(f, op, v, n) {
    if (n === 2) return fieldPath(f) + '=' + encodeValue(op);
    var o = operator(op);
    return fieldPath(f) + o + (NO_VALUE_OPS[o] ? '' : encodeValue(v));
  }

  function QueryCondition(owner, index) {
    hidden(this, '_o', owner);
    hidden(this, '_i', index);
  }
  QueryCondition.prototype.addOrCondition = function (f, op, v) {
    var t = arguments.length === 1 ? str(f) : term(f, op, v, arguments.length);
    this._o._q[this._i] = this._o._q[this._i] + '^OR' + t;
    return this;
  };
  QueryCondition.prototype.addCondition = function () {
    return this._o.addQuery.apply(this._o, arguments);
  };

  /** Query-building methods shared by GlideRecord and GlideAggregate. */
  var queryMethods = {
    addQuery: function (f, op, v) {
      var n = arguments.length;
      if (n === 1) {
        this.addEncodedQuery(f);
        return new QueryCondition(this, this._q.length - 1);
      }
      this._q.push(term(f, op, v, n));
      return new QueryCondition(this, this._q.length - 1);
    },
    addEncodedQuery: function (q) {
      var s = str(q).trim();
      if (s) this._q.push(s);
    },
    addNullQuery: function (f) {
      this._q.push(fieldPath(f) + 'ISEMPTY');
      return new QueryCondition(this, this._q.length - 1);
    },
    addNotNullQuery: function (f) {
      this._q.push(fieldPath(f) + 'ISNOTEMPTY');
      return new QueryCondition(this, this._q.length - 1);
    },
    addActiveQuery: function () {
      this._q.push('active=true');
      return new QueryCondition(this, this._q.length - 1);
    },
    addInactiveQuery: function () {
      this._q.push('active=false');
      return new QueryCondition(this, this._q.length - 1);
    },
    orderBy: function (f) { this._o.push([fieldPath(f), false]); },
    orderByDesc: function (f) { this._o.push([fieldPath(f), true]); },
    setLimit: function (n) { this._l = Math.max(0, Math.floor(Number(n) || 0)); },
    setWorkflow: function (b) { this._wf = !(b === false || b === 'false'); },
    getEncodedQuery: function () { return this._q.join('^'); },
    getTableName: function () { return this._t; },
    isValid: function () { return this._valid; }
  };

  function flag(b) {
    return !(b === false || b === 'false' || b === 0 || b === null || b === undefined);
  }

  // ------------------------------------------------------------ GlideElement

  function GlideElement(gr, path, fm) {
    hidden(this, '_g', gr);
    hidden(this, '_p', path);
    hidden(this, '_m', fm);
    if (fm[0] === 'reference' && fm[1]) return new ProxyCtor(this, elementHandler);
  }

  var elementHandler = {
    get: function (t, p) {
      if (typeof p === 'symbol' || p in t) return t[p];
      var f = meta(t._m[1]).f[p];
      return f ? new GlideElement(t._g, t._p + '.' + p, f) : undefined;
    },
    set: function (t, p, v) {
      if (typeof p === 'symbol' || p in t) {
        t[p] = v;
        return true;
      }
      throw new Error('Cannot assign dot-walked field ' + t._p + '.' + String(p));
    }
  };

  GlideElement.prototype = {
    constructor: GlideElement,
    toString: function () { return call('gr.getv', [this._g._h, this._p, 'str']); },
    valueOf: function () {
      var s = this.toString();
      return this._m[0] === 'boolean' ? s === 'true' : s;
    },
    toJSON: function () { return this.toString(); },
    getValue: function () { return call('gr.getv', [this._g._h, this._p, 'raw']); },
    getDisplayValue: function () { return call('gr.disp', [this._g._h, this._p]); },
    getChoiceValue: function () { return this.getDisplayValue(); },
    getBooleanValue: function () { return this.toString() === 'true'; },
    setValue: function (v) { this._g.setValue(this._p, v); },
    setDisplayValue: function (v) { this._g.setDisplayValue(this._p, v); },
    changes: function () { return call('gr.chg', [this._g._h, this._p, 'any', null]); },
    changesTo: function (v) { return call('gr.chg', [this._g._h, this._p, 'to', plain(v)]); },
    changesFrom: function (v) { return call('gr.chg', [this._g._h, this._p, 'from', plain(v)]); },
    nil: function () {
      var r = this.getValue();
      return r === null || r === '';
    },
    getRefRecord: function () {
      var r = call('gr.ref', [this._g._h, this._p]);
      return wrapRecord(r.t, r.h, this._g._secure, r.tv);
    },
    getReferenceTable: function () { return this._m[1] || null; },
    getName: function () { return this._p.slice(this._p.lastIndexOf('.') + 1); },
    getTableName: function () { return this._g._t; },
    getLabel: function () { return this._m[2]; },
    getED: function () {
      var self = this;
      return {
        getLabel: function () { return self._m[2]; },
        getName: function () { return self.getName(); },
        getInternalType: function () { return self._m[0]; }
      };
    },
    getJournalEntry: function (n) {
      return call('gr.journal', [this._g._h, this._p, n === undefined ? 1 : Number(n)]);
    },
    getGlideObject: function () {
      var v = this.getValue();
      var type = this._m[0];
      if (type === 'glide_duration') return new GlideDuration(v);
      if (type === 'glide_date') return new GlideDate(v);
      return new GlideDateTime(v === null ? '' : v);
    },
    dateNumericValue: function () {
      var v = this.getValue();
      return v ? parseUtc(v) : 0;
    }
  };

  function elementFor(gr, path) {
    var parts = path.split('.');
    var table = gr._t;
    var fm = null;
    for (var i = 0; i < parts.length; i++) {
      fm = meta(table).f[parts[i]];
      if (!fm) return null;
      if (i < parts.length - 1) {
        if (fm[0] !== 'reference' || !fm[1]) return null;
        table = fm[1];
      }
    }
    return new GlideElement(gr, path, fm);
  }

  // ------------------------------------------------------------- GlideRecord

  var recordHandler = {
    get: function (t, p) {
      if (typeof p === 'symbol' || p in t) return t[p];
      var f = meta(t._t).f[p];
      return f ? new GlideElement(t, p, f) : undefined;
    },
    set: function (t, p, v) {
      if (typeof p !== 'symbol' && !(p in t) && meta(t._t).f[p]) {
        t.setValue(p, v);
        return true;
      }
      t[p] = v;
      return true;
    }
  };

  function initRecord(o, table, h, secure, valid) {
    hidden(o, '_t', table);
    hidden(o, '_h', h);
    hidden(o, '_secure', !!secure);
    hidden(o, '_valid', valid !== false);
    hidden(o, '_q', []);
    hidden(o, '_o', []);
    hidden(o, '_l', null);
    hidden(o, '_s', null);
    hidden(o, '_wf', true);
    hidden(o, '_asf', true);
    hidden(o, '_n', 0);
    hidden(o, '_live', false);
    return new ProxyCtor(o, recordHandler);
  }

  function GlideRecord(table) {
    if (!(this instanceof GlideRecord)) throw new TypeError('GlideRecord must be called with new');
    var t = str(table);
    var r = call('gr.new', [t, false]);
    return initRecord(this, t, r.h, false, r.v);
  }

  function GlideRecordSecure(table) {
    if (!(this instanceof GlideRecordSecure)) throw new TypeError('GlideRecordSecure must be called with new');
    var t = str(table);
    var r = call('gr.new', [t, true]);
    return initRecord(this, t, r.h, true, r.v);
  }

  function wrapRecord(table, h, secure, valid) {
    var o = createObj(secure ? GlideRecordSecure.prototype : GlideRecord.prototype);
    return initRecord(o, table, h, secure, valid);
  }

  GlideRecord.prototype = {
    constructor: GlideRecord,
    _spec: function () { return { q: this._q, o: this._o, l: this._l, s: this._s, w: this._wf }; },
    _opts: function () { return { w: this._wf, a: this._asf }; },
    chooseWindow: function (first, last) {
      var f = Math.max(0, Math.floor(Number(first) || 0));
      var l = Math.max(f, Math.floor(Number(last) || 0));
      this._s = f;
      this._l = l - f;
    },
    autoSysFields: function (b) { this._asf = flag(b); },
    setAbortAction: function (b) { call('gr.abort', [this._h, flag(b)]); },
    isActionAborted: function () { return call('gr.aborted', [this._h]); },
    query: function (f, v) {
      if (arguments.length === 2) this.addQuery(f, v);
      if (this._live) return;
      this._n = call('gr.query', [this._h, this._spec()]);
    },
    _query: function () { this.query(); },
    next: function () { return call('gr.next', [this._h]); },
    _next: function () { return this.next(); },
    hasNext: function () { return call('gr.hasNext', [this._h]); },
    get: function (a, b) {
      var two = arguments.length > 1;
      var found = call('gr.get', [this._h, two ? fieldPath(a) : str(plain(a)), two ? plain(b) : null, two, this._wf]);
      this._n = found ? 1 : 0;
      return found;
    },
    getRowCount: function () { return this._n; },
    getValue: function (f) { return call('gr.getv', [this._h, fieldPath(f), 'raw']); },
    getDisplayValue: function (f) {
      return call('gr.disp', [this._h, f === undefined || f === null ? null : fieldPath(f)]);
    },
    getElement: function (f) { return elementFor(this, fieldPath(f)); },
    getFields: function () {
      var self = this;
      var m = meta(this._t);
      return objectKeys(m.f).map(function (k) { return new GlideElement(self, k, m.f[k]); });
    },
    setValue: function (f, v) { call('gr.set', [this._h, fieldName(f), plain(v), false]); },
    setDisplayValue: function (f, v) { call('gr.set', [this._h, fieldName(f), str(plain(v)), true]); },
    setNewGuidValue: function (id) { call('gr.set', [this._h, 'sys_id', str(id), false]); },
    getUniqueValue: function () { return call('gr.info', [this._h]).id; },
    getRecordClassName: function () { return call('gr.info', [this._h]).c; },
    getClassDisplayValue: function () { return meta(this._t).l; },
    getLabel: function () { return meta(this._t).l; },
    isNewRecord: function () { return call('gr.info', [this._h]).n; },
    isValidField: function (f) { return !!meta(this._t).f[str(f)]; },
    isValidRecord: function () { return call('gr.info', [this._h]).v; },
    operation: function () { return call('gr.info', [this._h]).op; },
    canRead: function () { return call('gr.can', [this._h, 'read']); },
    canWrite: function () { return call('gr.can', [this._h, 'write']); },
    canCreate: function () { return call('gr.can', [this._h, 'create']); },
    canDelete: function () { return call('gr.can', [this._h, 'delete']); },
    initialize: function () { call('gr.init', [this._h]); },
    newRecord: function () { call('gr.init', [this._h]); },
    insert: function () { return call('gr.ins', [this._h, this._opts()]); },
    update: function () { return call('gr.upd', [this._h, this._opts()]); },
    deleteRecord: function () { return call('gr.del', [this._h, this._opts()]); },
    updateMultiple: function () { return call('gr.updm', [this._h, this._spec(), this._opts()]); },
    deleteMultiple: function () { return call('gr.delm', [this._h, this._spec(), this._opts()]); },
    changes: function () { return call('gr.chg', [this._h, null, 'any', null]); },
    getLastErrorMessage: function () { return call('gr.err', [this._h]); },
    getLink: function () {
      var id = this.getUniqueValue();
      return id ? '/workspace/record/' + this._t + '/' + id : '';
    },
    toString: function () { return '[object GlideRecord]'; }
  };
  objectKeys(queryMethods).forEach(function (k) { GlideRecord.prototype[k] = queryMethods[k]; });

  GlideRecordSecure.prototype = createObj(GlideRecord.prototype);
  GlideRecordSecure.prototype.constructor = GlideRecordSecure;

  // ---------------------------------------------------------- GlideAggregate

  var AGGREGATES = { COUNT: 1, SUM: 1, AVG: 1, MIN: 1, MAX: 1 };

  function aggregateName(fn) {
    var f = str(fn).trim().toUpperCase();
    if (!AGGREGATES[f]) throw new Error('Invalid aggregate: ' + str(fn));
    return f;
  }

  function groupElement(pair) {
    return {
      toString: function () { return pair ? str(pair[0]) : ''; },
      valueOf: function () { return pair ? str(pair[0]) : ''; },
      toJSON: function () { return pair ? str(pair[0]) : ''; },
      getValue: function () { return pair ? pair[0] : null; },
      getDisplayValue: function () { return pair ? str(pair[1]) : ''; },
      nil: function () { return !pair || pair[0] === '' || pair[0] === null; }
    };
  }

  var aggregateHandler = {
    get: function (t, p) {
      if (typeof p === 'symbol' || p in t) return t[p];
      var row = t._rows[t._i];
      if (row && hasOwn.call(row.g, p)) return groupElement(row.g[p]);
      return meta(t._t).f[p] ? groupElement(null) : undefined;
    }
  };

  function GlideAggregate(table) {
    if (!(this instanceof GlideAggregate)) throw new TypeError('GlideAggregate must be called with new');
    var t = str(table);
    hidden(this, '_t', t);
    hidden(this, '_valid', meta(t).v);
    hidden(this, '_q', []);
    hidden(this, '_o', []);
    hidden(this, '_l', null);
    hidden(this, '_wf', true);
    hidden(this, '_aggs', []);
    hidden(this, '_grp', []);
    hidden(this, '_hav', []);
    hidden(this, '_oa', []);
    hidden(this, '_rows', []);
    hidden(this, '_i', -1);
    return new ProxyCtor(this, aggregateHandler);
  }

  GlideAggregate.prototype = {
    constructor: GlideAggregate,
    addAggregate: function (fn, field) {
      this._aggs.push([aggregateName(fn), field ? fieldPath(field) : null]);
    },
    groupBy: function (f) { this._grp.push(fieldPath(f)); },
    setGroup: function (b) { if (!flag(b)) this._grp = []; },
    addHaving: function (fn, field, op, value) {
      var o = str(op).trim();
      if (!/^(>|<|=|>=|<=|!=)$/.test(o)) throw new Error('Invalid having operator: ' + o);
      this._hav.push([aggregateName(fn), field ? fieldPath(field) : null, o, Number(value)]);
    },
    orderByAggregate: function (fn, field) {
      this._oa.push([aggregateName(fn), field ? fieldPath(field) : null, true]);
    },
    query: function () {
      this._rows = call('ga.run', [this._t, {
        q: this._q, o: this._o, l: this._l, w: this._wf, grp: this._grp, aggs: this._aggs, hav: this._hav, oa: this._oa
      }]) || [];
      this._i = -1;
    },
    next: function () {
      if (this._i + 1 < this._rows.length) {
        this._i++;
        return true;
      }
      this._i = this._rows.length;
      return false;
    },
    hasNext: function () { return this._i + 1 < this._rows.length; },
    getRowCount: function () { return this._rows.length; },
    getAggregate: function (fn, field) {
      var row = this._rows[this._i];
      if (!row) return null;
      var f = aggregateName(fn);
      var v = field ? row.a[f + '.' + str(field)] : f === 'COUNT' ? row.c : row.a[f];
      return v === null || v === undefined ? null : String(v);
    },
    getValue: function (f) {
      var row = this._rows[this._i];
      var g = row ? row.g[str(f)] : null;
      return g ? g[0] : null;
    },
    getDisplayValue: function (f) {
      var row = this._rows[this._i];
      var g = row ? row.g[str(f)] : null;
      return g ? str(g[1]) : '';
    },
    toString: function () { return '[object GlideAggregate]'; }
  };
  objectKeys(queryMethods).forEach(function (k) { GlideAggregate.prototype[k] = queryMethods[k]; });

  // ------------------------------------------------------- dates, durations

  function pad(n, w) {
    var s = String(n);
    while (s.length < (w || 2)) s = '0' + s;
    return s;
  }

  function formatUtc(ms) {
    var d = new RealDate(ms);
    return pad(d.getUTCFullYear(), 4) + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' +
      pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
  }

  function parseUtc(v) {
    var s = str(v).trim();
    if (!s) return NaN;
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?Z?$/.exec(s);
    if (m) return RealDate.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    var t = RealDate.parse(s);
    return isNaN(t) ? NaN : t;
  }

  function nowMs() {
    return RealDate.now() + env.offset;
  }

  function addMonthsMs(ms, n) {
    var d = new RealDate(ms);
    var total = d.getUTCMonth() + Math.trunc(Number(n) || 0);
    var y = d.getUTCFullYear() + Math.floor(total / 12);
    var mo = ((total % 12) + 12) % 12;
    var dim = new RealDate(RealDate.UTC(y, mo + 1, 0)).getUTCDate();
    return RealDate.UTC(y, mo, Math.min(d.getUTCDate(), dim), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  }

  function toMs(o) {
    if (o instanceof GlideDateTime || o instanceof GlideDate) return o._ms;
    if (typeof o === 'number') return o;
    return parseUtc(str(plain(o)));
  }

  function GlideDateTime(v) {
    if (!(this instanceof GlideDateTime)) return new GlideDateTime(v);
    var ms;
    if (v === undefined) ms = Math.floor(nowMs() / 1000) * 1000;
    else if (v instanceof GlideDateTime || v instanceof GlideDate) ms = v._ms;
    else if (typeof v === 'number') ms = v;
    else ms = parseUtc(str(plain(v)));
    hidden(this, '_ms', ms);
  }

  GlideDateTime.prototype = {
    constructor: GlideDateTime,
    getValue: function () { return isNaN(this._ms) ? '' : formatUtc(this._ms); },
    getDisplayValue: function () { return isNaN(this._ms) ? '' : call('gs.tz', ['disp', this.getValue()]); },
    getDisplayValueInternal: function () { return this.getDisplayValue(); },
    setValue: function (v) { this._ms = toMs(v); },
    setValueUTC: function (v) { this._ms = toMs(v); },
    setDisplayValue: function (v) { this._ms = parseUtc(call('gs.tz', ['parse', str(plain(v))])); },
    getNumericValue: function () { return this._ms; },
    setNumericValue: function (n) { this._ms = Number(n); },
    addSeconds: function (n) { this._ms += (Number(n) || 0) * 1000; },
    add: function (v) { this._ms += v instanceof GlideDuration ? v._ms : Number(v) || 0; },
    subtract: function (v) { this._ms -= v instanceof GlideDuration ? v._ms : Number(v) || 0; },
    addDaysUTC: function (n) { this._ms += (Number(n) || 0) * DAY; },
    addWeeksUTC: function (n) { this._ms += (Number(n) || 0) * 7 * DAY; },
    addMonthsUTC: function (n) { this._ms = addMonthsMs(this._ms, n); },
    addYearsUTC: function (n) { this._ms = addMonthsMs(this._ms, (Number(n) || 0) * 12); },
    compareTo: function (o) {
      var b = toMs(o);
      return this._ms < b ? -1 : this._ms > b ? 1 : 0;
    },
    before: function (o) { return this._ms < toMs(o); },
    after: function (o) { return this._ms > toMs(o); },
    equals: function (o) { return this._ms === toMs(o); },
    onOrBefore: function (o) { return this._ms <= toMs(o); },
    onOrAfter: function (o) { return this._ms >= toMs(o); },
    getDate: function () { return new GlideDate(this.getValue().slice(0, 10)); },
    getLocalDate: function () { return this.getDate(); },
    getDayOfWeekUTC: function () {
      var d = new RealDate(this._ms).getUTCDay();
      return d === 0 ? 7 : d;
    },
    getDayOfMonthUTC: function () { return new RealDate(this._ms).getUTCDate(); },
    getMonthUTC: function () { return new RealDate(this._ms).getUTCMonth() + 1; },
    getYearUTC: function () { return new RealDate(this._ms).getUTCFullYear(); },
    getDaysInMonthUTC: function () {
      var d = new RealDate(this._ms);
      return new RealDate(RealDate.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    },
    isValid: function () { return !isNaN(this._ms); },
    toString: function () { return this.getValue(); },
    toJSON: function () { return this.getValue(); }
  };
  ['addDays', 'addWeeks', 'addMonths', 'addYears'].forEach(function (k) {
    GlideDateTime.prototype[k] = GlideDateTime.prototype[k + 'UTC'];
    GlideDateTime.prototype[k + 'LocalTime'] = GlideDateTime.prototype[k + 'UTC'];
  });
  ['getDayOfWeek', 'getDayOfMonth', 'getMonth', 'getYear', 'getDaysInMonth'].forEach(function (k) {
    GlideDateTime.prototype[k] = GlideDateTime.prototype[k + 'UTC'];
    GlideDateTime.prototype[k + 'LocalTime'] = GlideDateTime.prototype[k + 'UTC'];
  });
  GlideDateTime.subtract = function (a, b) { return new GlideDuration(toMs(b) - toMs(a)); };

  function GlideDate(v) {
    if (!(this instanceof GlideDate)) return new GlideDate(v);
    var ms = v === undefined ? nowMs() : toMs(v);
    hidden(this, '_ms', isNaN(ms) ? NaN : Math.floor(ms / DAY) * DAY);
  }
  GlideDate.prototype = {
    constructor: GlideDate,
    getValue: function () { return isNaN(this._ms) ? '' : formatUtc(this._ms).slice(0, 10); },
    getDisplayValue: function () { return this.getValue(); },
    setValue: function (v) { var ms = toMs(v); this._ms = isNaN(ms) ? NaN : Math.floor(ms / DAY) * DAY; },
    setDisplayValue: function (v) { this.setValue(v); },
    getNumericValue: function () { return this._ms; },
    addDays: function (n) { this._ms += (Number(n) || 0) * DAY; },
    addDaysUTC: function (n) { this._ms += (Number(n) || 0) * DAY; },
    addMonths: function (n) { this._ms = addMonthsMs(this._ms, n); },
    addYears: function (n) { this._ms = addMonthsMs(this._ms, (Number(n) || 0) * 12); },
    compareTo: GlideDateTime.prototype.compareTo,
    before: GlideDateTime.prototype.before,
    after: GlideDateTime.prototype.after,
    equals: GlideDateTime.prototype.equals,
    onOrBefore: GlideDateTime.prototype.onOrBefore,
    onOrAfter: GlideDateTime.prototype.onOrAfter,
    getDayOfMonthNoTZ: function () { return new RealDate(this._ms).getUTCDate(); },
    getMonthNoTZ: function () { return new RealDate(this._ms).getUTCMonth() + 1; },
    getYearNoTZ: function () { return new RealDate(this._ms).getUTCFullYear(); },
    isValid: function () { return !isNaN(this._ms); },
    toString: function () { return this.getValue(); },
    toJSON: function () { return this.getValue(); }
  };

  function parseDuration(s) {
    s = str(s).trim();
    if (!s) return 0;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
    var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
    if (m) return RealDate.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    m = /^(?:(\d+)\s+)?(\d+):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (m) return ((+(m[1] || 0) * 24 + +m[2]) * 3600 + +m[3] * 60 + +(m[4] || 0)) * 1000;
    return 0;
  }

  function durationMs(v) {
    if (v instanceof GlideDuration) return v._ms;
    if (typeof v === 'number') return v;
    return parseDuration(plain(v));
  }

  function GlideDuration(v) {
    if (!(this instanceof GlideDuration)) return new GlideDuration(v);
    hidden(this, '_ms', v === undefined || v === null ? 0 : durationMs(v));
  }
  GlideDuration.prototype = {
    constructor: GlideDuration,
    getValue: function () { return formatUtc(this._ms); },
    getDurationValue: function () {
      var total = Math.floor(Math.abs(this._ms) / 1000);
      var days = Math.floor(total / 86400);
      var rest = total - days * 86400;
      var hms = pad(Math.floor(rest / 3600)) + ':' + pad(Math.floor((rest % 3600) / 60)) + ':' + pad(rest % 60);
      return (this._ms < 0 ? '-' : '') + (days ? days + ' ' : '') + hms;
    },
    getDisplayValue: function () {
      var secs = Math.floor(Math.abs(this._ms) / 1000);
      var days = Math.floor(secs / 86400);
      secs -= days * 86400;
      var hours = Math.floor(secs / 3600);
      secs -= hours * 3600;
      var mins = Math.floor(secs / 60);
      secs -= mins * 60;
      var parts = [];
      if (days) parts.push(days + (days === 1 ? ' Day' : ' Days'));
      if (hours) parts.push(hours + (hours === 1 ? ' Hour' : ' Hours'));
      if (mins) parts.push(mins + (mins === 1 ? ' Minute' : ' Minutes'));
      if (secs && days === 0) parts.push(secs + (secs === 1 ? ' Second' : ' Seconds'));
      return (this._ms < 0 ? '-' : '') + (parts.join(' ') || '0 Seconds');
    },
    getNumericValue: function () { return this._ms; },
    setValue: function (v) { this._ms = durationMs(v); },
    setNumericValue: function (n) { this._ms = Number(n) || 0; },
    add: function (v) { return new GlideDuration(this._ms + durationMs(v)); },
    subtract: function (v) { return new GlideDuration(this._ms - durationMs(v)); },
    getDayPart: function () { return Math.floor(this._ms / DAY); },
    getRoundedDayPart: function () { return Math.round(this._ms / DAY); },
    toString: function () { return this.getDurationValue(); },
    toJSON: function () { return this.getDurationValue(); }
  };

  // -------------------------------------------------------------------- gs

  var DATE_FUNCTIONS = [
    'nowDateTime', 'now', 'nowNoTZ', 'beginningOfToday', 'endOfToday', 'beginningOfYesterday', 'endOfYesterday',
    'beginningOfTomorrow', 'endOfTomorrow', 'beginningOfThisWeek', 'endOfThisWeek', 'beginningOfLastWeek',
    'endOfLastWeek', 'beginningOfNextWeek', 'endOfNextWeek', 'beginningOfThisMonth', 'endOfThisMonth',
    'beginningOfLastMonth', 'endOfLastMonth', 'beginningOfNextMonth', 'endOfNextMonth', 'beginningOfThisQuarter',
    'endOfThisQuarter', 'beginningOfLastQuarter', 'endOfLastQuarter', 'beginningOfThisYear', 'endOfThisYear',
    'beginningOfLastYear', 'endOfLastYear', 'beginningOfNextYear', 'endOfNextYear', 'minutesAgo',
    'minutesAgoStart', 'minutesAgoEnd', 'hoursAgo', 'hoursAgoStart', 'hoursAgoEnd', 'daysAgo', 'daysAgoStart',
    'daysAgoEnd', 'monthsAgo', 'monthsAgoStart', 'monthsAgoEnd', 'quartersAgo', 'quartersAgoStart',
    'quartersAgoEnd', 'yearsAgo', 'dateGenerate'
  ];

  function formatMessage(msg, args, start) {
    return str(msg).replace(/\{(\d+)\}/g, function (m, i) {
      var v = args[start + Number(i)];
      return v === undefined ? m : str(v);
    });
  }

  function describe(v) {
    if (v !== null && typeof v === 'object' && !(v instanceof GlideElement) && !(v instanceof GlideRecord)) {
      try {
        return JSONstringify(exportValue(v, 0));
      } catch (e) {
        return str(v);
      }
    }
    return str(v);
  }

  function log(level, text, source) {
    call('gs.log', [level, str(text), source === undefined || source === null ? null : str(source)]);
  }

  function recordHandle(gr) {
    return gr instanceof GlideRecord ? gr._h : null;
  }

  function javaList(arr) {
    var a = arr.slice();
    hidden(a, 'size', function () { return a.length; });
    hidden(a, 'get', function (i) { return a[i]; });
    hidden(a, 'contains', function (x) { return a.indexOf(str(x)) >= 0; });
    hidden(a, 'isEmpty', function () { return a.length === 0; });
    return a;
  }

  var userDetails = null;
  function userInfo() {
    if (!userDetails) userDetails = call('gs.user', []);
    return userDetails;
  }

  var currentUser = {
    getID: function () { return env.user.id; },
    getName: function () { return env.user.name; },
    getUserName: function () { return env.user.name; },
    getDisplayName: function () { return env.user.display; },
    getFullName: function () { return env.user.display; },
    getFirstName: function () { return userInfo().first; },
    getLastName: function () { return userInfo().last; },
    getEmail: function () { return userInfo().email; },
    getCompanyID: function () { return userInfo().company; },
    getDepartmentID: function () { return userInfo().department; },
    getManagerID: function () { return userInfo().manager; },
    getLocation: function () { return userInfo().location; },
    hasRole: function (r) { return gs.hasRole(r); },
    isMemberOf: function (g) { return call('gs.member', [str(plain(g))]); },
    getMyGroups: function () { return javaList(userInfo().groups); },
    getRoles: function () { return javaList(userInfo().roles); },
    getRecord: function () {
      var gr = new GlideRecord('sys_user');
      if (env.user.id) gr.get(env.user.id);
      return gr;
    }
  };

  var session = {
    isInteractive: function () { return false; },
    isLoggedIn: function () { return !!env.user.id; },
    getUser: function () { return currentUser; },
    getClientIP: function () { return null; },
    getTimeZoneName: function () { return userInfo().timeZone; }
  };

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function utf8Bytes(s) {
    var enc = unescape(encodeURIComponent(s));
    var out = [];
    for (var i = 0; i < enc.length; i++) out.push(enc.charCodeAt(i));
    return out;
  }
  function base64Encode(s) {
    var b = utf8Bytes(str(s));
    var out = '';
    for (var i = 0; i < b.length; i += 3) {
      var n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
    }
    return out;
  }
  function base64Decode(s) {
    var clean = str(s).replace(/[^A-Za-z0-9+/]/g, '');
    var bytes = '';
    for (var i = 0; i < clean.length; i += 4) {
      var n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
      bytes += String.fromCharCode((n >> 16) & 255);
      if (i + 2 < clean.length) bytes += String.fromCharCode((n >> 8) & 255);
      if (i + 3 < clean.length) bytes += String.fromCharCode(n & 255);
    }
    try {
      return decodeURIComponent(escape(bytes));
    } catch (e) {
      return bytes;
    }
  }

  var gs = {
    info: function (msg) { log('info', formatMessage(describe(msg), arguments, 1)); },
    warn: function (msg) { log('warn', formatMessage(describe(msg), arguments, 1)); },
    error: function (msg) { log('error', formatMessage(describe(msg), arguments, 1)); },
    debug: function (msg) { log('debug', formatMessage(describe(msg), arguments, 1)); },
    print: function (msg) { log('info', describe(msg)); },
    log: function (msg, source) { log('info', describe(msg), source); },
    logWarning: function (msg, source) { log('warn', describe(msg), source); },
    logError: function (msg, source) { log('error', describe(msg), source); },
    getUserID: function () { return env.user.id; },
    getUserName: function () { return env.user.name; },
    getUserDisplayName: function () { return env.user.display; },
    getUser: function () { return currentUser; },
    getSession: function () { return session; },
    hasRole: function (r) { return call('gs.hasRole', [str(r), false]); },
    hasRoleExactly: function (r) { return call('gs.hasRole', [str(r), true]); },
    isInteractive: function () { return false; },
    isLoggedIn: function () { return !!env.user.id; },
    getProperty: function (name, dflt) {
      var v = call('gs.prop', [str(name)]);
      return v === null ? (dflt === undefined ? null : dflt) : v;
    },
    setProperty: function (name, value, description) {
      call('gs.setprop', [str(name), str(plain(value)), description === undefined ? null : str(description)]);
    },
    eventQueue: function (name, gr, p1, p2) {
      call('gs.event', [str(name), recordHandle(gr), p1 === undefined || p1 === null ? null : str(plain(p1)), p2 === undefined || p2 === null ? null : str(plain(p2)), null]);
    },
    eventQueueScheduled: function (name, gr, p1, p2, when) {
      call('gs.event', [str(name), recordHandle(gr), p1 === undefined || p1 === null ? null : str(plain(p1)), p2 === undefined || p2 === null ? null : str(plain(p2)), str(plain(when))]);
    },
    addInfoMessage: function (m) { call('gs.msg', ['info', describe(m)]); },
    addErrorMessage: function (m) { call('gs.msg', ['error', describe(m)]); },
    nil: function (v) {
      if (v === null || v === undefined) return true;
      if (v instanceof GlideElement) return v.nil();
      return str(v) === '';
    },
    generateGUID: function () { return call('gs.guid', []); },
    include: function (name) { return loadInclude(str(name)); },
    getMessage: function (key, args) {
      var a = isArray(args) ? args : args === undefined ? [] : [args];
      return formatMessage(key, a, 0);
    },
    tableExists: function (t) { return call('gs.tableExists', [str(t)]); },
    getCurrentScopeName: function () { return 'global'; },
    dateDiff: function (a, b, numeric) {
      var ms = toMs(b) - toMs(a);
      if (numeric) return Math.round(ms / 1000);
      return new GlideDuration(ms).getDurationValue();
    },
    base64Encode: base64Encode,
    base64Decode: base64Decode,
    urlEncode: function (s) { return encodeURIComponent(str(s)); },
    urlDecode: function (s) { return decodeURIComponent(str(s)); }
  };
  DATE_FUNCTIONS.forEach(function (n) {
    gs[n] = function () {
      var a = [];
      for (var i = 0; i < arguments.length; i++) a.push(str(plain(arguments[i])));
      return call('gs.date', [n, a]);
    };
  });

  // ---------------------------------------------------- classes and helpers

  var Class = {
    create: function () {
      return function () {
        if (typeof this.initialize === 'function') this.initialize.apply(this, arguments);
      };
    }
  };

  hidden(Object, 'extendsObject', function (base, props) {
    var proto = createObj(typeof base === 'function' ? base.prototype : base);
    if (props) {
      for (var k in props) {
        if (hasOwn.call(props, k)) proto[k] = props[k];
      }
    }
    return proto;
  });

  var AbstractAjaxProcessor = Class.create();
  AbstractAjaxProcessor.prototype = {
    initialize: function (request, responseXML, gc) {
      this.request = request || null;
      this.responseXML = responseXML || null;
      this.gc = gc || null;
    },
    getParameter: function (name) {
      var r = this.request;
      if (!r) return null;
      return typeof r.getParameter === 'function' ? r.getParameter(name) : r[name] === undefined ? null : r[name];
    },
    type: 'AbstractAjaxProcessor'
  };

  function escapeHtml(s) {
    return str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var JSUtil = {
    nil: function (v) { return gs.nil(v); },
    notNil: function (v) { return !gs.nil(v); },
    has: function (v) { return !gs.nil(v); },
    doesNotHave: function (v) { return gs.nil(v); },
    toBoolean: function (v) {
      if (v instanceof GlideElement) v = v.toString();
      return v === true || v === 'true' || v === 1 || v === '1';
    },
    type_of: function (v) { return v === null ? 'null' : typeof v; },
    instance_of: function (o, c) { return o instanceof c; },
    isJavaObject: function () { return false; },
    escapeText: escapeHtml,
    escapeAttr: escapeHtml
  };

  function ArrayUtil() {}
  ArrayUtil.prototype = {
    contains: function (a, v) { return isArray(a) && a.indexOf(v) >= 0; },
    indexOf: function (a, v) { return isArray(a) ? a.indexOf(v) : -1; },
    unique: function (a) {
      var out = [];
      (a || []).forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); });
      return out;
    },
    concat: function (a, b) { return (a || []).concat(b || []); },
    union: function () {
      var out = [];
      for (var i = 0; i < arguments.length; i++) {
        (arguments[i] || []).forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); });
      }
      return out;
    },
    intersect: function (a, b) { return this.unique((a || []).filter(function (x) { return (b || []).indexOf(x) >= 0; })); },
    diff: function (a, b) { return (a || []).filter(function (x) { return (b || []).indexOf(x) < 0; }); },
    convertArray: function (a) { return Array.prototype.slice.call(a || []); },
    ensureArray: function (a) { return isArray(a) ? a : a === undefined || a === null ? [] : [a]; }
  };

  function consoleArgs(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(describe(args[i]));
    return parts.join(' ');
  }
  var consoleObject = {
    log: function () { log('info', consoleArgs(arguments)); },
    info: function () { log('info', consoleArgs(arguments)); },
    debug: function () { log('debug', consoleArgs(arguments)); },
    warn: function () { log('warn', consoleArgs(arguments)); },
    error: function () { log('error', consoleArgs(arguments)); }
  };

  // ------------------------------------------------------- script includes

  var loadedIncludes = {};
  var lazyIncludes = {};
  var IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  var RESERVED_GLOBALS = { __proto__: null, constructor: 1, prototype: 1, globalThis: 1 };

  function dropLazy(name) {
    if (lazyIncludes[name]) {
      delete lazyIncludes[name];
      delete G[name];
    }
  }

  function loadInclude(name) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(name)) return false;
    if (loadedIncludes[name]) return true;
    var r = call('gs.include', [name]);
    if (!r) return false;
    loadedIncludes[name] = true;
    loadedIncludes[r.n] = true;
    dropLazy(r.n);
    globalEval(r.src);
    return true;
  }

  function defineLazyInclude(name) {
    if (!IDENT_RE.test(name) || name in G) return;
    lazyIncludes[name] = true;
    defineProp(G, name, {
      configurable: true,
      enumerable: false,
      get: function () {
        dropLazy(name);
        loadInclude(name);
        return G[name];
      },
      set: function (v) {
        dropLazy(name);
        G[name] = v;
      }
    });
  }

  // -------------------------------------------------------- result export

  function exportValue(v, depth) {
    if (v === null || v === undefined) return null;
    var t = typeof v;
    if (t === 'string') return v;
    if (t === 'number') return isFinite(v) ? v : null;
    if (t === 'boolean') return v;
    if (t === 'bigint') return String(v);
    if (t !== 'object') return null;
    if (v instanceof GlideElement) return v.valueOf();
    if (v instanceof GlideRecord) return { table: v.getRecordClassName(), sys_id: v.getUniqueValue() };
    if (v instanceof GlideAggregate) return null;
    if (v instanceof GlideDateTime || v instanceof GlideDate || v instanceof GlideDuration) return v.getValue();
    if (v instanceof RealDate) return isNaN(v.getTime()) ? null : formatUtc(v.getTime());
    if (depth >= 20) return null;
    var i;
    if (isArray(v)) {
      var arr = [];
      var n = Math.min(v.length, 10000);
      for (i = 0; i < n; i++) arr.push(exportValue(v[i], depth + 1));
      return arr;
    }
    var out = {};
    var keys = objectKeys(v);
    var max = Math.min(keys.length, 10000);
    for (i = 0; i < max; i++) {
      var d = getOwnDesc(v, keys[i]);
      if (d && hasOwn.call(d, 'value')) out[keys[i]] = exportValue(d.value, depth + 1);
    }
    return out;
  }

  function importValue(d) {
    if (!d || typeof d !== 'object') return null;
    switch (d.k) {
      case 'v': return d.v;
      case 'gr': return wrapRecord(d.t, d.h, false, true);
      case 'fn': return function () {
        var a = [];
        for (var i = 0; i < arguments.length; i++) a.push(exportValue(arguments[i], 0));
        return call('fn', [d.id, a]);
      };
      case 'arr': return (d.a || []).map(importValue);
      case 'obj': {
        var o = {};
        for (var k in d.p) {
          if (hasOwn.call(d.p, k)) defineProp(o, k, { value: importValue(d.p[k]), writable: true, enumerable: true, configurable: true });
        }
        return o;
      }
      default: return null;
    }
  }

  function patchDate(offset) {
    if (!offset) return;
    function PatchedDate() {
      if (!new.target) return new RealDate(RealDate.now() + offset).toString();
      if (arguments.length === 0) return new RealDate(RealDate.now() + offset);
      return reflectConstruct(RealDate, arguments);
    }
    PatchedDate.prototype = RealDate.prototype;
    PatchedDate.now = function () { return RealDate.now() + offset; };
    PatchedDate.UTC = RealDate.UTC;
    PatchedDate.parse = RealDate.parse;
    G.Date = PatchedDate;
  }

  // ------------------------------------------------------------- globals

  G.GlideRecord = GlideRecord;
  G.GlideRecordSecure = GlideRecordSecure;
  G.GlideElement = GlideElement;
  G.GlideAggregate = GlideAggregate;
  G.GlideDateTime = GlideDateTime;
  G.GlideDate = GlideDate;
  G.GlideDuration = GlideDuration;
  G.GlideQueryCondition = QueryCondition;
  G.gs = gs;
  G.Class = Class;
  G.AbstractAjaxProcessor = AbstractAjaxProcessor;
  G.JSUtil = JSUtil;
  G.ArrayUtil = ArrayUtil;
  G.console = consoleObject;

  // --------------------------------------------------- worker entry points

  function setup(json) {
    var e = JSONparse(json);
    env.user = e.user || env.user;
    env.offset = Number(e.offset) || 0;
    env.readOnly = !!e.readOnly;
    patchDate(env.offset);
    (e.includes || []).forEach(defineLazyInclude);
    if (hasOwn.call(e, 'current')) {
      var c = e.current;
      G.current = c ? wrapRecord(c.t, c.h, false, true) : null;
      if (c && c.live) {
        G.current._live = true;
        liveCurrent = G.current;
      }
    }
    if (hasOwn.call(e, 'previous')) {
      G.previous = e.previous ? wrapRecord(e.previous.t, e.previous.h, false, true) : null;
    }
    var vars = e.vars || {};
    for (var k in vars) {
      if (hasOwn.call(vars, k) && IDENT_RE.test(k) && !RESERVED_GLOBALS[k]) G[k] = importValue(vars[k]);
    }
    G.answer = undefined;
  }

  function finish(v) {
    if (liveCurrent) call('gr.qset', [liveCurrent._h, liveCurrent._q]);
    var a = G.answer;
    var out = exportValue(a !== undefined ? a : v, 0);
    return JSONstringify({ v: out === undefined ? null : out });
  }

  function errinfo(e) {
    var o = { name: 'Error', message: '' };
    try {
      if (e !== null && typeof e === 'object') {
        o.name = str(e.name) || 'Error';
        o.message = str(e.message);
        o.stack = str(e.stack).slice(0, 4000);
        if (typeof e.lineNumber === 'number') o.line = e.lineNumber;
      } else {
        o.name = 'Error';
        o.message = str(e);
      }
    } catch (x) {
      o.message = 'Script error';
    }
    return JSONstringify(o);
  }

  return { setup: setup, finish: finish, errinfo: errinfo };
})(globalThis.__host, eval);
`;
