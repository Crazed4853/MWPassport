const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const multer = require('multer');
const csv = require('csv-parser');
const streamifier = require('streamifier');
const crypto = require('crypto');
const path = require('path');
const { pool, initDb, hashPassword, verifyPassword, withTransaction } = require('./db');

const app = express();
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
const UNIT_COUNT = 16;
const MAX_PASSPORTS_PER_STUDENT = 32; // most passports one student can have at the same time

// ===========================================================================
// Middleware
// ===========================================================================
app.set('trust proxy', 1); // Render sits behind a proxy; needed for secure cookies
app.use(express.json({ limit: '1mb' }));

if (!process.env.SESSION_SECRET) {
  console.warn('*** WARNING: SESSION_SECRET is not set. Everyone will be logged out whenever the server restarts. ***');
}

app.use(
  session({
    store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    name: 'passport.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: 12 * 60 * 60 * 1000, // 12 hours
    },
  })
);

// Serve only the web page and images - never server.js, db.js, package.json, etc.
const PUBLIC_FILE = /^\/[^/]+\.(html|png|jpe?g|gif|svg|ico|webp|css)$/i;
const serveStatic = express.static(__dirname, { index: false, dotfiles: 'ignore' });
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use((req, res, next) => (req.method === 'GET' && PUBLIC_FILE.test(req.path) ? serveStatic(req, res, next) : next()));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Memory storage for uploads (no local uploads folder required)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ===========================================================================
// Helpers
// ===========================================================================
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Lets async route handlers pass errors to the error handler
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const requireRole = (...roles) => (req, res, next) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  if (roles.length && !roles.includes(user.role)) {
    return res.status(403).json({ error: 'You do not have permission to do that.' });
  }
  req.user = user;
  next();
};
const anyUser = requireRole();
const staffOnly = requireRole('admin', 'teacher');
const adminOnly = requireRole('admin');
const teacherOnly = requireRole('teacher');

function idParam(value, label = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${label}.`);
  return n;
}

function unitParam(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > UNIT_COUNT) throw new HttpError(400, 'Invalid unit number.');
  return n;
}

function text(value, maxLength = 200) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function requirePassword(value) {
  const password = String(value ?? '').trim();
  if (password.length < 4) throw new HttpError(400, 'Passwords must be at least 4 characters.');
  if (password.length > 200) throw new HttpError(400, 'Password is too long.');
  return password;
}

// Staff (admin/teacher) can assist any student; students can only act on themselves.
function assertCanActOnStudent(user, studentId) {
  if (user.role === 'student' && user.id !== studentId) {
    throw new HttpError(403, 'You can only manage your own account and passports.');
  }
}

function studentName(first, last) {
  return first ? `${last}, ${first}` : last;
}

function toStudent(row) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    studentNum: row.student_num,
    teacherAdvisorId: row.teacher_advisor_id,
    teacherAdvisorName: row.teacher_advisor_name || null,
    pendingTeacherAdvisorId: row.pending_teacher_advisor_id,
  };
}

// Loads passports (with their 16 units) in the shape the front end uses.
// `where` is always a fixed string written in this file; values go in `params`.
async function fetchPassports(where = 'TRUE', params = []) {
  const { rows } = await pool.query(
    `SELECT p.id, p.student_id, p.course_id, p.teacher_id, p.delete_requested,
            s.first_name, s.last_name, c.name AS course_name, t.name AS teacher_name,
            COALESCE(
              json_agg(json_build_object(
                'unitNum', u.unit_num, 'reflection', u.reflection, 'approved', u.approved,
                'needsRevision', u.needs_revision, 'feedback', u.feedback
              ) ORDER BY u.unit_num) FILTER (WHERE u.unit_num IS NOT NULL),
              '[]'
            ) AS units
       FROM passports p
       JOIN students s ON s.id = p.student_id
       JOIN courses  c ON c.id = p.course_id
       JOIN teachers t ON t.id = p.teacher_id
       LEFT JOIN passport_units u ON u.passport_id = p.id
      WHERE ${where}
      GROUP BY p.id, s.id, c.id, t.id
      ORDER BY s.last_name, s.first_name, c.name`,
    params
  );
  return rows.map((r) => ({
    id: r.id,
    studentId: r.student_id,
    studentName: studentName(r.first_name, r.last_name),
    courseId: r.course_id,
    course: r.course_name,
    teacherId: r.teacher_id,
    teacher: r.teacher_name,
    deleteRequested: r.delete_requested,
    units: r.units,
  }));
}

async function getPassportOr404(passportId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.student_id, p.teacher_id, p.delete_requested, t.name AS teacher_name
       FROM passports p JOIN teachers t ON t.id = p.teacher_id
      WHERE p.id = $1`,
    [passportId]
  );
  if (!rows[0]) throw new HttpError(404, 'Passport not found.');
  return rows[0];
}

