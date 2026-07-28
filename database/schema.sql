CREATE DATABASE IF NOT EXISTS jdi_document_converter
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE jdi_document_converter;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
