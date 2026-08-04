const config = require('../config');
const logger = require('../services/logger');
const factory = require('./engineFactory');
const { preprocessImage } = require('./preprocessor');
const { computeQualityScore, computePageScore, shouldAcceptPage } = require('./qualityMetrics');
const { commonWordRatio } = require('../pdf/textLayerValidator');
const { repairTableBlocks, detectWiredGridRegions, blockInRegion } = require('./tableRegionOcr');
const { analyzeTables } = require('../services/tableAwareService');
const { formatTableHtmlToText } = require('../utils/tableFormatter');
const { PaddleEngine } = require('./engines/paddleEngine');
const { TesseractEngine } = require('./engines/tesseractEngine');
const { SuryaEngine } = require('./engines/suryaEngine');
const { rotateCanvas } = require('./orientationDetector');
const { cleanGarbageText, cleanLineText } = require('../utils/garbageTokens');
const { countSplitWords } = require('../utils/wordFixer');

factory.registerEngine('paddle', PaddleEngine);
factory.registerEngine('tesseract', TesseractEngine);
factory.registerEngine('surya', SuryaEngine);

let _engineConfig = null;
let _engineCache = {};

// Mirror horizontal (pencerminan kiri-kanan) — untuk halaman/blok scan yang
// tercermin; rotasi 0/90/180/270 tidak bisa memperbaikinya.
async function _mirrorCanvas(canvas) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const out = createCanvas(canvas.width, canvas.height);
  const octx = out.getContext('2d');
  octx.fillStyle = '#FFFFFF';
  octx.fillRect(0, 0, out.width, out.height);
  octx.translate(canvas.width, 0);
  octx.scale(-1, 1);
  octx.drawImage(canvas, 0, 0);
  return out;
}

function getEngineConfig() {
  if (_engineConfig) return _engineConfig;

  const ocrCfg = config.ocr || {};
  _engineConfig = {
    engine: ocrCfg.engine || 'paddle',
    preprocess: ocrCfg.preprocess === true || ocrCfg.preprocess === 'true',
    preprocessSteps: ocrCfg.preprocessSteps ? ocrCfg.preprocessSteps.split(',') : ['grayscale', 'denoise', 'threshold'],
    minimumConfidence: ocrCfg.minimumConfidence || 0.3,
    lang: ocrCfg.lang || 'id',
    serviceUrl: config.structureServiceUrl || '',
    timeout: config.sidecarTimeout || 120000,
    engineFallback: ocrCfg.engineFallback !== false,
    qualityGate: ocrCfg.qualityGate !== false,
    maxRetries: ocrCfg.maxConfidenceRetries != null ? ocrCfg.maxConfidenceRetries : 2,
  };

  _engineConfig.serviceUrl = _engineConfig.serviceUrl || process.env.SURYA_SERVICE_URL || '';

  return _engineConfig;
}

function getEngineCandidates(preferred) {
  const available = factory.getAvailableEngines();
  const fallbackEnabled = config.ocr ? config.ocr.engineFallback !== false : true;

  let order;
  if (preferred === 'auto') {
    order = ['surya', 'tesseract', 'paddle'];
  } else {
    order = [preferred, ...available.filter((e) => e !== preferred)];
  }
  const candidates = order.filter((e) => available.includes(e));
  return fallbackEnabled ? candidates : candidates[0] ? [candidates[0]] : [];
}

async function getEngine(name, engCfg) {
  if (_engineCache[name]) return _engineCache[name];
  try {
    let engine;
    if (name === 'auto') {
      engine = await factory.resolveEngine(engCfg);
    } else {
      engine = await factory.createEngine(name, engCfg);
    }
    _engineCache[name] = engine;
    logger.info(`  OCR engine "${name}" siap`);
    return engine;
  } catch (err) {
    logger.warn(`  OCR engine "${name}" tidak bisa dibuat: ${err.message}`);
    return null;
  }
}

async function getActiveEngine() {
  const engCfg = getEngineConfig();
  const candidates = getEngineCandidates(engCfg.engine);
  for (const name of candidates) {
    const engine = await getEngine(name, engCfg);
    if (engine) return engine;
  }
  throw new Error('Tidak ada engine OCR yang tersedia');
}

async function resetEngine() {
  for (const name of Object.keys(_engineCache)) {
    try {
      await _engineCache[name].destroy();
    } catch (_) {
      /* abaikan error destroy engine */
    }
  }
  _engineCache = {};
}

function _stepsForRetry(engCfg, retry) {
  const base =
    engCfg.preprocessSteps && engCfg.preprocessSteps.length > 0
      ? engCfg.preprocessSteps.slice()
      : ['grayscale', 'threshold'];

  if (retry === 1) return [...base, 'upscale'];
  if (retry === 2) return [...base, 'upscale', 'denoise', 'perspective'];
  return base;
}

function _engineForRetry(engCfg, retry, maxRetries) {
  if (retry >= maxRetries && engCfg.engineFallback) return 'auto';
  return engCfg.engine;
}

// Cache preprocessing PER-JOB (parameter `jobCache`), bukan global: dua
// request paralel (mis. upload + batch browser) sebelumnya saling menimpa
// _preprocessedCache[i] yang di-index nomor halaman absolute sehingga gambar
// job A dipakai di job B (repair/rescue/probe memakai gambar salah).
function _getPageImage(imageBuffers, i, retry, engCfg, jobCache) {
  if (!engCfg.preprocess || !imageBuffers[i]) return Promise.resolve(imageBuffers[i]);

  if (!jobCache[i]) jobCache[i] = [];
  if (jobCache[i][retry]) return Promise.resolve(jobCache[i][retry]);

  const steps = _stepsForRetry(engCfg, retry);
  const options = { steps };
  if (retry > 0) options.upscaleFactor = 1.5 * retry;

  return preprocessImage(imageBuffers[i], options).then((img) => {
    jobCache[i][retry] = img;
    return img;
  });
}