// Public profile of the logged-in user (never includes password hashes)
async function describeUser(user) {
  if (user.role === 'admin') {
    const { rows } = await pool.query('SELECT id, username FROM admins WHERE id = $1', [user.id]);
    return rows[0] ? { role: 'admin', id: rows[0].id, name: 'Administrator', username: rows[0].username } : null;
  }
  if (user.role === 'teacher') {
    const { rows } = await pool.query('SELECT id, name, username FROM teachers WHERE id = $1', [user.id]);
    return rows[0] ? { role: 'teacher', ...rows[0] } : null;
  }
  const { rows } = await pool.query(
    'SELECT id, first_name, last_name, student_num FROM students WHERE id = $1',
    [user.id]
  );
  if (!rows[0]) return null;
  return {
    role: 'student',
    id: rows[0].id,
    name: `${rows[0].first_name} ${rows[0].last_name}`.trim(),
    firstName: rows[0].first_name,
    lastName: rows[0].last_name,
    studentNum: rows[0].student_num,
  };
}

// ===========================================================================
// Authentication
// ===========================================================================
app.post('/api/login', wrap(async (req, res) => {
  const username = text(req.body.username);
  const password = String(req.body.password ?? '');
  if (!username || !password) throw new HttpError(400, 'Username and password are required.');

  let user = null;

  const admin = (await pool.query(
    'SELECT id, password_hash FROM admins WHERE LOWER(username) = LOWER($1)', [username]
  )).rows[0];
  if (admin && (await verifyPassword(password, admin.password_hash))) user = { role: 'admin', id: admin.id };

  if (!user) {
    const teacher = (await pool.query(
      'SELECT id, password_hash FROM teachers WHERE LOWER(username) = LOWER($1)', [username]
    )).rows[0];
    if (teacher && (await verifyPassword(password, teacher.password_hash))) user = { role: 'teacher', id: teacher.id };
  }

  if (!user) {
    // Students log in with their last name (or student number). Several students
    // can share a last name, so check each match's password.
    const { rows } = await pool.query(
      'SELECT id, password_hash FROM students WHERE LOWER(last_name) = LOWER($1) OR student_num = $1',
      [username]
    );
    for (const student of rows) {
      if (await verifyPassword(password, student.password_hash)) {
        user = { role: 'student', id: student.id };
        break;
      }
    }
  }

  if (!user) throw new HttpError(401, 'Invalid credentials. Please check your details.');

  await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.user = user;
  res.json({ user: await describeUser(user) });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('passport.sid');
    res.json({ ok: true });
  });
});

app.get('/api/me', wrap(async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in.' });
  const user = await describeUser(req.session.user);
  if (!user) {
    // Account was deleted while logged in
    req.session.destroy(() => res.status(401).json({ error: 'Account no longer exists.' }));
    return;
  }
  res.json({ user });
}));

// ===========================================================================
// Courses
// ===========================================================================
app.get('/api/courses', anyUser, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM courses ORDER BY name');
  res.json(rows);
}));

