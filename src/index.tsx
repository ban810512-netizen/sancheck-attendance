import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())
app.use('/static/*', serveStatic({ root: './' }))

// ─── 직원 API ───────────────────────────────────────────
app.get('/api/employees', async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT * FROM employees WHERE is_active=1 ORDER BY id'
  ).all()
  return c.json({ ok: true, data: result.results })
})

app.post('/api/employees', async (c) => {
  const { name, position } = await c.req.json()
  if (!name) return c.json({ ok: false, error: '이름을 입력하세요' }, 400)
  const r = await c.env.DB.prepare(
    'INSERT INTO employees (name, position) VALUES (?, ?)'
  ).bind(name, position || '사회복지사').run()
  return c.json({ ok: true, id: r.meta.last_row_id })
})

app.put('/api/employees/:id', async (c) => {
  const id = c.req.param('id')
  const { name, position } = await c.req.json()
  if (!name) return c.json({ ok: false, error: '이름을 입력하세요' }, 400)
  await c.env.DB.prepare(
    'UPDATE employees SET name=?, position=? WHERE id=?'
  ).bind(name, position || '사회복지사', id).run()
  return c.json({ ok: true })
})

app.delete('/api/employees/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('UPDATE employees SET is_active=0 WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})

// ─── 근무 기록 API ──────────────────────────────────────
// 오늘 전체 상태 조회
app.get('/api/attendance/today', async (c) => {
  const today = getKSTDateStr()
  const result = await c.env.DB.prepare(`
    SELECT a.*, e.name, e.position
    FROM attendance a
    JOIN employees e ON e.id = a.employee_id
    WHERE a.work_date = ? AND e.is_active = 1
    ORDER BY e.id
  `).bind(today).all()

  // 오늘 기록 없는 직원도 포함
  const employees = await c.env.DB.prepare('SELECT * FROM employees WHERE is_active=1 ORDER BY id').all()
  const map: Record<number, any> = {}
  for (const r of (result.results as any[])) map[r.employee_id] = r
  const list = (employees.results as any[]).map(e => map[e.id] || { employee_id: e.id, name: e.name, position: e.position, work_date: today, status: null })
  return c.json({ ok: true, data: list, date: today })
})

// 출퇴근 등록/수정
app.post('/api/attendance', async (c) => {
  const body = await c.req.json()
  const { employee_id, work_date, status, check_in, check_out, note } = body

  if (!employee_id || !work_date || !status) {
    return c.json({ ok: false, error: '필수 항목 누락' }, 400)
  }

  // UPSERT
  await c.env.DB.prepare(`
    INSERT INTO attendance (employee_id, work_date, status, check_in, check_out, note, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+9 hours'))
    ON CONFLICT(employee_id, work_date) DO UPDATE SET
      status=excluded.status,
      check_in=excluded.check_in,
      check_out=excluded.check_out,
      note=excluded.note,
      updated_at=datetime('now', '+9 hours')
  `).bind(employee_id, work_date, status, check_in || null, check_out || null, note || null).run()

  return c.json({ ok: true })
})

// 월별 근무 현황
app.get('/api/attendance/monthly', async (c) => {
  const { year, month, employee_id } = c.req.query()
  if (!year || !month) return c.json({ ok: false, error: '연월 필요' }, 400)

  const ym = `${year}-${month.padStart(2, '0')}`
  let query = `
    SELECT a.*, e.name, e.position
    FROM attendance a
    JOIN employees e ON e.id = a.employee_id
    WHERE a.work_date LIKE ? AND e.is_active=1
  `
  const params: any[] = [`${ym}-%`]

  if (employee_id) {
    query += ' AND a.employee_id = ?'
    params.push(employee_id)
  }
  query += ' ORDER BY a.work_date, e.id'

  const result = await c.env.DB.prepare(query).bind(...params).all()
  return c.json({ ok: true, data: result.results })
})

// 통계 (연월별 직원 집계)
app.get('/api/stats/monthly', async (c) => {
  const { year, month } = c.req.query()
  if (!year || !month) return c.json({ ok: false, error: '연월 필요' }, 400)

  const ym = `${year}-${month.padStart(2, '0')}`
  const result = await c.env.DB.prepare(`
    SELECT
      e.id as employee_id,
      e.name,
      COUNT(CASE WHEN a.status='출근' THEN 1 END) as work_count,
      COUNT(CASE WHEN a.status='연차' THEN 1 END) as annual_leave,
      COUNT(CASE WHEN a.status='오전반차' THEN 1 END) as am_half,
      COUNT(CASE WHEN a.status='오후반차' THEN 1 END) as pm_half,
      COUNT(CASE WHEN a.status='병가' THEN 1 END) as sick_leave,
      COUNT(CASE WHEN a.status='경조휴가' THEN 1 END) as family_leave,
      COUNT(CASE WHEN a.status='공가' THEN 1 END) as official_leave,
      COUNT(a.id) as total_records
    FROM employees e
    LEFT JOIN attendance a ON a.employee_id=e.id AND a.work_date LIKE ?
    WHERE e.is_active=1
    GROUP BY e.id
    ORDER BY e.id
  `).bind(`${ym}-%`).all()

  return c.json({ ok: true, data: result.results })
})

// 연도별 누적 연차/반차 통계
app.get('/api/stats/yearly', async (c) => {
  const { year } = c.req.query()
  const y = year || '2026'
  const result = await c.env.DB.prepare(`
    SELECT
      e.id as employee_id,
      e.name,
      COUNT(CASE WHEN a.status='연차' THEN 1 END) as annual_leave,
      COUNT(CASE WHEN a.status='오전반차' THEN 1 END) as am_half,
      COUNT(CASE WHEN a.status='오후반차' THEN 1 END) as pm_half,
      ROUND(COUNT(CASE WHEN a.status='연차' THEN 1 END) +
        (COUNT(CASE WHEN a.status='오전반차' THEN 1 END) + COUNT(CASE WHEN a.status='오후반차' THEN 1 END)) * 0.5, 1) as total_leave_days,
      COUNT(CASE WHEN a.status='병가' THEN 1 END) as sick_leave,
      COUNT(CASE WHEN a.status='경조휴가' THEN 1 END) as family_leave,
      COUNT(CASE WHEN a.status='공가' THEN 1 END) as official_leave
    FROM employees e
    LEFT JOIN attendance a ON a.employee_id=e.id AND a.work_date LIKE ?
    WHERE e.is_active=1
    GROUP BY e.id
    ORDER BY e.id
  `).bind(`${y}-%`).all()

  return c.json({ ok: true, data: result.results })
})

// ─── 연차 신청서 API ────────────────────────────────────
app.get('/api/leave-requests', async (c) => {
  const { employee_id, year } = c.req.query()
  let query = `
    SELECT lr.*, e.name
    FROM leave_requests lr
    JOIN employees e ON e.id = lr.employee_id
    WHERE 1=1
  `
  const params: any[] = []
  if (employee_id) { query += ' AND lr.employee_id=?'; params.push(employee_id) }
  if (year) { query += ' AND lr.leave_start LIKE ?'; params.push(`${year}-%`) }
  query += ' ORDER BY lr.created_at DESC'

  const result = await c.env.DB.prepare(query).bind(...params).all()
  return c.json({ ok: true, data: result.results })
})

