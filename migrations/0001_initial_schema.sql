-- 직원 테이블
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  position TEXT DEFAULT '사회복지사',
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now', '+9 hours'))
);

-- 근무 기록 테이블
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

-- 연차 신청서 테이블
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

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_attendance_employee_date ON attendance(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(work_date);
CREATE INDEX IF NOT EXISTS idx_leave_employee ON leave_requests(employee_id);