app.post('/api/courses', adminOnly, wrap(async (req, res) => {
  const name = text(req.body.name);
  if (!name) throw new HttpError(400, 'Course name is required.');
  try {
    const { rows } = await pool.query('INSERT INTO courses (name) VALUES ($1) RETURNING id, name', [name]);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, `The course "${name}" already exists.`);
    throw err;
  }
}));

app.delete('/api/courses/:id', adminOnly, wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM courses WHERE id = $1', [idParam(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Course not found.');
  res.json({ ok: true });
}));

// ===========================================================================
// Teachers
// ===========================================================================
app.get('/api/teachers', anyUser, wrap(async (req, res) => {
  const columns = req.user.role === 'admin' ? 'id, name, username' : 'id, name';
  const { rows } = await pool.query(`SELECT ${columns} FROM teachers ORDER BY name`);
  res.json(rows);
}));

app.post('/api/teachers', adminOnly, wrap(async (req, res) => {
  const name = text(req.body.name);
  const username = text(req.body.username);
  if (!name || !username) throw new HttpError(400, 'Teacher name and username are required.');
  const password = requirePassword(req.body.password || 'teacher123');
  try {
    const { rows } = await pool.query(
      'INSERT INTO teachers (name, username, password_hash) VALUES ($1, $2, $3) RETURNING id, name, username',
      [name, username, await hashPassword(password)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, `The username "${username}" is already taken.`);
    throw err;
  }
}));

app.delete('/api/teachers/:id', adminOnly, wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM teachers WHERE id = $1', [idParam(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Teacher not found.');
  res.json({ ok: true });
}));

app.put('/api/teachers/me/password', teacherOnly, wrap(async (req, res) => {
  const password = requirePassword(req.body.password);
  await pool.query('UPDATE teachers SET password_hash = $2 WHERE id = $1', [req.user.id, await hashPassword(password)]);
  res.json({ ok: true });
}));

app.get('/api/teacher/dashboard', teacherOnly, wrap(async (req, res) => {
  const me = req.user.id;
  const [students, taRequests, coursePassports, adviseePassports] = await Promise.all([
    pool.query('SELECT id, first_name, last_name, student_num FROM students ORDER BY last_name, first_name'),
    pool.query(
      `SELECT s.id, s.first_name, s.last_name, ta.name AS current_ta_name
         FROM students s LEFT JOIN teachers ta ON ta.id = s.teacher_advisor_id
        WHERE s.pending_teacher_advisor_id = $1
        ORDER BY s.last_name, s.first_name`,
      [me]
    ),
    fetchPassports('p.teacher_id = $1', [me]),
    fetchPassports('s.teacher_advisor_id = $1', [me]),
  ]);

  res.json({
    students: students.rows.map(toStudent),
    pendingTARequests: taRequests.rows.map((r) => ({
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      currentTAName: r.current_ta_name,
    })),
    pendingDeletions: coursePassports.filter((p) => p.deleteRequested),
    coursePassports,
    adviseePassports,
  });
}));