async function _recognizePageCascade(i, imageBuffers, jobCache) {
  const engCfg = getEngineConfig();
  const maxRetries = engCfg.maxRetries;
  let bestScore = null;
  let bestBlocks = [];
  let bestText = '';
  let bestEngine = null;
  let bestRetry = 0;
  let bestAngle = null;
  let lastError = null;
  let bestSplitCount = 0;

  for (let retry = 0; retry <= maxRetries; retry++) {
    const img = await _getPageImage(imageBuffers, i, retry, engCfg, jobCache);
    for (const engineName of getEngineCandidates(_engineForRetry(engCfg, retry, maxRetries))) {
      try {
        const engine = await getEngine(engineName, engCfg);
        if (!engine) continue;
        const blocks = await engine.recognizeBlocks(img);
        const score = computeQualityScore(blocks);
        const text = blocks.map((b) => b.text).join('\n');
        const splitCount = countSplitWords(text);

        if (!bestScore || score.score > bestScore.score) {
          bestScore = score;
          bestBlocks = blocks;
          bestText = text;
          bestEngine = engineName;
          bestRetry = retry;
          bestSplitCount = splitCount;
        }

        if (shouldAcceptPage(score)) {
          // (v30) Gate kata terpecah: halaman yang LULUS gate kualitas tapi
          // memuat >= 2 kata terpecah ("Dala m", "kerjasa ma") di-OCR ulang
          // sekali dengan upscale 1.5x — biasanya cukup menghilangkan
          // pemecahan kata tanpa mengorbankan kecepatan. Retry berikutnya
          // menangani; hasil terbaik tetap dipertahankan.
          if (splitCount >= 2 && retry < maxRetries) {
            logger.info(`  Halaman ${i + 1} diterima namun ${splitCount} kata terpecah, retry upscale 1.5x...`);
          } else {
            return { score, blocks, text, engine: engineName, accepted: true, image: img };
          }
        }
      } catch (error) {
        lastError = error;
        logger.warn(`  Halaman ${i + 1} engine "${engineName}" percobaan ${retry + 1} gagal: ${error.message}`);
      }
    }
    if (bestScore && shouldAcceptPage(bestScore) && !(bestSplitCount >= 2 && retry < maxRetries)) break;
    if (retry < maxRetries) {
      logger.info(
        `  Halaman ${i + 1} kualitas rendah (score: ${bestScore ? bestScore.score.toFixed(2) : '0.00'}, words: ${bestScore ? bestScore.wordCount : 0}), retry ${retry + 1}/${maxRetries} dengan strategi alternatif...`,
      );
    }
  }

  let bestImg = imageBuffers[i];
  console.error(
    'DEBUG-STATE bestRetry=',
    bestRetry,
    'cache=',
    jobCache[i] ? Object.keys(jobCache[i]).join(',') : 'none',
    'cacheHit=',
    !!(jobCache[i] && jobCache[i][bestRetry]),
    'img0=',
    imageBuffers[i].width,
    'x',
    imageBuffers[i].height,
    'accept=',
    !!(bestScore && shouldAcceptPage(bestScore)),
    'score=',
    bestScore ? bestScore.score.toFixed(2) : '0',
  );

  // Fallback rotasi 180/±90: halaman masih kualitas rendah setelah semua
  // retry (misal miring yang lolos koreksi kontur, atau terbalik 180°).
  if (!bestScore || !shouldAcceptPage(bestScore)) {
    const variant = await _tryRotationVariants(i, imageBuffers, engCfg);
    if (variant) {
      console.error(
        'DEBUG-VARIANT angle=',
        variant.angle,
        'score=',
        variant.score.score.toFixed(2),
        't0=',
        JSON.stringify((variant.text || '').slice(0, 60)),
      );
    }
    if (variant && variant.score && (!bestScore || variant.score.score > bestScore.score)) {
      logger.info(
        `  Halaman ${i + 1}: koreksi rotasi OCR fallback ${variant.label}${typeof variant.angle === 'number' ? '°' : ''} (score ${bestScore ? bestScore.score.toFixed(2) : '0.00'} -> ${variant.score.score.toFixed(2)})`,
      );
      bestScore = variant.score;
      bestBlocks = variant.blocks;
      bestText = variant.text;
      bestEngine = variant.engine;
      bestImg = variant.image;
      bestAngle = variant.angle;
    }
  }

  // Loop eskalasi skala anti-mirror: bila output masih mengandung simbol
  // terbalik (CJK/Yunani/∪/teks tanpa kata umum) atau belum diterima gate,
  // gambar diperbesar bertahap dan di-OCR ulang sampai bersih — hasil hanya
  // dipakai bila skornya lebih baik (tanpa regresi).
  if (
    bestScore &&
    bestImg &&
    bestBlocks.length > 0 &&
    (!shouldAcceptPage(bestScore) || _hasMirrorGarbage(bestText || ''))
  ) {
    try {
      const escalated = await _reOcrWithScaleEscalation(i, imageBuffers, engCfg, bestImg, {
        score: bestScore,
        blocks: bestBlocks,
        text: bestText,
        engine: bestEngine,
        image: bestImg,
      });
      if (escalated && escalated.text !== bestText && escalated.score.score > bestScore.score) {
        logger.info(
          `  Halaman ${i + 1}: eskalasi skala anti-mirror (score ${bestScore.score.toFixed(2)} -> ${escalated.score.score.toFixed(2)}, engine ${escalated.engine})`,
        );
        bestScore = escalated.score;
        bestBlocks = escalated.blocks;
        bestText = escalated.text;
        bestEngine = escalated.engine;
        bestImg = escalated.image;
      }
    } catch (err) {
      logger.warn(`  Eskalasi skala halaman ${i + 1} gagal: ${err.message}`);
    }
  }

  // Repair tabel (setelah rotasi agar grid selaras pada halaman miring):
  // region grid di-OCR ulang per region/per-sel, menggantikan blok OCR yang
  // jelek bila skor kualitasnya lebih tinggi. Gambar dasar = cache retry
  // terbaik yang SUDAH ter-rectify (deskew/perspective/threshold) — variant
  // rotasi hanya threshold+rotate tanpa deskew sehingga garis grid miring
  // lolos deteksi (densitas < 60%). Untuk halaman yang dikoreksi rotasi,
  // cache rectified di-rotate sebesar bestAngle agar grid selaras.
  if (bestEngine && _engineCache[bestEngine] && imageBuffers[i] && bestImg) {
    try {
      let repairImg = bestImg;
      const cached = jobCache[i] && jobCache[i][bestRetry];
      if (cached) {
        repairImg = cached;
        if (typeof bestAngle === 'number') {
          repairImg = await rotateCanvas(cached, bestAngle);
        }
      }
      const repair = await repairTableBlocks(repairImg, bestBlocks, _engineCache[bestEngine]);
      if (repair.replaced === 0 && repair.regions.length === 0 && bestScore && !shouldAcceptPage(bestScore)) {
        logger.warn(
          `  Repair tabel halaman ${i + 1}: 0 region grid pada canvas rectified (${repairImg.width}x${repairImg.height}, score ${bestScore.score.toFixed(2)})`,
        );
      }
      if (repair.replaced > 0) {
        const repairedScore = computeQualityScore(repair.blocks);
        if (!bestScore || repairedScore.score > bestScore.score) {
          logger.info(
            `  Halaman ${i + 1}: region repair tabel berhasil (${repair.replaced} blok baru, score ${bestScore ? bestScore.score.toFixed(2) : '0.00'} -> ${repairedScore.score.toFixed(2)})`,
          );
          bestScore = repairedScore;
          bestBlocks = repair.blocks;
          bestText = repair.blocks.map((b) => b.text).join('\n');
          bestImg = repairImg;
        }
      }
    } catch (err) {
      logger.warn(`  Region repair halaman ${i + 1} gagal: ${err.message}`);
    }
  }

  // Rescue rotasi per-blok: sisa garbage orientasi campuran (mis. grid tabel
  // miring 90° + fragmen tegak dalam satu halaman). Koreksi rotasi level
  // halaman hanya memperbaiki mayoritas; blok yang gagal gate di-crop lalu
  // di-OCR ulang pada 0/180/±90° untuk memilih orientasi terbaik per blok.
  if (bestImg && bestEngine && _engineCache[bestEngine] && bestBlocks.length > 0) {
    try {
      const rescued = await _rescueGarbageBlocks(bestImg, bestBlocks, _engineCache[bestEngine], engCfg);
      if (rescued.rescued > 0 || rescued.rejected > 0) {
        const afterScore = computeQualityScore(rescued.blocks);
        logger.info(
          `  Halaman ${i + 1}: rescue rotasi per-blok (${rescued.rescued} diperbaiki, ${rescued.rejected} tetap jelek, score ${bestScore ? bestScore.score.toFixed(2) : '0.00'} -> ${afterScore.score.toFixed(2)})`,
        );
        bestScore = afterScore;
        bestBlocks = rescued.blocks;
        bestText = rescued.blocks.map((b) => b.text).join('\n');
      }
    } catch (err) {
      logger.warn(`  Rescue per-blok halaman ${i + 1} gagal: ${err.message}`);
    }
  }

  return {
    score: bestScore,
    blocks: bestBlocks,
    text: bestText,
    engine: bestEngine || engCfg.engine,
    accepted: !!(bestScore && shouldAcceptPage(bestScore)),
    lastError,
    image: bestImg,
  };
}