app.post('/api/leave-requests', async (c) => {
  const b = await c.req.json()
  const r = await c.env.DB.prepare(`
    INSERT INTO leave_requests
      (employee_id, leave_start, leave_end, leave_type, reason, handover,
       applicant_sign, applicant_date, social_worker_sign, social_worker_date,
       director_sign, director_date, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    b.employee_id, b.leave_start, b.leave_end, b.leave_type,
    b.reason || '', b.handover || '',
    b.applicant_sign || '', b.applicant_date || '',
    b.social_worker_sign || '', b.social_worker_date || '',
    b.director_sign || '', b.director_date || '',
    b.status || 'pending'
  ).run()
  return c.json({ ok: true, id: r.meta.last_row_id })
})

app.put('/api/leave-requests/:id', async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json()
  await c.env.DB.prepare(`
    UPDATE leave_requests SET
      leave_start=?, leave_end=?, leave_type=?, reason=?, handover=?,
      applicant_sign=?, applicant_date=?,
      social_worker_sign=?, social_worker_date=?,
      director_sign=?, director_date=?,
      status=?
    WHERE id=?
  `).bind(
    b.leave_start, b.leave_end, b.leave_type, b.reason || '', b.handover || '',
    b.applicant_sign || '', b.applicant_date || '',
    b.social_worker_sign || '', b.social_worker_date || '',
    b.director_sign || '', b.director_date || '',
    b.status || 'pending', id
  ).run()
  return c.json({ ok: true })
})

app.delete('/api/leave-requests/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM leave_requests WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})

// ─── 메인 SPA ───────────────────────────────────────────
app.get('/', (c) => c.html(getHTML()))
app.get('*', (c) => c.html(getHTML()))

// ─── 유틸 ───────────────────────────────────────────────
function getKSTDateStr(): string {
  const now = new Date()
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  return kst.toISOString().slice(0, 10)
}


function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>산청인애노인통합지원센터 근무상황부</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700;800&display=swap');
*{font-family:'Noto Sans KR',sans-serif;box-sizing:border-box;}
:root{
  --primary:#2563eb;--primary-dark:#1d4ed8;--primary-light:#eff6ff;
  --success:#16a34a;--warning:#d97706;--danger:#dc2626;--info:#0891b2;
  --gray-50:#f9fafb;--gray-100:#f3f4f6;--gray-200:#e5e7eb;--gray-600:#4b5563;--gray-800:#1f2937;
}
/* 상태 배지 */
.badge{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap;}
.badge-출근{background:#dcfce7;color:#15803d;}
.badge-퇴근{background:#dbeafe;color:#1d4ed8;}
.badge-연차{background:#fef3c7;color:#b45309;}
.badge-오전반차{background:#ede9fe;color:#6d28d9;}
.badge-오후반차{background:#fce7f3;color:#9d174d;}
.badge-병가{background:#fee2e2;color:#b91c1c;}
.badge-경조휴가{background:#ffedd5;color:#c2410c;}
.badge-공가{background:#e0f2fe;color:#0369a1;}
.badge-휴무{background:#f3f4f6;color:#6b7280;}
.badge-미등록{background:#f1f5f9;color:#94a3b8;}

/* 탭 */
.tab-btn{padding:10px 20px;font-size:14px;font-weight:500;border-radius:8px;cursor:pointer;border:none;background:transparent;color:#6b7280;transition:all .2s;white-space:nowrap;}
.tab-btn:hover{background:#f1f5f9;color:#1e40af;}
.tab-btn.active{background:#2563eb;color:#fff;box-shadow:0 2px 8px rgba(37,99,235,.3);}

/* 카드 */
.card{background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,.08),0 4px 16px rgba(0,0,0,.04);border:1px solid #f1f5f9;}
.stat-card{border-radius:14px;padding:20px 24px;position:relative;overflow:hidden;}

/* 직원 카드 */
.emp-card{background:#fff;border-radius:16px;border:2px solid #e5e7eb;padding:20px 16px;cursor:pointer;transition:all .22s;text-align:center;position:relative;}
.emp-card:hover{border-color:#2563eb;box-shadow:0 8px 24px rgba(37,99,235,.15);transform:translateY(-2px);}
.emp-card.selected{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15);}
.emp-avatar{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;margin:0 auto 10px;}

/* 등록 패널 */
.reg-panel{background:#fff;border-radius:16px;border:2px solid #2563eb;box-shadow:0 8px 32px rgba(37,99,235,.12);padding:24px;margin-top:16px;}
.status-pill{padding:8px 16px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;border:2px solid transparent;transition:all .15s;text-align:center;}
.status-pill:hover{transform:scale(1.04);}
.status-pill.selected{border-color:#1d4ed8;box-shadow:0 0 0 2px rgba(37,99,235,.3);}

/* 인쇄 스타일 */
@media print{
  .no-print{display:none!important;}
  body{background:#fff;}
  .page-break{page-break-after:always;}
  /* 연차신청서 인쇄 */
  .leave-form-print{font-family:'Noto Sans KR',sans-serif;}
}

/* 연차신청서 */
.approval-wrap{display:flex;justify-content:flex-end;margin-bottom:16px;}
.approval-table{border-collapse:collapse;width:280px;}
.approval-table th,.approval-table td{border:1px solid #374151;padding:0;text-align:center;}
.approval-table .ap-label{background:#e5e7eb;font-size:11px;font-weight:700;padding:5px;color:#374151;}
.approval-table .ap-sign{height:64px;font-size:12px;vertical-align:top;padding:4px;position:relative;}
.approval-table .ap-date{font-size:10px;color:#6b7280;border-top:1px solid #d1d5db;padding:3px;background:#fafafa;}

.form-table{border-collapse:collapse;width:100%;margin-bottom:12px;}
.form-table th,.form-table td{border:1px solid #374151;padding:8px 12px;font-size:13px;}
.form-table th{background:#f8fafc;font-weight:700;color:#1e40af;white-space:nowrap;width:130px;text-align:left;}
.form-table td{color:#111827;}
.form-table [contenteditable]{outline:none;min-height:20px;}
.form-table [contenteditable]:focus{background:#fffbeb;}

/* 통계 테이블 */
.stats-tbl{border-collapse:collapse;width:100%;}
.stats-tbl th{background:linear-gradient(135deg,#1e40af,#2563eb);color:#fff;padding:10px 14px;font-size:12px;font-weight:600;text-align:center;}
.stats-tbl td{padding:9px 14px;font-size:13px;text-align:center;border-bottom:1px solid #f1f5f9;}
.stats-tbl tr:hover td{background:#f8fafc;}
.stats-tbl .name-cell{font-weight:700;color:#1e40af;text-align:left;}
.progress-bar{height:6px;border-radius:3px;background:#e5e7eb;overflow:hidden;}
.progress-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,#2563eb,#7c3aed);transition:width .4s;}

/* 월별 테이블 */
table.monthly-tbl{border-collapse:collapse;width:100%;font-size:12px;}
table.monthly-tbl th{background:#1e3a8a;color:#fff;padding:7px 4px;text-align:center;border:1px solid #1e40af;}
table.monthly-tbl td{border:1px solid #e2e8f0;padding:5px 4px;text-align:center;}
table.monthly-tbl tr.weekend{background:#fef2f2;}
table.monthly-tbl tr.holiday{background:#fff7ed;}

/* 입력 필드 */
input[type=text],input[type=date],select,textarea{
  border:1.5px solid #d1d5db;border-radius:8px;padding:8px 12px;
  width:100%;font-size:14px;transition:border-color .15s;outline:none;background:#fff;
}
input[type=text]:focus,input[type=date]:focus,select:focus,textarea:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1);}
label.form-label{display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:4px;}
.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all .15s;}
.btn-primary{background:#2563eb;color:#fff;}
.btn-primary:hover{background:#1d4ed8;box-shadow:0 4px 12px rgba(37,99,235,.3);}
.btn-success{background:#16a34a;color:#fff;}
.btn-success:hover{background:#15803d;}
.btn-gray{background:#f3f4f6;color:#374151;}
.btn-gray:hover{background:#e5e7eb;}
.btn-danger{background:#fee2e2;color:#b91c1c;}
.btn-danger:hover{background:#fecaca;}
.btn-sm{padding:6px 12px;font-size:12px;border-radius:7px;}

/* 알림 */
#toast{position:fixed;bottom:24px;right:24px;z-index:9999;}
.toast-item{display:flex;align-items:center;gap:10px;padding:14px 20px;border-radius:12px;color:#fff;font-size:14px;font-weight:500;box-shadow:0 8px 24px rgba(0,0,0,.15);margin-top:8px;animation:slideIn .2s ease;}
@keyframes slideIn{from{transform:translateX(60px);opacity:0;}to{transform:translateX(0);opacity:1;}}
.clock-display{font-size:2rem;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:2px;color:#1e40af;}

/* 사이드바 레이아웃 */
.app-layout{display:flex;min-height:100vh;}
.sidebar{width:220px;background:linear-gradient(180deg,#1e3a8a 0%,#1e40af 60%,#2563eb 100%);flex-shrink:0;display:flex;flex-direction:column;}
.main-content{flex:1;overflow:auto;background:#f1f5f9;}
@media(max-width:768px){
  .sidebar{width:60px;}
  .sidebar .nav-text{display:none;}
  .sidebar .site-name{display:none;}
  .main-content{margin-left:0;}
}
.nav-item{display:flex;align-items:center;gap:12px;padding:12px 20px;color:rgba(255,255,255,.75);cursor:pointer;transition:all .2s;border-radius:0;border-left:3px solid transparent;}
.nav-item:hover{background:rgba(255,255,255,.1);color:#fff;}
.nav-item.active{background:rgba(255,255,255,.18);color:#fff;border-left-color:#93c5fd;font-weight:700;}
.nav-item i{width:20px;text-align:center;font-size:15px;}
</style>
</head>
<body style="margin:0;background:#f1f5f9;">

<div class="app-layout">

<!-- ══════ 사이드바 ══════ -->
<aside class="sidebar no-print">
  <div style="padding:24px 20px 16px;">
    <div class="site-name" style="color:#bfdbfe;font-size:11px;font-weight:600;letter-spacing:.5px;margin-bottom:4px;">산청인애노인통합지원센터</div>
    <div style="color:#fff;font-size:13px;font-weight:700;">2026 근무상황부</div>
  </div>
  <div style="margin:0 12px;height:1px;background:rgba(255,255,255,.15);margin-bottom:8px;"></div>
  <nav style="flex:1;padding:8px 0;">
    <div class="nav-item active" onclick="showTab('dashboard')" id="nav-dashboard">
      <i class="fas fa-th-large"></i><span class="nav-text">대시보드</span>
    </div>
    <div class="nav-item" onclick="showTab('monthly')" id="nav-monthly">
      <i class="fas fa-calendar-alt"></i><span class="nav-text">월별 근무현황</span>
    </div>
    <div class="nav-item" onclick="showTab('leave')" id="nav-leave">
      <i class="fas fa-file-signature"></i><span class="nav-text">연차 신청서</span>
    </div>
    <div class="nav-item" onclick="showTab('print')" id="nav-print">
      <i class="fas fa-print"></i><span class="nav-text">개인별 출력</span>
    </div>
    <div class="nav-item" onclick="showTab('stats')" id="nav-stats">
      <i class="fas fa-chart-bar"></i><span class="nav-text">통계</span>
    </div>
    <div class="nav-item" onclick="showTab('employees')" id="nav-employees">
      <i class="fas fa-users-cog"></i><span class="nav-text">직원 관리</span>
    </div>
  </nav>
  <div style="padding:16px 20px;border-top:1px solid rgba(255,255,255,.1);">
    <div id="sidebarClock" style="color:#bfdbfe;font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:2px;"></div>
    <div id="sidebarDate" style="color:rgba(255,255,255,.5);font-size:11px;margin-top:2px;"></div>
  </div>
</aside>

<!-- ══════ 메인 콘텐츠 ══════ -->
<div class="main-content">

<!-- 상단 헤더 -->
<div class="no-print" style="background:#fff;border-bottom:1px solid #e5e7eb;padding:14px 28px;display:flex;align-items:center;justify-content:space-between;">
  <div style="font-size:18px;font-weight:800;color:#1e3a8a;" id="pageTitle">대시보드</div>
  <div style="display:flex;align-items:center;gap:12px;">
    <span id="todayBadge" style="background:#eff6ff;color:#1d4ed8;padding:5px 14px;border-radius:20px;font-size:13px;font-weight:600;"></span>
  </div>
</div>

<div style="padding:24px 28px;">

<!-- ══════════════════════════════════════════════
     대시보드 탭
══════════════════════════════════════════════ -->
<div id="page-dashboard">

  <!-- 직원 카드 그리드 + 등록 패널 -->
  <div class="card" style="padding:24px;margin-bottom:24px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
      <div>
        <div style="font-size:16px;font-weight:800;color:#1e3a8a;">직원 출퇴근 현황</div>
        <div style="font-size:13px;color:#6b7280;margin-top:2px;">카드를 클릭하면 출퇴근 등록 패널이 열립니다</div>
      </div>
      <button onclick="loadCardStatuses()" class="btn btn-gray btn-sm"><i class="fas fa-sync-alt"></i> 새로고침</button>
    </div>
    <div id="emp-cards" style="display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:0;"></div>

    <!-- 등록 패널 -->
    <div id="reg-panel" style="display:none;margin-top:20px;">
      <div class="reg-panel">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <div style="font-size:15px;font-weight:800;color:#1e3a8a;">
            <i class="fas fa-pencil-alt" style="color:#2563eb;margin-right:8px;"></i>
            <span id="reg-emp-name" style="color:#2563eb;"></span> 출퇴근 등록
          </div>
          <button onclick="closeRegPanel()" style="background:#f1f5f9;border:none;border-radius:8px;padding:6px 12px;cursor:pointer;color:#6b7280;font-size:13px;">✕ 닫기</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
          <div>
            <label class="form-label">날짜</label>
            <input type="date" id="reg-date">
          </div>
          <div>
            <label class="form-label">시간 <span style="font-size:11px;color:#9ca3af;">(HH:MM)</span></label>
            <input type="text" id="reg-time" placeholder="08:35" maxlength="5">
          </div>
        </div>
        <div style="margin-bottom:16px;">
          <label class="form-label">근무 상태 선택</label>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">
            <div class="status-pill badge-출근" onclick="setStatus('출근',this)">✅ 출근</div>
            <div class="status-pill badge-퇴근" onclick="setStatus('퇴근',this)">🔵 퇴근</div>
            <div class="status-pill badge-오전반차" onclick="setStatus('오전반차',this)">🟣 오전반차</div>
            <div class="status-pill badge-오후반차" onclick="setStatus('오후반차',this)">🩷 오후반차</div>
            <div class="status-pill badge-연차" onclick="setStatus('연차',this)">🟡 연차</div>
            <div class="status-pill badge-병가" onclick="setStatus('병가',this)">🔴 병가</div>
            <div class="status-pill badge-경조휴가" onclick="setStatus('경조휴가',this)">🟠 경조휴가</div>
            <div class="status-pill badge-공가" onclick="setStatus('공가',this)">🔷 공가</div>
          </div>
          <input type="hidden" id="reg-status">
          <input type="hidden" id="reg-employee">
        </div>
        <div style="margin-bottom:16px;">
          <label class="form-label">메모 <span style="font-size:11px;color:#9ca3af;">(선택)</span></label>
          <input type="text" id="reg-note" placeholder="비고 입력">
        </div>
        <div id="reg-status-display" style="height:28px;margin-bottom:12px;display:flex;align-items:center;justify-content:center;"></div>
        <button onclick="submitAttendance()" class="btn btn-primary" style="width:100%;justify-content:center;padding:12px;">
          <i class="fas fa-check-circle"></i> 등록하기
        </button>
      </div>
    </div>
  </div>

</div>


<!-- ══════════════════════════════════════════════
     월별 근무현황 탭
══════════════════════════════════════════════ -->
<div id="page-monthly" style="display:none;">
  <div class="card" style="padding:24px;">
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:20px;" class="no-print">
      <select id="monthly-year" style="width:120px;">
        <option value="2026" selected>2026년</option>
        <option value="2025">2025년</option>
      </select>
      <select id="monthly-month" style="width:100px;">
        ${Array.from({length:12},(_,i)=>`<option value="${i+1}">${i+1}월</option>`).join('')}
      </select>
      <button onclick="loadMonthly()" class="btn btn-primary"><i class="fas fa-search"></i> 조회</button>
      <button onclick="window.print()" class="btn btn-gray no-print"><i class="fas fa-print"></i> 인쇄</button>
    </div>
    <div id="monthly-table" style="overflow-x:auto;"></div>
  </div>
</div>


<!-- ══════════════════════════════════════════════
     연차 신청서 탭
══════════════════════════════════════════════ -->
<div id="page-leave" style="display:none;">
  <div style="display:grid;grid-template-columns:1fr 340px;gap:20px;align-items:start;">

    <!-- 신청서 작성 영역 -->
    <div class="card" style="padding:28px;" id="leave-form-area">
      <!-- 공문서 양식 헤더 -->
      <div style="text-align:center;margin-bottom:20px;border-bottom:3px double #1e3a8a;padding-bottom:16px;">
        <div style="font-size:13px;color:#6b7280;margin-bottom:4px;">산청인애노인통합지원센터</div>
        <div style="font-size:24px;font-weight:900;color:#1e3a8a;letter-spacing:8px;">연차사용신청서</div>
      </div>

      <!-- 결재란 (우상단) -->
      <div style="display:flex;justify-content:flex-end;margin-bottom:20px;" class="no-print">
        <div style="border:2px solid #1e3a8a;display:grid;grid-template-columns:repeat(3,80px);">
          <div style="background:#dbeafe;text-align:center;padding:5px 0;font-size:11px;font-weight:700;color:#1e3a8a;border-right:1px solid #1e3a8a;">담&nbsp;&nbsp;&nbsp;당</div>
          <div style="background:#dbeafe;text-align:center;padding:5px 0;font-size:11px;font-weight:700;color:#1e3a8a;border-right:1px solid #1e3a8a;">전문사회복지사</div>
          <div style="background:#dbeafe;text-align:center;padding:5px 0;font-size:11px;font-weight:700;color:#1e3a8a;">센&nbsp;터&nbsp;장</div>
          <div style="border-top:1px solid #1e3a8a;border-right:1px solid #1e3a8a;height:64px;padding:4px;font-size:11px;color:#374151;">
            <div id="sign-applicant-view" contenteditable="true" style="height:100%;outline:none;font-size:11px;"></div>
          </div>
          <div style="border-top:1px solid #1e3a8a;border-right:1px solid #1e3a8a;height:64px;padding:4px;font-size:11px;color:#374151;">
            <div id="sign-social-view" contenteditable="true" style="height:100%;outline:none;font-size:11px;"></div>
          </div>
          <div style="border-top:1px solid #1e3a8a;height:64px;padding:4px;font-size:11px;color:#374151;">
            <div id="sign-director-view" contenteditable="true" style="height:100%;outline:none;font-size:11px;"></div>
          </div>
        </div>
      </div>

      <!-- 신청서 본문 테이블 -->
      <table class="form-table">
        <tr>
          <th>소&nbsp;&nbsp;&nbsp;&nbsp;속</th>
          <td colspan="3">산청인애노인통합지원센터</td>
        </tr>
        <tr>
          <th>신&nbsp;청&nbsp;자</th>
          <td style="width:160px;">
            <select id="lr-employee" style="border:none;background:transparent;font-weight:700;font-size:14px;color:#1e3a8a;padding:0;cursor:pointer;width:100%;"></select>
          </td>
          <th style="width:130px;">직&nbsp;&nbsp;&nbsp;&nbsp;책</th>
          <td id="lr-position" style="color:#374151;font-weight:500;">-</td>
        </tr>
        <tr>
          <th>휴가구분</th>
          <td colspan="3">
            <select id="lr-type" style="border:none;background:transparent;font-weight:700;font-size:14px;color:#1e3a8a;padding:0;cursor:pointer;width:auto;">
              <option value="연차">연차</option>
              <option value="오전반차">오전반차</option>
              <option value="오후반차">오후반차</option>
              <option value="경조휴가">경조휴가</option>
              <option value="병가">병가</option>
              <option value="공가">공가</option>
              <option value="기타">기타</option>
            </select>
          </td>
        </tr>
        <tr>
          <th>휴가기간</th>
          <td>
            <input type="date" id="lr-start" style="border:none;background:transparent;padding:0;font-size:14px;width:auto;">
          </td>
          <th>종&nbsp;료&nbsp;일</th>
          <td>
            <input type="date" id="lr-end" style="border:none;background:transparent;padding:0;font-size:14px;width:auto;">
          </td>
        </tr>
        <tr>
          <th>총&nbsp;일&nbsp;수</th>
          <td colspan="3" id="lr-days-display" style="font-weight:700;color:#dc2626;">-</td>
        </tr>
        <tr>
          <th>사&nbsp;&nbsp;&nbsp;&nbsp;유</th>
          <td colspan="3">
            <div id="lr-reason" contenteditable="true" style="min-height:36px;outline:none;padding:2px;color:#111827;" placeholder="사유를 입력하세요"></div>
          </td>
        </tr>
        <tr>
          <th>업무인수인계</th>
          <td colspan="3">
            <div id="lr-handover" contenteditable="true" style="min-height:60px;outline:none;padding:2px;color:#111827;"></div>
          </td>
        </tr>
      </table>

      <div style="text-align:center;margin:16px 0;font-size:13px;color:#374151;line-height:1.8;">
        위와 같이 휴가 사용을 신청합니다.<br>
        <span id="lr-submit-date" style="font-weight:700;"></span>
      </div>

      <div style="text-align:right;font-size:13px;color:#374151;margin-bottom:20px;">
        산청인애노인통합지원센터장 귀중
      </div>

      <div style="display:flex;gap:10px;justify-content:center;" class="no-print">
        <button onclick="submitLeaveRequest()" class="btn btn-primary"><i class="fas fa-save"></i> 저장</button>
        <button onclick="printLeaveForm()" class="btn btn-gray"><i class="fas fa-print"></i> 인쇄</button>
        <button onclick="resetLeaveForm()" class="btn btn-gray"><i class="fas fa-redo"></i> 초기화</button>
      </div>
    </div>

    <!-- 신청서 목록 -->
    <div class="card" style="padding:20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div style="font-size:14px;font-weight:800;color:#1e3a8a;"><i class="fas fa-list" style="margin-right:6px;"></i>신청서 목록</div>
        <button onclick="loadLeaveRequests()" class="btn btn-gray btn-sm"><i class="fas fa-sync-alt"></i></button>
      </div>
      <div id="leave-list" style="max-height:calc(100vh - 280px);overflow-y:auto;"></div>
    </div>
  </div>
</div>


<!-- ══════════════════════════════════════════════
     개인별 출력 탭
══════════════════════════════════════════════ -->
<div id="page-print" style="display:none;">
  <div class="card" style="padding:24px;">
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:20px;" class="no-print">
      <select id="print-employee" style="width:130px;"><option value="">직원 선택</option></select>
      <select id="print-year" style="width:110px;"><option value="2026" selected>2026년</option></select>
      <select id="print-month" style="width:100px;">
        ${Array.from({length:12},(_,i)=>`<option value="${i+1}">${i+1}월</option>`).join('')}
      </select>
      <button onclick="loadPrint()" class="btn btn-primary"><i class="fas fa-eye"></i> 미리보기</button>
      <button onclick="window.print()" class="btn btn-success no-print"><i class="fas fa-print"></i> 인쇄</button>
    </div>
    <div id="print-area"></div>
  </div>
</div>


<!-- ══════════════════════════════════════════════
     통계 탭
══════════════════════════════════════════════ -->
<div id="page-stats" style="display:none;">
  <!-- 탭 내부 (월별/연간) -->
  <div class="card" style="padding:24px;margin-bottom:20px;">
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:20px;">
      <select id="stats-year" style="width:110px;"><option value="2026" selected>2026년</option><option value="2025">2025년</option></select>
      <select id="stats-month" style="width:110px;">
        <option value="">연간 통계</option>
        ${Array.from({length:12},(_,i)=>`<option value="${i+1}">${i+1}월</option>`).join('')}
      </select>
      <button onclick="loadStats()" class="btn btn-primary"><i class="fas fa-chart-bar"></i> 조회</button>
    </div>
    <div id="stats-table"></div>
  </div>

  <!-- 연간 연차 현황 (개인별 발생/사용/잔여) -->
  <div class="card" style="padding:24px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <div style="font-size:15px;font-weight:800;color:#1e3a8a;"><i class="fas fa-calendar-check" style="color:#2563eb;margin-right:8px;"></i>개인별 연간 연차 현황</div>
      <div style="display:flex;gap:10px;align-items:center;">
        <select id="annual-year" style="width:110px;"><option value="2026" selected>2026년</option><option value="2025">2025년</option></select>
        <button onclick="loadAnnualLeave()" class="btn btn-primary btn-sm"><i class="fas fa-sync-alt"></i> 조회</button>
      </div>
    </div>
    <div id="annual-leave-table"></div>
    <div style="margin-top:14px;padding:12px 16px;background:#fffbeb;border-radius:10px;border-left:4px solid #f59e0b;">
      <div style="font-size:12px;color:#92400e;font-weight:600;margin-bottom:6px;"><i class="fas fa-info-circle"></i> 연차 발생 기준 안내</div>
      <div style="font-size:12px;color:#78350f;line-height:1.7;">
        · 1년 미만 근로자: 매월 1일 발생 (최대 11일)<br>
        · 1년 이상 3년 미만: 15일 발생<br>
        · 3년 이상: 2년마다 1일 추가 (최대 25일)<br>
        · 반차 2회 = 연차 1일로 환산
      </div>
    </div>
  </div>
</div>


<!-- ══════════════════════════════════════════════
     직원 관리 탭
══════════════════════════════════════════════ -->
<div id="page-employees" style="display:none;">
  <div class="card" style="padding:24px;">
    <div style="font-size:15px;font-weight:800;color:#1e3a8a;margin-bottom:20px;"><i class="fas fa-users-cog" style="color:#2563eb;margin-right:8px;"></i>직원 관리</div>
    <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">
      <input type="text" id="new-employee-name" placeholder="직원 이름" style="flex:1;min-width:140px;">
      <input type="text" id="new-employee-pos" placeholder="직책 (예: 사회복지사)" style="flex:1;min-width:160px;">
      <button onclick="addEmployee()" class="btn btn-primary"><i class="fas fa-plus"></i> 직원 추가</button>
    </div>
    <div id="employee-list"></div>
  </div>
</div>

</div><!-- /padding -->
</div><!-- /main-content -->
</div><!-- /app-layout -->

<!-- 알림 토스트 -->
<div id="toast"></div>

<script>
// ══════════════════════════════════════════════
// 전역 상태
// ══════════════════════════════════════════════
let employees = []
let selectedStatus = ''
const DAYS = ['일','월','화','수','목','금','토']
const AVATARCOLORS = [
  ['#dbeafe','#1d4ed8'],['#dcfce7','#15803d'],['#fce7f3','#9d174d'],
  ['#fef3c7','#b45309'],['#e0f2fe','#0369a1']
]

// ══════════════════════════════════════════════
// 초기화
// ══════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  startClock()
  setDefaultDate()
  setLrSubmitDate()
  await loadEmployees()
  loadCardStatuses()
})

function startClock() {
  function tick() {
    const now = new Date()
    const h = String(now.getHours()).padStart(2,'0')
    const m = String(now.getMinutes()).padStart(2,'0')
    const s = String(now.getSeconds()).padStart(2,'0')
    const el = document.getElementById('sidebarClock')
    if(el) el.textContent = h+':'+m+':'+s
  }
  tick(); setInterval(tick,1000)
}

function setDefaultDate() {
  const today = new Date()
  const str = today.toISOString().slice(0,10)
  const el = document.getElementById('reg-date')
  if(el) el.value = str

  // 상단 날짜 배지
  const badge = document.getElementById('todayBadge')
  const sideDate = document.getElementById('sidebarDate')
  const formatted = today.getFullYear()+'년 '+(today.getMonth()+1)+'월 '+today.getDate()+'일 ('+DAYS[today.getDay()]+')'
  if(badge) badge.textContent = formatted
  if(sideDate) sideDate.textContent = (today.getMonth()+1)+'월 '+today.getDate()+'일 '+DAYS[today.getDay()]+'요일'
}

function setLrSubmitDate() {
  const today = new Date()
  const el = document.getElementById('lr-submit-date')
  if(el) el.textContent = today.getFullYear()+'년 '+(today.getMonth()+1)+'월 '+today.getDate()+'일'
  const s = document.getElementById('lr-start')
  const e = document.getElementById('lr-end')
  if(s) s.value = today.toISOString().slice(0,10)
  if(e) e.value = today.toISOString().slice(0,10)
  // 날짜 변경 시 일수 업데이트
  if(s) s.onchange = calcLrDays
  if(e) e.onchange = calcLrDays
}

function calcLrDays() {
  const s = document.getElementById('lr-start')?.value
  const e = document.getElementById('lr-end')?.value
  const el = document.getElementById('lr-days-display')
  if(!s||!e||!el) return
  const diff = Math.floor((new Date(e)-new Date(s))/(86400000))+1
  el.textContent = diff > 0 ? diff+'일' : '-'
}

// ══════════════════════════════════════════════
// 사이드바 탭 전환
// ══════════════════════════════════════════════
const PAGE_TITLES = {
  dashboard:'대시보드', monthly:'월별 근무현황', leave:'연차 신청서',
  print:'개인별 출력', stats:'통계', employees:'직원 관리'
}
function showTab(name) {
  ['dashboard','monthly','leave','print','stats','employees'].forEach(t => {
    const pg = document.getElementById('page-'+t)
    if(pg) pg.style.display = t===name?'':'none'
    const nv = document.getElementById('nav-'+t)
    if(nv) nv.classList.toggle('active', t===name)
  })
  const pt = document.getElementById('pageTitle')
  if(pt) pt.textContent = PAGE_TITLES[name]||''
  if(name==='monthly') loadMonthly()
  if(name==='stats') { loadStats(); loadAnnualLeave() }
  if(name==='leave') loadLeaveRequests()
}

// ══════════════════════════════════════════════
// KPI 카드
// ══════════════════════════════════════════════
async function loadKPI() {
  const today = new Date()
  const year = today.getFullYear()
  const month = today.getMonth()+1

  // 오늘 출근 수
  try {
    const r = await fetch('/api/attendance/today')
    const d = await r.json()
    const cnt = (d.data||[]).filter(x=>x.status==='출근').length
    const el = document.getElementById('kpi-checkin')
    if(el) el.textContent = cnt
  } catch(e){}

  // 이번달 통계
  try {
    const r = await fetch('/api/stats/monthly?year='+year+'&month='+month)
    const d = await r.json()
    let annual=0, half=0, sick=0
    ;(d.data||[]).forEach(x=>{
      annual += (x.annual_leave||0)
      half += (x.am_half||0)+(x.pm_half||0)
      sick += (x.sick_leave||0)
    })
    const ea = document.getElementById('kpi-annual')
    const eh = document.getElementById('kpi-half')
    const es = document.getElementById('kpi-sick')
    if(ea) ea.textContent = annual
    if(eh) eh.textContent = half
    if(es) es.textContent = sick
  } catch(e){}
}

// ══════════════════════════════════════════════
// 이번달 요약 테이블
// ══════════════════════════════════════════════
async function loadMonthSummaryTable() {
  const today = new Date()
  const year = today.getFullYear()
  const month = today.getMonth()+1
  const r = await fetch('/api/stats/monthly?year='+year+'&month='+month)
  const d = await r.json()
  const container = document.getElementById('month-summary-table')
  if(!d.data||!container) return

  let html = \`<table class="stats-tbl"><thead><tr>
    <th>성명</th><th>출근일수</th><th>연차</th><th>오전반차</th><th>오후반차</th><th>병가</th><th>경조휴가</th><th>공가</th>
  </tr></thead><tbody>\`
  d.data.forEach(row => {
    html += \`<tr>
      <td class="name-cell">\${row.name}</td>
      <td><span style="font-weight:700;color:#15803d;">\${row.work_count||0}</span></td>
      <td><span style="color:#b45309;">\${row.annual_leave||0}일</span></td>
      <td>\${row.am_half||0}</td><td>\${row.pm_half||0}</td>
      <td style="color:#dc2626;">\${row.sick_leave||0}</td>
      <td>\${row.family_leave||0}</td><td>\${row.official_leave||0}</td>
    </tr>\`
  })
  html += '</tbody></table>'
  container.innerHTML = html
}

// ══════════════════════════════════════════════
// 직원 로드 & 카드 렌더링
// ══════════════════════════════════════════════
async function loadEmployees() {
  const r = await fetch('/api/employees')
  const d = await r.json()
  employees = d.data || []

  // 셀렉트 채우기
  ;['print-employee','lr-employee'].forEach(id => {
    const el = document.getElementById(id)
    if(!el) return
    const prev = el.value
    el.innerHTML = '<option value="">-- 선택 --</option>'
    employees.forEach(e => { el.innerHTML += \`<option value="\${e.id}">\${e.name}</option>\` })
    if(prev) el.value = prev
  })

  // lr-employee 선택 시 직책 표시
  const lrEmp = document.getElementById('lr-employee')
  if(lrEmp) {
    lrEmp.onchange = function() {
      const emp = employees.find(e=>e.id==this.value)
      const pos = document.getElementById('lr-position')
      if(pos) pos.textContent = emp ? emp.position : '-'
    }
    if(employees.length>0) {
      lrEmp.value = employees[0].id
      lrEmp.dispatchEvent(new Event('change'))
    }
  }

  renderEmpCards()
  renderEmployeeList()
}

function renderEmpCards() {
  const container = document.getElementById('emp-cards')
  if(!container) return
  container.innerHTML = employees.map((e,i) => {
    const [bg,fg] = AVATARCOLORS[i % AVATARCOLORS.length]
    return \`<div class="emp-card" id="emp-card-\${e.id}" onclick="openRegPanel(\${e.id},'\${e.name}','\${e.position}')">
      <div class="emp-avatar" style="background:\${bg};color:\${fg};">\${e.name.charAt(0)}</div>
      <div style="font-size:14px;font-weight:700;color:#1f2937;margin-bottom:4px;">\${e.name}</div>
      <div style="font-size:11px;color:#6b7280;margin-bottom:8px;">\${e.position||''}</div>
      <div id="emp-card-status-\${e.id}" class="badge badge-미등록" style="font-size:11px;">미등록</div>
    </div>\`
  }).join('')
  loadCardStatuses()
}

async function loadCardStatuses() {
  try {
    const r = await fetch('/api/attendance/today')
    const d = await r.json()
    ;(d.data||[]).forEach(a => {
      const el = document.getElementById('emp-card-status-'+a.employee_id)
      if(!el) return
      if(a.status) {
        el.className = 'badge badge-'+a.status
        el.textContent = a.status
        const card = document.getElementById('emp-card-'+a.employee_id)
        if(card && a.status==='출근') card.style.borderColor='#16a34a'
      }
    })
  } catch(e) {}
}

function openRegPanel(id, name, pos) {
  // 선택된 카드 강조
  document.querySelectorAll('.emp-card').forEach(c=>c.classList.remove('selected'))
  const card = document.getElementById('emp-card-'+id)
  if(card) card.classList.add('selected')

  document.getElementById('reg-employee').value = id
  document.getElementById('reg-emp-name').textContent = name
  document.getElementById('reg-status').value = ''
  document.getElementById('reg-status-display').innerHTML = ''
  document.getElementById('reg-note').value = ''
  document.querySelectorAll('.status-pill').forEach(p=>p.classList.remove('selected'))

  const today = new Date().toISOString().slice(0,10)
  document.getElementById('reg-date').value = today
  const now = new Date()
  document.getElementById('reg-time').value = String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0')

  const panel = document.getElementById('reg-panel')
  panel.style.display = ''
  panel.scrollIntoView({behavior:'smooth',block:'nearest'})
}

function closeRegPanel() {
  document.getElementById('reg-panel').style.display = 'none'
  document.getElementById('reg-employee').value = ''
  document.querySelectorAll('.emp-card').forEach(c=>c.classList.remove('selected'))
}

// ══════════════════════════════════════════════
// 출퇴근 등록
// ══════════════════════════════════════════════
function setStatus(s, el) {
  selectedStatus = s
  document.getElementById('reg-status').value = s
  document.querySelectorAll('.status-pill').forEach(p=>p.classList.remove('selected'))
  if(el) el.classList.add('selected')

  const disp = document.getElementById('reg-status-display')
  disp.innerHTML = \`<span class="badge badge-\${s}" style="font-size:13px;padding:4px 16px;">\${s} 선택됨</span>\`

  const timeEl = document.getElementById('reg-time')
  if(s==='연차'||s==='병가'||s==='경조휴가'||s==='공가') {
    timeEl.disabled=true; timeEl.value=''
  } else if(s==='퇴근') {
    timeEl.disabled=false; if(!timeEl.value) timeEl.value='18:00'
  } else if(s==='오전반차') {
    timeEl.disabled=false; timeEl.value='13:00'
  } else if(s==='오후반차') {
    timeEl.disabled=false; timeEl.value='08:35'
  } else {
    timeEl.disabled=false
    if(!timeEl.value) {
      const n=new Date()
      timeEl.value=String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0')
    }
  }
}

async function submitAttendance() {
  const employee_id = document.getElementById('reg-employee').value
  const work_date = document.getElementById('reg-date').value
  const status = document.getElementById('reg-status').value
  const timeVal = document.getElementById('reg-time').value
  const note = document.getElementById('reg-note').value

  if(!employee_id) return showToast('직원 카드를 클릭하세요','error')
  if(!work_date) return showToast('날짜를 선택하세요','error')
  if(!status) return showToast('상태를 선택하세요','error')

  let check_in=null, check_out=null
  if(status==='출근') check_in=timeVal
  else if(status==='퇴근') check_out=timeVal
  else if(status==='오전반차') { check_in='13:00'; check_out='18:00' }
  else if(status==='오후반차') { check_in=timeVal; check_out='13:00' }

  const r = await fetch('/api/attendance',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({employee_id:parseInt(employee_id),work_date,status,check_in,check_out,note})
  })
  const data = await r.json()
  if(data.ok) {
    showToast('등록 완료!','success')
    closeRegPanel()
    loadCardStatuses()
  } else showToast(data.error||'오류','error')
}

// ══════════════════════════════════════════════
// 월별 근무현황
// ══════════════════════════════════════════════
async function loadMonthly() {
  const year = document.getElementById('monthly-year').value
  const month = document.getElementById('monthly-month').value
  const r = await fetch('/api/attendance/monthly?year='+year+'&month='+month)
  const data = await r.json()
  const container = document.getElementById('monthly-table')
  if(!data.data) { container.innerHTML='<p style="color:#9ca3af;text-align:center;padding:32px;">데이터 없음</p>'; return }

  const records = data.data
  const map = {}
  const empNames = {}
  records.forEach(r => {
    empNames[r.employee_id] = r.name
    if(!map[r.work_date]) map[r.work_date] = {}
    map[r.work_date][r.employee_id] = r
  })

  const allDates = []
  const d = new Date(year, month-1, 1)
  while(d.getMonth()===month-1) { allDates.push(d.toISOString().slice(0,10)); d.setDate(d.getDate()+1) }

  const empIds = employees.map(e=>e.id)
  const holidays = ['2026-01-01','2026-01-28','2026-01-29','2026-01-30','2026-03-01','2026-03-02','2026-05-05','2026-06-06']

  let html = \`<div style="text-align:center;font-weight:800;font-size:16px;margin-bottom:12px;">
    산청인애노인통합지원센터 \${year}년 \${month}월 근무상황부
  </div>
  <table class="monthly-tbl"><thead><tr>
    <th style="width:60px;">날짜</th><th style="width:30px;">요일</th>
    \${empIds.map(id=>\`<th>\${empNames[id]||id}</th>\`).join('')}
    <th>비고</th>
  </tr></thead><tbody>\`

  // 직원별 집계 카운터
  const empWorkCount = {}
  const empAnnualCount = {}
  const empHalfCount = {}
  empIds.forEach(eid => { empWorkCount[eid]=0; empAnnualCount[eid]=0; empHalfCount[eid]=0 })

  allDates.forEach(dateStr => {
    const dow = new Date(dateStr).getDay()
    const isWknd = dow===0||dow===6
    const isHol = holidays.includes(dateStr)
    const cls = isWknd||isHol ? 'weekend' : ''
    const dayColor = dow===0?'style="color:#dc2626;font-weight:700;"':dow===6?'style="color:#1d4ed8;font-weight:700;"':''
    html += \`<tr class="\${cls}"><td>\${dateStr.slice(5)}</td><td \${dayColor}>\${DAYS[dow]}</td>\`
    empIds.forEach(eid => {
      if(isWknd||isHol) { html += \`<td style="color:#9ca3af;font-size:11px;">휴무</td>\`; return }
      const rec = map[dateStr]?.[eid]
      if(rec) {
        if(rec.status==='출근') empWorkCount[eid]++
        else if(rec.status==='연차') empAnnualCount[eid]++
        else if(rec.status==='오전반차'||rec.status==='오후반차') empHalfCount[eid]++
        const display = rec.status==='출근' ? (rec.check_in||'출근') : rec.status
        html += \`<td><span class="badge badge-\${rec.status}" style="font-size:10px;">\${display}</span></td>\`
      } else html += \`<td style="color:#d1d5db;">-</td>\`
    })
    html += \`<td style="font-size:11px;color:#6b7280;">\${isHol?'공휴일':''}</td></tr>\`
  })

  // ── 합계 행 ──
  html += \`<tr style="background:#1e3a8a;">
    <td colspan="2" style="color:#fff;font-weight:800;font-size:12px;text-align:center;">합&nbsp;&nbsp;계</td>\`
  empIds.forEach(eid => {
    html += \`<td style="background:#1e3a8a;padding:6px 2px;">
      <div style="color:#86efac;font-size:11px;font-weight:700;">출근 \${empWorkCount[eid]}일</div>
      <div style="color:#fde68a;font-size:11px;">연차 \${empAnnualCount[eid]}일</div>
      <div style="color:#c4b5fd;font-size:11px;">반차 \${empHalfCount[eid]}회</div>
    </td>\`
  })
  html += \`<td style="background:#1e3a8a;"></td></tr>\`

  html += '</tbody></table>'

  // ── 개인별 총 근무일수 / 연가일수 요약 카드 ──
  html += \`<div style="margin-top:20px;border:2px solid #1e3a8a;border-radius:10px;overflow:hidden;">
    <div style="background:#1e3a8a;color:#fff;padding:8px 16px;font-size:13px;font-weight:800;letter-spacing:1px;">
      <i class="fas fa-table" style="margin-right:6px;"></i>개인별 총 근무일수 및 연가 일수 집계
    </div>
    <table style="border-collapse:collapse;width:100%;">
      <thead>
        <tr style="background:#eff6ff;">
          <th style="border:1px solid #bfdbfe;padding:8px 12px;font-size:12px;color:#1e40af;text-align:center;">성명</th>
          <th style="border:1px solid #bfdbfe;padding:8px 12px;font-size:12px;color:#1e40af;text-align:center;">총 근무일수</th>
          <th style="border:1px solid #bfdbfe;padding:8px 12px;font-size:12px;color:#1e40af;text-align:center;">연차 사용(일)</th>
          <th style="border:1px solid #bfdbfe;padding:8px 12px;font-size:12px;color:#1e40af;text-align:center;">반차 사용(회)</th>
          <th style="border:1px solid #bfdbfe;padding:8px 12px;font-size:12px;color:#1e40af;text-align:center;">반차 환산(일)</th>
          <th style="border:1px solid #bfdbfe;padding:8px 12px;font-size:12px;color:#1e40af;text-align:center;">합산 연가(일)</th>
        </tr>
      </thead>
      <tbody>
        \${empIds.map(eid => {
          const nm = empNames[eid] || eid
          const wc = empWorkCount[eid] || 0
          const ac = empAnnualCount[eid] || 0
          const hc = empHalfCount[eid] || 0
          const hd = (hc * 0.5).toFixed(1)
          const total = (ac + hc * 0.5).toFixed(1)
          return \`<tr style="text-align:center;">
            <td style="border:1px solid #e2e8f0;padding:8px 12px;font-weight:700;color:#1e3a8a;">\${nm}</td>
            <td style="border:1px solid #e2e8f0;padding:8px 12px;"><span style="font-size:18px;font-weight:800;color:#15803d;">\${wc}</span><span style="font-size:11px;color:#6b7280;"> 일</span></td>
            <td style="border:1px solid #e2e8f0;padding:8px 12px;"><span style="font-size:18px;font-weight:800;color:#b45309;">\${ac}</span><span style="font-size:11px;color:#6b7280;"> 일</span></td>
            <td style="border:1px solid #e2e8f0;padding:8px 12px;"><span style="font-size:18px;font-weight:800;color:#6d28d9;">\${hc}</span><span style="font-size:11px;color:#6b7280;"> 회</span></td>
            <td style="border:1px solid #e2e8f0;padding:8px 12px;"><span style="font-size:16px;font-weight:700;color:#7c3aed;">\${hd}</span><span style="font-size:11px;color:#6b7280;"> 일</span></td>
            <td style="border:1px solid #e2e8f0;padding:8px 12px;background:#fffbeb;"><span style="font-size:18px;font-weight:800;color:#dc2626;">\${total}</span><span style="font-size:11px;color:#6b7280;"> 일</span></td>
          </tr>\`
        }).join('')}
      </tbody>
    </table>
    <div style="background:#f8fafc;padding:8px 16px;font-size:11px;color:#6b7280;border-top:1px solid #e2e8f0;">
      ※ 합산 연가 = 연차 사용일 + 반차 사용횟수 × 0.5일
    </div>
  </div>\`

  container.innerHTML = html
}

// ══════════════════════════════════════════════
// 통계
// ══════════════════════════════════════════════
async function loadStats() {
  const year = document.getElementById('stats-year').value
  const month = document.getElementById('stats-month').value
  const url = month ? '/api/stats/monthly?year='+year+'&month='+month : '/api/stats/yearly?year='+year
  const title = month ? year+'년 '+month+'월 근무 통계' : year+'년 연간 누적 통계'
  const r = await fetch(url)
  const data = await r.json()
  const container = document.getElementById('stats-table')
  if(!data.data) { container.innerHTML=''; return }

  let html = \`<div style="font-weight:800;color:#1e3a8a;font-size:15px;margin-bottom:14px;text-align:center;">\${title}</div>
  <div style="overflow-x:auto;"><table class="stats-tbl"><thead><tr>
    <th style="text-align:left;">성명</th>
    <th>출근일수</th><th>연차(일)</th><th>오전반차</th><th>오후반차</th>
    <th>반차환산(일)</th><th>병가</th><th>경조휴가</th><th>공가</th>
    \${!month?'<th>총 연차환산</th>':''}
  </tr></thead><tbody>\`

  data.data.forEach(row => {
    const halfDays = ((row.am_half||0)+(row.pm_half||0))*0.5
    const total = (row.annual_leave||0)+halfDays
    html += \`<tr>
      <td class="name-cell">\${row.name}</td>
      <td><b style="color:#15803d;">\${row.work_count||0}</b></td>
      <td><b style="color:#b45309;">\${row.annual_leave||0}</b></td>
      <td>\${row.am_half||0}</td><td>\${row.pm_half||0}</td>
      <td style="color:#6d28d9;font-weight:700;">\${halfDays}</td>
      <td style="color:#dc2626;">\${row.sick_leave||0}</td>
      <td style="color:#c2410c;">\${row.family_leave||0}</td>
      <td style="color:#0369a1;">\${row.official_leave||0}</td>
      \${!month?\`<td><b style="color:#1d4ed8;font-size:15px;">\${total}</b></td>\`:''}
    </tr>\`
  })
  html += '</tbody></table></div>'
  container.innerHTML = html
}

// ══════════════════════════════════════════════
// 연간 연차 발생/사용/잔여
// ══════════════════════════════════════════════
// 근속년수로 연차 발생일수 계산 (2026년 기준 단순 계산)
function calcAnnualAllowance(yearsWorked) {
  if(yearsWorked < 1) return Math.min(Math.floor(yearsWorked*12), 11)
  if(yearsWorked < 3) return 15
  // 3년 이상: 15 + floor((yearsWorked-1)/2) 단 최대 25
  return Math.min(15 + Math.floor((yearsWorked-1)/2), 25)
}

async function loadAnnualLeave() {
  const year = document.getElementById('annual-year').value
  const r = await fetch('/api/stats/yearly?year='+year)
  const d = await r.json()
  const container = document.getElementById('annual-leave-table')
  if(!d.data||!container) return

  // 직원별 입사년도 (없으면 2020년 기준으로 계산)
  const hireYears = {1:2018, 2:2019, 3:2017, 4:2021, 5:2023}

  let html = \`<div style="overflow-x:auto;"><table class="stats-tbl"><thead><tr>
    <th style="text-align:left;">성명</th>
    <th>입사년도</th><th>근속(년)</th>
    <th>연차발생(일)</th><th>연차사용(일)</th><th>반차사용(회)</th><th>반차환산(일)</th>
    <th>총사용(일)</th><th style="background:#1e3a8a;">잔여연차(일)</th>
    <th>사용률(%)</th>
  </tr></thead><tbody>\`

  d.data.forEach(row => {
    const hireYear = hireYears[row.employee_id] || 2020
    const yearsWorked = parseInt(year) - hireYear
    const allowance = calcAnnualAllowance(yearsWorked)
    const halfDays = ((row.am_half||0)+(row.pm_half||0))*0.5
    const usedDays = (row.annual_leave||0) + halfDays
    const remaining = Math.max(0, allowance - usedDays)
    const usageRate = allowance > 0 ? Math.round(usedDays/allowance*100) : 0
    const barColor = usageRate > 80 ? '#dc2626' : usageRate > 50 ? '#f59e0b' : '#16a34a'

    html += \`<tr>
      <td class="name-cell">\${row.name}</td>
      <td style="color:#6b7280;">\${hireYear}</td>
      <td style="font-weight:600;">\${yearsWorked}년</td>
      <td><b style="color:#1d4ed8;font-size:15px;">\${allowance}일</b></td>
      <td style="color:#b45309;">\${row.annual_leave||0}일</td>
      <td>\${(row.am_half||0)+(row.pm_half||0)}회</td>
      <td style="color:#6d28d9;">\${halfDays}일</td>
      <td><b style="color:#374151;">\${usedDays}일</b></td>
      <td><b style="\${remaining===0?'color:#dc2626':'color:#15803d;'};font-size:15px;">\${remaining}일</b></td>
      <td>
        <div style="min-width:80px;">
          <div class="progress-bar"><div class="progress-fill" style="width:\${usageRate}%;background:\${barColor};"></div></div>
          <div style="font-size:11px;color:\${barColor};font-weight:700;margin-top:2px;">\${usageRate}%</div>
        </div>
      </td>
    </tr>\`
  })
  html += '</tbody></table></div>'
  container.innerHTML = html
}

// ══════════════════════════════════════════════
// 개인별 출력
// ══════════════════════════════════════════════
async function loadPrint() {
  const eid = document.getElementById('print-employee').value
  const year = document.getElementById('print-year').value
  const month = document.getElementById('print-month').value
  if(!eid) return showToast('직원을 선택하세요','error')

  const emp = employees.find(e=>e.id==eid)
  const r = await fetch('/api/attendance/monthly?year='+year+'&month='+month+'&employee_id='+eid)
  const data = await r.json()

  const allDates = []
  const d = new Date(year, month-1, 1)
  while(d.getMonth()===month-1) { allDates.push(d.toISOString().slice(0,10)); d.setDate(d.getDate()+1) }

  const map = {}
  ;(data.data||[]).forEach(rec => { map[rec.work_date]=rec })

  const holidays = ['2026-01-01','2026-01-28','2026-01-29','2026-01-30','2026-03-01','2026-03-02','2026-05-05','2026-06-06']
  let workCount=0, annualLeave=0, amHalf=0, pmHalf=0, sickLeave=0, familyLeave=0, officialLeave=0

  const rows = allDates.map(dateStr => {
    const dow = new Date(dateStr).getDay()
    const isWknd = dow===0||dow===6
    const isHol = holidays.includes(dateStr)
    const rec = map[dateStr]
    let statusDisplay='-', checkIn='-', checkOut='-', rowStyle=''
    if(isWknd||isHol) { statusDisplay='휴무'; rowStyle='background:#fff7f7;' }
    else if(rec) {
      statusDisplay=rec.status; checkIn=rec.check_in||'-'; checkOut=rec.check_out||'-'
      if(rec.status==='출근') workCount++
      if(rec.status==='연차') annualLeave++
      if(rec.status==='오전반차') amHalf++
      if(rec.status==='오후반차') pmHalf++
      if(rec.status==='병가') sickLeave++
      if(rec.status==='경조휴가') familyLeave++
      if(rec.status==='공가') officialLeave++
    }
    const dayStyle = dow===0?'color:#dc2626;':dow===6?'color:#1d4ed8;':''
    return \`<tr style="\${rowStyle}">
      <td>\${dateStr.slice(5)}</td>
      <td style="\${dayStyle}">\${DAYS[dow]}</td>
      <td><span class="badge badge-\${statusDisplay}" style="font-size:11px;">\${statusDisplay}</span></td>
      <td>\${checkIn}</td><td>\${checkOut}</td>
      <td style="font-size:11px;color:#6b7280;">\${rec?.note||''}</td>
    </tr>\`
  }).join('')

  const html = \`<div class="print-area">
    <div style="text-align:center;margin-bottom:20px;">
      <div style="font-size:14px;color:#6b7280;margin-bottom:4px;">산청인애노인통합지원센터</div>
      <div style="font-size:22px;font-weight:900;color:#1e3a8a;">\${year}년 \${month}월 근무상황부</div>
      <div style="font-size:14px;color:#374151;margin-top:6px;">성명: <b>\${emp?.name||''}</b> · 직책: \${emp?.position||''}</div>
    </div>
    <table style="border-collapse:collapse;width:100%;margin-bottom:16px;">
      <thead><tr style="background:#1e3a8a;color:#fff;">
        <th style="padding:8px;border:1px solid #1e40af;">날짜</th>
        <th style="padding:8px;border:1px solid #1e40af;">요일</th>
        <th style="padding:8px;border:1px solid #1e40af;">상태</th>
        <th style="padding:8px;border:1px solid #1e40af;">출근</th>
        <th style="padding:8px;border:1px solid #1e40af;">퇴근</th>
        <th style="padding:8px;border:1px solid #1e40af;">비고</th>
      </tr></thead>
      <tbody>\${rows}</tbody>
    </table>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">
      <div style="background:#f0fdf4;border-radius:10px;padding:14px;text-align:center;border:1px solid #bbf7d0;">
        <div style="font-size:12px;color:#6b7280;margin-bottom:4px;">출근일수</div>
        <div style="font-size:24px;font-weight:800;color:#15803d;">\${workCount}</div>
      </div>
      <div style="background:#fffbeb;border-radius:10px;padding:14px;text-align:center;border:1px solid #fde68a;">
        <div style="font-size:12px;color:#6b7280;margin-bottom:4px;">연차</div>
        <div style="font-size:24px;font-weight:800;color:#b45309;">\${annualLeave}일</div>
      </div>
      <div style="background:#f5f3ff;border-radius:10px;padding:14px;text-align:center;border:1px solid #ddd6fe;">
        <div style="font-size:12px;color:#6b7280;margin-bottom:4px;">반차</div>
        <div style="font-size:24px;font-weight:800;color:#6d28d9;">\${amHalf+pmHalf}회</div>
      </div>
      <div style="background:#fff1f2;border-radius:10px;padding:14px;text-align:center;border:1px solid #fecdd3;">
        <div style="font-size:12px;color:#6b7280;margin-bottom:4px;">병가/기타</div>
        <div style="font-size:24px;font-weight:800;color:#dc2626;">\${sickLeave+familyLeave+officialLeave}일</div>
      </div>
    </div>
    <div style="text-align:right;font-size:12px;color:#9ca3af;">출력일: \${new Date().toLocaleDateString('ko-KR')}</div>
  </div>\`
  document.getElementById('print-area').innerHTML = html
}

// ══════════════════════════════════════════════
// 연차 신청서
// ══════════════════════════════════════════════
async function submitLeaveRequest() {
  const employee_id = document.getElementById('lr-employee').value
  const leave_type = document.getElementById('lr-type').value
  const leave_start = document.getElementById('lr-start').value
  const leave_end = document.getElementById('lr-end').value
  const reason = document.getElementById('lr-reason').innerText.trim()
  const handover = document.getElementById('lr-handover').innerText.trim()
  const applicant_sign = document.getElementById('sign-applicant-view')?.innerText||''
  const applicant_date = document.getElementById('date-applicant-view')?.value||''
  const social_worker_sign = document.getElementById('sign-social-view')?.innerText||''
  const social_worker_date = document.getElementById('date-social-view')?.value||''
  const director_sign = document.getElementById('sign-director-view')?.innerText||''
  const director_date = document.getElementById('date-director-view')?.value||''

  if(!employee_id||!leave_start||!leave_end) return showToast('필수 항목을 입력하세요','error')

  const r = await fetch('/api/leave-requests',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({employee_id:parseInt(employee_id),leave_type,leave_start,leave_end,reason,handover,
      applicant_sign,applicant_date,social_worker_sign,social_worker_date,director_sign,director_date})
  })
  const data = await r.json()
  if(data.ok) { showToast('신청서가 저장되었습니다','success'); loadLeaveRequests() }
}

function resetLeaveForm() {
  const today = new Date().toISOString().slice(0,10)
  document.getElementById('lr-start').value = today
  document.getElementById('lr-end').value = today
  document.getElementById('lr-reason').innerText = ''
  document.getElementById('lr-handover').innerText = ''
  ;['sign-applicant-view','sign-social-view','sign-director-view'].forEach(id=>{
    const el = document.getElementById(id)
    if(el) el.innerText=''
  })
  ;['date-applicant-view','date-social-view','date-director-view'].forEach(id=>{
    const el = document.getElementById(id)
    if(el) el.value=''
  })
  calcLrDays()
}

function printLeaveForm() {
  window.print()
}

async function loadLeaveRequests() {
  const r = await fetch('/api/leave-requests?year=2026')
  const data = await r.json()
  const container = document.getElementById('leave-list')
  if(!data.data||data.data.length===0) {
    container.innerHTML='<div style="text-align:center;padding:32px;color:#9ca3af;font-size:13px;"><i class="fas fa-inbox" style="font-size:24px;display:block;margin-bottom:8px;"></i>신청서 없음</div>'
    return
  }
  container.innerHTML = data.data.map(lr => \`
    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin-bottom:10px;transition:.15s;cursor:pointer;" 
         onmouseenter="this.style.borderColor='#2563eb'" onmouseleave="this.style.borderColor='#e5e7eb'">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-weight:700;color:#1e3a8a;">\${lr.name}</span>
          <span class="badge badge-\${lr.leave_type}" style="font-size:11px;">\${lr.leave_type}</span>
        </div>
        <div style="display:flex;gap:6px;">
          <button onclick="openLeaveDetail(\${lr.id})" class="btn btn-gray btn-sm"><i class="fas fa-eye"></i></button>
          <button onclick="deleteLeave(\${lr.id})" class="btn btn-danger btn-sm"><i class="fas fa-trash"></i></button>
        </div>
      </div>
      <div style="font-size:12px;color:#6b7280;">\${lr.leave_start} ~ \${lr.leave_end}</div>
      <div style="font-size:12px;color:#374151;margin-top:4px;">\${lr.reason||'(사유 없음)'}</div>
    </div>
  \`).join('')
}

let allLeaveData = []
async function openLeaveDetail(id) {
  if(!allLeaveData.length) {
    const r = await fetch('/api/leave-requests?year=2026')
    const d = await r.json()
    allLeaveData = d.data||[]
  }
  const lr = allLeaveData.find(x=>x.id===id)
  if(!lr) return

  // 폼에 데이터 채우기
  const emp = employees.find(e=>e.id===lr.employee_id)
  const lrEmp = document.getElementById('lr-employee')
  if(lrEmp) { lrEmp.value = lr.employee_id; lrEmp.dispatchEvent(new Event('change')) }

  const lt = document.getElementById('lr-type')
  if(lt) lt.value = lr.leave_type
  const ls = document.getElementById('lr-start')
  if(ls) ls.value = lr.leave_start
  const le = document.getElementById('lr-end')
  if(le) le.value = lr.leave_end
  const lrReason = document.getElementById('lr-reason')
  if(lrReason) lrReason.innerText = lr.reason||''
  const lrHandover = document.getElementById('lr-handover')
  if(lrHandover) lrHandover.innerText = lr.handover||''

  // 결재란
  const sa = document.getElementById('sign-applicant-view')
  if(sa) sa.innerText = lr.applicant_sign||''
  const ss = document.getElementById('sign-social-view')
  if(ss) ss.innerText = lr.social_worker_sign||''
  const sd = document.getElementById('sign-director-view')
  if(sd) sd.innerText = lr.director_sign||''
  const da = document.getElementById('date-applicant-view')
  if(da) da.value = lr.applicant_date||''
  const ds = document.getElementById('date-social-view')
  if(ds) ds.value = lr.social_worker_date||''
  const dd = document.getElementById('date-director-view')
  if(dd) dd.value = lr.director_date||''

  calcLrDays()
  showToast(lr.name+' 신청서를 불러왔습니다','info')
  // 폼으로 스크롤
  document.getElementById('leave-form-area')?.scrollIntoView({behavior:'smooth'})
}

async function deleteLeave(id) {
  if(!confirm('삭제하시겠습니까?')) return
  const r = await fetch('/api/leave-requests/'+id,{method:'DELETE'})
  const data = await r.json()
  if(data.ok) {
    showToast('삭제되었습니다','success')
    allLeaveData = []
    loadLeaveRequests()
  }
}

// ══════════════════════════════════════════════
// 직원 관리
// ══════════════════════════════════════════════
function renderEmployeeList() {
  const container = document.getElementById('employee-list')
  if(!container) return
  if(employees.length===0) {
    container.innerHTML='<div style="text-align:center;padding:32px;color:#9ca3af;">직원 없음</div>'
    return
  }
  container.innerHTML = \`<div style="overflow-x:auto;">
  <table class="stats-tbl"><thead><tr>
    <th style="width:50px;">번호</th><th style="text-align:left;">성명</th><th>직책</th><th style="width:160px;">관리</th>
  </tr></thead><tbody>
  \${employees.map((e,idx)=>\`<tr id="emp-row-\${e.id}">
    <td style="color:#9ca3af;">\${idx+1}</td>
    <td style="text-align:left;">
      <span id="emp-name-text-\${e.id}" style="font-weight:700;color:#1e3a8a;">\${e.name}</span>
      <input id="emp-name-input-\${e.id}" type="text" value="\${e.name}" style="display:none;width:100px;font-size:13px;padding:4px 8px;">
    </td>
    <td>
      <span id="emp-pos-text-\${e.id}">\${e.position||''}</span>
      <input id="emp-pos-input-\${e.id}" type="text" value="\${e.position||''}" style="display:none;width:120px;font-size:13px;padding:4px 8px;">
    </td>
    <td>
      <div id="emp-btn-view-\${e.id}" style="display:flex;gap:6px;justify-content:center;">
        <button onclick="startEditEmployee(\${e.id})" class="btn btn-gray btn-sm"><i class="fas fa-edit"></i> 수정</button>
        <button onclick="removeEmployee(\${e.id})" class="btn btn-danger btn-sm"><i class="fas fa-trash"></i></button>
      </div>
      <div id="emp-btn-edit-\${e.id}" style="display:none;gap:6px;justify-content:center;">
        <button onclick="saveEditEmployee(\${e.id})" class="btn btn-success btn-sm"><i class="fas fa-check"></i> 저장</button>
        <button onclick="cancelEditEmployee(\${e.id})" class="btn btn-gray btn-sm">취소</button>
      </div>
    </td>
  </tr>\`).join('')}
  </tbody></table></div>\`
}

function startEditEmployee(id) {
  employees.forEach(e => { if(e.id!==id) cancelEditEmployee(e.id) })
  const nameText=document.getElementById('emp-name-text-'+id)
  const nameInput=document.getElementById('emp-name-input-'+id)
  const posText=document.getElementById('emp-pos-text-'+id)
  const posInput=document.getElementById('emp-pos-input-'+id)
  const btnView=document.getElementById('emp-btn-view-'+id)
  const btnEdit=document.getElementById('emp-btn-edit-'+id)
  if(!nameText) return
  nameText.style.display='none'; posText.style.display='none'
  nameInput.style.display=''; posInput.style.display=''
  btnView.style.display='none'; btnEdit.style.display='flex'
  nameInput.focus()
  nameInput.onkeydown=e=>{ if(e.key==='Enter') saveEditEmployee(id) }
  posInput.onkeydown=e=>{ if(e.key==='Enter') saveEditEmployee(id) }
}

function cancelEditEmployee(id) {
  const emp=employees.find(e=>e.id===id)
  if(!emp) return
  const nameText=document.getElementById('emp-name-text-'+id)
  const nameInput=document.getElementById('emp-name-input-'+id)
  const posText=document.getElementById('emp-pos-text-'+id)
  const posInput=document.getElementById('emp-pos-input-'+id)
  const btnView=document.getElementById('emp-btn-view-'+id)
  const btnEdit=document.getElementById('emp-btn-edit-'+id)
  if(!nameText) return
  nameInput.value=emp.name; posInput.value=emp.position||''
  nameText.style.display=''; posText.style.display=''
  nameInput.style.display='none'; posInput.style.display='none'
  btnView.style.display='flex'; btnEdit.style.display='none'
}

async function saveEditEmployee(id) {
  const newName=document.getElementById('emp-name-input-'+id).value.trim()
  const newPos=document.getElementById('emp-pos-input-'+id).value.trim()
  if(!newName) return showToast('이름을 입력하세요','error')
  const r=await fetch('/api/employees/'+id,{
    method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:newName,position:newPos||'사회복지사'})
  })
  const data=await r.json()
  if(data.ok) { showToast(newName+' 수정 완료','success'); await loadEmployees() }
  else showToast(data.error||'오류','error')
}

async function addEmployee() {
  const name=document.getElementById('new-employee-name').value.trim()
  const pos=document.getElementById('new-employee-pos').value.trim()
  if(!name) return showToast('이름을 입력하세요','error')
  const r=await fetch('/api/employees',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name,position:pos||'사회복지사'})
  })
  const data=await r.json()
  if(data.ok) {
    showToast(name+' 추가 완료','success')
    document.getElementById('new-employee-name').value=''
    document.getElementById('new-employee-pos').value=''
    await loadEmployees()
  }
}

async function removeEmployee(id) {
  const emp=employees.find(e=>e.id===id)
  if(!confirm((emp?.name||id)+'을(를) 삭제하시겠습니까?')) return
  const r=await fetch('/api/employees/'+id,{method:'DELETE'})
  const data=await r.json()
  if(data.ok) { showToast('삭제되었습니다','success'); await loadEmployees() }
}

// ══════════════════════════════════════════════
// 토스트
// ══════════════════════════════════════════════
function showToast(msg, type='info') {
  const toast=document.getElementById('toast')
  const bg=type==='success'?'#16a34a':type==='error'?'#dc2626':'#1d4ed8'
  const icon=type==='success'?'fa-check-circle':type==='error'?'fa-exclamation-circle':'fa-info-circle'
  const div=document.createElement('div')
  div.className='toast-item'
  div.style.background=bg
  div.innerHTML='<i class="fas '+icon+'"></i>'+msg
  toast.appendChild(div)
  setTimeout(()=>div.remove(), 3200)
}

// ══════════════════════════════════════════════
// 기본값 설정
// ══════════════════════════════════════════════
const _now = new Date()
const _m = _now.getMonth()+1
if(document.getElementById('monthly-month')) document.getElementById('monthly-month').value=_m
if(document.getElementById('print-month')) document.getElementById('print-month').value=_m
</script>
</body>
</html>`
}

export default app