// ===========================================================================
// Students
// ===========================================================================
app.get('/api/students', staffOnly, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.id, s.first_name, s.last_name, s.student_num, s.teacher_advisor_id,
            s.pending_teacher_advisor_id, ta.name AS teacher_advisor_name
       FROM students s LEFT JOIN teachers ta ON ta.id = s.teacher_advisor_id
      ORDER BY s.last_name, s.first_name`
  );
  res.json(rows.map(toStudent));
}));

app.post('/api/students', adminOnly, wrap(async (req, res) => {
  const firstName = text(req.body.firstName);
  const lastName = text(req.body.lastName);
  const studentNum = text(req.body.studentNum, 50);
  if (!firstName || !lastName || !studentNum) {
    throw new HttpError(400, 'First name, last name and student number are required.');
  }
  // Default password = last 4 digits of the student number
  const password = String(req.body.password || studentNum.slice(-4));
  try {
    const { rows } = await pool.query(
      `INSERT INTO students (first_name, last_name, student_num, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, first_name, last_name, student_num, teacher_advisor_id, pending_teacher_advisor_id`,
      [firstName, lastName, studentNum, await hashPassword(password)]
    );
    res.status(201).json(toStudent(rows[0]));
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, `Student number ${studentNum} already exists.`);
    throw err;
  }
}));

app.delete('/api/students/:id', adminOnly, wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM students WHERE id = $1', [idParam(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Student not found.');
  res.json({ ok: true });
}));

// Everything the student dashboard needs in one request
app.get('/api/students/:id/dashboard', anyUser, wrap(async (req, res) => {
  const studentId = idParam(req.params.id);
  assertCanActOnStudent(req.user, studentId);

  const { rows } = await pool.query(
    `SELECT id, first_name, last_name, student_num, teacher_advisor_id, pending_teacher_advisor_id
       FROM students WHERE id = $1`,
    [studentId]
  );
  if (!rows[0]) throw new HttpError(404, 'Student not found.');

  const [passports, teachers, courses] = await Promise.all([
    fetchPassports('p.student_id = $1', [studentId]),
    pool.query('SELECT id, name FROM teachers ORDER BY name'),
    pool.query('SELECT id, name FROM courses ORDER BY name'),
  ]);

  res.json({
    student: toStudent(rows[0]),
    passports,
    teachers: teachers.rows,
    courses: courses.rows,
    maxPassports: MAX_PASSPORTS_PER_STUDENT,
  });
}));

app.put('/api/students/:id/password', anyUser, wrap(async (req, res) => {
  const studentId = idParam(req.params.id);
  assertCanActOnStudent(req.user, studentId);
  const password = requirePassword(req.body.password);
  const { rows } = await pool.query(
    'UPDATE students SET password_hash = $2 WHERE id = $1 RETURNING first_name, last_name',
    [studentId, await hashPassword(password)]
  );
  if (!rows[0]) throw new HttpError(404, 'Student not found.');
  res.json({ ok: true, studentName: `${rows[0].first_name} ${rows[0].last_name}`.trim() });
}));

// First TA choice is saved immediately; changing TA needs the new teacher's approval
app.put('/api/students/:id/teacher-advisor', anyUser, wrap(async (req, res) => {
  const studentId = idParam(req.params.id);
  assertCanActOnStudent(req.user, studentId);
  const teacherId = idParam(req.body.teacherId, 'teacher');

  const teacher = (await pool.query('SELECT id, name FROM teachers WHERE id = $1', [teacherId])).rows[0];
  if (!teacher) throw new HttpError(404, 'Teacher not found.');
  const student = (await pool.query('SELECT teacher_advisor_id FROM students WHERE id = $1', [studentId])).rows[0];
  if (!student) throw new HttpError(404, 'Student not found.');

  if (!student.teacher_advisor_id) {
    await pool.query(
      'UPDATE students SET teacher_advisor_id = $2, pending_teacher_advisor_id = NULL WHERE id = $1',
      [studentId, teacherId]
    );
    return res.json({ status: 'assigned', teacherName: teacher.name });
  }

  if (student.teacher_advisor_id === teacherId) {
    throw new HttpError(400, `${teacher.name} is already the Teacher Advisor.`);
  }

  await pool.query('UPDATE students SET pending_teacher_advisor_id = $2 WHERE id = $1', [studentId, teacherId]);
  res.json({ status: 'requested', teacherName: teacher.name });
}));

app.delete('/api/students/:id/teacher-advisor-request', anyUser, wrap(async (req, res) => {
  const studentId = idParam(req.params.id);
  assertCanActOnStudent(req.user, studentId);
  await pool.query('UPDATE students SET pending_teacher_advisor_id = NULL WHERE id = $1', [studentId]);
  res.json({ ok: true });
}));

// Only the requested teacher (or an admin) can approve/deny a TA change
async function resolveTARequest(req, approve) {
  const studentId = idParam(req.params.id);
  const onlyTeacherId = req.user.role === 'teacher' ? req.user.id : null;
  const setClause = approve
    ? 'teacher_advisor_id = pending_teacher_advisor_id, pending_teacher_advisor_id = NULL'
    : 'pending_teacher_advisor_id = NULL';
  const { rows } = await pool.query(
    `UPDATE students SET ${setClause}
      WHERE id = $1 AND pending_teacher_advisor_id IS NOT NULL
        AND ($2::int IS NULL OR pending_teacher_advisor_id = $2::int)
      RETURNING first_name, last_name`,
    [studentId, onlyTeacherId]
  );
  if (!rows[0]) throw new HttpError(404, 'No pending Teacher Advisor request found for this student.');
  return `${rows[0].first_name} ${rows[0].last_name}`.trim();
}

app.post('/api/students/:id/ta-request/approve', staffOnly, wrap(async (req, res) => {
  res.json({ ok: true, studentName: await resolveTARequest(req, true) });
}));

app.post('/api/students/:id/ta-request/deny', staffOnly, wrap(async (req, res) => {
  res.json({ ok: true, studentName: await resolveTARequest(req, false) });
}));

// ===========================================================================
// Passports
// ===========================================================================
app.post('/api/students/:id/passports', anyUser, wrap(async (req, res) => {
  const studentId = idParam(req.params.id);
  assertCanActOnStudent(req.user, studentId);
  const courseId = idParam(req.body.courseId, 'course');
  const teacherId = idParam(req.body.teacherId, 'teacher');

  try {
    const passportId = await withTransaction(async (client) => {
      // Lock the student's row so two requests at the same moment can't both slip past the limit
      const student = await client.query('SELECT id FROM students WHERE id = $1 FOR UPDATE', [studentId]);
      if (!student.rows[0]) throw new HttpError(404, 'Student not found.');

      const { rows: countRows } = await client.query(
        'SELECT COUNT(*)::int AS count FROM passports WHERE student_id = $1', [studentId]
      );
      if (countRows[0].count >= MAX_PASSPORTS_PER_STUDENT) {
        throw new HttpError(
          409,
          `This student already has the maximum of ${MAX_PASSPORTS_PER_STUDENT} passports. ` +
          'A passport must be deleted before a new one can be created.'
        );
      }

      const { rows } = await client.query(
        'INSERT INTO passports (student_id, course_id, teacher_id) VALUES ($1, $2, $3) RETURNING id',
        [studentId, courseId, teacherId]
      );
      await client.query(
        'INSERT INTO passport_units (passport_id, unit_num) SELECT $1, g FROM generate_series(1, $2::int) AS g',
        [rows[0].id, UNIT_COUNT]
      );
      return rows[0].id;
    });
    const [passport] = await fetchPassports('p.id = $1', [passportId]);
    res.status(201).json(passport);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'A passport for this course already exists for this student.');
    if (err.code === '23503') throw new HttpError(400, 'The selected student, course or teacher no longer exists.');
    throw err;
  }
}));

// Passports for exports. Admin: all passports. Teacher: only passports they teach.
app.get('/api/passports', staffOnly, wrap(async (req, res) => {
  const conditions = [];
  const params = [];
  if (req.user.role === 'teacher') {
    params.push(req.user.id);
    conditions.push(`p.teacher_id = $${params.length}`);
  }
  const course = text(req.query.course);
  if (course && course !== 'ALL') {
    params.push(course);
    conditions.push(`c.name = $${params.length}`);
  }
  res.json(await fetchPassports(conditions.join(' AND ') || 'TRUE', params));
}));

// End-of-year rollover
app.delete('/api/passports', adminOnly, wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM passports');
  res.json({ ok: true, deleted: rowCount });
}));

app.get('/api/passports/:id', anyUser, wrap(async (req, res) => {
  const [passport] = await fetchPassports('p.id = $1', [idParam(req.params.id)]);
  if (!passport) throw new HttpError(404, 'Passport not found.');
  assertCanActOnStudent(req.user, passport.studentId);
  res.json(passport);
}));

// Student (or staff assisting) requests / cancels deletion
app.post('/api/passports/:id/deletion-request', anyUser, wrap(async (req, res) => {
  const passport = await getPassportOr404(idParam(req.params.id));
  assertCanActOnStudent(req.user, passport.student_id);
  const requested = req.body.requested !== false;
  await pool.query('UPDATE passports SET delete_requested = $2 WHERE id = $1', [passport.id, requested]);
  res.json({ ok: true, teacher: passport.teacher_name });
}));

app.post('/api/passports/:id/deletion/approve', staffOnly, wrap(async (req, res) => {
  const passport = await getPassportOr404(idParam(req.params.id));
  if (req.user.role === 'teacher') {
    if (passport.teacher_id !== req.user.id) throw new HttpError(403, 'Only the course teacher can approve this deletion.');
    if (!passport.delete_requested) throw new HttpError(400, 'There is no pending deletion request for this passport.');
  }
  await pool.query('DELETE FROM passports WHERE id = $1', [passport.id]);
  res.json({ ok: true });
}));

app.post('/api/passports/:id/deletion/deny', staffOnly, wrap(async (req, res) => {
  const passport = await getPassportOr404(idParam(req.params.id));
  if (req.user.role === 'teacher' && passport.teacher_id !== req.user.id) {
    throw new HttpError(403, 'Only the course teacher can deny this deletion.');
  }
  await pool.query('UPDATE passports SET delete_requested = FALSE WHERE id = $1', [passport.id]);
  res.json({ ok: true });
}));

app.put('/api/passports/:id/units/:unitNum/reflection', anyUser, wrap(async (req, res) => {
  const passport = await getPassportOr404(idParam(req.params.id));
  assertCanActOnStudent(req.user, passport.student_id);
  const unitNum = unitParam(req.params.unitNum);
  const reflection = String(req.body.reflection ?? '').slice(0, 10000);

  const { rowCount } = await pool.query(
    `UPDATE passport_units SET reflection = $3, needs_revision = FALSE, updated_at = NOW()
      WHERE passport_id = $1 AND unit_num = $2 AND approved = FALSE`,
    [passport.id, unitNum, reflection]
  );
  if (!rowCount) throw new HttpError(400, 'This unit has already been signed off and can no longer be edited.');
  res.json({ ok: true });
}));

app.put('/api/passports/:id/units/:unitNum/review', staffOnly, wrap(async (req, res) => {
  const passport = await getPassportOr404(idParam(req.params.id));
  if (req.user.role === 'teacher' && passport.teacher_id !== req.user.id) {
    throw new HttpError(403, 'Only the course teacher can sign off on or request revisions for this passport.');
  }
  const unitNum = unitParam(req.params.unitNum);
  const approve = req.body.approve === true;
  const feedback = String(req.body.feedback ?? '').trim().slice(0, 5000);

  await pool.query(
    `UPDATE passport_units SET approved = $3, needs_revision = $4, feedback = $5, updated_at = NOW()
      WHERE passport_id = $1 AND unit_num = $2`,
    [passport.id, unitNum, approve, !approve, feedback]
  );
  res.json({ ok: true });
}));

// ===========================================================================
// Bulk CSV imports (admin only) - rows are saved straight into the database
// ===========================================================================
const parseCSVFromBuffer = (buffer) =>
  new Promise((resolve, reject) => {
    const results = [];
    streamifier
      .createReadStream(buffer)
      .pipe(csv({ mapHeaders: ({ header }) => header.replace(/^\uFEFF/, '').trim() })) // strip Excel BOM
      .on('data', (row) => results.push(row))
      .on('end', () => resolve(results))
      .on('error', reject);
  });

// "First Name", "first_name" and "firstName" all become "firstname"
function normalizeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.toLowerCase().replace(/[^a-z0-9]/g, '')] = String(value ?? '').trim();
  }
  return out;
}

// prepare(row) -> { error } or data;  insert(data) -> true if inserted, false if it already existed
async function runImport(rows, prepare, insert) {
  const BATCH_SIZE = 8;
  let imported = 0;
  const skipped = [];

  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (raw, i) => {
        const line = start + i + 2; // +2 = header row + 1-based numbering
        const item = prepare(normalizeRow(raw));
        if (item.error) return `Row ${line}: ${item.error}`;
        try {
          return (await insert(item)) ? null : `Row ${line}: already exists`;
        } catch (err) {
          return `Row ${line}: ${err.message}`;
        }
      })
    );
    for (const result of results) {
      if (result) skipped.push(result);
      else imported++;
    }
  }

  return { status: 'Success', rowsRead: rows.length, imported, skipped: skipped.length, skippedDetails: skipped.slice(0, 50) };
}

function csvImportRoute(prepare, insert) {
  return [
    adminOnly,
    upload.single('file'),
    wrap(async (req, res) => {
      if (!req.file) throw new HttpError(400, 'No file uploaded.');
      let rows;
      try {
        rows = await parseCSVFromBuffer(req.file.buffer);
      } catch (err) {
        throw new HttpError(400, `Could not read CSV: ${err.message}`);
      }
      res.json(await runImport(rows, prepare, insert));
    }),
  ];
}

app.post('/api/bulk-courses', ...csvImportRoute(
  (r) => {
    const name = (r.course || r.coursename || r.name || Object.values(r)[0] || '').slice(0, 200);
    return name ? { name } : { error: 'missing course name' };
  },
  async ({ name }) => {
    const { rowCount } = await pool.query('INSERT INTO courses (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
    return rowCount > 0;
  }
));

app.post('/api/bulk-teachers', ...csvImportRoute(
  (r) => {
    const name = (r.name || `${r.firstname || ''} ${r.lastname || ''}`).trim().slice(0, 200);
    const username = (r.username || r.lastname || name.replace(/[^a-zA-Z]/g, '')).slice(0, 200);
    const password = r.password || 'teacher123';
    if (!name || !username) return { error: 'missing name/username' };
    return { name, username, password };
  },
  async ({ name, username, password }) => {
    const { rowCount } = await pool.query(
      'INSERT INTO teachers (name, username, password_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [name, username, await hashPassword(password)]
    );
    return rowCount > 0;
  }
));

app.post('/api/bulk-students', ...csvImportRoute(
  (r) => {
    const firstName = (r.firstname || r.first || '').slice(0, 200);
    const lastName = (r.lastname || r.last || '').slice(0, 200);
    const studentNum = (r.studentnum || r.studentnumber || r.studentid || r.id || '').slice(0, 50);
    if (!lastName) return { error: 'missing lastName' };
    if (!studentNum) return { error: 'missing studentNum' };
    return { firstName, lastName, studentNum, password: r.password || studentNum.slice(-4) };
  },
  async ({ firstName, lastName, studentNum, password }) => {
    const { rowCount } = await pool.query(
      `INSERT INTO students (first_name, last_name, student_num, password_hash)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [firstName, lastName, studentNum, await hashPassword(password)]
    );
    return rowCount > 0;
  }
));

// ===========================================================================
// Errors
// ===========================================================================
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: `Upload error: ${err.message}` });
  if (err.code === '23503') {
    return res.status(409).json({
      error: "This item is still linked to existing passports, so it can't be removed yet. " +
        'Delete those passports first (or use the end-of-year rollover).',
    });
  }
  if (err.code === '23505') return res.status(409).json({ error: 'That record already exists.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request data.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

// ===========================================================================
// Start
// ===========================================================================
const PORT = process.env.PORT || 3000; // Render assigns PORT automatically

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to set up the database:', err);
    process.exit(1);
  });
