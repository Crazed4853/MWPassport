const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Helper to stream and parse CSV files locally
const parseCSV = (filePath) => {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (err) => reject(err));
  });
};

// Bulk Teachers Upload Route
app.post('/api/bulk-teachers', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const data = await parseCSV(req.file.path);
    console.log('\n--- Parsed Teachers CSV ---');
    console.table(data);

    fs.unlinkSync(req.file.path); // Remove temp file after parsing
    return res.json({ status: 'Success', rowsImported: data.length, data });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: 'Failed to process CSV', details: err.message });
  }
});

// Bulk Courses Upload Route
app.post('/api/bulk-courses', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const data = await parseCSV(req.file.path);
    console.log('\n--- Parsed Courses CSV ---');
    console.table(data);

    fs.unlinkSync(req.file.path);
    return res.json({ status: 'Success', rowsImported: data.length, data });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: 'Failed to process CSV', details: err.message });
  }
});

app.listen(3000, () => {
  console.log('Local CSV server listening on http://localhost:3000');
});