// Coba OCR pada halaman yang diputar 180/±90° untuk halaman kualitas
// rendah (miring yang lolos koreksi kontur, atau terbalik 180°). Steps
// rectify (rotate/deskew/perspective) dihilangkan — rotasi sudah eksplisit.
async function _tryRotationVariants(i, imageBuffers, engCfg) {
  if (!imageBuffers[i] || !engCfg.preprocess) return null;
  const steps = (engCfg.preprocessSteps || ['grayscale', 'threshold']).filter(
    (s) => !['rotate', 'deskew-adaptive', 'perspective'].includes(s),
  );
  let best = null;
  const variants = [
    { angle: 180, label: '180' },
    { angle: 90, label: '90' },
    { angle: -90, label: '-90' },
    { angle: 'M', label: 'mirror' }, // pencerminan horizontal
  ];
  for (const variant of variants) {
    try {
      const base = await preprocessImage(imageBuffers[i], { steps });
      const transformed = variant.angle === 'M' ? await _mirrorCanvas(base) : await rotateCanvas(base, variant.angle);
      const img = transformed;
      for (const engineName of getEngineCandidates(engCfg.engine)) {
        const engine = await getEngine(engineName, engCfg);
        if (!engine) continue;
        const blocks = await engine.recognizeBlocks(img);
        const score = computeQualityScore(blocks);
        if (!best || score.score > best.score.score) {
          best = {
            angle: variant.angle,
            label: variant.label,
            score,
            blocks,
            text: blocks.map((b) => b.text).join('\n'),
            engine: engineName,
            image: img,
          };
        }
      }
    } catch (error) {
      logger.warn(`  Variasi rotasi ${variant.label}° halaman ${i + 1} gagal: ${error.message}`);
    }
  }
  return best;
}

const SCALE_ESCALATION_FACTORS = [1.0, 1.5, 2.0, 2.5, 3.0];

// Deteksi teks mirror/terbalik (hasil OCR arah salah): mengandung CJK/simbol
// non-Latin (Yunani, ∪, superscript, box-drawing) atau tidak memiliki satu
// pun kata umum ("NOLERA TA RORANS AN D p 2"). Output seperti ini tidak
// boleh lolos — memicu loop eskalasi skala untuk OCR ulang.
function _hasMirrorGarbage(text) {
  if (!text) return false;
  if (
    /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\u0370-\u03FF\u2200-\u22FF\u2300-\u23FF\u2500-\u257F\u2070-\u209F\u00B2\u00B3\u00B9]/.test(
      text,
    )
  ) {
    return true;
  }
  const common = commonWordRatio(text);
  return common !== null && common === 0;
}

