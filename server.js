import express from 'express'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())

// DB 초기화
const dataDir = join(__dirname, 'data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
const db = new Database(join(dataDir, 'sancheck.db'))

db.exec(`
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  position TEXT DEFAULT '사회복지사',
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now', '+9 hours'))
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  work_date TEXT NOT NULL,
  status TEXT NOT NULL,
  check_in TEXT,
  check_out TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now', '+9 hours')),
  updated_at TEXT DEFAULT (datetime('now', '+9 hours')),
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  UNIQUE(employee_id, work_date)
);
CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  leave_start TEXT NOT NULL,
  leave_end TEXT NOT NULL,
  leave_type TEXT NOT NULL,
  reason TEXT,
  handover TEXT,
  applicant_sign TEXT,
  applicant_date TEXT,
  social_worker_sign TEXT,
  social_worker_date TEXT,
  director_sign TEXT,
  director_date TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now', '+9 hours')),
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);
CREATE INDEX IF NOT EXISTS idx_att_emp_date ON attendance(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(work_date);
CREATE INDEX IF NOT EXISTS idx_lr_emp ON leave_requests(employee_id);
`)

function getKST() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
}

// ── 직원 API ──
app.get('/api/employees', (req, res) => {
  res.json({ ok: true, data: db.prepare('SELECT * FROM employees WHERE is_active=1 ORDER BY id').all() })
})
app.post('/api/employees', (req, res) => {
  const { name, position } = req.body
  if (!name) return res.status(400).json({ ok: false, error: '이름 필요' })
  const r = db.prepare('INSERT INTO employees (name, position) VALUES (?, ?)').run(name, position || '사회복지사')
  res.json({ ok: true, id: r.lastInsertRowid })
})
app.put('/api/employees/:id', (req, res) => {
  const { name, position } = req.body
  if (!name) return res.status(400).json({ ok: false, error: '이름 필요' })
  db.prepare('UPDATE employees SET name=?, position=? WHERE id=?').run(name, position || '사회복지사', req.params.id)
  res.json({ ok: true })
})
app.delete('/api/employees/:id', (req, res) => {
  db.prepare('UPDATE employees SET is_active=0 WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

// ── 근태 API ──
app.get('/api/attendance/today', (req, res) => {
  const today = getKST()
  const emps = db.prepare('SELECT * FROM employees WHERE is_active=1 ORDER BY id').all()
  const recs = db.prepare(`SELECT a.*,e.name,e.position FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE a.work_date=? AND e.is_active=1`).all(today)
  const map = {}
  recs.forEach(r => { map[r.employee_id] = r })
  const list = emps.map(e => map[e.id] || { employee_id: e.id, name: e.name, position: e.position, work_date: today, status: null })
  res.json({ ok: true, data: list, date: today })
})
app.post('/api/attendance', (req, res) => {
  const { employee_id, work_date, status, check_in, check_out, note } = req.body
  if (!employee_id || !work_date || !status) return res.status(400).json({ ok: false, error: '필수 항목 누락' })
  db.prepare(`INSERT INTO attendance (employee_id,work_date,status,check_in,check_out,note,updated_at)
    VALUES (?,?,?,?,?,?,datetime('now','+9 hours'))
    ON CONFLICT(employee_id,work_date) DO UPDATE SET
    status=excluded.status,check_in=excluded.check_in,check_out=excluded.check_out,
    note=excluded.note,updated_at=datetime('now','+9 hours')`
  ).run(employee_id, work_date, status, check_in || null, check_out || null, note || null)
  res.json({ ok: true })
})
app.get('/api/attendance/monthly', (req, res) => {
  const { year, month, employee_id } = req.query
  if (!year || !month) return res.status(400).json({ ok: false, error: '연월 필요' })
  const ym = `${year}-${String(month).padStart(2, '0')}`
  let q = `SELECT a.*,e.name,e.position FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE a.work_date LIKE ? AND e.is_active=1`
  const p = [`${ym}-%`]
  if (employee_id) { q += ' AND a.employee_id=?'; p.push(employee_id) }
  q += ' ORDER BY a.work_date,e.id'
  res.json({ ok: true, data: db.prepare(q).all(...p) })
})

// ── 통계 API ──
app.get('/api/stats/monthly', (req, res) => {
  const { year, month } = req.query
  if (!year || !month) return res.status(400).json({ ok: false, error: '연월 필요' })
  const ym = `${year}-${String(month).padStart(2, '0')}`
  const rows = db.prepare(`SELECT e.id as employee_id,e.name,
    COUNT(CASE WHEN a.status='출근' THEN 1 END) as work_count,
    COUNT(CASE WHEN a.status='연차' THEN 1 END) as annual_leave,
    COUNT(CASE WHEN a.status='오전반차' THEN 1 END) as am_half,
    COUNT(CASE WHEN a.status='오후반차' THEN 1 END) as pm_half,
    COUNT(CASE WHEN a.status='병가' THEN 1 END) as sick_leave,
    COUNT(CASE WHEN a.status='경조휴가' THEN 1 END) as family_leave,
    COUNT(CASE WHEN a.status='공가' THEN 1 END) as official_leave
    FROM employees e LEFT JOIN attendance a ON a.employee_id=e.id AND a.work_date LIKE ?
    WHERE e.is_active=1 GROUP BY e.id ORDER BY e.id`).all(`${ym}-%`)
  res.json({ ok: true, data: rows })
})
app.get('/api/stats/yearly', (req, res) => {
  const y = req.query.year || new Date().getFullYear().toString()
  const rows = db.prepare(`SELECT e.id as employee_id,e.name,
    COUNT(CASE WHEN a.status='연차' THEN 1 END) as annual_leave,
    COUNT(CASE WHEN a.status='오전반차' THEN 1 END) as am_half,
    COUNT(CASE WHEN a.status='오후반차' THEN 1 END) as pm_half,
    ROUND(COUNT(CASE WHEN a.status='연차' THEN 1 END)+(COUNT(CASE WHEN a.status='오전반차' THEN 1 END)+COUNT(CASE WHEN a.status='오후반차' THEN 1 END))*0.5,1) as total_leave_days,
    COUNT(CASE WHEN a.status='병가' THEN 1 END) as sick_leave,
    COUNT(CASE WHEN a.status='경조휴가' THEN 1 END) as family_leave,
    COUNT(CASE WHEN a.status='공가' THEN 1 END) as official_leave
    FROM employees e LEFT JOIN attendance a ON a.employee_id=e.id AND a.work_date LIKE ?
    WHERE e.is_active=1 GROUP BY e.id ORDER BY e.id`).all(`${y}-%`)
  res.json({ ok: true, data: rows })
})

// ── 연차신청 API ──
app.get('/api/leave-requests', (req, res) => {
  const { employee_id, year } = req.query
  let q = `SELECT lr.*,e.name FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id WHERE 1=1`
  const p = []
  if (employee_id) { q += ' AND lr.employee_id=?'; p.push(employee_id) }
  if (year) { q += ' AND lr.leave_start LIKE ?'; p.push(`${year}-%`) }
  q += ' ORDER BY lr.created_at DESC'
  res.json({ ok: true, data: db.prepare(q).all(...p) })
})
app.post('/api/leave-requests', (req, res) => {
  const b = req.body
  const r = db.prepare(`INSERT INTO leave_requests (employee_id,leave_start,leave_end,leave_type,reason,handover,applicant_sign,applicant_date,social_worker_sign,social_worker_date,director_sign,director_date,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(b.employee_id, b.leave_start, b.leave_end, b.leave_type, b.reason||'', b.handover||'', b.applicant_sign||'', b.applicant_date||'', b.social_worker_sign||'', b.social_worker_date||'', b.director_sign||'', b.director_date||'', b.status||'pending')
  res.json({ ok: true, id: r.lastInsertRowid })
})
app.put('/api/leave-requests/:id', (req, res) => {
  const b = req.body
  db.prepare(`UPDATE leave_requests SET leave_start=?,leave_end=?,leave_type=?,reason=?,handover=?,applicant_sign=?,applicant_date=?,social_worker_sign=?,social_worker_date=?,director_sign=?,director_date=?,status=? WHERE id=?`
  ).run(b.leave_start, b.leave_end, b.leave_type, b.reason||'', b.handover||'', b.applicant_sign||'', b.applicant_date||'', b.social_worker_sign||'', b.social_worker_date||'', b.director_sign||'', b.director_date||'', b.status||'pending', req.params.id)
  res.json({ ok: true })
})
app.delete('/api/leave-requests/:id', (req, res) => {
  db.prepare('DELETE FROM leave_requests WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

// ── HTML 서빙 ──
const htmlContent = fs.readFileSync(join(__dirname, 'public', 'index.html'), 'utf-8')
app.get('*', (req, res) => {
  res.send(htmlContent)
})

app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: http://localhost:${PORT}`)
})
