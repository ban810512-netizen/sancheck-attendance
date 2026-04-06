-- 3월 평일 출근시간 무작위 업데이트
-- 규칙: 08:35~08:50 범위, 날짜별 직원간 중복 없음, 날마다 개인별 시간 다름

UPDATE attendance SET check_in='08:39' WHERE employee_id=1 AND work_date='2026-03-03';
UPDATE attendance SET check_in='08:46' WHERE employee_id=2 AND work_date='2026-03-03';
UPDATE attendance SET check_in='08:38' WHERE employee_id=3 AND work_date='2026-03-03';
UPDATE attendance SET check_in='08:35' WHERE employee_id=5 AND work_date='2026-03-03';

UPDATE attendance SET check_in='08:46' WHERE employee_id=1 AND work_date='2026-03-04';
UPDATE attendance SET check_in='08:43' WHERE employee_id=2 AND work_date='2026-03-04';
UPDATE attendance SET check_in='08:45' WHERE employee_id=3 AND work_date='2026-03-04';
UPDATE attendance SET check_in='08:38' WHERE employee_id=5 AND work_date='2026-03-04';

UPDATE attendance SET check_in='08:36' WHERE employee_id=1 AND work_date='2026-03-05';
UPDATE attendance SET check_in='08:50' WHERE employee_id=2 AND work_date='2026-03-05';
UPDATE attendance SET check_in='08:38' WHERE employee_id=3 AND work_date='2026-03-05';
UPDATE attendance SET check_in='08:35' WHERE employee_id=5 AND work_date='2026-03-05';

UPDATE attendance SET check_in='08:41' WHERE employee_id=1 AND work_date='2026-03-06';
UPDATE attendance SET check_in='08:45' WHERE employee_id=4 AND work_date='2026-03-06';
UPDATE attendance SET check_in='08:46' WHERE employee_id=5 AND work_date='2026-03-06';

UPDATE attendance SET check_in='08:50' WHERE employee_id=1 AND work_date='2026-03-09';
UPDATE attendance SET check_in='08:42' WHERE employee_id=2 AND work_date='2026-03-09';
UPDATE attendance SET check_in='08:39' WHERE employee_id=4 AND work_date='2026-03-09';
UPDATE attendance SET check_in='08:44' WHERE employee_id=5 AND work_date='2026-03-09';

UPDATE attendance SET check_in='08:45' WHERE employee_id=1 AND work_date='2026-03-10';
UPDATE attendance SET check_in='08:39' WHERE employee_id=2 AND work_date='2026-03-10';
UPDATE attendance SET check_in='08:37' WHERE employee_id=3 AND work_date='2026-03-10';
UPDATE attendance SET check_in='08:38' WHERE employee_id=4 AND work_date='2026-03-10';
UPDATE attendance SET check_in='08:40' WHERE employee_id=5 AND work_date='2026-03-10';

-- 03-11 반철영 오후반차(check_in 있음) + 나머지 출근
UPDATE attendance SET check_in='08:48' WHERE employee_id=1 AND work_date='2026-03-11';
UPDATE attendance SET check_in='08:39' WHERE employee_id=2 AND work_date='2026-03-11';
UPDATE attendance SET check_in='08:44' WHERE employee_id=3 AND work_date='2026-03-11';
UPDATE attendance SET check_in='08:46' WHERE employee_id=4 AND work_date='2026-03-11';
UPDATE attendance SET check_in='08:40' WHERE employee_id=5 AND work_date='2026-03-11';

UPDATE attendance SET check_in='08:39' WHERE employee_id=2 AND work_date='2026-03-12';
UPDATE attendance SET check_in='08:36' WHERE employee_id=3 AND work_date='2026-03-12';
UPDATE attendance SET check_in='08:47' WHERE employee_id=4 AND work_date='2026-03-12';
UPDATE attendance SET check_in='08:43' WHERE employee_id=5 AND work_date='2026-03-12';

UPDATE attendance SET check_in='08:45' WHERE employee_id=1 AND work_date='2026-03-13';
UPDATE attendance SET check_in='08:39' WHERE employee_id=2 AND work_date='2026-03-13';
UPDATE attendance SET check_in='08:35' WHERE employee_id=3 AND work_date='2026-03-13';
UPDATE attendance SET check_in='08:37' WHERE employee_id=4 AND work_date='2026-03-13';
UPDATE attendance SET check_in='08:38' WHERE employee_id=5 AND work_date='2026-03-13';

UPDATE attendance SET check_in='08:42' WHERE employee_id=1 AND work_date='2026-03-16';
UPDATE attendance SET check_in='08:40' WHERE employee_id=2 AND work_date='2026-03-16';
UPDATE attendance SET check_in='08:45' WHERE employee_id=3 AND work_date='2026-03-16';
UPDATE attendance SET check_in='08:37' WHERE employee_id=4 AND work_date='2026-03-16';
UPDATE attendance SET check_in='08:43' WHERE employee_id=5 AND work_date='2026-03-16';

