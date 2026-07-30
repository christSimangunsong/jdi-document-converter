const mysql = require('mysql2/promise');
const config = require('../config');
const logger = require('./logger');

let pool = null;

async function getPool() {
  if (pool) {
    try {
      await pool.execute('SELECT 1');
      return pool;
    } catch (_) {
      logger.warn('Koneksi database terputus, membuat pool baru...');
      await pool.end().catch(() => {});
      pool = null;
    }
  }
  pool = mysql.createPool({
    host: config.db.host,
    user: config.db.user,
    password: config.db.password,
    database: config.db.name,
    port: config.db.port,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    charset: 'utf8mb4',
  });
  return pool;
}

async function initDatabase() {
  try {
    const initPool = mysql.createPool({
      host: config.db.host,
      user: config.db.user,
      password: config.db.password,
      port: config.db.port,
      waitForConnections: true,
      connectionLimit: 2,
    });

    await initPool.execute(
      `CREATE DATABASE IF NOT EXISTS \`${config.db.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await initPool.end();

    const p = await getPool();
    await p.execute(`
      CREATE TABLE IF NOT EXISTS conversion_activities (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(36) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        original_name VARCHAR(255) DEFAULT NULL,
        source_type ENUM('url','upload') NOT NULL,
        source_url TEXT DEFAULT NULL,
        file_hash VARCHAR(64) DEFAULT NULL,
        file_type ENUM('TEXT','SCAN') DEFAULT NULL,
        ocr_status VARCHAR(50) DEFAULT NULL,
        page_count INT DEFAULT 0,
        file_size_bytes BIGINT DEFAULT NULL,
        duration_seconds DECIMAL(10,1) DEFAULT NULL,
        status ENUM('BERHASIL','GAGAL','RUSAK','KOSONG') NOT NULL DEFAULT 'BERHASIL',
        error_message TEXT DEFAULT NULL,
        output_text LONGTEXT DEFAULT NULL,
        text_uploaded TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_session_id (session_id),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at),
        INDEX idx_file_hash (file_hash)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    try {
      await p.execute(
        `ALTER TABLE conversion_activities ADD COLUMN file_hash VARCHAR(64) DEFAULT NULL AFTER source_url, ADD INDEX idx_file_hash (file_hash)`,
      );
    } catch (_) {
      /* kolom sudah ada — abaikan */
    }

    logger.info('Database siap');
  } catch (error) {
    logger.error(`Gagal inisialisasi database: ${error?.message || error || 'Unknown error'}`);
    throw error;
  }
}

async function logActivity(data) {
  try {
    const p = await getPool();
    const [result] = await p.execute(
      `INSERT INTO conversion_activities
       (session_id, file_name, original_name, source_type, source_url, file_hash,
        file_type, ocr_status, page_count, file_size_bytes,
        duration_seconds, status, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.session_id,
        data.file_name,
        data.original_name || null,
        data.source_type,
        data.source_url || null,
        data.file_hash || null,
        data.file_type || null,
        data.ocr_status || null,
        data.page_count || 0,
        data.file_size_bytes || null,
        data.duration_seconds || null,
        data.status,
        data.error_message || null,
      ],
    );
    return result.insertId;
  } catch (error) {
    logger.error(`Gagal log aktivitas: ${error?.message || error || 'Unknown error'}`);
    return null;
  }
}

async function uploadTextToDb(id, text) {
  try {
    const p = await getPool();
    await p.execute(`UPDATE conversion_activities SET output_text = ?, text_uploaded = 1 WHERE id = ?`, [text, id]);
    return true;
  } catch (error) {
    logger.error(`Gagal upload teks ke DB: ${error?.message || error || 'Unknown error'}`);
    return false;
  }
}

async function getActivities() {
  try {
    const p = await getPool();
    const [rows] = await p.execute(
      `SELECT id, session_id, file_name, original_name, source_type, source_url, file_hash,
              file_type, ocr_status, page_count, file_size_bytes,
              duration_seconds, status, error_message, text_uploaded,
              created_at, updated_at
       FROM conversion_activities
       WHERE output_text IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 200`,
    );
    return rows;
  } catch (error) {
    logger.error(`Gagal ambil aktivitas: ${error?.message || error || 'Unknown error'}`);
    return [];
  }
}

async function getActivityById(id) {
  try {
    const p = await getPool();
    const [rows] = await p.execute(
      `SELECT id, session_id, file_name, original_name, source_type, source_url, file_hash,
              file_type, ocr_status, page_count, file_size_bytes,
              duration_seconds, status, error_message, output_text, text_uploaded,
              created_at, updated_at
       FROM conversion_activities WHERE id = ?`,
      [id],
    );
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    logger.error(`Gagal ambil aktivitas ${id}: ${error?.message || error || 'Unknown error'}`);
    return null;
  }
}

async function getStats() {
  try {
    const p = await getPool();
    const [rows] = await p.execute(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'BERHASIL' THEN 1 ELSE 0 END) AS berhasil,
        SUM(CASE WHEN status = 'GAGAL' THEN 1 ELSE 0 END) AS gagal,
        SUM(CASE WHEN status = 'RUSAK' THEN 1 ELSE 0 END) AS rusak,
        SUM(CASE WHEN status = 'KOSONG' THEN 1 ELSE 0 END) AS kosong,
        SUM(CASE WHEN text_uploaded = 1 THEN 1 ELSE 0 END) AS uploaded,
        ROUND(AVG(CASE WHEN duration_seconds IS NOT NULL THEN duration_seconds ELSE NULL END), 1) AS rata_durasi
      FROM conversion_activities
      WHERE output_text IS NOT NULL
    `);

    const [dailyRows] = await p.execute(`
      SELECT DATE(created_at) AS tgl, COUNT(*) AS jumlah
      FROM conversion_activities
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      AND output_text IS NOT NULL
      GROUP BY DATE(created_at)
      ORDER BY tgl ASC
    `);

    return { summary: rows[0], daily: dailyRows };
  } catch (error) {
    logger.error(`Gagal ambil statistik: ${error?.message || error || 'Unknown error'}`);
    return {
      summary: { total: 0, berhasil: 0, gagal: 0, rusak: 0, kosong: 0, uploaded: 0, rata_durasi: null },
      daily: [],
    };
  }
}

async function checkDuplicateByUrl(url) {
  try {
    const p = await getPool();
    const [rows] = await p.execute(
      `SELECT id, file_name FROM conversion_activities
       WHERE source_url = ? AND status = 'BERHASIL' LIMIT 1`,
      [url],
    );
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    logger.error(`Gagal cek duplikat URL: ${error?.message || error || 'Unknown error'}`);
    return null;
  }
}

async function checkDuplicateByHash(hash) {
  try {
    const p = await getPool();
    const [rows] = await p.execute(
      `SELECT id, file_name FROM conversion_activities
       WHERE file_hash = ? AND status = 'BERHASIL' AND output_text IS NOT NULL LIMIT 1`,
      [hash],
    );
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    logger.error(`Gagal cek duplikat hash: ${error?.message || error || 'Unknown error'}`);
    return null;
  }
}

async function getReportData(startDate, endDate) {
  try {
    const p = await getPool();
    let dateFilter = '';
    const params = [];
    if (startDate) {
      dateFilter += ' AND DATE(created_at) >= ?';
      params.push(startDate);
    }
    if (endDate) {
      dateFilter += ' AND DATE(created_at) <= ?';
      params.push(endDate);
    }

    const [summaryRows] = await p.execute(
      `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'BERHASIL' THEN 1 ELSE 0 END) AS berhasil,
        SUM(CASE WHEN status = 'GAGAL' THEN 1 ELSE 0 END) AS gagal,
        SUM(CASE WHEN status = 'RUSAK' THEN 1 ELSE 0 END) AS rusak,
        SUM(CASE WHEN status = 'KOSONG' THEN 1 ELSE 0 END) AS kosong,
        SUM(CASE WHEN text_uploaded = 1 THEN 1 ELSE 0 END) AS uploaded,
        SUM(CASE WHEN text_uploaded = 0 AND status = 'BERHASIL' THEN 1 ELSE 0 END) AS belum_uploaded,
        ROUND(AVG(CASE WHEN duration_seconds IS NOT NULL THEN duration_seconds ELSE NULL END), 1) AS rata_durasi
      FROM conversion_activities
      WHERE 1=1${dateFilter}
    `,
      params,
    );

    const [dailyRows] = await p.execute(
      `
      SELECT DATE(created_at) AS tgl,
             COUNT(*) AS jumlah,
             SUM(CASE WHEN text_uploaded = 1 THEN 1 ELSE 0 END) AS uploaded
      FROM conversion_activities
      WHERE 1=1${dateFilter}
      GROUP BY DATE(created_at)
      ORDER BY tgl ASC
    `,
      params,
    );

    const [details] = await p.execute(
      `
      SELECT id, session_id, file_name, original_name, source_type, source_url,
             file_type, ocr_status, page_count, file_size_bytes,
             duration_seconds, status, error_message, text_uploaded,
             created_at
      FROM conversion_activities
      WHERE 1=1${dateFilter}
      ORDER BY created_at DESC
    `,
      params,
    );

    return { summary: summaryRows[0], daily: dailyRows, details };
  } catch (error) {
    logger.error(`Gagal ambil data laporan: ${error?.message || error || 'Unknown error'}`);
    return {
      summary: {
        total: 0,
        berhasil: 0,
        gagal: 0,
        rusak: 0,
        kosong: 0,
        uploaded: 0,
        belum_uploaded: 0,
        rata_durasi: null,
      },
      daily: [],
      details: [],
    };
  }
}

async function deleteActivity(id) {
  try {
    const p = await getPool();
    await p.execute(`DELETE FROM conversion_activities WHERE id = ?`, [id]);
    return true;
  } catch (error) {
    logger.error(`Gagal hapus aktivitas ${id}: ${error?.message || error || 'Unknown error'}`);
    return false;
  }
}

module.exports = {
  initDatabase,
  logActivity,
  uploadTextToDb,
  getActivities,
  getActivityById,
  getStats,
  checkDuplicateByUrl,
  checkDuplicateByHash,
  getReportData,
  deleteActivity,
};