// Loop re-OCR anti simbol terbalik dengan eskalasi skala: bila output masih
// mengandung mirror garbage, gambar (orientasi terbaik yang sudah diketahui)
// diperbesar bertahap 1.5×→2×→2.5×→3× lalu di-OCR ulang sampai bersih atau
// batas tercapai. Selalu simpan hasil skor terbaik — tidak pernah menurunkan
// kualitas dari kondisi sebelum loop.
async function _reOcrWithScaleEscalation(i, imageBuffers, engCfg, bestImg, current) {
  if (!bestImg || !engCfg.preprocess || !current || !current.score) return current;
  const steps = (engCfg.preprocessSteps || ['grayscale', 'threshold']).filter(
    (s) => !['rotate', 'deskew-adaptive', 'perspective'].includes(s),
  );
  const out = { ...current, image: bestImg };
  for (const factor of SCALE_ESCALATION_FACTORS) {
    if (factor === 1.0) continue; // 1× = hasil retry/rotasi yang sudah ada
    const img = await preprocessImage(bestImg, { steps, upscaleFactor: factor });
    for (const engineName of getEngineCandidates(engCfg.engine)) {
      const engine = await getEngine(engineName, engCfg);
      if (!engine) continue;
      const blocks = await engine.recognizeBlocks(img);
      const score = computeQualityScore(blocks);
      const text = blocks.map((b) => b.text).join('\n');
      if (score.score > out.score.score) {
        out.score = score;
        out.blocks = blocks;
        out.text = text;
        out.engine = engineName;
        out.image = img;
      }
      if (shouldAcceptPage(score) && !_hasMirrorGarbage(text)) {
        out.score = score;
        out.blocks = blocks;
        out.text = text;
        out.engine = engineName;
        out.image = img;
        logger.info(
          `  Halaman ${i + 1}: skala x${factor} membersihkan mirror garbage (score ${score.score.toFixed(2)}, engine ${engineName})`,
        );
        return out;
      }
    }
    if (!_hasMirrorGarbage(out.text) && shouldAcceptPage(out.score)) break;
  }
  return out;
}

// Keputusan gate "kualitas > estetika" untuk blok table-aware: blok sidecar
// hanya menggantikan blok OCR dalam region bila teksnya TIDAK lebih buruk —
// ditolak jika terlalu pendek, sarat placeholder "None", rasio CJK tinggi
// (indikasi mirror/rotasi salah arah), atau skor lebih rendah dari blok OCR.
function _tableAwareWins(taBlock, ocrBlocks) {
  const ta = computePageScore([{ text: taBlock.text, confidence: 1 }]);
  const taWords = ta.wordCount;
  const taGarbage = ta.garbageRatio;
  const taCjk = taWords > 0 ? ta.cjkWords / taWords : 1;

  const ocr = computePageScore(ocrBlocks);
  const ocrWords = ocr.wordCount;
  const ocrGarbage = ocrWords > 0 ? ocr.garbageRatio : 1;
  const ocrCjk = ocrWords > 0 ? ocr.cjkWords / ocrWords : 1;

  if (taWords < 3) return { replace: false, reason: 'teks terlalu pendek' };
  const noneRatio = (taBlock.text.match(/\bNone\b/g) || []).length / Math.max(1, taWords);
  if (noneRatio > 0.25) {
    return { replace: false, reason: `placeholder None berlebih (${(noneRatio * 100).toFixed(0)}%)` };
  }
  if (taCjk > 0.15) {
    return { replace: false, reason: `rasio CJK tinggi (${(taCjk * 100).toFixed(0)}%) — indikasi mirror` };
  }

  const taScore = 1 - taGarbage * 0.7 - taCjk * 1.5;
  const ocrScore = 1 - ocrGarbage * 0.7 - ocrCjk * 1.5;

  if (taScore >= ocrScore - 0.05 && taScore > 0.25) {
    // Gate kelengkapan: bila region hanya berisi blok whole-page (tanpa
    // bbox — jalur fallback rotasi), tabel harus memuat seluruh konten
    // prosa. Baris prosa (≥3 token konten) yang mayoritas tokennya tidak ada
    // di tabel = konten hilang (img2table sering men-drop baris/kolom) →
    // tolak. Hanya berlaku bila prosa terbaca (mengandung kata umum) —
    // blok mirror/garbage tidak boleh memblokir tabel yang baik.
    const wholePage = ocrBlocks.filter((b) => !(b.bbox && (b.bbox.w || b.bbox.x2 || b.bbox.h || b.bbox.y2)));
    if (
      wholePage.length > 0 &&
      wholePage.some((b) => commonWordRatio(b.text) !== null && commonWordRatio(b.text) > 0)
    ) {
      const taLower = (taBlock.text || '').toLowerCase();
      for (const b of wholePage) {
        if (commonWordRatio(b.text) === null || commonWordRatio(b.text) === 0) continue;
        for (const line of (b.text || '').split('\n')) {
          const toks = line
            .split(/\s+/)
            .map((w) => w.replace(/[^a-zA-Z0-9]/g, '').toLowerCase())
            .filter((w) => w.length >= 4);
          if (toks.length < 3) continue;
          const missing = toks.filter((t) => !taLower.includes(t));
          if (missing.length >= toks.length * 0.5) {
            return {
              replace: false,
              reason: `tabel kehilangan konten prosa "${line.trim().slice(0, 50)}" (${missing.length}/${toks.length} token tidak ada)`,
            };
          }
        }
      }
    }
    return { replace: true };
  }
  return {
    replace: false,
    reason: `skor ${taScore.toFixed(2)} <= OCR ${ocrScore.toFixed(2)} (garbage ${taGarbage.toFixed(2)} vs ${ocrGarbage.toFixed(2)}, CJK ${taCjk.toFixed(2)} vs ${ocrCjk.toFixed(2)})`,
  };
}

