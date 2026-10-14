// A fake ServiceNow record store (GlideRecord), shared by the executor tests and the offline run of the ATF step scripts.
function makeStore({ afterInsert } = {}) {
  const tables = {};
  let seq = 0;
  // like the platform's date-times (UTC, to the second), made unique and ordered by a counter so the order of changes is always clear
  const stamp = () => `${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${String(seq).padStart(8, '0')}`;
  const rowsOf = (t) => (tables[t] = tables[t] || []);

  class GR {
    constructor(table) { this.table = table; this.row = null; this.cursor = []; this.i = -1; this.q = []; this.lim = null; this.order = null; }
    initialize() { this.row = {}; }
    setValue(k, v) { this.row[k] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v); }
    getValue(k) { return this.row && k in this.row ? this.row[k] : null; }
    isValidRecord() { return !!this.row; }
    getDisplayValue(k) { return this.getValue(k) === null ? '' : this.getValue(k); }
    getUniqueValue() { return this.row.sys_id; }
    insert() { this.row.sys_id = 'sys' + ++seq; this.row.sys_created_on = stamp(); this.row.sys_updated_on = stamp(); rowsOf(this.table).push(this.row); if (afterInsert) afterInsert(this); return this.row.sys_id; }
    deleteRecord() { const rows = rowsOf(this.table); const i = rows.indexOf(this.row); if (i >= 0) rows.splice(i, 1); return true; }
    update() { ++seq; this.row.sys_updated_on = stamp(); return this.row.sys_id; }
    get assigned_to() { const r = this.row || {}; return { nil: () => !r.assigned_to, getDisplayValue: () => r.assigned_to_name || '' }; }
    get(id) { const r = rowsOf(this.table).find((x) => x.sys_id === id); if (!r) return false; this.row = r; return true; }
    addQuery(k, a, b) {
      const op = b === undefined ? '=' : a;
      const v = b === undefined ? a : b;
      const want = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
      this.q.push((r) => (op === '<' ? r[k] !== undefined && String(r[k]) < want : r[k] === want));
    }
    getRowCount() { return this.cursor.length; }
    deleteMultiple() { const rows = rowsOf(this.table); this.cursor.forEach((r) => { const i = rows.indexOf(r); if (i >= 0) rows.splice(i, 1); }); }
    addNotNullQuery(k) { this.q.push((r) => r[k] !== undefined && r[k] !== ''); }
    orderByDesc(k) { this.order = k; }
    setLimit(n) { this.lim = n; }
    query() {
      let rs = rowsOf(this.table).filter((r) => this.q.every((f) => f(r)));
      if (this.order) rs = rs.slice().sort((a, b) => (String(b[this.order]) < String(a[this.order]) ? -1 : String(b[this.order]) > String(a[this.order]) ? 1 : 0));
      if (this.lim) rs = rs.slice(0, this.lim);
      this.cursor = rs; this.i = -1;
    }
    next() { this.i++; if (this.i < this.cursor.length) { this.row = this.cursor[this.i]; return true; } return false; }
  }

  return { tables, rowsOf, GR };
}

module.exports = { makeStore };
