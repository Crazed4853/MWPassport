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

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'index.html'));
});

// Bulk Teachers Upload
app.post('/api/bulk-teachers', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const data = await parseCSVFromBuffer(req.file.buffer);
    return res.json({ status: 'Success', count: data.length, data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to process CSV', details: err.message });
  }
});

// Bulk Courses Upload
app.post('/api/bulk-courses', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const data = await parseCSVFromBuffer(req.file.buffer);
    return res.json({ status: 'Success', count: data.length, data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to process CSV', details: err.message });
  }
});

// Bulk Students Upload
app.post('/api/bulk-students', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const data = await parseCSVFromBuffer(req.file.buffer);
    return res.json({ status: 'Success', count: data.length, data });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to process CSV', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