// Filter baris garbage untuk blok whole-page (tanpa bbox): setiap baris
// dirapikan dulu token-nya (garbage individual + run mirror + normalisasi
// angka menempel), lalu baris yang masih mengandung CJK atau sangat tidak
// terbaca (hasil OCR arah salah) dibuang, sementara baris teks nyata
// dipertahankan. Urutan penting: token dibersihkan DULU — baris sah yang
// menyisipkan CJK acak ("Pasal 1 国") tidak boleh ikut terbuang.
function _filterWholePageGarbageLines(text) {
  const lines = (text || '').split('\n');
  const kept = [];
  for (const line of lines) {
    const t = cleanLineText(line).trim();
    if (!t) continue;
    if (/[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(t)) continue;
    if (_lineReadability(t) < -0.5) continue;
    kept.push(t);
  }
  return kept.join('\n');
}

// Perbaikan band atas untuk blok whole-page (jalur fallback rotasi):
// recognizeBlocks full-page sering salah baca baris header/tepi atas sebagai
// garbage (fragmen mirror, mis. "lpom era" untuk baris "c) DPRD kabupaten ..."),
// sedangkan OCR band atas (0..420px) pada orientasi saat ini terbukti bersih.
// Prefix garbage diganti dengan pembacaan band; baris asli yang sudah tercakup
// pembacaan band dibuang (dedup), sisanya dipertahankan utuh.
async function _repairWholePageTopBand(canvas, text, engine, engCfg) {
  const lines = (text || '').split('\n');
  const firstReadable = lines.findIndex((l) => {
    const t = l.trim();
    if (!t) return false;
    if (_lineReadability(t) >= 0.5) return true;
    const letters = (t.match(/[a-zA-Z]/g) || []).length;
    const digits = (t.match(/\d/g) || []).length;
    return letters >= 10 && digits <= 4 && t.length >= 15;
  });
  if (firstReadable <= 0) return null; // tidak ada prefix garbage
  const garbageLen = lines.slice(0, firstReadable).join('\n').trim().length;
  if (garbageLen < 4) return null;

  const bandH = Math.min(420, canvas.height);
  const { createCanvas } = await import('@napi-rs/canvas');
  const band = createCanvas(canvas.width, bandH);
  const ctx = band.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, band.width, band.height);
  ctx.drawImage(canvas, 0, 0, canvas.width, bandH, 0, 0, band.width, band.height);
  const steps = (engCfg.preprocessSteps || ['grayscale', 'threshold']).filter(
    (s) => !['rotate', 'deskew-adaptive', 'perspective'].includes(s),
  );
  const prep = await preprocessImage(band, { steps });
  const blocks = await engine.recognizeBlocks(prep);
  if (!blocks || blocks.length === 0) return null;
  const bandLines = [];
  for (const b of blocks) {
    for (const l of (b.text || '').split('\n')) {
      const t = l.trim();
      if (t) bandLines.push(t);
    }
  }
  const readableBand = bandLines.filter(
    (l) => _lineReadability(l) >= 0.5 || (l.match(/\d/g) || []).length >= 8 || l.length >= 8,
  );
  if (readableBand.length === 0) return null;
  const bandLower = readableBand.join('\n').toLowerCase();
  // Baris asli yang seluruh tokennya (≥4 huruf) sudah ada di pembacaan band
  // dianggap tercakup — buang agar tidak duplikat; baris lain dipertahankan.
  const rest = lines.slice(firstReadable).filter((l) => {
    const toks = l
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zA-Z0-9]/g, '').toLowerCase())
      .filter((w) => w.length >= 4);
    return !(toks.length >= 3 && toks.every((t) => bandLower.includes(t)));
  });
  const joined = [...readableBand, ...rest].join('\n');
  const newScore = computePageScore([{ text: joined, confidence: 1 }]);
  const oldScore = computePageScore([{ text: text || '', confidence: 1 }]);
  if (newScore.wordCount < oldScore.wordCount) return null; // jangan kehilangan konten
  if ((newScore.cjkWords || 0) >= 1) return null;
  return joined;
}

// Rescue rotasi per-blok: cek blok yang masih garbage (CJK / garbage tinggi /
// tanpa kata umum — ciri teks mirror/terbalik). Blok di-crop lalu di-OCR ulang
// pada 0/180/±90°; teks akhir dirakit PER-BARIS (pilih pembacaan terbaik tiap
// band baris) agar halaman orientasi campuran (fragmen mirror + teks tegak
// dalam satu blok) tetap bisa diperbaiki tanpa merusak bagian yang sudah benar.
async function _rescueGarbageBlocks(pageCanvas, blocks, engine, engCfg) {
  if (!pageCanvas || !blocks || !engine) return { blocks: blocks || [], rescued: 0, rejected: 0 };

  const out = [];
  let rescued = 0;
  let rejected = 0;

  for (let block of blocks) {
    let text = block.text || '';
    if (!text.trim()) {
      out.push(block);
      continue;
    }

    // Perbaikan generik v29.1: pembersihan token TANPA SYARAT untuk SEMUA
    // blok — blok yang lolos gate sekalipun. Fragmen mirror seperti
    // "T E SALINAN L R 3 1 E 5. E" punya kata Latin utuh sehingga score
    // tetap tinggi (needsRescue false) dan sebelumnya bocor ke output;
    // pembersihan token/run di sini menghapusnya tanpa menghapus kalimat.
    const tokenCleaned = cleanGarbageText(text);
    if (tokenCleaned !== text) {
      block = { ...block, text: tokenCleaned };
      text = tokenCleaned;
      if (!text.trim()) {
        out.push(block);
        continue;
      }
    }

    // Blok tanpa bbox = hasil recognize dalam bentuk string (seluruh halaman
    // satu region, mis. jalur fallback rotasi) -> gunakan bbox seluruh halaman.
    const hasBbox = !!(block.bbox && (block.bbox.w || block.bbox.x2 || block.bbox.h || block.bbox.y2));
    const blockBbox = hasBbox ? block.bbox : { x: 0, y: 0, w: pageCanvas.width, h: pageCanvas.height };

    const score = computePageScore([{ text, confidence: block.confidence }]);
    const common = commonWordRatio(text);
    const needsRescue =
      score.wordCount >= 3 &&
      ((score.cjkWords || 0) >= 1 || score.garbageRatio > 0.35 || (common !== null && common === 0));

    // Blok yang sudah bersih (skor bagus, tanpa garbage/CJK): jangan sentuh —
    // filter/repair/probe hanya merusak (mis. baris tahun "2020...2025" ikut
    // terbuang sehingga skor turun). Rescue hanya untuk blok yang gagal gate.
    if (!needsRescue) {
      out.push(block);
      continue;
    }

    if (!hasBbox) {
      const cleaned = _filterWholePageGarbageLines(text);
      if (cleaned !== text) {
        block = { ...block, text: cleaned };
        text = cleaned;
        rescued++;
      }
      // Perbaiki prefix garbage di band atas (header/tepi tabel yang salah
      // baca oleh OCR full-page) dengan pembacaan band atas yang bersih.
      try {
        const repaired = await _repairWholePageTopBand(pageCanvas, text, engine, engCfg);
        if (repaired) {
          block = { ...block, text: repaired };
          text = repaired;
          rescued++;
        }
      } catch (err) {
        logger.warn(`  Perbaikan band atas blok whole-page gagal: ${err.message}`);
      }
    }

    try {
      const rescuedBlock = await _tryRescueBlock(pageCanvas, { ...block, bbox: blockBbox }, engine, engCfg);
      if (rescuedBlock) {
        rescued++;
        out.push(rescuedBlock);
      } else {
        rejected++;
        out.push(block); // tetap pertahankan teks asli (tanpa downgrade)
      }
    } catch (err) {
      logger.warn(`  Rescue blok gagal (${block.text.slice(0, 40)}...): ${err.message}`);
      rejected++;
      out.push(block);
    }
  }

  return { blocks: out, rescued, rejected };
}

