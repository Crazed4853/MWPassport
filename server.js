const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const streamifier = require('streamifier');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const upload = multer({ storage: multer.memoryStorage() });

// Connect to Render PostgreSQL or fallback to local connection string
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/passport_db',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Initialize Database Tables
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS courses (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS teachers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      student_num TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      teacher_advisor_id TEXT,
      pending_teacher_advisor_id TEXT
    );
    CREATE TABLE IF NOT EXISTS passports (
      id TEXT PRIMARY KEY,
      student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
      student_name TEXT NOT NULL,
      course TEXT NOT NULL,
      teacher TEXT NOT NULL,
      delete_requested BOOLEAN DEFAULT FALSE,
      units JSONB NOT NULL
    );
  `);
}
initDB().catch(console.error);

// Helper to parse CSV buffer
const parseCSVFromBuffer = (buffer) => {
  return new Promise((resolve, reject) => {
    const results = [];
    streamifier.createReadStream(buffer)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (err) => reject(err));
  });
};

// --- AUTHENTICATION & FULL DATA FETCH ---
app.get('/api/data', async (req, res) => {
  try {
    const coursesRes = await pool.query('SELECT name FROM courses ORDER BY name ASC');
    const teachersRes = await pool.query('SELECT id, name, username, password FROM teachers');
    const studentsRes = await pool.query('SELECT id, first_name AS "firstName", last_name AS "lastName", student_num AS "studentNum", password, teacher_advisor_id AS "teacherAdvisorId", pending_teacher_advisor_id AS "pendingTeacherAdvisorId" FROM students');
    const passportsRes = await pool.query('SELECT id, student_id AS "studentId", student_name AS "studentName", course, teacher, delete_requested AS "deleteRequested", units FROM passports');

    res.json({
      courses: coursesRes.rows.map(r => r.name),
      teachers: teachersRes.rows,
      students: studentsRes.rows,
      passports: passportsRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LOGIN ENDPOINT
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (username.toLowerCase() === 'admin' && password === 'admin') {
    return res.json({ role: 'admin', name: 'Administrator' });
  }

  const teacherRes = await pool.query('SELECT * FROM teachers WHERE LOWER(username) = LOWER($1) AND password = $2', [username, password]);
  if (teacherRes.rows.length > 0) {
    const t = teacherRes.rows[0];
    return res.json({ role: 'teacher', id: t.id, name: t.name, username: t.username });
  }

  const studentRes = await pool.query('SELECT * FROM students WHERE LOWER(last_name) = LOWER($1)', [username]);
  for (let s of studentRes.rows) {
    const effectivePass = s.password || s.student_num.slice(-4);
    if (effectivePass === password) {
      return res.json({
        role: 'student',
        id: s.id,
        firstName: s.first_name,
        lastName: s.last_name,
        studentNum: s.student_num,
        teacherAdvisorId: s.teacher_advisor_id,
        pendingTeacherAdvisorId: s.pending_teacher_advisor_id
      });
    }
  }

  return res.status(401).json({ error: 'Invalid credentials' });
});

// --- BULK CSV IMPORTS SAVED TO DATABASE ---
app.post('/api/bulk-teachers', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const rows = await parseCSVFromBuffer(req.file.buffer);
    for (let item of rows) {
      const name = item.name || item.Name || `${item.firstName || ''} ${item.lastName || ''}`.trim();
      const username = item.username || item.Username || item.lastName || name.replace(/[^a-zA-Z]/g, '');
      const password = item.password || item.Password || 'teacher123';
      const id = 't_' + Date.now() + Math.random();
      if (name) {
        await pool.query(
          'INSERT INTO teachers (id, name, username, password) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO NOTHING',
          [id, name, username, password]
        );
      }
    }
    res.json({ status: 'Success', count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PASSPORT SAVE / UPDATE ENDPOINT
app.post('/api/passports', async (req, res) => {
  const { id, studentId, studentName, course, teacher, deleteRequested, units } = req.body;
  try {
    await pool.query(
      `INSERT INTO passports (id, student_id, student_name, course, teacher, delete_requested, units)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         delete_requested = EXCLUDED.delete_requested,
         units = EXCLUDED.units`,
      [id, studentId, studentName, course, teacher, deleteRequested || false, JSON.stringify(units)]
    );
    res.json({ status: 'Success' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
