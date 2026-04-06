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
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap');
    * { font-family: 'Noto Sans KR', sans-serif; }
    .tab-active { background: #1e40af; color: white; }
    .status-출근 { background:#dcfce7; color:#166534; }
    .status-퇴근 { background:#dbeafe; color:#1e40af; }
    .status-연차 { background:#fef3c7; color:#92400e; }
    .status-오전반차 { background:#ede9fe; color:#5b21b6; }
    .status-오후반차 { background:#fce7f3; color:#9d174d; }
    .status-병가 { background:#fee2e2; color:#991b1b; }
    .status-경조휴가 { background:#ffedd5; color:#9a3412; }
    .status-공가 { background:#e0f2fe; color:#075985; }
    .status-휴무 { background:#f3f4f6; color:#6b7280; }
    @media print {
      .no-print { display: none !important; }
      body { background: white; }
      .print-area { page-break-inside: avoid; }
    }
    .modal-bg { background: rgba(0,0,0,0.5); }
    .clock { font-size: 2.5rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    input[type="text"], input[type="date"], select, textarea {
      border: 1px solid #d1d5db;
      border-radius: 0.375rem;
      padding: 0.375rem 0.5rem;
      width: 100%;
      font-size: 0.875rem;
    }
    .sign-box {
      border: 1px solid #d1d5db;
      border-radius: 0.375rem;
      padding: 0.5rem;
      min-height: 60px;
      cursor: text;
    }
    .approval-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      border: 2px solid #1e40af;
    }
    .approval-cell {
      border: 1px solid #93c5fd;
      text-align: center;
      padding: 0.5rem;
    }
    table.print-table { border-collapse: collapse; width: 100%; }
    table.print-table th, table.print-table td {
      border: 1px solid #94a3b8;
      padding: 4px 6px;
      font-size: 12px;
      text-align: center;
    }
    table.print-table th { background: #e2e8f0; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">

<!-- 헤더 -->
<header class="bg-blue-900 text-white shadow-lg no-print">
  <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
    <div>
      <h1 class="text-lg font-bold">산청인애노인통합지원센터</h1>
      <p class="text-blue-200 text-sm">2026년 근무상황부</p>
    </div>
    <div id="liveClock" class="clock text-blue-100"></div>
  </div>
</header>

<!-- 탭 네비게이션 -->
<nav class="bg-white border-b shadow-sm no-print">
  <div class="max-w-7xl mx-auto px-4">
    <div class="flex space-x-1 py-2 overflow-x-auto">
      <button onclick="showTab('dashboard')" id="tab-dashboard" class="tab-btn tab-active px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition">
        <i class="fas fa-tachometer-alt mr-1"></i>대시보드
      </button>
      <button onclick="showTab('monthly')" id="tab-monthly" class="tab-btn px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition bg-gray-100 hover:bg-gray-200">
        <i class="fas fa-calendar-alt mr-1"></i>월별 근무현황
      </button>
      <button onclick="showTab('stats')" id="tab-stats" class="tab-btn px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition bg-gray-100 hover:bg-gray-200">
        <i class="fas fa-chart-bar mr-1"></i>통계
      </button>
      <button onclick="showTab('print')" id="tab-print" class="tab-btn px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition bg-gray-100 hover:bg-gray-200">
        <i class="fas fa-print mr-1"></i>개인별 출력
      </button>
      <button onclick="showTab('leave')" id="tab-leave" class="tab-btn px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition bg-gray-100 hover:bg-gray-200">
        <i class="fas fa-file-alt mr-1"></i>연차 신청서
      </button>
      <button onclick="showTab('employees')" id="tab-employees" class="tab-btn px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition bg-gray-100 hover:bg-gray-200">
        <i class="fas fa-users mr-1"></i>직원 관리
      </button>
    </div>
  </div>
</nav>

<main class="max-w-7xl mx-auto px-4 py-6">

<!-- ════════════════ 대시보드 탭 ════════════════ -->
<div id="page-dashboard">
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">

    <!-- 출퇴근 등록 패널 -->
    <div class="lg:col-span-1 bg-white rounded-2xl shadow-md p-5">
      <h2 class="text-lg font-bold text-blue-900 mb-4 flex items-center">
        <i class="fas fa-clock mr-2 text-blue-500"></i>출퇴근 등록
      </h2>
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-600 mb-1">직원 선택</label>
        <select id="reg-employee" class="text-sm">
          <option value="">-- 직원 선택 --</option>
        </select>
      </div>
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-600 mb-1">날짜</label>
        <input type="date" id="reg-date" class="text-sm">
      </div>
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-600 mb-1">시간 (HH:MM)</label>
        <input type="text" id="reg-time" placeholder="08:35" maxlength="5" class="text-sm">
      </div>
      <div class="mb-5">
        <label class="block text-sm font-medium text-gray-600 mb-2">상태 선택</label>
        <div class="grid grid-cols-2 gap-2">
          <button onclick="setStatus('출근')" class="status-btn status-출근 py-2 px-3 rounded-lg text-sm font-medium border-2 border-transparent hover:border-green-400 transition">출근</button>
          <button onclick="setStatus('퇴근')" class="status-btn status-퇴근 py-2 px-3 rounded-lg text-sm font-medium border-2 border-transparent hover:border-blue-400 transition">퇴근</button>
          <button onclick="setStatus('오전반차')" class="status-btn status-오전반차 py-2 px-3 rounded-lg text-sm font-medium border-2 border-transparent hover:border-purple-400 transition">오전반차</button>
          <button onclick="setStatus('오후반차')" class="status-btn status-오후반차 py-2 px-3 rounded-lg text-sm font-medium border-2 border-transparent hover:border-pink-400 transition">오후반차</button>
          <button onclick="setStatus('연차')" class="status-btn status-연차 py-2 px-3 rounded-lg text-sm font-medium border-2 border-transparent hover:border-yellow-400 transition">연차</button>
          <button onclick="setStatus('병가')" class="status-btn status-병가 py-2 px-3 rounded-lg text-sm font-medium border-2 border-transparent hover:border-red-400 transition">병가</button>
          <button onclick="setStatus('경조휴가')" class="status-btn status-경조휴가 py-2 px-3 rounded-lg text-sm font-medium border-2 border-transparent hover:border-orange-400 transition">경조휴가</button>
          <button onclick="setStatus('공가')" class="status-btn status-공가 py-2 px-3 rounded-lg text-sm font-medium border-2 border-transparent hover:border-sky-400 transition">공가</button>
        </div>
        <input type="hidden" id="reg-status" value="">
      </div>
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-600 mb-1">메모 (선택)</label>
        <input type="text" id="reg-note" placeholder="비고 입력" class="text-sm">
      </div>
      <div id="reg-status-display" class="mb-3 text-center text-sm font-semibold text-gray-500 h-6"></div>
      <button onclick="submitAttendance()" class="w-full bg-blue-700 hover:bg-blue-800 text-white py-3 rounded-xl font-bold text-base transition">
        <i class="fas fa-check-circle mr-2"></i>등록하기
      </button>
    </div>

    <!-- 오늘 현황 -->
    <div class="lg:col-span-2 bg-white rounded-2xl shadow-md p-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-bold text-blue-900">
          <i class="fas fa-list-check mr-2 text-blue-500"></i>오늘 근무 현황
        </h2>
        <span id="today-date-label" class="text-sm text-gray-500 font-medium"></span>
      </div>
      <div id="today-list" class="space-y-3">
        <div class="text-center text-gray-400 py-8"><i class="fas fa-spinner fa-spin mr-2"></i>로딩 중...</div>
      </div>

      <!-- 이번달 요약 -->
      <div class="mt-6 border-t pt-4">
        <h3 class="font-bold text-blue-800 mb-3 text-sm">
          <i class="fas fa-chart-pie mr-1"></i>이번 달 휴가 현황
        </h3>
        <div id="month-summary" class="grid grid-cols-2 sm:grid-cols-5 gap-2">
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ════════════════ 월별 근무현황 탭 ════════════════ -->
<div id="page-monthly" class="hidden">
  <div class="bg-white rounded-2xl shadow-md p-5">
    <div class="flex flex-wrap items-center gap-3 mb-5 no-print">
      <h2 class="text-lg font-bold text-blue-900 flex-1">
        <i class="fas fa-calendar-alt mr-2 text-blue-500"></i>월별 근무현황
      </h2>
      <select id="monthly-year" class="text-sm w-28">
        <option value="2026" selected>2026년</option>
        <option value="2025">2025년</option>
      </select>
      <select id="monthly-month" class="text-sm w-24">
        ${Array.from({length:12},(_,i)=>`<option value="${i+1}" ${i+2===new Date().getMonth()+1?'selected':''}>${i+1}월</option>`).join('')}
      </select>
      <button onclick="loadMonthly()" class="bg-blue-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-800">조회</button>
      <button onclick="window.print()" class="bg-gray-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-gray-700 no-print">
        <i class="fas fa-print mr-1"></i>인쇄
      </button>
    </div>
    <div id="monthly-table" class="overflow-x-auto"></div>
  </div>
</div>

<!-- ════════════════ 통계 탭 ════════════════ -->
<div id="page-stats" class="hidden">
  <div class="bg-white rounded-2xl shadow-md p-5">
    <div class="flex flex-wrap items-center gap-3 mb-5">
      <h2 class="text-lg font-bold text-blue-900 flex-1">
        <i class="fas fa-chart-bar mr-2 text-blue-500"></i>근무 통계
      </h2>
      <select id="stats-year" class="text-sm w-28">
        <option value="2026" selected>2026년</option>
        <option value="2025">2025년</option>
      </select>
      <select id="stats-month" class="text-sm w-24">
        <option value="">연간 통계</option>
        ${Array.from({length:12},(_,i)=>`<option value="${i+1}">${i+1}월</option>`).join('')}
      </select>
      <button onclick="loadStats()" class="bg-blue-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-800">조회</button>
    </div>
    <div id="stats-table"></div>
  </div>
</div>

<!-- ════════════════ 개인별 출력 탭 ════════════════ -->
<div id="page-print" class="hidden">
  <div class="bg-white rounded-2xl shadow-md p-5">
    <div class="flex flex-wrap items-center gap-3 mb-5 no-print">
      <h2 class="text-lg font-bold text-blue-900 flex-1">
        <i class="fas fa-print mr-2 text-blue-500"></i>개인별 출력
      </h2>
      <select id="print-employee" class="text-sm w-32">
        <option value="">직원 선택</option>
      </select>
      <select id="print-year" class="text-sm w-28">
        <option value="2026" selected>2026년</option>
      </select>
      <select id="print-month" class="text-sm w-24">
        ${Array.from({length:12},(_,i)=>`<option value="${i+1}">${i+1}월</option>`).join('')}
      </select>
      <button onclick="loadPrint()" class="bg-blue-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-800">미리보기</button>
      <button onclick="window.print()" class="bg-green-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-700 no-print">
        <i class="fas fa-print mr-1"></i>인쇄
      </button>
    </div>
    <div id="print-area"></div>
  </div>
</div>

<!-- ════════════════ 연차 신청서 탭 ════════════════ -->
<div id="page-leave" class="hidden">
  <div class="space-y-6">
    <!-- 신청서 작성 -->
    <div class="bg-white rounded-2xl shadow-md p-5 no-print">
      <h2 class="text-lg font-bold text-blue-900 mb-4">
        <i class="fas fa-file-signature mr-2 text-blue-500"></i>연차 사용 신청서 작성
      </h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <label class="block text-sm font-medium text-gray-600 mb-1">신청자</label>
          <select id="lr-employee" class="text-sm"></select>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-600 mb-1">휴가 구분</label>
          <select id="lr-type" class="text-sm">
            <option value="연차">연차</option>
            <option value="오전반차">오전반차</option>
            <option value="오후반차">오후반차</option>
            <option value="경조휴가">경조휴가</option>
            <option value="병가">병가</option>
            <option value="공가">공가</option>
            <option value="기타">기타</option>
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-600 mb-1">휴가 시작일</label>
          <input type="date" id="lr-start" class="text-sm">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-600 mb-1">휴가 종료일</label>
          <input type="date" id="lr-end" class="text-sm">
        </div>
      </div>
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-600 mb-1">사유</label>
        <textarea id="lr-reason" rows="2" class="text-sm w-full border rounded-lg p-2" placeholder="휴가 사유를 입력하세요"></textarea>
      </div>
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-600 mb-1">주요 업무 인수인계 사항</label>
        <textarea id="lr-handover" rows="3" class="text-sm w-full border rounded-lg p-2" placeholder="업무 인수인계 내용을 입력하세요"></textarea>
      </div>
      <button onclick="submitLeaveRequest()" class="bg-blue-700 text-white px-6 py-2 rounded-lg text-sm hover:bg-blue-800 font-medium">
        <i class="fas fa-save mr-1"></i>신청서 저장
      </button>
    </div>

    <!-- 신청서 목록 -->
    <div class="bg-white rounded-2xl shadow-md p-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-bold text-blue-900">
          <i class="fas fa-list mr-2 text-blue-500"></i>신청서 목록
        </h2>
        <button onclick="loadLeaveRequests()" class="bg-gray-100 text-gray-700 px-3 py-1 rounded text-sm hover:bg-gray-200">
          <i class="fas fa-sync-alt mr-1"></i>새로고침
        </button>
      </div>
      <div id="leave-list"></div>
    </div>
  </div>
</div>

<!-- ════════════════ 직원 관리 탭 ════════════════ -->
<div id="page-employees" class="hidden">
  <div class="bg-white rounded-2xl shadow-md p-5">
    <h2 class="text-lg font-bold text-blue-900 mb-4">
      <i class="fas fa-users-cog mr-2 text-blue-500"></i>직원 관리
    </h2>
    <div class="flex gap-3 mb-5">
      <input type="text" id="new-employee-name" placeholder="직원 이름" class="text-sm flex-1">
      <input type="text" id="new-employee-pos" placeholder="직책 (예: 사회복지사)" class="text-sm flex-1">
      <button onclick="addEmployee()" class="bg-blue-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-800 whitespace-nowrap">
        <i class="fas fa-plus mr-1"></i>직원 추가
      </button>
    </div>
    <div id="employee-list"></div>
  </div>
</div>

</main>

<!-- 연차 신청서 출력 모달 -->
<div id="leave-modal" class="fixed inset-0 modal-bg z-50 hidden flex items-center justify-center p-4">
  <div class="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-screen overflow-y-auto">
    <div class="p-6" id="leave-print-content"></div>
    <div class="flex gap-3 p-4 border-t no-print">
      <button onclick="window.print()" class="flex-1 bg-blue-700 text-white py-2 rounded-lg font-medium hover:bg-blue-800">
        <i class="fas fa-print mr-1"></i>인쇄
      </button>
      <button onclick="closeLeaveModal()" class="flex-1 bg-gray-200 text-gray-700 py-2 rounded-lg font-medium hover:bg-gray-300">닫기</button>
    </div>
  </div>
</div>

<!-- 알림 토스트 -->
<div id="toast" class="fixed bottom-6 right-6 z-50 hidden"></div>

<script>
// ═══════════════════════════════════════════════════
// 전역 상태
// ═══════════════════════════════════════════════════
let employees = []
let selectedStatus = ''
let currentLeaveId = null

// 한국어 요일
const DAYS = ['일','월','화','수','목','금','토']
const STATUS_COLORS = {
  '출근':'status-출근','퇴근':'status-퇴근','연차':'status-연차',
  '오전반차':'status-오전반차','오후반차':'status-오후반차',
  '병가':'status-병가','경조휴가':'status-경조휴가','공가':'status-공가','휴무':'status-휴무'
}

// ═══════════════════════════════════════════════════
// 초기화
// ═══════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  startClock()
  setDefaultDate()
  await loadEmployees()
  loadTodayAttendance()
  loadMonthSummary()
})

function startClock() {
  function tick() {
    const now = new Date()
    const h = String(now.getHours()).padStart(2,'0')
    const m = String(now.getMinutes()).padStart(2,'0')
    const s = String(now.getSeconds()).padStart(2,'0')
    document.getElementById('liveClock').textContent = h+':'+m+':'+s
  }
  tick(); setInterval(tick, 1000)
}

function setDefaultDate() {
  const today = new Date()
  const str = today.toISOString().slice(0,10)
  const el = document.getElementById('reg-date')
  if(el) el.value = str

  // 오늘 날짜 라벨
  const label = document.getElementById('today-date-label')
  if(label) {
    const d = today
    label.textContent = d.getFullYear()+'년 '+(d.getMonth()+1)+'월 '+d.getDate()+'일 ('+DAYS[d.getDay()]+')'
  }
}

async function loadEmployees() {
  const r = await fetch('/api/employees')
  const data = await r.json()
  employees = data.data || []

  // 모든 직원 셀렉트 채우기
  const selects = ['reg-employee','print-employee','lr-employee']
  selects.forEach(id => {
    const el = document.getElementById(id)
    if(!el) return
    const prev = el.value
    el.innerHTML = '<option value="">-- 선택 --</option>'
    employees.forEach(e => {
      el.innerHTML += '<option value="'+e.id+'">'+e.name+'</option>'
    })
    if(prev) el.value = prev
  })
  renderEmployeeList()
}

// ═══════════════════════════════════════════════════
// 탭 전환
// ═══════════════════════════════════════════════════
function showTab(name) {
  document.querySelectorAll('[id^="page-"]').forEach(el => el.classList.add('hidden'))
  document.getElementById('page-'+name).classList.remove('hidden')
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('tab-active')
    btn.classList.add('bg-gray-100','hover:bg-gray-200','text-gray-700')
  })
  const activeBtn = document.getElementById('tab-'+name)
  if(activeBtn) {
    activeBtn.classList.add('tab-active')
    activeBtn.classList.remove('bg-gray-100','hover:bg-gray-200','text-gray-700')
  }
  // 탭별 초기 로드
  if(name==='monthly') loadMonthly()
  if(name==='stats') loadStats()
  if(name==='leave') loadLeaveRequests()
}

// ═══════════════════════════════════════════════════
// 출퇴근 등록
// ═══════════════════════════════════════════════════
function setStatus(s) {
  selectedStatus = s
  document.getElementById('reg-status').value = s
  document.getElementById('reg-status-display').textContent = '선택: '+s
  document.getElementById('reg-status-display').className = 'mb-3 text-center text-sm font-semibold h-6 py-1 px-2 rounded '+STATUS_COLORS[s]

  // 시간 자동 설정
  const timeEl = document.getElementById('reg-time')
  if(s==='연차'||s==='병가'||s==='경조휴가'||s==='공가') {
    timeEl.value = ''
    timeEl.disabled = true
  } else if(s==='퇴근') {
    timeEl.disabled = false
    if(!timeEl.value) timeEl.value='18:00'
  } else if(s==='오전반차') {
    timeEl.disabled = false
    timeEl.value='13:00'
  } else if(s==='오후반차') {
    timeEl.disabled = false
    timeEl.value='08:35'
  } else {
    timeEl.disabled = false
    if(!timeEl.value) {
      const now = new Date()
      timeEl.value = String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0')
    }
  }
  document.querySelectorAll('.status-btn').forEach(btn => btn.style.outline='')
  event.target.style.outline='2px solid #1e40af'
}

async function submitAttendance() {
  const employee_id = document.getElementById('reg-employee').value
  const work_date = document.getElementById('reg-date').value
  const status = document.getElementById('reg-status').value
  const timeVal = document.getElementById('reg-time').value
  const note = document.getElementById('reg-note').value

  if(!employee_id) return showToast('직원을 선택하세요','error')
  if(!work_date) return showToast('날짜를 선택하세요','error')
  if(!status) return showToast('상태를 선택하세요','error')

  let check_in = null, check_out = null
  if(status==='출근') check_in = timeVal
  else if(status==='퇴근') check_out = timeVal
  else if(status==='오전반차') check_out = timeVal  // 오전반차: 오후 출근
  else if(status==='오후반차') check_in = timeVal   // 오후반차: 오전 출근 후 오후 반차

  const r = await fetch('/api/attendance', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({employee_id: parseInt(employee_id), work_date, status, check_in, check_out, note})
  })
  const data = await r.json()
  if(data.ok) {
    showToast('등록 완료!','success')
    loadTodayAttendance()
    loadMonthSummary()
  } else {
    showToast(data.error||'오류 발생','error')
  }
}

async function loadTodayAttendance() {
  const r = await fetch('/api/attendance/today')
  const data = await r.json()
  const list = document.getElementById('today-list')
  if(!data.data || data.data.length===0) {
    list.innerHTML='<div class="text-center text-gray-400 py-4">오늘 등록된 기록이 없습니다</div>'
    return
  }
  list.innerHTML = data.data.map(a => {
    const sc = STATUS_COLORS[a.status] || 'bg-gray-100 text-gray-500'
    return \`<div class="flex items-center justify-between p-3 rounded-xl border \${sc.split(' ')[0]==='status-출근'?'border-green-200':'border-gray-100'}">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center font-bold text-blue-800 text-sm">\${a.name.charAt(0)}</div>
        <div>
          <div class="font-semibold text-gray-800">\${a.name}</div>
          <div class="text-xs text-gray-500">\${a.position||''}</div>
        </div>
      </div>
      <div class="text-right">
        <span class="inline-block px-2 py-1 rounded-full text-xs font-medium \${sc}">\${a.status||'미등록'}</span>
        \${a.check_in ? '<div class="text-xs text-gray-500 mt-1">출근 '+a.check_in+'</div>' : ''}
        \${a.check_out ? '<div class="text-xs text-gray-500">퇴근 '+a.check_out+'</div>' : ''}
      </div>
    </div>\`
  }).join('')
}

async function loadMonthSummary() {
  const now = new Date()
  const r = await fetch(\`/api/stats/monthly?year=\${now.getFullYear()}&month=\${now.getMonth()+1}\`)
  const data = await r.json()
  const el = document.getElementById('month-summary')
  if(!el || !data.data) return
  el.innerHTML = data.data.map(d => \`
    <div class="bg-gray-50 rounded-xl p-3 text-center">
      <div class="font-bold text-gray-800 text-sm mb-1">\${d.name}</div>
      <div class="text-xs text-gray-500">출근 <span class="text-green-600 font-bold">\${d.work_count}</span>일</div>
      <div class="text-xs text-gray-500">연차 <span class="text-yellow-600 font-bold">\${d.annual_leave}</span>일</div>
      <div class="text-xs text-gray-500">반차 <span class="text-purple-600 font-bold">\${d.am_half+d.pm_half}</span>회</div>
    </div>
  \`).join('')
}

// ═══════════════════════════════════════════════════
// 월별 근무현황
// ═══════════════════════════════════════════════════
async function loadMonthly() {
  const year = document.getElementById('monthly-year').value
  const month = document.getElementById('monthly-month').value
  const r = await fetch(\`/api/attendance/monthly?year=\${year}&month=\${month}\`)
  const data = await r.json()

  const container = document.getElementById('monthly-table')
  if(!data.data) { container.innerHTML='<p class="text-gray-400">데이터 없음</p>'; return }

  // 날짜별, 직원별 매핑
  const records = data.data
  const dateSet = new Set()
  const empSet = new Set()
  const empNames = {}
  const map = {}

  records.forEach(r => {
    dateSet.add(r.work_date)
    empSet.add(r.employee_id)
    empNames[r.employee_id] = r.name
    if(!map[r.work_date]) map[r.work_date] = {}
    map[r.work_date][r.employee_id] = r
  })

  // 해당 월 모든 날짜 생성
  const allDates = []
  const d = new Date(year, month-1, 1)
  while(d.getMonth() === month-1) {
    allDates.push(d.toISOString().slice(0,10))
    d.setDate(d.getDate()+1)
  }

  const empIds = employees.map(e=>e.id)

  // 공휴일 (간단히 주말만)
  const isHoliday = (dateStr) => {
    const dow = new Date(dateStr).getDay()
    return dow===0||dow===6
  }
  const isSpecialHoliday = (dateStr) => {
    const holidays = ['2026-01-01','2026-01-28','2026-01-29','2026-01-30','2026-03-01','2026-03-02','2026-05-05','2026-06-06']
    return holidays.includes(dateStr)
  }

  let html = \`
    <div class="text-center font-bold text-xl mb-4 print-area">
      산청인애노인통합지원센터 \${year}년 \${month}월 근무상황부
    </div>
    <table class="print-table">
      <thead>
        <tr>
          <th class="w-20">날짜</th>
          <th class="w-8">요일</th>
          \${empIds.map(id=>\`<th>\${empNames[id]||id}</th>\`).join('')}
          <th>비고</th>
        </tr>
      </thead>
      <tbody>
  \`

  allDates.forEach(dateStr => {
    const dow = new Date(dateStr).getDay()
    const dayName = DAYS[dow]
    const isWknd = dow===0||dow===6
    const isHol = isSpecialHoliday(dateStr)
    const rowClass = isWknd||isHol ? 'bg-red-50' : ''
    const dayClass = dow===0?'text-red-500 font-bold': dow===6?'text-blue-500 font-bold':''

    html += \`<tr class="\${rowClass}">\`
    html += \`<td class="text-xs">\${dateStr.slice(5)}</td>\`
    html += \`<td class="\${dayClass} text-xs">\${dayName}</td>\`

    empIds.forEach(eid => {
      const rec = map[dateStr]?.[eid]
      if(isWknd||isHol) {
        html += \`<td class="text-gray-400 text-xs">휴무</td>\`
      } else if(rec) {
        const sc = STATUS_COLORS[rec.status]||''
        const display = rec.status==='출근'
          ? (rec.check_in||rec.status)
          : rec.status
        html += \`<td class="\${sc} text-xs font-medium">\${display}</td>\`
      } else {
        html += \`<td class="text-gray-300 text-xs">-</td>\`
      }
    })

    const notes = []
    if(isHol) notes.push(isSpecialHoliday(dateStr)?'공휴일':'')
    html += \`<td class="text-xs text-gray-500">\${notes.join(', ')}</td>\`
    html += \`</tr>\`
  })

  html += '</tbody></table>'
  container.innerHTML = html
}

// ═══════════════════════════════════════════════════
// 통계
// ═══════════════════════════════════════════════════
async function loadStats() {
  const year = document.getElementById('stats-year').value
  const month = document.getElementById('stats-month').value
  let url, title

  if(month) {
    url = \`/api/stats/monthly?year=\${year}&month=\${month}\`
    title = \`\${year}년 \${month}월 근무 통계\`
  } else {
    url = \`/api/stats/yearly?year=\${year}\`
    title = \`\${year}년 연간 누적 통계\`
  }

  const r = await fetch(url)
  const data = await r.json()
  const container = document.getElementById('stats-table')
  if(!data.data) { container.innerHTML='<p class="text-gray-400">데이터 없음</p>'; return }

  const rows = data.data

  let html = \`
    <h3 class="font-bold text-blue-900 mb-4 text-center">\${title}</h3>
    <div class="overflow-x-auto">
    <table class="print-table">
      <thead>
        <tr>
          <th>성명</th>
          <th>출근일수</th>
          <th>연차(일)</th>
          <th>오전반차(회)</th>
          <th>오후반차(회)</th>
          <th>반차환산(일)</th>
          <th>병가(일)</th>
          <th>경조휴가(일)</th>
          <th>공가(일)</th>
          \${!month?'<th>총 연차환산</th>':''}
        </tr>
      </thead>
      <tbody>
  \`

  rows.forEach(r => {
    const halfDays = ((r.am_half||0)+(r.pm_half||0)) * 0.5
    html += \`<tr>
      <td class="font-medium">\${r.name}</td>
      <td>\${r.work_count||0}</td>
      <td>\${r.annual_leave||0}</td>
      <td>\${r.am_half||0}</td>
      <td>\${r.pm_half||0}</td>
      <td>\${halfDays}</td>
      <td>\${r.sick_leave||0}</td>
      <td>\${r.family_leave||0}</td>
      <td>\${r.official_leave||0}</td>
      \${!month?\`<td class="font-bold text-blue-800">\${(r.annual_leave||0)+halfDays}</td>\`:''}
    </tr>\`
  })

  html += '</tbody></table></div>'
  container.innerHTML = html
}

// ═══════════════════════════════════════════════════
// 개인별 출력
// ═══════════════════════════════════════════════════
async function loadPrint() {
  const eid = document.getElementById('print-employee').value
  const year = document.getElementById('print-year').value
  const month = document.getElementById('print-month').value
  if(!eid) return showToast('직원을 선택하세요','error')

  const emp = employees.find(e=>e.id==eid)
  const r = await fetch(\`/api/attendance/monthly?year=\${year}&month=\${month}&employee_id=\${eid}\`)
  const data = await r.json()

  const allDates = []
  const d = new Date(year, month-1, 1)
  while(d.getMonth() === month-1) {
    allDates.push(d.toISOString().slice(0,10))
    d.setDate(d.getDate()+1)
  }

  const map = {}
  ;(data.data||[]).forEach(rec => { map[rec.work_date] = rec })

  const specialHolidays = ['2026-01-01','2026-01-28','2026-01-29','2026-01-30','2026-03-01','2026-03-02','2026-05-05','2026-06-06']
  const isHol = (d) => specialHolidays.includes(d)

  let workCount=0, annualLeave=0, amHalf=0, pmHalf=0, sickLeave=0, familyLeave=0, officialLeave=0

  const rows = allDates.map(dateStr => {
    const dow = new Date(dateStr).getDay()
    const isWknd = dow===0||dow===6
    const isHoliday = isHol(dateStr)
    const rec = map[dateStr]

    let statusDisplay = '-'
    let checkIn = '-', checkOut = '-'
    let rowClass = ''

    if(isWknd||isHoliday) {
      statusDisplay = '휴무'; rowClass = 'bg-red-50'
    } else if(rec) {
      statusDisplay = rec.status
      checkIn = rec.check_in||'-'
      checkOut = rec.check_out||'-'
      if(rec.status==='출근') workCount++
      if(rec.status==='연차') annualLeave++
      if(rec.status==='오전반차') amHalf++
      if(rec.status==='오후반차') pmHalf++
      if(rec.status==='병가') sickLeave++
      if(rec.status==='경조휴가') familyLeave++
      if(rec.status==='공가') officialLeave++
    }

    const sc = STATUS_COLORS[statusDisplay]||''
    return \`<tr class="\${rowClass}">
      <td>\${dateStr.slice(5)}</td>
      <td class="\${dow===0?'text-red-500':dow===6?'text-blue-500':''}">\${DAYS[dow]}</td>
      <td class="\${sc} font-medium">\${statusDisplay}</td>
      <td>\${checkIn}</td>
      <td>\${checkOut}</td>
      <td class="text-xs text-gray-400">\${rec?.note||''}</td>
    </tr>\`
  }).join('')

  const html = \`
    <div class="print-area">
      <div class="text-center mb-6">
        <h2 class="text-2xl font-bold text-blue-900">산청인애노인통합지원센터</h2>
        <h3 class="text-xl font-semibold mt-1">\${year}년 \${month}월 근무상황부</h3>
        <p class="text-gray-600 mt-1">성명: <strong>\${emp?.name||''}</strong> · 직책: \${emp?.position||''}</p>
      </div>
      <table class="print-table mb-6">
        <thead>
          <tr><th>날짜</th><th>요일</th><th>상태</th><th>출근시간</th><th>퇴근시간</th><th>비고</th></tr>
        </thead>
        <tbody>\${rows}</tbody>
      </table>
      <div class="grid grid-cols-4 gap-3 text-center border rounded-xl overflow-hidden mb-6">
        <div class="bg-green-50 p-3"><div class="text-xs text-gray-500">출근일수</div><div class="text-xl font-bold text-green-700">\${workCount}</div></div>
        <div class="bg-yellow-50 p-3"><div class="text-xs text-gray-500">연차</div><div class="text-xl font-bold text-yellow-700">\${annualLeave}일</div></div>
        <div class="bg-purple-50 p-3"><div class="text-xs text-gray-500">반차</div><div class="text-xl font-bold text-purple-700">\${amHalf+pmHalf}회</div></div>
        <div class="bg-red-50 p-3"><div class="text-xs text-gray-500">병가/기타</div><div class="text-xl font-bold text-red-700">\${sickLeave+familyLeave+officialLeave}일</div></div>
      </div>
      <div class="text-right text-sm text-gray-500">출력일: \${new Date().toLocaleDateString('ko-KR')}</div>
    </div>
  \`
  document.getElementById('print-area').innerHTML = html
}

// ═══════════════════════════════════════════════════
// 연차 신청서
// ═══════════════════════════════════════════════════
async function submitLeaveRequest() {
  const employee_id = document.getElementById('lr-employee').value
  const leave_type = document.getElementById('lr-type').value
  const leave_start = document.getElementById('lr-start').value
  const leave_end = document.getElementById('lr-end').value
  const reason = document.getElementById('lr-reason').value
  const handover = document.getElementById('lr-handover').value

  if(!employee_id||!leave_start||!leave_end) return showToast('필수 항목을 입력하세요','error')

  const r = await fetch('/api/leave-requests',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({employee_id:parseInt(employee_id), leave_type, leave_start, leave_end, reason, handover})
  })
  const data = await r.json()
  if(data.ok) {
    showToast('신청서가 저장되었습니다','success')
    loadLeaveRequests()
  }
}

async function loadLeaveRequests() {
  const r = await fetch('/api/leave-requests?year=2026')
  const data = await r.json()
  const container = document.getElementById('leave-list')
  if(!data.data||data.data.length===0) {
    container.innerHTML='<p class="text-gray-400 text-sm py-4 text-center">신청서가 없습니다</p>'
    return
  }

  container.innerHTML = data.data.map(lr => \`
    <div class="border rounded-xl p-4 mb-3 hover:border-blue-300 transition">
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2">
          <span class="font-bold text-gray-800">\${lr.name}</span>
          <span class="px-2 py-0.5 rounded-full text-xs font-medium \${STATUS_COLORS[lr.leave_type]||'bg-gray-100 text-gray-600'}">\${lr.leave_type}</span>
          <span class="text-sm text-gray-500">\${lr.leave_start} ~ \${lr.leave_end}</span>
        </div>
        <div class="flex gap-2">
          <button onclick="openLeaveModal(\${lr.id})" class="bg-blue-100 text-blue-700 px-3 py-1 rounded text-xs hover:bg-blue-200">
            <i class="fas fa-eye mr-1"></i>보기/결재
          </button>
          <button onclick="deleteLeave(\${lr.id})" class="bg-red-100 text-red-700 px-3 py-1 rounded text-xs hover:bg-red-200">삭제</button>
        </div>
      </div>
      <div class="text-xs text-gray-500">\${lr.reason||'(사유 없음)'}</div>
    </div>
  \`).join('')
}

let currentLeaveData = null

async function openLeaveModal(id) {
  const r = await fetch('/api/leave-requests?year=2026')
  const data = await r.json()
  const lr = data.data.find(x=>x.id===id)
  if(!lr) return
  currentLeaveData = lr
  currentLeaveId = id

  const emp = employees.find(e=>e.id===lr.employee_id)||{}
  const modal = document.getElementById('leave-modal')
  const content = document.getElementById('leave-print-content')

  content.innerHTML = \`
    <div class="print-area">
      <div class="text-center mb-6">
        <h2 class="text-2xl font-bold text-blue-900 border-b-2 border-blue-900 pb-2">연 차 사 용 신 청 서</h2>
        <p class="text-sm text-gray-500 mt-1">산청인애노인통합지원센터</p>
      </div>

      <!-- 결재란 -->
      <div class="approval-grid mb-6">
        <div class="approval-cell bg-blue-50 font-bold text-blue-900">담당</div>
        <div class="approval-cell bg-blue-50 font-bold text-blue-900">전문사회복지사</div>
        <div class="approval-cell bg-blue-50 font-bold text-blue-900">센터장</div>
        <div class="approval-cell min-h-16">
          <div id="sign-applicant" class="sign-box" contenteditable="true" style="min-height:50px">\${lr.applicant_sign||''}</div>
          <div class="text-xs mt-1">
            <input id="date-applicant" type="text" value="\${lr.applicant_date||''}" placeholder="서명일자" style="font-size:10px;padding:2px;text-align:center">
          </div>
        </div>
        <div class="approval-cell min-h-16">
          <div id="sign-social" class="sign-box" contenteditable="true" style="min-height:50px">\${lr.social_worker_sign||''}</div>
          <div class="text-xs mt-1">
            <input id="date-social" type="text" value="\${lr.social_worker_date||''}" placeholder="서명일자" style="font-size:10px;padding:2px;text-align:center">
          </div>
        </div>
        <div class="approval-cell min-h-16">
          <div id="sign-director" class="sign-box" contenteditable="true" style="min-height:50px">\${lr.director_sign||''}</div>
          <div class="text-xs mt-1">
            <input id="date-director" type="text" value="\${lr.director_date||''}" placeholder="서명일자" style="font-size:10px;padding:2px;text-align:center">
          </div>
        </div>
      </div>

      <!-- 신청 내용 -->
      <table class="print-table mb-4">
        <tr>
          <th class="w-32 bg-blue-50">신청자</th>
          <td class="font-bold">\${lr.name}</td>
          <th class="w-32 bg-blue-50">제출일</th>
          <td>\${lr.created_at?.slice(0,10)||''}</td>
        </tr>
        <tr>
          <th class="bg-blue-50">휴가 사용 기간</th>
          <td>\${lr.leave_start} ~ \${lr.leave_end}</td>
          <th class="bg-blue-50">휴가 구분</th>
          <td class="font-bold">\${lr.leave_type}</td>
        </tr>
        <tr>
          <th class="bg-blue-50">사유</th>
          <td colspan="3">
            <div id="lr-edit-reason" contenteditable="true" class="min-h-8 p-1">\${lr.reason||''}</div>
          </td>
        </tr>
        <tr>
          <th class="bg-blue-50">주요 업무<br>인수인계 사항</th>
          <td colspan="3">
            <div id="lr-edit-handover" contenteditable="true" class="min-h-16 p-1" style="min-height:60px">\${lr.handover||''}</div>
          </td>
        </tr>
      </table>

      <div class="text-center text-sm text-gray-500 mt-4">
        위와 같이 휴가 사용을 신청합니다.<br>
        <span class="font-medium">\${lr.leave_start?.slice(0,4)}년 \${lr.leave_start?.slice(5,7)}월 \${lr.leave_start?.slice(8,10)}일</span>
      </div>
    </div>
    <div class="flex gap-2 mt-4 no-print">
      <button onclick="saveLeaveEdits(\${id})" class="bg-green-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-700">
        <i class="fas fa-save mr-1"></i>변경사항 저장
      </button>
    </div>
  \`
  modal.classList.remove('hidden')
}

async function saveLeaveEdits(id) {
  const lr = currentLeaveData
  const updates = {
    leave_start: lr.leave_start,
    leave_end: lr.leave_end,
    leave_type: lr.leave_type,
    reason: document.getElementById('lr-edit-reason')?.innerText || lr.reason,
    handover: document.getElementById('lr-edit-handover')?.innerText || lr.handover,
    applicant_sign: document.getElementById('sign-applicant')?.innerText || '',
    applicant_date: document.getElementById('date-applicant')?.value || '',
    social_worker_sign: document.getElementById('sign-social')?.innerText || '',
    social_worker_date: document.getElementById('date-social')?.value || '',
    director_sign: document.getElementById('sign-director')?.innerText || '',
    director_date: document.getElementById('date-director')?.value || '',
    status: lr.status
  }
  const r = await fetch('/api/leave-requests/'+id, {
    method:'PUT',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(updates)
  })
  const data = await r.json()
  if(data.ok) {
    showToast('저장되었습니다','success')
    loadLeaveRequests()
  }
}

function closeLeaveModal() {
  document.getElementById('leave-modal').classList.add('hidden')
}

async function deleteLeave(id) {
  if(!confirm('삭제하시겠습니까?')) return
  const r = await fetch('/api/leave-requests/'+id, {method:'DELETE'})
  const data = await r.json()
  if(data.ok) { showToast('삭제되었습니다','success'); loadLeaveRequests() }
}

// ═══════════════════════════════════════════════════
// 직원 관리
// ═══════════════════════════════════════════════════
function renderEmployeeList() {
  const container = document.getElementById('employee-list')
  if(!container) return
  if(employees.length===0) {
    container.innerHTML='<p class="text-gray-400 text-sm">등록된 직원이 없습니다</p>'
    return
  }
  container.innerHTML = \`
    <table class="print-table">
      <thead><tr><th>번호</th><th>성명</th><th>직책</th><th>관리</th></tr></thead>
      <tbody>
        \${employees.map(e=>\`
          <tr>
            <td>\${e.id}</td>
            <td class="font-medium">\${e.name}</td>
            <td>\${e.position||''}</td>
            <td><button onclick="removeEmployee(\${e.id})" class="bg-red-100 text-red-700 px-3 py-1 rounded text-xs hover:bg-red-200">삭제</button></td>
          </tr>
        \`).join('')}
      </tbody>
    </table>
  \`
}

async function addEmployee() {
  const name = document.getElementById('new-employee-name').value.trim()
  const pos = document.getElementById('new-employee-pos').value.trim()
  if(!name) return showToast('이름을 입력하세요','error')
  const r = await fetch('/api/employees',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name, position: pos||'사회복지사'})
  })
  const data = await r.json()
  if(data.ok) {
    showToast(name+' 직원이 추가되었습니다','success')
    document.getElementById('new-employee-name').value=''
    document.getElementById('new-employee-pos').value=''
    await loadEmployees()
  }
}

async function removeEmployee(id) {
  const emp = employees.find(e=>e.id===id)
  if(!confirm((emp?.name||id)+'을(를) 삭제하시겠습니까?')) return
  const r = await fetch('/api/employees/'+id, {method:'DELETE'})
  const data = await r.json()
  if(data.ok) {
    showToast('삭제되었습니다','success')
    await loadEmployees()
  }
}

// ═══════════════════════════════════════════════════
// 유틸
// ═══════════════════════════════════════════════════
function showToast(msg, type='info') {
  const toast = document.getElementById('toast')
  const bgColor = type==='success'?'bg-green-600':type==='error'?'bg-red-600':'bg-blue-600'
  const icon = type==='success'?'fa-check-circle':type==='error'?'fa-exclamation-circle':'fa-info-circle'
  toast.innerHTML = \`<div class="\${bgColor} text-white px-5 py-3 rounded-xl shadow-lg flex items-center gap-2">
    <i class="fas \${icon}"></i>\${msg}
  </div>\`
  toast.classList.remove('hidden')
  setTimeout(()=>toast.classList.add('hidden'), 3000)
}

// 월 선택 기본값 현재월로
const now = new Date()
document.getElementById('monthly-month').value = now.getMonth()+1
document.getElementById('stats-month').value = ''
document.getElementById('print-month').value = now.getMonth()+1
</script>
</body>
</html>`
}

export default app