// Skor keterbacaan baris untuk seleksi per-band: kata umum + huruf, penalti
// CJK (simbol miring) dan garbage ratio (token terisolasi/digit pendek).
function _lineReadability(text) {
  const wr = commonWordRatio(text) || 0;
  const letters = (text.match(/[a-zA-Z]+/g) || []).length;
  const cjk = (text.match(/[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/g) || []).length;
  const score = computePageScore([{ text, confidence: 1 }]);
  return wr * 10 + letters / 60 - cjk * 1.5 - score.garbageRatio * 2;
}

// Transform titik dari ruang hasil rotateCanvas(angle) kembali ke ruang asli.
function _inverseRotatePoint(px, py, angle, origW, origH) {
  if (angle === 'M') return [origW - 1 - px, py]; // mirror horizontal
  const a = ((angle % 360) + 360) % 360;
  if (a === 180) return [origW - 1 - px, origH - 1 - py];
  if (a === 90) return [py, origH - 1 - px];
  if (a === 270) return [origW - 1 - py, px];
  return [px, py];
}

function _mapBlockBboxToCrop(bbox, angle, origW, origH, rotW, rotH) {
  const bw = bbox.w || (bbox.x2 ? bbox.x2 - bbox.x : 0);
  const bh = bbox.h || (bbox.y2 ? bbox.y2 - bbox.y : 0);
  const bx = bbox.x || bbox.x1 || 0;
  const by = bbox.y || bbox.y1 || 0;
  const corners = [
    [bx, by],
    [bx + bw, by],
    [bx + bw, by + bh],
    [bx, by + bh],
  ];
  const mapped = corners.map(([px, py]) => _inverseRotatePoint(px, py, angle, origW, origH));
  const xs = mapped.map((p) => p[0]);
  const ys = mapped.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - y;
  return { x, y, w, h, cy: y + h / 2 };
}

async function _tryRescueBlock(pageCanvas, block, engine, engCfg) {
  const pw = pageCanvas.width;
  const ph = pageCanvas.height;
  const b = block.bbox;
  const pad = 12;
  const x = Math.max(0, Math.floor(b.x || 0) - pad);
  const y = Math.max(0, Math.floor(b.y || 0) - pad);
  const w = Math.min(Math.ceil(b.w || 0 || (b.x2 ? b.x2 - b.x : 0)) + pad * 2, pw - x);
  const h = Math.min(Math.ceil(b.h || 0 || (b.y2 ? b.y2 - b.y : 0)) + pad * 2, ph - y);
  if (w < 20 || h < 20) return null;

  const { createCanvas } = await import('@napi-rs/canvas');

  const crop = createCanvas(w, h);
  const ctx = crop.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(pageCanvas, x, y, w, h, 0, 0, w, h);

  // Downscale crop agar OCR 4 rotasi tetap murah. Untuk blok tanpa bbox
  // (seluruh halaman) pakai resolusi penuh agar deteksi baris tetap aktif.
  const isFullPage = w >= pw * 0.8 && h >= ph * 0.8;
  const maxDim = isFullPage ? Infinity : 900;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  let probe = crop;
  if (scale < 1) {
    probe = createCanvas(Math.round(w * scale), Math.round(h * scale));
    const pctx = probe.getContext('2d');
    pctx.fillStyle = '#FFFFFF';
    pctx.fillRect(0, 0, probe.width, probe.height);
    pctx.drawImage(crop, 0, 0, w, h, 0, 0, probe.width, probe.height);
  }

  const mirrorCanvas = (c) => {
    const out = createCanvas(c.width, c.height);
    const octx = out.getContext('2d');
    octx.translate(c.width, 0);
    octx.scale(-1, 1);
    octx.drawImage(c, 0, 0);
    return out;
  };

  const steps = (engCfg.preprocessSteps || ['grayscale', 'threshold']).filter(
    (s) => !['rotate', 'deskew-adaptive', 'perspective'].includes(s),
  );

  // OCR 4 rotasi + mirror horizontal; tiap baris (blok) diberi skor
  // keterbacaan + posisi di crop. Mirror menangani halaman scan yang
  // tercermin horizontal (rotasi tidak bisa memperbaikinya).
  const candidates = [];
  for (const angle of [0, 180, 90, -90, 'M']) {
    let img = probe;
    if (angle === 'M') img = mirrorCanvas(probe);
    else if (angle !== 0) img = await rotateCanvas(probe, angle);
    img = await preprocessImage(img, { steps });
    const blocks = await engine.recognizeBlocks(img);
    if (!blocks || blocks.length === 0) continue;
    for (const bb of blocks) {
      const lineText = (bb.text || '').trim();
      if (!lineText) continue;
      const bbBox = bb.bbox || { x: 0, y: 0, w: img.width, h: img.height };
      const mapped = _mapBlockBboxToCrop(bbBox, angle, probe.width, probe.height, img.width, img.height);
      candidates.push({
        angle,
        text: lineText,
        cy: mapped.cy,
        readability: _lineReadability(lineText),
      });
    }
  }
  if (candidates.length === 0) return null;

  // Group per band baris (toleransi tinggi crop 2%), pilih pembacaan terbaik
  // tiap band — hanya beralih dari 0° bila jelas lebih baik (margin ≥ 0.15).
  const sorted = candidates.slice().sort((a, b) => a.cy - b.cy);
  // Toleransi grup adaptif: median jarak antar baris × 0.65 (dibatasi).
  // Toleransi tetap (2% tinggi) terlalu lebar untuk halaman penuh (baris
  // ~25-30px, 2% halaman ~30px) sehingga baris yang berbeda tergabung.
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i].cy - sorted[i - 1].cy;
    if (g > 4) gaps.push(g);
  }
  let tol = 14;
  if (gaps.length > 0) {
    const med = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    tol = Math.max(10, Math.min(24, med * 0.65));
  }
  const bands = [];
  for (const cand of sorted) {
    const last = bands[bands.length - 1];
    if (last && cand.cy - last.cy <= tol) {
      last.cands.push(cand);
    } else {
      bands.push({ cy: cand.cy, cands: [cand] });
    }
  }

  const assembled = [];
  const bandLog = [];
  let improvedBands = 0;
  for (const band of bands) {
    band.cands.sort((a, b) => b.readability - a.readability);
    const upright = band.cands.find((c) => c.angle === 0) || band.cands[0];
    const best = band.cands[0];
    if (best.angle !== 0 && best.readability - upright.readability >= 0.15) {
      improvedBands++;
      assembled.push(best.text);
      bandLog.push(`${best.angle}:${best.readability.toFixed(2)}>${upright.readability.toFixed(2)}`);
    } else {
      assembled.push(upright.text);
      bandLog.push(`0:${upright.readability.toFixed(2)}`);
    }
  }

  if (improvedBands === 0) {
    console.error(
      'RESCUE-NOIMPROVE bands=',
      bands.length,
      'cands=',
      candidates
        .map((c) => `${c.angle}[${Number(c.readability).toFixed(2)}]${c.text.replace(/\n/g, ' ').slice(0, 40)}`)
        .join(' | '),
    );
    return null; // tidak ada baris yang membaik
  }

  const text = assembled.join('\n');
  const newScore = computePageScore([{ text, confidence: 1 }]);
  if (newScore.wordCount < 3) return null;
  const newCjk = newScore.wordCount > 0 ? newScore.cjkWords / newScore.wordCount : 1;
  if (newCjk > 0.02) return null;

  const oldScore = computePageScore([{ text: block.text, confidence: block.confidence || 0 }]);
  const oldCjk = oldScore.wordCount > 0 ? oldScore.cjkWords / oldScore.wordCount : 1;
  const oldCommon = commonWordRatio(block.text);
  const newCommon = commonWordRatio(text);
  const newQualityScore = computeQualityScore([{ text, confidence: 1 }]);
  const oldQualityScore = computeQualityScore([{ text: block.text, confidence: 1 }]);

  // Jangan ganti teks yang terbaca dengan teks yang tidak terbaca (regresi
  // mirror garbage: probe mirror sering lolos gate CJK/garbage padahal hasil
  // assembly secara obyektif lebih buruk dari teks asli).
  if (oldCommon !== null && oldCommon >= 0.02 && (newCommon === null || newCommon < 0.02)) {
    return null;
  }

  // Sinyal yang memicu rescue harus membaik (CJK hilang / garbage turun /
  // teks kini mengandung kata umum), dan skor gabungan tidak boleh jauh
  // lebih buruk dari teks asli.
  const flaggedCjk = oldScore.wordCount > 0 && (oldScore.cjkWords || 0) >= 1;
  const flaggedGarbage = oldScore.garbageRatio > 0.35;
  const flaggedCommon = oldCommon !== null && oldCommon === 0;
  const signalImproved =
    (!flaggedCjk || newCjk < oldCjk) &&
    (!flaggedGarbage || newScore.garbageRatio < oldScore.garbageRatio) &&
    (!flaggedCommon || (newCommon !== null && newCommon >= 0.02));
  const accepted = improvedBands > 0 && signalImproved && newQualityScore.score >= oldQualityScore.score - 0.03;
  console.error(
    'RESCUE-ACCEPT?',
    accepted,
    'cands=',
    candidates.length,
    'bands=',
    bands.length,
    'improved=',
    improvedBands,
    'cjk:',
    Number(newCjk).toFixed(3),
    '->',
    Number(oldCjk).toFixed(3),
    'g:',
    Number(newScore.garbageRatio).toFixed(2),
    '->',
    Number(oldScore.garbageRatio).toFixed(2),
    'common:',
    newCommon,
    '->',
    oldCommon,
    'score:',
    newQualityScore.score.toFixed(3),
    '->',
    oldQualityScore.score.toFixed(3),
    'words:',
    newScore.wordCount,
    '->',
    oldScore.wordCount,
    'angles:',
    bandLog.join('/'),
    'assembled:',
    text.replace(/\n/g, ' ').slice(0, 90),
  );
  if (!accepted) return null;

  return {
    ...block,
    text,
    confidence: newScore.confidence || block.confidence || 0,
    quality: 'ok',
    source: (block.source || 'ocr') + '-rescue',
  };
}

