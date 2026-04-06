import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

type Bindings = { DB: D1Database }
const app = new Hono<{ Bindings: Bindings }>()
app.use('/api/*', cors())
app.use('/static/*', serveStatic({ root: './' }))

app.get('/api/employees', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM employees WHERE is_active=1 ORDER BY id').all()
  return c.json({ ok: true, data: r.results })
})
app.post('/api/employees', async (c) => {
  const { name, position } = await c.req.json()
  if (!name) return c.json({ ok: false, error: '이름 필요' }, 400)
  const r = await c.env.DB.prepare('INSERT INTO employees (name, position) VALUES (?, ?)').bind(name, position || '사회복지사').run()
  return c.json({ ok: true, id: r.meta.last_row_id })
})
app.put('/api/employees/:id', async (c) => {
  const id = c.req.param('id')
  const { name, position } = await c.req.json()
  if (!name) return c.json({ ok: false, error: '이름 필요' }, 400)
  await c.env.DB.prepare('UPDATE employees SET name=?, position=? WHERE id=?').bind(name, position || '사회복지사', id).run()
  return c.json({ ok: true })
})
app.delete('/api/employees/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('UPDATE employees SET is_active=0 WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})

app.get('/api/attendance/today', async (c) => {
  const today = getKST()
  const res = await c.env.DB.prepare(`SELECT a.*,e.name,e.position FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE a.work_date=? AND e.is_active=1 ORDER BY e.id`).bind(today).all()
  const emps = await c.env.DB.prepare('SELECT * FROM employees WHERE is_active=1 ORDER BY id').all()
  const map: Record<number, any> = {}
  for (const r of (res.results as any[])) map[r.employee_id] = r
  const list = (emps.results as any[]).map(e => map[e.id] || { employee_id: e.id, name: e.name, position: e.position, work_date: today, status: null })
  return c.json({ ok: true, data: list, date: today })
})
app.post('/api/attendance', async (c) => {
  const { employee_id, work_date, status, check_in, check_out, note } = await c.req.json()
  if (!employee_id || !work_date || !status) return c.json({ ok: false, error: '필수 항목 누락' }, 400)
  await c.env.DB.prepare(`INSERT INTO attendance (employee_id,work_date,status,check_in,check_out,note,updated_at) VALUES (?,?,?,?,?,?,datetime('now','+9 hours')) ON CONFLICT(employee_id,work_date) DO UPDATE SET status=excluded.status,check_in=excluded.check_in,check_out=excluded.check_out,note=excluded.note,updated_at=datetime('now','+9 hours')`).bind(employee_id, work_date, status, check_in || null, check_out || null, note || null).run()
  return c.json({ ok: true })
})
app.get('/api/attendance/monthly', async (c) => {
  const { year, month, employee_id } = c.req.query()
  if (!year || !month) return c.json({ ok: false, error: '연월 필요' }, 400)
  const ym = `${year}-${month.padStart(2, '0')}`
  let q = `SELECT a.*,e.name,e.position FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE a.work_date LIKE ? AND e.is_active=1`
  const p: any[] = [`${ym}-%`]
  if (employee_id) { q += ' AND a.employee_id=?'; p.push(employee_id) }
  q += ' ORDER BY a.work_date,e.id'
  const r = await c.env.DB.prepare(q).bind(...p).all()
  return c.json({ ok: true, data: r.results })
})
app.get('/api/stats/monthly', async (c) => {
  const { year, month } = c.req.query()
  if (!year || !month) return c.json({ ok: false, error: '연월 필요' }, 400)
  const ym = `${year}-${month.padStart(2, '0')}`
  const r = await c.env.DB.prepare(`SELECT e.id as employee_id,e.name, COUNT(CASE WHEN a.status='출근' THEN 1 END) as work_count, COUNT(CASE WHEN a.status='연차' THEN 1 END) as annual_leave, COUNT(CASE WHEN a.status='오전반차' THEN 1 END) as am_half, COUNT(CASE WHEN a.status='오후반차' THEN 1 END) as pm_half, COUNT(CASE WHEN a.status='병가' THEN 1 END) as sick_leave, COUNT(CASE WHEN a.status='경조휴가' THEN 1 END) as family_leave, COUNT(CASE WHEN a.status='공가' THEN 1 END) as official_leave, COUNT(a.id) as total_records FROM employees e LEFT JOIN attendance a ON a.employee_id=e.id AND a.work_date LIKE ? WHERE e.is_active=1 GROUP BY e.id ORDER BY e.id`).bind(`${ym}-%`).all()
  return c.json({ ok: true, data: r.results })
})
app.get('/api/stats/yearly', async (c) => {
  const { year } = c.req.query()
  const y = year || '2026'
  const r = await c.env.DB.prepare(`SELECT e.id as employee_id,e.name, COUNT(CASE WHEN a.status='연차' THEN 1 END) as annual_leave, COUNT(CASE WHEN a.status='오전반차' THEN 1 END) as am_half, COUNT(CASE WHEN a.status='오후반차' THEN 1 END) as pm_half, ROUND(COUNT(CASE WHEN a.status='연차' THEN 1 END)+(COUNT(CASE WHEN a.status='오전반차' THEN 1 END)+COUNT(CASE WHEN a.status='오후반차' THEN 1 END))*0.5,1) as total_leave_days, COUNT(CASE WHEN a.status='병가' THEN 1 END) as sick_leave, COUNT(CASE WHEN a.status='경조휴가' THEN 1 END) as family_leave, COUNT(CASE WHEN a.status='공가' THEN 1 END) as official_leave FROM employees e LEFT JOIN attendance a ON a.employee_id=e.id AND a.work_date LIKE ? WHERE e.is_active=1 GROUP BY e.id ORDER BY e.id`).bind(`${y}-%`).all()
  return c.json({ ok: true, data: r.results })
})
app.get('/api/leave-requests', async (c) => {
  const { employee_id, year } = c.req.query()
  let q = `SELECT lr.*,e.name FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id WHERE 1=1`
  const p: any[] = []
  if (employee_id) { q += ' AND lr.employee_id=?'; p.push(employee_id) }
  if (year) { q += ' AND lr.leave_start LIKE ?'; p.push(`${year}-%`) }
  q += ' ORDER BY lr.created_at DESC'
  const r = await c.env.DB.prepare(q).bind(...p).all()
  return c.json({ ok: true, data: r.results })
})
app.post('/api/leave-requests', async (c) => {
  const b = await c.req.json()
  const r = await c.env.DB.prepare(`INSERT INTO leave_requests (employee_id,leave_start,leave_end,leave_type,reason,handover,applicant_sign,applicant_date,social_worker_sign,social_worker_date,director_sign,director_date,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(b.employee_id, b.leave_start, b.leave_end, b.leave_type, b.reason || '', b.handover || '', b.applicant_sign || '', b.applicant_date || '', b.social_worker_sign || '', b.social_worker_date || '', b.director_sign || '', b.director_date || '', b.status || 'pending').run()
  return c.json({ ok: true, id: r.meta.last_row_id })
})
app.put('/api/leave-requests/:id', async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json()
  await c.env.DB.prepare(`UPDATE leave_requests SET leave_start=?,leave_end=?,leave_type=?,reason=?,handover=?,applicant_sign=?,applicant_date=?,social_worker_sign=?,social_worker_date=?,director_sign=?,director_date=?,status=? WHERE id=?`).bind(b.leave_start, b.leave_end, b.leave_type, b.reason || '', b.handover || '', b.applicant_sign || '', b.applicant_date || '', b.social_worker_sign || '', b.social_worker_date || '', b.director_sign || '', b.director_date || '', b.status || 'pending', id).run()
  return c.json({ ok: true })
})
app.delete('/api/leave-requests/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM leave_requests WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})

app.get('/', (c) => c.html(getHTML()))
app.get('*', (c) => c.html(getHTML()))

function getKST(): string {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
}

function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>근무상황부 · 산청인애노인통합지원센터</title>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
body{font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;background:#f0f4f8;color:#1e293b;min-height:100vh;}

/* ══════════════════════════════
   PC 레이아웃 (768px 이상)
   좌측 사이드바 + 우측 콘텐츠
══════════════════════════════ */
.app-shell{display:flex;min-height:100vh;}

/* ── PC 사이드바 ── */
.sidebar{width:220px;min-height:100vh;background:#1e293b;display:flex;flex-direction:column;flex-shrink:0;position:fixed;top:0;left:0;bottom:0;z-index:300;}
.sidebar-logo{padding:24px 20px 16px;border-bottom:1px solid rgba(255,255,255,.08);}
.sidebar-logo .s-title{font-size:15px;font-weight:800;color:#fff;line-height:1.3;}
.sidebar-logo .s-sub{font-size:11px;color:rgba(255,255,255,.45);margin-top:3px;}
.sidebar-clock{font-size:22px;font-weight:800;color:#fff;letter-spacing:1px;padding:12px 20px;font-variant-numeric:tabular-nums;border-bottom:1px solid rgba(255,255,255,.08);}
.sidebar-date{font-size:11px;color:rgba(255,255,255,.45);padding:6px 20px 14px;}
.sidebar-nav{flex:1;padding:10px 0;overflow-y:auto;}
.s-nav-item{display:flex;align-items:center;gap:12px;padding:12px 20px;cursor:pointer;color:rgba(255,255,255,.6);font-size:14px;font-weight:600;transition:all .15s;border:none;background:none;width:100%;text-align:left;}
.s-nav-item i{width:18px;text-align:center;font-size:15px;}
.s-nav-item:hover{background:rgba(255,255,255,.07);color:#fff;}
.s-nav-item.active{background:#2563eb;color:#fff;border-radius:0;}

/* ── PC 메인 콘텐츠 영역 ── */
.main-area{margin-left:220px;flex:1;min-height:100vh;display:flex;flex-direction:column;}
.main-topbar{background:#fff;border-bottom:1px solid #e2e8f0;padding:14px 28px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;}
.main-topbar .page-title{font-size:18px;font-weight:800;color:#1e293b;}
.content-wrap{padding:24px 28px;flex:1;}

/* ── 모바일: 사이드바 숨김, 바텀탭 표시 ── */
@media(max-width:767px){
  .sidebar{display:none;}
  .main-area{margin-left:0;}
  .main-topbar{padding:12px 16px;}
  .main-topbar .page-title{font-size:16px;}
  .content-wrap{padding:12px 12px 76px;}
  .bot-nav{display:flex!important;}
}
@media(min-width:768px){
  .bot-nav{display:none!important;}
  .content-wrap{padding:24px 28px 24px;}
}

/* ── 바텀 탭 (모바일 전용) ── */
.bot-nav{position:fixed;bottom:0;left:0;right:0;height:62px;background:#fff;border-top:1px solid #e2e8f0;display:none;z-index:200;box-shadow:0 -2px 12px rgba(0,0,0,.08);}
.bot-tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border:none;background:none;cursor:pointer;color:#94a3b8;font-size:10px;font-weight:600;transition:color .15s;padding:6px 0;}
.bot-tab i{font-size:19px;}
.bot-tab.active{color:#2563eb;}

/* ── 페이지 전환 ── */
.page{display:none;}
.page.active{display:block;}

/* ── 카드 ── */
.card{background:#fff;border-radius:14px;padding:20px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.06),0 1px 8px rgba(0,0,0,.04);}
.card-title{font-size:13px;font-weight:700;color:#64748b;margin-bottom:14px;display:flex;align-items:center;gap:6px;}
.card-title i{color:#2563eb;}

/* ── 직원 아코디언 ── */
.emp-item{background:#fff;border-radius:14px;border:2px solid #e2e8f0;overflow:hidden;margin-bottom:10px;transition:border-color .15s,box-shadow .15s;box-shadow:0 1px 3px rgba(0,0,0,.05);}
.emp-item:hover{box-shadow:0 2px 8px rgba(37,99,235,.12);}
.emp-item.open{border-color:#2563eb;box-shadow:0 2px 12px rgba(37,99,235,.15);}
.emp-head{display:flex;align-items:center;gap:14px;padding:16px 18px;cursor:pointer;user-select:none;}
.emp-head:hover{background:#f8faff;}
.emp-av{width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:800;flex-shrink:0;}
.emp-info{flex:1;min-width:0;}
.emp-nm{font-size:17px;font-weight:800;color:#0f172a;}
.emp-ps{font-size:12px;color:#94a3b8;margin-top:2px;}
.emp-right{text-align:right;flex-shrink:0;}
.emp-time-txt{font-size:11px;color:#94a3b8;margin-top:4px;}
.emp-chevron{font-size:13px;color:#94a3b8;margin-left:6px;transition:transform .2s;}
.emp-item.open .emp-chevron{transform:rotate(180deg);}

/* ── 상태 버튼 패널 ── */
.stt-panel{display:none;border-top:1px solid #e2e8f0;padding:16px 18px;background:#f8fafc;}
.emp-item.open .stt-panel{display:block;}
.stt-date-row{display:flex;gap:10px;margin-bottom:14px;}
.stt-date-row>div{flex:1;}
.stt-date-label{font-size:11px;font-weight:700;color:#64748b;margin-bottom:5px;}
.stt-date-row input{width:100%;border:1.5px solid #e2e8f0;border-radius:9px;padding:9px 12px;font-size:14px;outline:none;background:#fff;font-family:inherit;}
.stt-date-row input:focus{border-color:#2563eb;}
.stt-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}
@media(min-width:768px){.stt-grid{grid-template-columns:repeat(8,1fr);gap:10px;}}
.stt-btn{border:none;border-radius:12px;padding:14px 4px 12px;font-size:12px;font-weight:800;cursor:pointer;text-align:center;transition:transform .1s,opacity .15s;line-height:1.2;box-shadow:0 1px 3px rgba(0,0,0,.1);}
.stt-btn:hover{filter:brightness(1.05);}
.stt-btn:active{transform:scale(.91);opacity:.8;}
.stt-btn i{display:block;font-size:20px;margin-bottom:6px;}
.stt-출근{background:#dcfce7;color:#16a34a;}
.stt-퇴근{background:#dbeafe;color:#1d4ed8;}
.stt-오전반차{background:#ede9fe;color:#6d28d9;}
.stt-오후반차{background:#ede9fe;color:#6d28d9;}
.stt-연차{background:#fef9c3;color:#92400e;}
.stt-병가{background:#fee2e2;color:#b91c1c;}
.stt-경조휴가{background:#ffedd5;color:#c2410c;}
.stt-공가{background:#e0f2fe;color:#0369a1;}

/* ── 배지 ── */
.bdg{display:inline-block;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:700;}
.bdg-출근{background:#dcfce7;color:#16a34a;}
.bdg-퇴근{background:#dbeafe;color:#1d4ed8;}
.bdg-연차{background:#fef9c3;color:#92400e;}
.bdg-오전반차,.bdg-오후반차{background:#ede9fe;color:#6d28d9;}
.bdg-병가{background:#fee2e2;color:#b91c1c;}
.bdg-경조휴가{background:#ffedd5;color:#c2410c;}
.bdg-공가{background:#e0f2fe;color:#0369a1;}
.bdg-미등록{background:#f1f5f9;color:#94a3b8;}
.bdg-휴무{background:#f1f5f9;color:#94a3b8;}

/* ── 공통 입력 ── */
input[type=text],input[type=date],select,textarea{width:100%;border:1.5px solid #e2e8f0;border-radius:9px;padding:10px 12px;font-size:14px;outline:none;background:#fff;font-family:inherit;color:#1e293b;}
input:focus,select:focus,textarea:focus{border-color:#2563eb;}
label{font-size:12px;font-weight:600;color:#64748b;display:block;margin-bottom:5px;}

/* ── 버튼 ── */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:11px 18px;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;border:none;width:100%;transition:filter .1s;}
.btn:hover{filter:brightness(1.05);}
.btn-blue{background:#2563eb;color:#fff;}
.btn-gray{background:#f1f5f9;color:#374151;border:1px solid #e2e8f0;}
.btn-red{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;}
.btn-green{background:#16a34a;color:#fff;}
.btn-sm{padding:7px 14px;font-size:13px;border-radius:8px;width:auto;}

/* ── 폼 행 ── */
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;}
.form-row.full{grid-template-columns:1fr;}

/* ── 월별 테이블 ── */
.mo-tbl{border-collapse:collapse;width:100%;font-size:11px;}
.mo-tbl th{background:#334155;color:#fff;padding:6px 4px;text-align:center;border:1px solid #475569;}
.mo-tbl td{border:1px solid #e2e8f0;padding:5px 3px;text-align:center;}
.mo-tbl .wknd td{background:#fafafa;color:#94a3b8;}
.mo-tbl .sum td{background:#eff6ff;font-weight:700;color:#1d4ed8;}

/* ── 통계 테이블 ── */
.st-tbl{width:100%;border-collapse:collapse;font-size:14px;}
.st-tbl th{background:#f8fafc;color:#64748b;font-weight:600;font-size:12px;padding:10px 12px;border-bottom:2px solid #e2e8f0;text-align:center;}
.st-tbl td{padding:12px;border-bottom:1px solid #f1f5f9;text-align:center;color:#374151;}
.st-tbl tr:hover td{background:#f8faff;}
.st-tbl .nm{text-align:left;font-weight:700;color:#0f172a;}

/* ── 연차신청서 ── */
.lv-tbl{width:100%;border-collapse:collapse;}
.lv-tbl th,.lv-tbl td{border:1px solid #374151;padding:10px 12px;font-size:13px;}
.lv-tbl th{background:#f5f5f5;font-weight:700;color:#111;width:100px;}
.ap-wrap{display:flex;justify-content:flex-end;margin-bottom:16px;}
.ap-table{border-collapse:collapse;border:1.5px solid #111;}
.ap-table th{background:#f0f0f0;text-align:center;padding:5px 18px;font-size:11px;font-weight:700;color:#111;border:1px solid #555;white-space:nowrap;}
.ap-table td{width:68px;height:58px;border:1px solid #555;vertical-align:top;padding:3px;font-size:11px;}

/* ── 토스트 ── */
#toast{position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:9999;pointer-events:none;}
.tst{background:#0f172a;color:#fff;padding:11px 22px;border-radius:50px;font-size:13px;font-weight:600;margin-bottom:8px;animation:fadeIn .2s ease;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.2);}
@keyframes fadeIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}

/* ── PIN 잠금 화면 ── */
#pin-screen{position:fixed;inset:0;background:#1e293b;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9000;}
#pin-screen.hide{display:none;}
.pin-logo{text-align:center;margin-bottom:36px;}
.pin-logo .pl-title{font-size:22px;font-weight:800;color:#fff;margin-bottom:6px;}
.pin-logo .pl-sub{font-size:13px;color:rgba(255,255,255,.45);}
.pin-dots{display:flex;gap:16px;margin-bottom:40px;}
.pin-dot{width:16px;height:16px;border-radius:50%;background:rgba(255,255,255,.2);transition:background .15s;}
.pin-dot.filled{background:#2563eb;}
.pin-dot.error{background:#ef4444;}
.pin-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;width:260px;}
.pin-btn{height:72px;border-radius:16px;border:none;background:rgba(255,255,255,.08);color:#fff;font-size:24px;font-weight:700;cursor:pointer;transition:background .1s,transform .1s;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;}
.pin-btn:active{background:rgba(255,255,255,.18);transform:scale(.94);}
.pin-btn .pk-sub{font-size:9px;color:rgba(255,255,255,.35);font-weight:500;letter-spacing:1px;}
.pin-del{background:transparent!important;font-size:20px;}
.pin-err{font-size:13px;color:#ef4444;margin-top:-24px;margin-bottom:16px;min-height:20px;text-align:center;}

/* ── 인쇄 ── */
@media print{
  .sidebar,.bot-nav,.main-topbar,.no-print{display:none!important;}
  .main-area{margin-left:0!important;}
  body{background:#fff!important;}
  .card{box-shadow:none!important;border-radius:0!important;padding:6px!important;}
  @page{size:A4 portrait;margin:8mm;}
}
body.print-monthly .main-area>*:not(#pg-monthly){display:none!important;}
body.print-monthly #pg-monthly{display:block!important;padding:0!important;}
body.print-monthly .mo-tbl{font-size:7px!important;table-layout:fixed;width:100%!important;}
body.print-monthly .mo-tbl th,body.print-monthly .mo-tbl td{font-size:7px!important;padding:2px 1px!important;}
body.print-personal #pg-print{display:block!important;padding:0!important;}
body.print-personal .main-area>*:not(#pg-print){display:none!important;}
body.print-leave #pg-leave{display:block!important;padding:0!important;}
body.print-leave .main-area>*:not(#pg-leave){display:none!important;}
</style>
</head>
<body>

<!-- ══ PIN 잠금 화면 ══ -->
<div id="pin-screen">
  <div class="pin-logo">
    <div style="font-size:40px;margin-bottom:12px;">🔒</div>
    <div class="pl-title">산청인애노인통합지원센터</div>
    <div class="pl-sub">근무상황부 · PIN 4자리를 입력하세요</div>
  </div>
  <div class="pin-dots">
    <div class="pin-dot" id="pd-0"></div>
    <div class="pin-dot" id="pd-1"></div>
    <div class="pin-dot" id="pd-2"></div>
    <div class="pin-dot" id="pd-3"></div>
  </div>
  <div class="pin-err" id="pin-err"></div>
  <div class="pin-pad">
    <button class="pin-btn" onclick="pinInput('1')">1<span class="pk-sub"></span></button>
    <button class="pin-btn" onclick="pinInput('2')">2<span class="pk-sub">ABC</span></button>
    <button class="pin-btn" onclick="pinInput('3')">3<span class="pk-sub">DEF</span></button>
    <button class="pin-btn" onclick="pinInput('4')">4<span class="pk-sub">GHI</span></button>
    <button class="pin-btn" onclick="pinInput('5')">5<span class="pk-sub">JKL</span></button>
    <button class="pin-btn" onclick="pinInput('6')">6<span class="pk-sub">MNO</span></button>
    <button class="pin-btn" onclick="pinInput('7')">7<span class="pk-sub">PQRS</span></button>
    <button class="pin-btn" onclick="pinInput('8')">8<span class="pk-sub">TUV</span></button>
    <button class="pin-btn" onclick="pinInput('9')">9<span class="pk-sub">WXYZ</span></button>
    <div></div>
    <button class="pin-btn" onclick="pinInput('0')">0</button>
    <button class="pin-btn pin-del" onclick="pinDel()"><i class="fas fa-delete-left"></i></button>
  </div>
</div>

<div class="app-shell">

<!-- ══ PC 사이드바 ══ -->
<aside class="sidebar no-print">
  <div class="sidebar-logo">
    <div class="s-title">근무상황부</div>
    <div class="s-sub">산청인애노인통합지원센터</div>
  </div>
  <div class="sidebar-clock" id="hClock">--:--:--</div>
  <div class="sidebar-date" id="side-date"></div>
  <nav class="sidebar-nav">
    <button class="s-nav-item active" onclick="goTab('dash',this)" id="tab-dash"><i class="fas fa-home"></i>대시보드</button>
    <button class="s-nav-item" onclick="goTab('monthly',this)" id="tab-monthly"><i class="fas fa-calendar-alt"></i>근무현황</button>
    <button class="s-nav-item" onclick="goTab('leave',this)" id="tab-leave"><i class="fas fa-file-alt"></i>연차신청</button>
    <button class="s-nav-item" onclick="goTab('print',this)" id="tab-print"><i class="fas fa-print"></i>개인출력</button>
    <button class="s-nav-item" onclick="goTab('stats',this)" id="tab-stats"><i class="fas fa-chart-bar"></i>연차현황</button>
    <button class="s-nav-item" onclick="goTab('emp',this)" id="tab-emp"><i class="fas fa-users"></i>직원관리</button>
  </nav>
</aside>

<!-- ══ 메인 영역 ══ -->
<div class="main-area">

  <!-- 상단 타이틀바 (PC/모바일 공용) -->
  <div class="main-topbar no-print">
    <div class="page-title" id="main-title">대시보드</div>
    <div style="display:flex;align-items:center;gap:12px;">
      <span style="font-size:13px;color:#64748b;" id="top-date"></span>
      <span style="font-size:17px;font-weight:700;color:#1e293b;font-variant-numeric:tabular-nums;display:none;" id="top-clock"></span>
    </div>
  </div>

  <div class="content-wrap">

    <!-- ─── 대시보드 ─── -->
    <div class="page active" id="pg-dash">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div style="font-size:13px;color:#64748b;" id="dash-date"></div>
        <button onclick="refreshStatus()" style="border:none;background:none;color:#94a3b8;font-size:17px;cursor:pointer;padding:4px;" title="새로고침"><i class="fas fa-sync-alt"></i></button>
      </div>
      <div id="emp-tabs"></div>
    </div>

<div class="page" id="pg-monthly">
  <div class="card no-print">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <select id="mo-year" style="flex:1;min-width:90px;"><option value="2026">2026년</option><option value="2025">2025년</option></select>
      <select id="mo-month" style="flex:1;min-width:80px;">${Array.from({length:12},(_,i)=>`<option value="${i+1}">${i+1}월</option>`).join('')}</select>
      <button onclick="loadMonthly()" class="btn btn-blue btn-sm" style="width:auto;">조회</button>
      <button onclick="printMonthly()" class="btn btn-gray btn-sm no-print" style="width:auto;"><i class="fas fa-print"></i> 인쇄</button>
    </div>
  </div>
  <div class="card" style="overflow-x:auto;padding:10px;">
    <div id="mo-out"></div>
  </div>
</div>

<div class="page" id="pg-leave">
  <div class="card" id="lv-form-area">

    <!-- 공문 스타일: 제목 + 결재란 같은 줄 -->
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px;">
      <div style="flex:1;text-align:center;padding-top:8px;">
        <div style="font-size:11px;color:#888;margin-bottom:4px;">산청인애노인통합지원센터</div>
        <div style="font-size:22px;font-weight:900;letter-spacing:8px;color:#111;">연차사용신청서</div>
      </div>
      <!-- 결재란 (공문 스타일) -->
      <div class="ap-wrap" style="margin:0;flex-shrink:0;">
        <table class="ap-table">
          <tr>
            <th>담&nbsp;당</th>
            <th>전문사회복지사</th>
            <th>센&nbsp;터&nbsp;장</th>
          </tr>
          <tr>
            <td><div contenteditable="true" id="sg-1" style="height:52px;"></div></td>
            <td><div contenteditable="true" id="sg-2" style="height:52px;"></div></td>
            <td><div contenteditable="true" id="sg-3" style="height:52px;"></div></td>
          </tr>
        </table>
      </div>
    </div>

    <table class="lv-tbl">
      <tr><th>소&nbsp;&nbsp;속</th><td colspan="3">산청인애노인통합지원센터</td></tr>
      <tr>
        <th>신&nbsp;청&nbsp;자</th>
        <td><select id="lr-emp" style="border:none;padding:0;font-weight:700;font-size:14px;color:#111;background:transparent;"></select></td>
        <th>직&nbsp;&nbsp;책</th>
        <td id="lr-pos" style="font-weight:600;">-</td>
      </tr>
      <tr>
        <th>휴가구분</th>
        <td colspan="3">
          <select id="lr-type" style="border:none;padding:0;font-weight:700;font-size:14px;color:#111;background:transparent;">
            <option>연차</option><option>오전반차</option><option>오후반차</option><option>경조휴가</option><option>병가</option><option>공가</option>
          </select>
        </td>
      </tr>
      <tr>
        <th>휴가기간</th>
        <td><input type="date" id="lr-start" style="border:none;padding:0;font-size:13px;background:transparent;"></td>
        <th>종&nbsp;료&nbsp;일</th>
        <td><input type="date" id="lr-end" style="border:none;padding:0;font-size:13px;background:transparent;"></td>
      </tr>
      <tr><th>총&nbsp;일&nbsp;수</th><td colspan="3" id="lr-days" style="font-weight:700;color:#111;">-</td></tr>
      <tr><th>사&nbsp;&nbsp;유</th><td colspan="3"><div id="lr-reason" contenteditable="true" style="min-height:36px;"></div></td></tr>
      <tr><th>업무인수인계</th><td colspan="3"><div id="lr-handover" contenteditable="true" style="min-height:52px;"></div></td></tr>
    </table>

    <div style="text-align:center;padding:16px 0 8px;font-size:13px;color:#222;line-height:2;">
      위와 같이 휴가 사용을 신청합니다.<br>
      <span id="lr-date" style="font-weight:700;"></span>
    </div>
    <div style="text-align:right;font-size:13px;color:#222;margin-bottom:16px;">산청인애노인통합지원센터장 귀중</div>

    <div style="display:flex;gap:8px;" class="no-print">
      <button onclick="submitLR()" class="btn btn-blue"><i class="fas fa-save"></i> 저장</button>
      <button onclick="printLeave()" class="btn btn-gray" style="width:auto;padding:11px 16px;"><i class="fas fa-print"></i> 인쇄</button>
      <button onclick="resetLR()" class="btn btn-gray" style="width:auto;padding:11px 16px;"><i class="fas fa-redo"></i></button>
    </div>
  </div>

  <div class="card no-print">
    <div class="card-title"><i class="fas fa-list"></i>신청 목록 <button onclick="loadLRList()" class="btn btn-gray btn-sm" style="margin-left:auto;"><i class="fas fa-sync-alt"></i></button></div>
    <div id="lr-list"></div>
  </div>
</div>

<div class="page" id="pg-print">
  <div class="card no-print">
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <select id="pr-emp" style="flex:1;min-width:100px;"><option value="">직원선택</option></select>
      <select id="pr-year" style="flex:1;min-width:80px;"><option value="2026">2026년</option></select>
      <select id="pr-month" style="flex:1;min-width:70px;">${Array.from({length:12},(_,i)=>`<option value="${i+1}">${i+1}월</option>`).join('')}</select>
    </div>
    <div style="display:flex;gap:8px;margin-top:8px;">
      <button onclick="loadPrint()" class="btn btn-blue">미리보기</button>
      <button onclick="printPersonal()" class="btn btn-gray" style="width:auto;padding:11px 14px;"><i class="fas fa-print"></i> 인쇄</button>
    </div>
  </div>
  <div class="card" style="padding:12px;"><div id="pr-out"></div></div>
</div>

<div class="page" id="pg-stats">
  <div class="card">
    <div class="card-title"><i class="fas fa-calendar-check"></i> 연차 현황</div>
    <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center;">
      <select id="al-year" style="flex:1;min-width:80px;"><option value="2026">2026년</option><option value="2025">2025년</option></select>
      <button onclick="loadAnnual()" class="btn btn-blue btn-sm" style="width:auto;">조회</button>
    </div>
    <!-- 입사연도 설정 -->
    <div style="background:#f8fafc;border-radius:10px;padding:12px;margin-bottom:14px;">
      <div style="font-size:12px;font-weight:700;color:#6b7280;margin-bottom:10px;"><i class="fas fa-edit" style="color:#2563eb;"></i> 입사연도 설정</div>
      <div id="hire-year-list" style="display:flex;flex-direction:column;gap:8px;"></div>
    </div>
    <div id="al-out" style="overflow-x:auto;"></div>
    <div style="margin-top:10px;padding:10px;background:#f8fafc;border-radius:8px;font-size:11px;color:#6b7280;line-height:1.7;">
      · 1년 미만: 매월 1일 (최대 11일) &nbsp;· 1~3년 미만: 15일 &nbsp;· 3년 이상: 2년마다 +1일 (최대 25일)
    </div>
  </div>
</div>

<div class="page" id="pg-emp">
  <div class="card">
    <div class="card-title"><i class="fas fa-user-plus"></i> 직원 추가</div>
    <div class="form-row">
      <div><label>이름</label><input type="text" id="ne-name" placeholder="홍길동"></div>
      <div><label>직책</label><input type="text" id="ne-pos" placeholder="사회복지사"></div>
    </div>
    <button onclick="addEmp()" class="btn btn-blue"><i class="fas fa-plus"></i> 추가</button>
  </div>
  <div class="card">
    <div class="card-title"><i class="fas fa-users"></i> 직원 목록</div>
    <div id="emp-mgr-list"></div>
  </div>
</div>

  </div><!-- /content-wrap -->
</div><!-- /main-area -->
</div><!-- /app-shell -->

<!-- ══ 모바일 바텀 탭 ══ -->
<nav class="bot-nav no-print">
  <button class="bot-tab active" onclick="goTab('dash',this)" id="m-tab-dash"><i class="fas fa-home"></i>대시보드</button>
  <button class="bot-tab" onclick="goTab('monthly',this)" id="m-tab-monthly"><i class="fas fa-calendar-alt"></i>근무현황</button>
  <button class="bot-tab" onclick="goTab('leave',this)" id="m-tab-leave"><i class="fas fa-file-alt"></i>연차신청</button>
  <button class="bot-tab" onclick="goTab('print',this)" id="m-tab-print"><i class="fas fa-print"></i>출력</button>
  <button class="bot-tab" onclick="goTab('stats',this)" id="m-tab-stats"><i class="fas fa-chart-bar"></i>통계</button>
  <button class="bot-tab" onclick="goTab('emp',this)" id="m-tab-emp"><i class="fas fa-users"></i>직원</button>
</nav>

<div id="toast"></div>

<script>
const DAYS=['일','월','화','수','목','금','토']
const AVCOL=[['#dbeafe','#1d4ed8'],['#dcfce7','#16a34a'],['#fce7f3','#9d174d'],['#fef9c3','#92400e'],['#e0f2fe','#0369a1']]
let emps=[]

// ── PIN 비활성화 (바로 접속) ──
function checkSession(){ return true }
function saveSession(){}
function pinInput(){}
function pinDel(){}
function updatePinDots(){}
// PIN 화면 바로 숨김
document.getElementById('pin-screen').classList.add('hide')

// 시계 + 날짜 표시 (PC 사이드바 & 모바일 상단 동시)
const PAGE_TITLES={dash:'대시보드',monthly:'근무현황',leave:'연차신청',print:'개인출력',stats:'연차현황',emp:'직원관리'}
;(function tick(){
  const n=new Date()
  const h=String(n.getHours()).padStart(2,'0'),mi=String(n.getMinutes()).padStart(2,'0'),s=String(n.getSeconds()).padStart(2,'0')
  const t=h+':'+mi+':'+s
  const el=document.getElementById('hClock'); if(el) el.textContent=t
  const tc=document.getElementById('top-clock'); if(tc) tc.textContent=t
  setTimeout(tick,1000)
})()

// 탭 전환 (PC 사이드바 + 모바일 바텀 동시 처리)
function goTab(name,el){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'))
  document.querySelectorAll('.s-nav-item,.bot-tab').forEach(b=>b.classList.remove('active'))
  document.getElementById('pg-'+name).classList.add('active')
  // 사이드바 + 바텀탭 동시 활성화
  const sEl=document.getElementById('tab-'+name); if(sEl) sEl.classList.add('active')
  const mEl=document.getElementById('m-tab-'+name); if(mEl) mEl.classList.add('active')
  // 상단 페이지 타이틀
  const mt=document.getElementById('main-title'); if(mt) mt.textContent=PAGE_TITLES[name]||''
  if(name==='monthly') loadMonthly()
  if(name==='stats'){renderHireYearList().then(()=>loadAnnual())}
  if(name==='leave'){loadLRList()}
  if(name==='emp') renderEmpMgr()
}

// 직원 로드
async function loadEmps(){
  const r=await fetch('/api/employees'); const d=await r.json(); emps=d.data||[]
  ;['pr-emp','lr-emp'].forEach(id=>{
    const el=document.getElementById(id); if(!el) return
    const pv=el.value; el.innerHTML='<option value="">선택</option>'
    emps.forEach(e=>el.innerHTML+=\`<option value="\${e.id}">\${e.name}</option>\`)
    if(pv) el.value=pv
  })
  const lrEl=document.getElementById('lr-emp')
  if(lrEl){
    lrEl.onchange=function(){
      const e=emps.find(x=>x.id==this.value)
      document.getElementById('lr-pos').textContent=e?e.position:'-'
    }
    if(emps.length){lrEl.value=emps[0].id;lrEl.dispatchEvent(new Event('change'))}
  }
  renderEmpCards()
  renderEmpMgr()
}

function renderEmpCards(){
  const c=document.getElementById('emp-tabs'); if(!c) return
  const today=new Date().toISOString().slice(0,10)
  c.innerHTML=emps.map((e,i)=>{
    const [bg,fg]=AVCOL[i%AVCOL.length]
    return \`<div class="emp-item" id="ec-\${e.id}">
      <div class="emp-head" onclick="toggleEmp(\${e.id})">
        <div class="emp-av" style="background:\${bg};color:\${fg};">\${e.name[0]}</div>
        <div class="emp-info">
          <div class="emp-nm">\${e.name}</div>
          <div class="emp-ps">\${e.position||''}</div>
        </div>
        <div class="emp-right">
          <div id="ec-bdg-\${e.id}"><span class="bdg bdg-미등록">미등록</span></div>
          <div class="emp-time-txt" id="ec-time-\${e.id}"></div>
        </div>
        <i class="fas fa-chevron-down emp-chevron"></i>
      </div>
      <div class="stt-panel" id="sp-\${e.id}">
        <div class="stt-date-row">
          <div><div class="stt-date-label">날짜</div><input type="date" id="sh-date-\${e.id}" value="\${today}"></div>
          <div><div class="stt-date-label">시간</div><input type="time" id="sh-time-\${e.id}"></div>
        </div>
        <div class="stt-grid">
          <button class="stt-btn stt-출근" onclick="quickReg(\${e.id},'출근',this)"><i class="fas fa-sign-in-alt"></i>출근</button>
          <button class="stt-btn stt-퇴근" onclick="quickReg(\${e.id},'퇴근',this)"><i class="fas fa-sign-out-alt"></i>퇴근</button>
          <button class="stt-btn stt-오전반차" onclick="quickReg(\${e.id},'오전반차',this)"><i class="fas fa-hourglass-start"></i>오전반차</button>
          <button class="stt-btn stt-오후반차" onclick="quickReg(\${e.id},'오후반차',this)"><i class="fas fa-hourglass-end"></i>오후반차</button>
          <button class="stt-btn stt-연차" onclick="quickReg(\${e.id},'연차',this)"><i class="fas fa-umbrella-beach"></i>연차</button>
          <button class="stt-btn stt-병가" onclick="quickReg(\${e.id},'병가',this)"><i class="fas fa-procedures"></i>병가</button>
          <button class="stt-btn stt-경조휴가" onclick="quickReg(\${e.id},'경조휴가',this)"><i class="fas fa-heart"></i>경조휴가</button>
          <button class="stt-btn stt-공가" onclick="quickReg(\${e.id},'공가',this)"><i class="fas fa-landmark"></i>공가</button>
        </div>
      </div>
    </div>\`
  }).join('')
  refreshStatus()
}

async function refreshStatus(){
  try{
    const r=await fetch('/api/attendance/today'); const d=await r.json()
    ;(d.data||[]).forEach(a=>{
      const bdg=document.getElementById('ec-bdg-'+a.employee_id)
      const tim=document.getElementById('ec-time-'+a.employee_id)
      if(a.status){
        if(bdg) bdg.innerHTML=\`<span class="bdg bdg-\${a.status}">\${a.status}</span>\`
        if(tim) tim.textContent=a.check_in||''
      } else {
        if(bdg) bdg.innerHTML=\`<span class="bdg bdg-미등록">미등록</span>\`
        if(tim) tim.textContent=''
      }
    })
  }catch(e){}
}

// 직원 아코디언 토글
function toggleEmp(id){
  const item=document.getElementById('ec-'+id); if(!item) return
  const isOpen=item.classList.contains('open')
  document.querySelectorAll('.emp-item.open').forEach(el=>el.classList.remove('open'))
  if(!isOpen){
    item.classList.add('open')
    const n=new Date()
    const ti=document.getElementById('sh-time-'+id)
    if(ti&&!ti.value) ti.value=String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0')
    setTimeout(()=>item.scrollIntoView({behavior:'smooth',block:'start'}),80)
  }
}
function closeSheet(){ document.querySelectorAll('.emp-item.open').forEach(el=>el.classList.remove('open')) }

// 상태 버튼 한 번에 등록
async function quickReg(eid,st,btn){
  const wd=document.getElementById('sh-date-'+eid)?.value||new Date().toISOString().slice(0,10)
  let tv=document.getElementById('sh-time-'+eid)?.value||''
  if(st==='퇴근'&&!tv) tv='18:00'
  else if(st==='오전반차') tv='13:00'
  else if(st==='오후반차') tv='08:35'
  let ci=null,co=null
  if(st==='출근') ci=tv
  else if(st==='퇴근') co=tv
  else if(st==='오전반차'){ci='13:00';co='18:00'}
  else if(st==='오후반차'){ci=tv;co='13:00'}
  btn.style.opacity='0.5'
  const r=await fetch('/api/attendance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({employee_id:parseInt(eid),work_date:wd,status:st,check_in:ci,check_out:co,note:''})})
  const data=await r.json()
  btn.style.opacity='1'
  if(data.ok){
    const nm=emps.find(e=>e.id===eid)?.name||''
    toast(nm+' · '+st+' 등록 ✔','s')
    closeSheet()
    refreshStatus()
  } else toast(data.error||'오류 발생','e')
}
function setStt(){} function submitAtt(){}

// 월별 근무현황
const HOL=['2026-01-01','2026-01-28','2026-01-29','2026-01-30','2026-03-01','2026-03-02','2026-05-05','2026-06-06']
async function loadMonthly(){
  const year=document.getElementById('mo-year').value
  const month=document.getElementById('mo-month').value
  const r=await fetch('/api/attendance/monthly?year='+year+'&month='+month)
  const data=await r.json()
  const c=document.getElementById('mo-out'); if(!c) return
  if(!data.data){c.innerHTML='<p style="text-align:center;color:#9ca3af;padding:20px;">데이터 없음</p>';return}

  const recs=data.data; const mp={}; const nm={}
  recs.forEach(r=>{nm[r.employee_id]=r.name;if(!mp[r.work_date])mp[r.work_date]={};mp[r.work_date][r.employee_id]=r})

  const dates=[]; const d=new Date(year,month-1,1)
  while(d.getMonth()==month-1){dates.push(d.toISOString().slice(0,10));d.setDate(d.getDate()+1)}

  const ids=emps.map(e=>e.id)
  const wc={},ac={},hc={}
  ids.forEach(id=>{wc[id]=0;ac[id]=0;hc[id]=0})

  // 세로 A4 기준 컬럼 너비 배분: 날짜30+요일18 고정, 나머지 직원수로 균등
  const empColW = Math.floor((190 - 30 - 18 - 16) / ids.length)
  let html=\`<div style="text-align:center;font-weight:700;font-size:13px;margin-bottom:8px;">
    \${year}년 \${month}월 근무상황부
  </div>
  <table class="mo-tbl" style="table-layout:fixed;width:100%;"><thead><tr>
    <th style="width:30px;">날짜</th><th style="width:18px;">요일</th>
    \${ids.map(id=>\`<th style="width:\${empColW}px;">\${nm[id]||id}</th>\`).join('')}
    <th style="width:16px;">비고</th>
  </tr></thead><tbody>\`

  dates.forEach(ds=>{
    const dow=new Date(ds).getDay()
    const isW=dow===0||dow===6; const isH=HOL.includes(ds)
    const rc=isW||isH?'wknd':''
    const dc=dow===0?'color:#dc2626;font-weight:700':dow===6?'color:#2563eb;font-weight:700':''
    html+=\`<tr class="\${rc}"><td>\${ds.slice(5)}</td><td style="\${dc}">\${DAYS[dow]}</td>\`
    ids.forEach(id=>{
      if(isW||isH){html+=\`<td style="color:#d1d5db;font-size:9px;">휴</td>\`;return}
      const rec=mp[ds]?.[id]
      if(rec){
        if(rec.status==='출근') wc[id]++
        else if(rec.status==='연차') ac[id]++
        else if(rec.status==='오전반차'||rec.status==='오후반차') hc[id]++
        const dsp=rec.status==='출근'?(rec.check_in||'출근'):rec.status
        html+=\`<td><span class="bdg bdg-\${rec.status}" style="font-size:9px;padding:2px 5px;">\${dsp}</span></td>\`
      } else html+=\`<td style="color:#e5e7eb;">-</td>\`
    })
    html+=\`<td style="font-size:9px;color:#9ca3af;">\${isH?'공휴일':''}</td></tr>\`
  })

  html+=\`<tr class="sum"><td colspan="2">합계</td>\`
  ids.forEach(id=>{
    const hd=(hc[id]*0.5).toFixed(1)
    html+=\`<td style="font-size:10px;">출근 \${wc[id]}<br>연차 \${ac[id]}<br>반차 \${hc[id]}(\${hd}일)</td>\`
  })
  html+=\`<td></td></tr></tbody></table>\`
  c.innerHTML=html
}

// 연차 현황
// 입사연도 저장소 (서버 DB 사용)
let _hireYearsCache = {}
async function getHireYears(){
  try{
    const r = await fetch('/api/hire-years'); const d = await r.json()
    _hireYearsCache = d.data || {}
  }catch(e){}
  return _hireYearsCache
}
async function saveHireYear(empId, year){
  await fetch('/api/hire-years',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({employee_id:empId,hire_year:year})})
  _hireYearsCache[empId] = year
}

async function renderHireYearList(){
  const c=document.getElementById('hire-year-list'); if(!c) return
  const hy=await getHireYears()
  const curYear=new Date().getFullYear()
  c.innerHTML=emps.map(e=>{
    const defY=hy[e.id]||curYear
    return \`<div style="display:flex;align-items:center;gap:10px;">
      <span style="font-size:13px;font-weight:600;color:#111;min-width:60px;">\${e.name}</span>
      <select id="hy-\${e.id}" onchange="onHireYearChange(\${e.id},this.value)" style="flex:1;padding:7px 10px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:13px;">
        \${Array.from({length:35},(_,i)=>curYear-i).map(y=>
          \`<option value="\${y}" \${defY==y?'selected':''}>\${y}년 입사</option>\`
        ).join('')}
      </select>
    </div>\`
  }).join('')
}

async function onHireYearChange(empId, year){
  await saveHireYear(parseInt(empId), parseInt(year))
  toast('입사연도 저장 완료!','s')
  loadAnnual()
}

function calcAllow(y){
  if(y<1) return Math.min(Math.floor(y*12),11)
  if(y<3) return 15
  return Math.min(15+Math.floor((y-1)/2),25)
}

async function loadAnnual(){
  const year=document.getElementById('al-year').value
  const r=await fetch('/api/stats/yearly?year='+year); const d=await r.json()
  const c=document.getElementById('al-out'); if(!c||!d.data) return
  const hy=await getHireYears()
  let html=\`<div style="overflow-x:auto;"><table class="st-tbl"><thead><tr>
    <th style="text-align:left;">성명</th><th>입사</th><th>발생일수</th><th>사용</th><th>잔여</th><th>사용률</th>
  </tr></thead><tbody>\`
  d.data.forEach(row=>{
    const hireY=hy[row.employee_id]||(new Date().getFullYear())
    const yw=parseInt(year)-hireY
    const allow=calcAllow(yw)
    const hd=((row.am_half||0)+(row.pm_half||0))*0.5
    const used=(row.annual_leave||0)+hd
    const rem=Math.max(0,allow-used)
    const rate=allow>0?Math.round(used/allow*100):0
    const rc=rate>80?'#dc2626':rate>50?'#f59e0b':'#16a34a'
    html+=\`<tr>
      <td class="nm">\${row.name}</td>
      <td style="font-size:12px;color:#6b7280;">\${hireY}년</td>
      <td><b style="color:#2563eb;">\${allow}일</b></td>
      <td>\${used}일</td>
      <td><b style="color:\${rem===0?'#dc2626':'#16a34a'};">\${rem}일</b></td>
      <td>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="flex:1;height:6px;background:#e5e7eb;border-radius:3px;min-width:40px;">
            <div style="height:6px;border-radius:3px;background:\${rc};width:\${Math.min(rate,100)}%;"></div>
          </div>
          <span style="color:\${rc};font-weight:700;font-size:12px;white-space:nowrap;">\${rate}%</span>
        </div>
      </td>
    </tr>\`
  })
  html+=\`</tbody></table></div>\`
  c.innerHTML=html
}

// 개인별 출력
async function loadPrint(){
  const eid=document.getElementById('pr-emp').value
  const year=document.getElementById('pr-year').value
  const month=document.getElementById('pr-month').value
  if(!eid) return toast('직원을 선택하세요','e')
  const emp=emps.find(e=>e.id==eid)
  const r=await fetch('/api/attendance/monthly?year='+year+'&month='+month+'&employee_id='+eid)
  const data=await r.json()
  const dates=[]; const d=new Date(year,month-1,1)
  while(d.getMonth()==month-1){dates.push(d.toISOString().slice(0,10));d.setDate(d.getDate()+1)}
  const mp={}; ;(data.data||[]).forEach(rec=>{mp[rec.work_date]=rec})
  let wc=0,al=0,amh=0,pmh=0,sl=0,fl=0,ol=0
  const rows=dates.map(ds=>{
    const dow=new Date(ds).getDay(); const isW=dow===0||dow===6; const isH=HOL.includes(ds)
    const rec=mp[ds]
    let st='-',ci='-',co='-',bg=''
    if(isW||isH){st='휴무';bg='background:#f8fafc;'}
    else if(rec){
      st=rec.status;ci=rec.check_in||'-';co=rec.check_out||'-'
      if(st==='출근')wc++;if(st==='연차')al++;if(st==='오전반차')amh++;
      if(st==='오후반차')pmh++;if(st==='병가')sl++;if(st==='경조휴가')fl++;if(st==='공가')ol++
    }
    const dc=dow===0?'color:#dc2626':dow===6?'color:#2563eb':''
    return \`<tr style="\${bg}">
      <td style="padding:5px;border:1px solid #e5e7eb;">\${ds.slice(5)}</td>
      <td style="padding:5px;border:1px solid #e5e7eb;\${dc}">\${DAYS[dow]}</td>
      <td style="padding:5px;border:1px solid #e5e7eb;"><span class="bdg bdg-\${st}" style="font-size:11px;">\${st}</span></td>
      <td style="padding:5px;border:1px solid #e5e7eb;font-size:12px;">\${ci}</td>
      <td style="padding:5px;border:1px solid #e5e7eb;font-size:12px;">\${co}</td>
    </tr>\`
  }).join('')
  document.getElementById('pr-out').innerHTML=\`
    <div style="text-align:center;margin-bottom:12px;">
      <div style="font-size:11px;color:#9ca3af;">산청인애노인통합지원센터</div>
      <div style="font-size:18px;font-weight:800;color:#111;">\${year}년 \${month}월 근무상황부</div>
      <div style="font-size:13px;color:#374151;margin-top:4px;">성명: <b>\${emp?.name||''}</b> · 직책: \${emp?.position||''}</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px;">
      \${[['출근',wc,'#16a34a'],['연차',al+'일','#92400e'],['반차',(amh+pmh)+'회','#6d28d9'],['병가등',sl+fl+ol+'일','#b91c1c']].map(([l,v,cl])=>\`
      <div style="background:#f8fafc;border-radius:8px;padding:10px;text-align:center;">
        <div style="font-size:10px;color:#6b7280;">\${l}</div>
        <div style="font-size:20px;font-weight:800;color:\${cl};">\${v}</div>
      </div>\`).join('')}
    </div>
    <table style="border-collapse:collapse;width:100%;">
      <thead><tr style="background:#374151;color:#fff;">
        <th style="padding:6px;border:1px solid #4b5563;">날짜</th>
        <th style="padding:6px;border:1px solid #4b5563;">요일</th>
        <th style="padding:6px;border:1px solid #4b5563;">상태</th>
        <th style="padding:6px;border:1px solid #4b5563;">출근</th>
        <th style="padding:6px;border:1px solid #4b5563;">퇴근</th>
      </tr></thead><tbody>\${rows}</tbody>
    </table>
    <div style="text-align:right;font-size:11px;color:#9ca3af;margin-top:8px;">출력: \${new Date().toLocaleDateString('ko-KR')}</div>
  \`
}

// 연차신청서
function setupLR(){
  const t=new Date(); const ts=t.toISOString().slice(0,10)
  document.getElementById('lr-start').value=ts
  document.getElementById('lr-end').value=ts
  document.getElementById('lr-start').onchange=calcLRDays
  document.getElementById('lr-end').onchange=calcLRDays
  const el=document.getElementById('lr-date')
  if(el) el.textContent=t.getFullYear()+'년 '+(t.getMonth()+1)+'월 '+t.getDate()+'일'
  calcLRDays()
}
function calcLRDays(){
  const s=document.getElementById('lr-start').value
  const e=document.getElementById('lr-end').value
  const el=document.getElementById('lr-days')
  if(s&&e&&el){ const diff=Math.floor((new Date(e).getTime()-new Date(s).getTime())/86400000)+1; el.textContent=diff>0?diff+'일':'-' }
}
async function submitLR(){
  const eid=document.getElementById('lr-emp').value
  const ls=document.getElementById('lr-start').value
  const le=document.getElementById('lr-end').value
  if(!eid||!ls||!le) return toast('필수 항목을 입력하세요','e')
  const r=await fetch('/api/leave-requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    employee_id:parseInt(eid),leave_type:document.getElementById('lr-type').value,
    leave_start:ls,leave_end:le,
    reason:document.getElementById('lr-reason').innerText,
    handover:document.getElementById('lr-handover').innerText,
    applicant_sign:document.getElementById('sg-1').innerText,
    social_worker_sign:document.getElementById('sg-2').innerText,
    director_sign:document.getElementById('sg-3').innerText,
    applicant_date:'',social_worker_date:'',director_date:''
  })})
  const data=await r.json()
  if(data.ok){toast('저장 완료!','s');loadLRList()}
}
function resetLR(){
  const ts=new Date().toISOString().slice(0,10)
  document.getElementById('lr-start').value=ts
  document.getElementById('lr-end').value=ts
  ;['lr-reason','lr-handover','sg-1','sg-2','sg-3'].forEach(id=>{const el=document.getElementById(id);if(el)el.innerText=''})
  calcLRDays()
}

// ── 인쇄 함수 (탭별 분리) ──
function printMonthly(){
  document.body.classList.add('print-monthly')
  window.print()
  document.body.classList.remove('print-monthly')
}
function printPersonal(){
  document.body.classList.add('print-personal')
  window.print()
  document.body.classList.remove('print-personal')
}
function printLeave(){
  document.body.classList.add('print-leave')
  window.print()
  document.body.classList.remove('print-leave')
}
async function loadLRList(){
  const r=await fetch('/api/leave-requests?year=2026'); const data=await r.json()
  const c=document.getElementById('lr-list'); if(!c) return
  if(!data.data||!data.data.length){
    c.innerHTML='<div style="text-align:center;padding:20px;color:#9ca3af;font-size:13px;">신청서 없음</div>'; return
  }
  c.innerHTML=data.data.map(lr=>\`
    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <div style="display:flex;gap:6px;align-items:center;">
          <b style="color:#111;">\${lr.name}</b>
          <span class="bdg bdg-\${lr.leave_type}" style="font-size:11px;">\${lr.leave_type}</span>
        </div>
        <div style="display:flex;gap:5px;">
          <button onclick="openLRDetail(\${lr.id})" class="btn btn-gray btn-sm"><i class="fas fa-eye"></i></button>
          <button onclick="deleteLR(\${lr.id})" class="btn btn-red btn-sm"><i class="fas fa-trash"></i></button>
        </div>
      </div>
      <div style="font-size:12px;color:#6b7280;">\${lr.leave_start} ~ \${lr.leave_end}</div>
    </div>
  \`).join('')
}
let lrCache=[]
async function openLRDetail(id){
  if(!lrCache.length){const r=await fetch('/api/leave-requests?year=2026');const d=await r.json();lrCache=d.data||[]}
  const lr=lrCache.find(x=>x.id===id); if(!lr) return
  document.getElementById('lr-emp').value=lr.employee_id; document.getElementById('lr-emp').dispatchEvent(new Event('change'))
  document.getElementById('lr-type').value=lr.leave_type
  document.getElementById('lr-start').value=lr.leave_start
  document.getElementById('lr-end').value=lr.leave_end
  document.getElementById('lr-reason').innerText=lr.reason||''
  document.getElementById('lr-handover').innerText=lr.handover||''
  ;[['sg-1',lr.applicant_sign],['sg-2',lr.social_worker_sign],['sg-3',lr.director_sign]].forEach(([id,v])=>{const el=document.getElementById(id);if(el)el.innerText=v||''})
  calcLRDays(); toast(lr.name+' 신청서 불러옴','i')
}
async function deleteLR(id){
  if(!confirm('삭제하시겠습니까?')) return
  const r=await fetch('/api/leave-requests/'+id,{method:'DELETE'}); const data=await r.json()
  if(data.ok){toast('삭제 완료','s');lrCache=[];loadLRList()}
}

// 직원 관리
function renderEmpMgr(){
  const c=document.getElementById('emp-mgr-list'); if(!c) return
  if(!emps.length){c.innerHTML='<div style="text-align:center;padding:20px;color:#9ca3af;">직원 없음</div>';return}
  c.innerHTML=emps.map((e,i)=>\`
    <div style="display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid #f1f5f9;" id="em-\${e.id}">
      <div style="font-size:14px;color:#9ca3af;width:20px;text-align:center;">\${i+1}</div>
      <div style="flex:1;">
        <span id="em-nt-\${e.id}" style="font-weight:700;color:#111;">\${e.name}</span>
        <input id="em-ni-\${e.id}" type="text" value="\${e.name}" style="display:none;width:80px;padding:5px 8px;font-size:13px;">
        <div style="font-size:11px;color:#9ca3af;margin-top:1px;">
          <span id="em-pt-\${e.id}">\${e.position||''}</span>
          <input id="em-pi-\${e.id}" type="text" value="\${e.position||''}" style="display:none;width:100px;padding:5px 8px;font-size:12px;">
        </div>
      </div>
      <div id="em-bv-\${e.id}" style="display:flex;gap:5px;">
        <button onclick="startEmpEdit(\${e.id})" class="btn btn-gray btn-sm"><i class="fas fa-edit"></i></button>
        <button onclick="removeEmp(\${e.id})" class="btn btn-red btn-sm"><i class="fas fa-trash"></i></button>
      </div>
      <div id="em-be-\${e.id}" style="display:none;gap:5px;">
        <button onclick="saveEmpEdit(\${e.id})" class="btn btn-green btn-sm"><i class="fas fa-check"></i></button>
        <button onclick="cancelEmpEdit(\${e.id})" class="btn btn-gray btn-sm">취소</button>
      </div>
    </div>
  \`).join('')
}
function startEmpEdit(id){
  emps.forEach(e=>{if(e.id!==id)cancelEmpEdit(e.id)})
  ;['nt','ni','pt','pi'].forEach(f=>{
    const show=f.endsWith('i'); const el=document.getElementById('em-'+f+'-'+id)
    if(el) el.style.display=show?'':'none'
  })
  document.getElementById('em-bv-'+id).style.display='none'
  document.getElementById('em-be-'+id).style.display='flex'
  const ni=document.getElementById('em-ni-'+id); if(ni){ni.focus();ni.onkeydown=e=>{if(e.key==='Enter')saveEmpEdit(id)}}
}
function cancelEmpEdit(id){
  const emp=emps.find(e=>e.id===id); if(!emp) return
  ;['nt','ni','pt','pi'].forEach(f=>{
    const show=f.endsWith('t'); const el=document.getElementById('em-'+f+'-'+id)
    if(el) el.style.display=show?'':'none'
  })
  const bv=document.getElementById('em-bv-'+id); if(bv) bv.style.display='flex'
  const be=document.getElementById('em-be-'+id); if(be) be.style.display='none'
}
async function saveEmpEdit(id){
  const n=document.getElementById('em-ni-'+id).value.trim()
  const p=document.getElementById('em-pi-'+id).value.trim()
  if(!n) return toast('이름을 입력하세요','e')
  const r=await fetch('/api/employees/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,position:p||'사회복지사'})})
  const data=await r.json()
  if(data.ok){toast(n+' 수정 완료','s');await loadEmps()}else toast('오류','e')
}
async function addEmp(){
  const n=document.getElementById('ne-name').value.trim()
  const p=document.getElementById('ne-pos').value.trim()
  if(!n) return toast('이름을 입력하세요','e')
  const r=await fetch('/api/employees',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,position:p||'사회복지사'})})
  const data=await r.json()
  if(data.ok){toast(n+' 추가 완료','s');document.getElementById('ne-name').value='';document.getElementById('ne-pos').value='';await loadEmps()}
}
async function removeEmp(id){
  const emp=emps.find(e=>e.id===id)
  if(!confirm((emp?.name||id)+'을(를) 삭제하시겠습니까?')) return
  const r=await fetch('/api/employees/'+id,{method:'DELETE'}); const data=await r.json()
  if(data.ok){toast('삭제 완료','s');await loadEmps()}
}

// 토스트
function toast(msg,t='i'){
  const c=document.getElementById('toast')
  const div=document.createElement('div'); div.className='tst'
  const ic=t==='s'?'✅':t==='e'?'❌':'ℹ️'
  div.textContent=ic+' '+msg; c.appendChild(div)
  setTimeout(()=>div.remove(),2500)
}

// 앱 초기화 함수 (PIN 통과 후 / 세션 이미 있을 때 공용)
async function initApp(){
  const n=new Date(),m=n.getMonth()+1
  if(document.getElementById('mo-month')) document.getElementById('mo-month').value=m
  if(document.getElementById('pr-month')) document.getElementById('pr-month').value=m
  const KDAYS=['일요일','월요일','화요일','수요일','목요일','금요일','토요일']
  const dateStr=n.getFullYear()+'년 '+(n.getMonth()+1)+'월 '+n.getDate()+'일 ('+KDAYS[n.getDay()]+')'
  const dd=document.getElementById('dash-date'); if(dd) dd.textContent=dateStr
  const sd=document.getElementById('side-date'); if(sd) sd.textContent=dateStr
  const td=document.getElementById('top-date'); if(td) td.textContent=n.getFullYear()+'.'+(n.getMonth()+1)+'.'+n.getDate()
  setupLR()
  await loadEmps()
}

// PIN 비활성화
async function checkPin(){ await initApp() }

// 페이지 로드 시: 세션 있으면 바로 초기화, 없으면 PIN 대기
;(async()=>{ if(checkSession()) await initApp() })()
</script>
</body>
</html>`
}

export default app
