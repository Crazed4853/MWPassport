const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const parseCSVFromBuffer = (buffer) => {
  return new Promise((resolve, reject) => {
    const results = [];
    Readable.from(buffer)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (err) => reject(err));
  });
};

// Serve static assets from root directory
app.use(express.static(__dirname));

// Serve index.html on root route with absolute path resolution
app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'index.html'));
});

// Bulk Teachers Upload Route
app.post('/api/bulk-teachers', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const data = await parseCSVFromBuffer(req.file.buffer);
    return res.json({ status: 'Success', rowsImported: data.length, data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to process CSV', details: err.message });
  }
});

// Bulk Courses Upload Route
app.post('/api/bulk-courses', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const data = await parseCSVFromBuffer(req.file.buffer);
    return res.json({ status: 'Success', rowsImported: data.length, data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to process CSV', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');

// Configure Multer to store uploaded CSV files temporarily in memory RAM
const upload = multer({ storage: multer.memoryStorage() });

// Helper function to convert buffer into a readable stream and parse CSV rows
const parseCSVFromBuffer = (buffer) => {
  return new Promise((resolve, reject) => {
    const results = [];
    Readable.from(buffer)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (err) => reject(err));
  });
};

// POST route: Bulk Upload Teachers
app.post('/api/bulk-teachers', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const teacherRows = await parseCSVFromBuffer(req.file.buffer);
    
    // TODO: Insert teacherRows array into your database (e.g., await Teacher.insertMany(teacherRows))
    console.log('Parsed Teachers:', teacherRows);

    return res.json({ status: 'Success', count: teacherRows.length, data: teacherRows });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to process CSV file', details: err.message });
  }
});

// POST route: Bulk Upload Courses
app.post('/api/bulk-courses', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const courseRows = await parseCSVFromBuffer(req.file.buffer);

    // TODO: Insert courseRows array into your database (e.g., await Course.insertMany(courseRows))
    console.log('Parsed Courses:', courseRows);

    return res.json({ status: 'Success', count: courseRows.length, data: courseRows });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to process CSV file', details: err.message });
  }
});