-- 03-17 반철영 오후반차(check_in 있음) + 나머지 출근
UPDATE attendance SET check_in='08:37' WHERE employee_id=1 AND work_date='2026-03-17';
UPDATE attendance SET check_in='08:50' WHERE employee_id=2 AND work_date='2026-03-17';
UPDATE attendance SET check_in='08:43' WHERE employee_id=3 AND work_date='2026-03-17';
UPDATE attendance SET check_in='08:44' WHERE employee_id=4 AND work_date='2026-03-17';
UPDATE attendance SET check_in='08:45' WHERE employee_id=5 AND work_date='2026-03-17';

UPDATE attendance SET check_in='08:46' WHERE employee_id=1 AND work_date='2026-03-18';
UPDATE attendance SET check_in='08:50' WHERE employee_id=2 AND work_date='2026-03-18';
UPDATE attendance SET check_in='08:49' WHERE employee_id=3 AND work_date='2026-03-18';
UPDATE attendance SET check_in='08:45' WHERE employee_id=4 AND work_date='2026-03-18';
UPDATE attendance SET check_in='08:43' WHERE employee_id=5 AND work_date='2026-03-18';

UPDATE attendance SET check_in='08:47' WHERE employee_id=1 AND work_date='2026-03-19';
UPDATE attendance SET check_in='08:41' WHERE employee_id=2 AND work_date='2026-03-19';
UPDATE attendance SET check_in='08:40' WHERE employee_id=3 AND work_date='2026-03-19';
UPDATE attendance SET check_in='08:39' WHERE employee_id=4 AND work_date='2026-03-19';
UPDATE attendance SET check_in='08:36' WHERE employee_id=5 AND work_date='2026-03-19';

UPDATE attendance SET check_in='08:41' WHERE employee_id=1 AND work_date='2026-03-20';
UPDATE attendance SET check_in='08:45' WHERE employee_id=2 AND work_date='2026-03-20';
UPDATE attendance SET check_in='08:42' WHERE employee_id=5 AND work_date='2026-03-20';

UPDATE attendance SET check_in='08:37' WHERE employee_id=1 AND work_date='2026-03-23';
UPDATE attendance SET check_in='08:38' WHERE employee_id=2 AND work_date='2026-03-23';
UPDATE attendance SET check_in='08:46' WHERE employee_id=3 AND work_date='2026-03-23';
UPDATE attendance SET check_in='08:39' WHERE employee_id=4 AND work_date='2026-03-23';
UPDATE attendance SET check_in='08:50' WHERE employee_id=5 AND work_date='2026-03-23';

UPDATE attendance SET check_in='08:43' WHERE employee_id=1 AND work_date='2026-03-24';
UPDATE attendance SET check_in='08:37' WHERE employee_id=2 AND work_date='2026-03-24';
UPDATE attendance SET check_in='08:38' WHERE employee_id=3 AND work_date='2026-03-24';
UPDATE attendance SET check_in='08:47' WHERE employee_id=4 AND work_date='2026-03-24';
UPDATE attendance SET check_in='08:40' WHERE employee_id=5 AND work_date='2026-03-24';

-- 03-25 반철영 오후반차(check_in 있음) + 나머지 출근
UPDATE attendance SET check_in='08:47' WHERE employee_id=1 AND work_date='2026-03-25';
UPDATE attendance SET check_in='08:45' WHERE employee_id=2 AND work_date='2026-03-25';
UPDATE attendance SET check_in='08:39' WHERE employee_id=3 AND work_date='2026-03-25';
UPDATE attendance SET check_in='08:49' WHERE employee_id=4 AND work_date='2026-03-25';
UPDATE attendance SET check_in='08:37' WHERE employee_id=5 AND work_date='2026-03-25';

UPDATE attendance SET check_in='08:50' WHERE employee_id=1 AND work_date='2026-03-26';
UPDATE attendance SET check_in='08:39' WHERE employee_id=2 AND work_date='2026-03-26';
UPDATE attendance SET check_in='08:49' WHERE employee_id=3 AND work_date='2026-03-26';
UPDATE attendance SET check_in='08:43' WHERE employee_id=4 AND work_date='2026-03-26';

UPDATE attendance SET check_in='08:47' WHERE employee_id=1 AND work_date='2026-03-27';
UPDATE attendance SET check_in='08:45' WHERE employee_id=2 AND work_date='2026-03-27';
UPDATE attendance SET check_in='08:43' WHERE employee_id=4 AND work_date='2026-03-27';
UPDATE attendance SET check_in='08:40' WHERE employee_id=5 AND work_date='2026-03-27';

UPDATE attendance SET check_in='08:40' WHERE employee_id=1 AND work_date='2026-03-30';
UPDATE attendance SET check_in='08:46' WHERE employee_id=2 AND work_date='2026-03-30';
UPDATE attendance SET check_in='08:47' WHERE employee_id=3 AND work_date='2026-03-30';
UPDATE attendance SET check_in='08:35' WHERE employee_id=4 AND work_date='2026-03-30';
UPDATE attendance SET check_in='08:42' WHERE employee_id=5 AND work_date='2026-03-30';

UPDATE attendance SET check_in='08:45' WHERE employee_id=1 AND work_date='2026-03-31';
UPDATE attendance SET check_in='08:48' WHERE employee_id=3 AND work_date='2026-03-31';
UPDATE attendance SET check_in='08:43' WHERE employee_id=4 AND work_date='2026-03-31';
UPDATE attendance SET check_in='08:44' WHERE employee_id=5 AND work_date='2026-03-31';