async function performOcr(imageBuffers, onProgress) {
  const results = [];
  const engCfg = getEngineConfig();
  const jobCache = [];
  const pageQuality = [];

  for (let i = 0; i < imageBuffers.length; i++) {
    logger.info(`  OCR halaman ${i + 1}/${imageBuffers.length}...`);
    const outcome = await _recognizePageCascade(i, imageBuffers, jobCache);
    const pageText = outcome.text || '';

    pageQuality.push({
      page: i + 1,
      accepted: outcome.accepted,
      lowQuality: engCfg.qualityGate && !outcome.accepted,
      score: outcome.score ? Number(outcome.score.score.toFixed(3)) : 0,
      confidence: outcome.score ? Number(outcome.score.confidence.toFixed(3)) : 0,
      garbageRatio: outcome.score ? Number(outcome.score.garbageRatio.toFixed(3)) : 1,
      wordCount: outcome.score ? outcome.score.wordCount : 0,
      engine: outcome.engine,
    });

    if (pageQuality[pageQuality.length - 1].lowQuality) {
      logger.warn(`  Halaman ${i + 1}: kualitas rendah — teks tetap dipakai tapi ditandai LOW QUALITY`);
    }

    results.push(pageText);

    if (onProgress) {
      onProgress(i + 1, imageBuffers.length);
    }
  }

  results.pageQuality = pageQuality;
  return results;
}

async function performOcrBlocks(imageBuffers, onProgress) {
  const results = [];
  const engCfg = getEngineConfig();
  const jobCache = [];
  const pageQuality = [];
  const perPage = [];
  const taRequests = [];
  let paddlexUsed = 0;

  for (let i = 0; i < imageBuffers.length; i++) {
    logger.info(`  OCR blocks halaman ${i + 1}/${imageBuffers.length}...`);
    const outcome = await _recognizePageCascade(i, imageBuffers, jobCache);
    let pageBlocks = outcome.blocks || [];

    pageQuality.push({
      page: i + 1,
      accepted: outcome.accepted,
      lowQuality: engCfg.qualityGate !== false && !outcome.accepted,
      score: outcome.score ? Number(outcome.score.score.toFixed(3)) : 0,
      confidence: outcome.score ? Number(outcome.score.confidence.toFixed(3)) : 0,
      garbageRatio: outcome.score ? Number(outcome.score.garbageRatio.toFixed(3)) : 1,
      wordCount: outcome.score ? outcome.score.wordCount : 0,
      engine: outcome.engine,
    });

    const low = engCfg.qualityGate && !outcome.accepted;
    if (low) {
      logger.warn(`  Halaman ${i + 1}: kualitas rendah — blok ditandai LOW QUALITY`);
      for (const b of pageBlocks) {
        b.quality = 'low';
      }
    }

    perPage.push({ blocks: pageBlocks, low });

    if (config.tableAware.enabled && outcome.image) {
      const regions = detectWiredGridRegions(outcome.image);
      const wired = regions.length > 0;
      let engine = wired ? 'paddlex' : 'img2table';
      if (wired && paddlexUsed >= config.tableAware.maxPaddlexPages) {
        engine = 'img2table';
        logger.info(
          `  Halaman ${i + 1}: grid wired dialihkan ke img2table (maks ${config.tableAware.maxPaddlexPages} PaddleX/dokumen)`,
        );
      }
      if (engine === 'paddlex') paddlexUsed++;
      taRequests.push({
        pageIndex: i,
        image: outcome.image,
        engine,
      });
    }

    if (onProgress) onProgress(i + 1, imageBuffers.length);
  }

  if (taRequests.length > 0) {
    const taResults = await analyzeTables(taRequests.map((r) => ({ image: r.image, engine: r.engine })));
    if (taResults) {
      for (let k = 0; k < taResults.length; k++) {
        const pageInfo = perPage[taRequests[k].pageIndex];
        if (!pageInfo) continue;
        const tables = (taResults[k] && taResults[k].tables) || [];
        const newBlocks = [];
        for (const t of tables) {
          const text = formatTableHtmlToText(t.html);
          if (!text.trim() || !t.bbox || t.bbox.length < 4) continue;
          const tb = {
            text,
            confidence: 1,
            bbox: {
              x: t.bbox[0],
              y: t.bbox[1],
              w: t.bbox[2] - t.bbox[0],
              h: t.bbox[3] - t.bbox[1],
            },
            source: 'table-aware',
            quality: 'ok',
          };
          // Gate kualitas: table-aware hanya menggantikan blok OCR bila
          // tidak lebih buruk (mirror/None/skor rendah ditolak).
          const regionBlocks = pageInfo.blocks.filter((b) => blockInRegion(b, tb));
          const decision = _tableAwareWins(tb, regionBlocks);
          if (decision.replace) {
            newBlocks.push(tb);
          } else {
            logger.info(
              `  Halaman ${taRequests[k].pageIndex + 1}: table-aware ditolak (${decision.reason}) — ${regionBlocks.length} blok OCR dipertahankan`,
            );
          }
        }
        if (newBlocks.length > 0) {
          const taText = newBlocks
            .map((tb) => tb.text)
            .join('\n')
            .toLowerCase();
          const kept = pageInfo.blocks.filter((b) => {
            if (newBlocks.some((tb) => blockInRegion(b, tb))) return false;
            // Blok whole-page (tanpa bbox): sisa konten tabel yang terbaca
            // salah arah (mirror) atau duplikat konten tabel → buang.
            const isWholePage = !(b.bbox && (b.bbox.w || b.bbox.x2 || b.bbox.h || b.bbox.y2));
            if (!isWholePage) return true;
            const common = commonWordRatio(b.text);
            const digits = (b.text.match(/\d/g) || []).length;
            const wc = computePageScore([{ text: b.text, confidence: b.confidence }]).wordCount;
            const noSentences = (common === 0 && digits < 15) || (common === null && wc >= 3 && digits < 8);
            if (noSentences) return false;
            // Duplikat konten: ≥60% baris blok (kata ≥4 huruf) muncul di teks
            // tabel table-aware → blok hanya versi prosa dari tabel yang sama.
            const lines = (b.text || '')
              .split('\n')
              .map((l) => l.trim().toLowerCase())
              .filter(Boolean);
            if (lines.length >= 4) {
              let matched = 0;
              for (const line of lines) {
                const toks = line.split(/\s+/).filter((w) => w.length >= 4);
                if (toks.length > 0 && toks.every((t) => taText.includes(t))) matched++;
              }
              if (matched / lines.length >= 0.6) return false;
            }
            return true;
          });
          pageInfo.blocks = [...kept, ...newBlocks];
          logger.info(
            `  Halaman ${taRequests[k].pageIndex + 1}: table-aware ${newBlocks.length} tabel (${taResults[k].engine}) menggantikan blok OCR dalam region`,
          );
        }
      }
    }
  }

  for (let p = 0; p < perPage.length; p++) {
    const pageInfo = perPage[p];
    for (const b of pageInfo.blocks) {
      b.page = p;
      b.order = results.length + (b.order || 0);
    }
    results.push(...pageInfo.blocks);
  }

  results.pageQuality = pageQuality;
  return results;
}

async function performOcrWithEngine(engine, imageBuffers, onProgress) {
  const results = [];
  const engCfg = getEngineConfig();
  const engineName = engine.getMetadata().name;

  for (let i = 0; i < imageBuffers.length; i++) {
    logger.info(`  OCR halaman ${i + 1}/${imageBuffers.length} (${engineName})...`);

    try {
      let img = imageBuffers[i];

      if (engCfg.preprocess && img) {
        img = await preprocessImage(img, { steps: engCfg.preprocessSteps });
      }

      const pageText = await engine.recognizePage(img);
      results.push(pageText);
    } catch (error) {
      logger.warn(`  OCR halaman ${i + 1} gagal: ${error.message}. Dilewati.`);
      results.push('');
    }

    if (onProgress) {
      onProgress(i + 1, imageBuffers.length);
    }
  }

  return results;
}

const ocrRouter = {
  performOcr,
  performOcrBlocks,
  performOcrWithEngine,
  getActiveEngine,
  resetEngine,
  getEngineConfig,
  getEngineCandidates,
  getAvailableEngines: factory.getAvailableEngines,
  loadEngines: factory.loadEngines,
  tableAwareWins: _tableAwareWins,
};

module.exports = {
  ocrRouter,
  _rescueGarbageBlocks,
  _tryRescueBlock,
  _filterWholePageGarbageLines,
  _repairWholePageTopBand,
  _hasMirrorGarbage,
  _reOcrWithScaleEscalation,
};
