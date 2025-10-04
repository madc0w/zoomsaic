// Simple mosaic generator using Sharp.
// Reads zoomsaic/config.json and creates a mosaic of config.sourceImage using tiles from config.tilesDir.
// Optional config: outputWidth (px), tileSize (px), maxNonuniqueTiles (0 = unlimited)

const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const crypto = require('crypto');

// Global error handlers for better diagnostics
process.on('uncaughtException', (err) => {
	try {
		console.error('[uncaughtException]', err && err.stack ? err.stack : err);
	} catch (_) {}
	process.exit(1);
});
process.on('unhandledRejection', (reason) => {
	try {
		console.error(
			'[unhandledRejection]',
			reason && reason.stack ? reason.stack : reason
		);
	} catch (_) {}
	process.exit(1);
});

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']);

const DEFAULT_OUTPUT_WIDTH = 1024;

function isImage(file) {
	const ext = path.extname(file || '').toLowerCase();
	return IMAGE_EXTS.has(ext);
}

async function readConfig(configPath = path.join(__dirname, 'config.json')) {
	const absPath = path.resolve(configPath);
	const raw = await fs.readFile(absPath, 'utf8');
	const json = JSON.parse(raw);
	return { json, absPath };
}

async function* walkImages(dir) {
	// Recursively yield image file paths
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			// Skip hidden/system-like folders for a bit of safety
			if (
				entry.name.startsWith('.') ||
				entry.name.toLowerCase() === 'node_modules'
			)
				continue;
			yield* walkImages(full);
		} else if (entry.isFile() && isImage(full)) {
			yield full;
		}
	}
}

async function computeAvgColor(imgPath, size = 8) {
	// Return { r, g, b, path }
	const { data } = await sharp(imgPath)
		.resize(size, size)
		.removeAlpha()
		.toColourspace('srgb')
		.raw()
		.toBuffer({ resolveWithObject: true });
	let r = 0,
		g = 0,
		b = 0;
	const pixels = data.length / 3;
	for (let i = 0; i < data.length; i += 3) {
		r += data[i];
		g += data[i + 1];
		b += data[i + 2];
	}
	return {
		r: Math.round(r / pixels),
		g: Math.round(g / pixels),
		b: Math.round(b / pixels),
		path: imgPath,
	};
}

function distSq(a, b) {
	const dr = a.r - b.r;
	const dg = a.g - b.g;
	const db = a.b - b.b;
	return dr * dr + dg * dg + db * db;
}

// ---- Gaussian random (Box-Muller) ----
function randn() {
	// Standard normal N(0,1)
	let u = 0,
		v = 0;
	while (u === 0) {
		u = Math.random(); // avoid 0
	}
	while (v === 0) {
		v = Math.random();
	}
	return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function clamp(x, lo, hi) {
	return Math.max(lo, Math.min(hi, x));
}

// ---- Simple 3D KD-Tree for nearest color lookup ----
function buildKdTree(points, depth = 0) {
	if (!points || points.length === 0) return null;
	const k = 3;
	const axis = depth % k;
	const key = axis === 0 ? 'r' : axis === 1 ? 'g' : 'b';
	const sorted = points.slice().sort((a, b) => a[key] - b[key]);
	const median = Math.floor(sorted.length / 2);
	return {
		point: sorted[median],
		axis,
		left: buildKdTree(sorted.slice(0, median), depth + 1),
		right: buildKdTree(sorted.slice(median + 1), depth + 1),
	};
}

function nearestInKdTree(node, target, best = { point: null, dist: Infinity }) {
	if (!node) return best;
	const { point, axis, left, right } = node;
	const d = distSq(target, point);
	if (d < best.dist) best = { point, dist: d };
	const key = axis === 0 ? 'r' : axis === 1 ? 'g' : 'b';
	const goLeft = target[key] < point[key];
	best = nearestInKdTree(goLeft ? left : right, target, best);
	const delta = target[key] - point[key];
	if (delta * delta < best.dist) {
		best = nearestInKdTree(goLeft ? right : left, target, best);
	}
	return best;
}

// KD-tree nearest neighbor with an allowance predicate (e.g., enforce usage limit)
function nearestAllowedInKdTree(
	node,
	target,
	isAllowed,
	best = { point: null, dist: Infinity }
) {
	if (!node) return best;
	const { point, axis, left, right } = node;
	const d = distSq(target, point);
	if (isAllowed(point) && d < best.dist) best = { point, dist: d };
	const key = axis === 0 ? 'r' : axis === 1 ? 'g' : 'b';
	const goLeft = target[key] < point[key];
	best = nearestAllowedInKdTree(goLeft ? left : right, target, isAllowed, best);
	const delta = target[key] - point[key];
	if (delta * delta < best.dist) {
		best = nearestAllowedInKdTree(
			goLeft ? right : left,
			target,
			isAllowed,
			best
		);
	}
	return best;
}

// Compose a frame from a fixed pattern (tile paths), using a given tileSize.
async function composeFrameFromPattern({
	pattern, // 2D array of tile objects or paths
	mosaicW,
	mosaicH,
	tileSize,
	outputWidth,
	outputHeight,
	outputPath,
	centerX = 0.5,
	centerY = 0.5,
	zoomScale = 1,
}) {
	const fullW = mosaicW * tileSize;
	const fullH = mosaicH * tileSize;

	// Fast path for 1px tiles: emit from RGB averages without reading any tile images
	if (tileSize === 1) {
		const pix = Buffer.alloc(mosaicW * mosaicH * 3);
		for (let y = 0; y < mosaicH; y++) {
			const row = pattern[y];
			for (let x = 0; x < mosaicW; x++) {
				const t = row[x];
				const off = (y * mosaicW + x) * 3;
				pix[off] = t.r;
				pix[off + 1] = t.g;
				pix[off + 2] = t.b;
			}
		}
		// Crop window shrinks with zoomScale and then resize to output
		const cropW = Math.max(
			1,
			Math.min(mosaicW, Math.round(mosaicW / Math.max(1, zoomScale)))
		);
		const cropH = Math.max(
			1,
			Math.min(mosaicH, Math.round(mosaicH / Math.max(1, zoomScale)))
		);
		const desiredLeft = Math.round(centerX * mosaicW - cropW / 2);
		const desiredTop = Math.round(centerY * mosaicH - cropH / 2);
		const cropLeft = Math.max(0, Math.min(mosaicW - cropW, desiredLeft));
		const cropTop = Math.max(0, Math.min(mosaicH - cropH, desiredTop));
		await sharp(pix, { raw: { width: mosaicW, height: mosaicH, channels: 3 } })
			.extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
			.resize(outputWidth, outputHeight)
			.png()
			.toFile(outputPath);
		return;
	}

	const buffer = Buffer.alloc(fullW * fullH * 3);

	const memCache = new Map();
	async function getTileBuf(p) {
		const key = `${p}|${tileSize}`;
		let buf = memCache.get(key);
		if (buf) return buf;
		buf = await readTileCacheBuffer(p, tileSize);
		if (!buf) {
			buf = await sharp(p)
				.resize(tileSize, tileSize)
				.removeAlpha()
				.toColourspace('srgb')
				.raw()
				.toBuffer();
			const expected = tileSize * tileSize * 3;
			if (buf.length !== expected) {
				// Force RGB 3-channel output as a fallback
				buf = await sharp(p)
					.resize(tileSize, tileSize)
					.removeAlpha()
					.toColourspace('srgb')
					.raw()
					.toBuffer();
			}
			if (buf.length === expected) {
				writeTileCacheBuffer(p, tileSize, buf).catch(() => {});
			}
		}
		memCache.set(key, buf);
		return buf;
	}

	for (let y = 0; y < mosaicH; y++) {
		const rowStart = y * tileSize * fullW * 3;
		const row = pattern[y];
		const bufs = await Promise.all(row.map((t) => getTileBuf(t.path || t)));
		for (let x = 0; x < mosaicW; x++) {
			const tile = bufs[x];
			const startX = x * tileSize;
			for (let ty = 0; ty < tileSize; ty++) {
				const srcRow = ty * tileSize * 3;
				const dstRow = rowStart + (ty * fullW + startX) * 3;
				tile.copy(buffer, dstRow, srcRow, srcRow + tileSize * 3);
			}
		}
		if ((y + 1) % 5 === 0 || y === mosaicH - 1) {
			const pct = Math.round(((y + 1) / mosaicH) * 100);
			process.stdout.write(`\r[compose pattern t${tileSize}px] ${pct}%`);
			if (y === mosaicH - 1) process.stdout.write('\n');
		}
	}

	// Crop size determined by zoomScale (bigger zoom => smaller window)
	const cropW = Math.max(
		1,
		Math.min(fullW, Math.round(fullW / Math.max(1, zoomScale)))
	);
	const cropH = Math.max(
		1,
		Math.min(fullH, Math.round(fullH / Math.max(1, zoomScale)))
	);
	const desiredLeft = Math.round(centerX * fullW - cropW / 2);
	const desiredTop = Math.round(centerY * fullH - cropH / 2);
	const cropLeft = Math.max(0, Math.min(fullW - cropW, desiredLeft));
	const cropTop = Math.max(0, Math.min(fullH - cropH, desiredTop));
	const pipeline = sharp(buffer, {
		raw: { width: fullW, height: fullH, channels: 3 },
	});
	await pipeline
		.extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
		.resize(outputWidth, outputHeight)
		.png()
		.toFile(outputPath);
}

// Compute the tile selection pattern once for an iteration (enforces maxNonuniqueTiles)
async function computeIterationPattern({
	sourceImage,
	outputWidth,
	outputHeight,
	tiles,
	kdTree,
	maxNonuniqueTiles,
	centerX,
	centerY,
	layoutTileSize = 2, // base tile size for layout grid
}) {
	// Build the layout on a coarser grid to keep usage caps feasible and fast
	const mosaicW = Math.max(
		1,
		Math.floor(outputWidth / Math.max(1, layoutTileSize))
	);
	const mosaicH = Math.max(
		1,
		Math.floor(outputHeight / Math.max(1, layoutTileSize))
	);

	// Prepare analysis: resize the whole source to the mosaic grid, centered as requested
	const srcMeta = await sharp(sourceImage).metadata();
	const srcW = srcMeta.width,
		srcH = srcMeta.height;
	const cx = Math.round(srcW * centerX),
		cy = Math.round(srcH * centerY);
	// With scale=1 (no zoom), crop is full source but we still center if bounds allow
	const left = Math.max(0, Math.min(srcW - srcW, cx - Math.round(srcW / 2)));
	const top = Math.max(0, Math.min(srcH - srcH, cy - Math.round(srcH / 2)));
	const { data: analysis } = await sharp(sourceImage)
		.extract({ left, top, width: srcW, height: srcH })
		.resize(mosaicW, mosaicH)
		.removeAlpha()
		.toColourspace('srgb')
		.raw()
		.toBuffer({ resolveWithObject: true });

	const usage = maxNonuniqueTiles > 0 ? new Map() : null;
	const isAllowed = (t) =>
		!usage ? true : (usage.get(t.path) || 0) < maxNonuniqueTiles;
	const pattern = new Array(mosaicH);
	const t0 = Date.now();
	for (let y = 0; y < mosaicH; y++) {
		pattern[y] = new Array(mosaicW);
		for (let x = 0; x < mosaicW; x++) {
			const idx = (y * mosaicW + x) * 3;
			const color = {
				r: analysis[idx],
				g: analysis[idx + 1],
				b: analysis[idx + 2],
			};
			let nearest = nearestAllowedInKdTree(kdTree, color, isAllowed);
			let best = nearest.point || nearestInKdTree(kdTree, color).point;
			if (usage) usage.set(best.path, (usage.get(best.path) || 0) + 1);
			pattern[y][x] = best;
		}

		if ((y + 1) % 4 === 0 || y === mosaicH - 1) {
			const pct = ((y + 1) / mosaicH) * 100;
			const elapsed = Date.now() - t0;
			// Track timing for the last 8 iterations for better projection accuracy
			if (!computeIterationPattern.timings) {
				computeIterationPattern.timings = [];
			}
			const timings = computeIterationPattern.timings;

			let projectedTotal;
			if (timings.length >= 2) {
				// Calculate average time per row from recent iterations
				const recentTimings = timings.slice(-8); // Last 8 iterations
				const avgTimePerRow =
					recentTimings.reduce((sum, time) => sum + time, 0) /
					recentTimings.length;
				projectedTotal = avgTimePerRow * mosaicH;
			} else {
				// Fallback to original calculation for first few iterations
				projectedTotal = elapsed * (mosaicH / (y + 1));
			}
			const projectedDuration = (projectedTotal - elapsed) / 60000;
			const projectedEndDate = new Date(Date.now() + projectedTotal - elapsed);

			// Store timing for this iteration when complete
			if (y === mosaicH - 1) {
				timings.push(elapsed / mosaicH); // time per row
				while (timings.length > 8) {
					timings.shift(); // Keep only last 8
				}
			}
			process.stdout.write(
				`\r[layout iteration] ${pct.toFixed(
					2
				)}%  projected duration: ${projectedDuration.toFixed(
					1
				)} minutes, projected end: ${projectedEndDate.toISOString()}`
			);
			if (y === mosaicH - 1) process.stdout.write('\n');
		}
	}
	return { pattern, mosaicW, mosaicH };
}

// ---- Disk cache for resized tile buffers (.tile_cache) ----
function getTileCacheDir() {
	return path.join(__dirname, '.tile_cache');
}

async function ensureTileCacheDir() {
	const dir = getTileCacheDir();
	try {
		await fs.mkdir(dir, { recursive: true });
	} catch (_) {}
	return dir;
}

function cacheFilenameFor(tilePath, tileSize) {
	const hash = crypto
		.createHash('md5')
		.update(tilePath + '_' + tileSize)
		.digest('hex');
	return `${hash}_${tileSize}.cache`;
}

async function readTileCacheBuffer(tilePath, tileSize) {
	const dir = getTileCacheDir();
	const file = path.join(dir, cacheFilenameFor(tilePath, tileSize));
	try {
		const buf = await fs.readFile(file);
		const expected = tileSize * tileSize * 3;
		if (buf.length !== expected) {
			// corrupted; remove and signal miss
			try {
				await fs.unlink(file);
			} catch (_) {}
			return null;
		}
		return buf;
	} catch (_) {
		return null;
	}
}

async function writeTileCacheBuffer(tilePath, tileSize, buffer) {
	const dir = await ensureTileCacheDir();
	const file = path.join(dir, cacheFilenameFor(tilePath, tileSize));
	try {
		await fs.writeFile(file, buffer);
	} catch (e) {
		// Non-fatal: continue without disk cache if write fails
		// console.warn(`[tile cache] write failed: ${e.message}`);
	}
}

async function loadOrBuildTileCache(tilesDir, cacheName = 'tiles.csv') {
	const cachePath = path.join(tilesDir, cacheName);
	// Try reading cache
	try {
		const csv = await fs.readFile(cachePath, 'utf8');
		const lines = csv.trim().split(/\r?\n/);
		const out = [];
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i];
			// path,r,g,b
			const idx1 = line.lastIndexOf(',');
			const idx2 = line.lastIndexOf(',', idx1 - 1);
			const idx3 = line.lastIndexOf(',', idx2 - 1);
			if (idx1 < 0 || idx2 < 0 || idx3 < 0) continue;
			const p = line.slice(0, idx3);
			const r = parseInt(line.slice(idx3 + 1, idx2));
			const g = parseInt(line.slice(idx2 + 1, idx1));
			const b = parseInt(line.slice(idx1 + 1));
			if (
				!Number.isNaN(r) &&
				!Number.isNaN(g) &&
				!Number.isNaN(b) &&
				isImage(p)
			) {
				out.push({ path: p, r, g, b });
			}
		}
		if (out.length > 0) {
			console.log(`[tiles cache] loaded ${out.length} from ${cachePath}`);
			return out;
		}
	} catch (_) {
		// ignore; we'll build
	}

	// Build cache
	console.log(`[tiles] scanning ${tilesDir}...`);
	const tiles = [];
	let count = 0;
	for await (const img of walkImages(tilesDir)) {
		try {
			const avg = await computeAvgColor(img);
			tiles.push(avg);
			count++;
			if (count % 100 === 0) process.stdout.write(`\rprocessed ${count} tiles`);
		} catch (e) {
			// skip unreadable images
		}
	}
	if (count) process.stdout.write('\n');
	if (tiles.length === 0) throw new Error('No tile images found');

	// Save cache
	const lines = [
		'path,r,g,b',
		...tiles.map((t) => `${t.path},${t.r},${t.g},${t.b}`),
	];
	try {
		await fs.writeFile(cachePath, lines.join('\n'), 'utf8');
		console.log(`[tiles cache] saved ${tiles.length} to ${cachePath}`);
	} catch (e) {
		console.warn(`[tiles cache] failed to save: ${e.message}`);
	}
	return tiles;
}

// async function buildMosaic({
// 	sourceImage,
// 	tiles,
// 	outputWidth,
// 	tileSize,
// 	outputPath,
// 	maxNonuniqueTiles = 0,
// }) {
// 	// Analyze source
// 	const meta = await sharp(sourceImage).metadata();
// 	if (!meta.width || !meta.height)
// 		throw new Error('Could not read source image metadata');

// 	const aspect = meta.height / meta.width;
// 	const mosaicW = Math.max(1, Math.round(outputWidth / tileSize));
// 	const mosaicH = Math.max(1, Math.round(mosaicW * aspect));

// 	console.log(`[mosaic] grid ${mosaicW} x ${mosaicH} tiles (${tileSize}px)`);

// 	const { data: src } = await sharp(sourceImage)
// 		.resize(mosaicW, mosaicH)
// 		.removeAlpha()
// 		.raw()
// 		.toBuffer({ resolveWithObject: true });

// 	// Select tile per cell
// 	const usage = new Map();
// 	const chosen = new Array(mosaicH);
// 	for (let y = 0; y < mosaicH; y++) {
// 		chosen[y] = new Array(mosaicW);
// 		for (let x = 0; x < mosaicW; x++) {
// 			const idx = (y * mosaicW + x) * 3;
// 			const target = { r: src[idx], g: src[idx + 1], b: src[idx + 2] };

// 			let best = null;
// 			let bestD = Infinity;
// 			for (const t of tiles) {
// 				if (maxNonuniqueTiles > 0) {
// 					const u = usage.get(t.path) || 0;
// 					if (u >= maxNonuniqueTiles) continue;
// 				}
// 				const d = distSq(target, t);
// 				if (d < bestD) {
// 					bestD = d;
// 					best = t;
// 				}
// 			}
// 			// If all exhausted due to maxNonuniqueTiles, ignore limit
// 			if (!best) {
// 				for (const t of tiles) {
// 					const d = distSq(target, t);
// 					if (d < bestD) {
// 						bestD = d;
// 						best = t;
// 					}
// 				}
// 			}
// 			chosen[y][x] = best.path;
// 			if (maxNonuniqueTiles > 0)
// 				usage.set(best.path, (usage.get(best.path) || 0) + 1);
// 		}
// 		if ((y + 1) % 10 === 0 || y === mosaicH - 1) {
// 			const pct = Math.round(((y + 1) / mosaicH) * 100);
// 			process.stdout.write(`\r[match] ${pct}%`);
// 			if (y === mosaicH - 1) process.stdout.write('\n');
// 		}
// 	}

// 	// Compose final buffer (actual mosaic size)
// 	const actualW = mosaicW * tileSize;
// 	const actualH = mosaicH * tileSize;
// 	const buffer = Buffer.alloc(actualW * actualH * 3);

// 	// Precompute and cache resized tile buffers to avoid rework
// 	const tileBufferCache = new Map(); // key: `${path}|${tileSize}`
// 	async function getTileBuffer(p) {
// 		const key = `${p}|${tileSize}`;
// 		let buf = tileBufferCache.get(key);
// 		if (buf) return buf;
// 		// Try disk cache first
// 		buf = await readTileCacheBuffer(p, tileSize);
// 		if (!buf) {
// 			// Generate and persist
// 			buf = await sharp(p)
// 				.resize(tileSize, tileSize)
// 				.removeAlpha()
// 				.raw()
// 				.toBuffer();
// 			const expected = tileSize * tileSize * 3;
// 			if (buf.length !== expected) {
// 				// Regenerate if somehow wrong size
// 				buf = await sharp(p)
// 					.resize(tileSize, tileSize)
// 					.removeAlpha()
// 					.raw()
// 					.toBuffer();
// 			}
// 			// Best-effort save to disk cache
// 			writeTileCacheBuffer(p, tileSize, buf).catch(() => {});
// 		}
// 		tileBufferCache.set(key, buf);
// 		return buf;
// 	}

// 	for (let y = 0; y < mosaicH; y++) {
// 		// Build one row at a time
// 		const rowTilePaths = chosen[y];
// 		const rowStart = y * tileSize * actualW * 3;
// 		const rowTileBuffers = await Promise.all(
// 			rowTilePaths.map((p) => getTileBuffer(p))
// 		);
// 		for (let x = 0; x < mosaicW; x++) {
// 			const tileBuf = rowTileBuffers[x];
// 			const startX = x * tileSize;
// 			for (let ty = 0; ty < tileSize; ty++) {
// 				const srcRow = ty * tileSize * 3;
// 				const dstRow = rowStart + (ty * actualW + startX) * 3;
// 				tileBuf.copy(buffer, dstRow, srcRow, srcRow + tileSize * 3);
// 			}
// 		}
// 		if ((y + 1) % 5 === 0 || y === mosaicH - 1) {
// 			const pct = Math.round(((y + 1) / mosaicH) * 100);
// 			process.stdout.write(`\r[compose] ${pct}%`);
// 			if (y === mosaicH - 1) process.stdout.write('\n');
// 		}
// 	}

// 	// Resize to requested outputWidth and keep aspect
// 	const targetW = outputWidth;
// 	const targetH = Math.round(targetW * (actualH / actualW));
// 	await sharp(buffer, { raw: { width: actualW, height: actualH, channels: 3 } })
// 		.resize(targetW, targetH)
// 		.png()
// 		.toFile(outputPath);

// 	return { width: targetW, height: targetH, tilesUsed: mosaicW * mosaicH };
// }

function pad4(n) {
	return String(n).padStart(4, '0');
}

// Generate a single frame by re-mosaicing the zoomed crop of the source
async function generateFrame({
	frameIndex, // for logging only (global running index)
	stepInIteration = frameIndex, // 1..zoomSteps controls tile sizing
	sourceImage,
	outputWidth,
	outputHeight,
	zoomFactor,
	tiles,
	kdTree,
	maxNonuniqueTiles = 0,
	outputPath,
	centerX = 0.5,
	centerY = 0.5,
}) {
	// tile size for this frame (reset progression per iteration)
	const tileSize = Math.max(
		1,
		Math.ceil(Math.pow(zoomFactor, stepInIteration - 1))
	);

	// number of tiles in the output grid
	const mosaicW = Math.max(1, Math.round(outputWidth / tileSize));
	const mosaicH = Math.max(1, Math.round(outputHeight / tileSize));

	// Determine crop on the original source to create the zoom effect
	const srcMeta = await sharp(sourceImage).metadata();
	const srcW = srcMeta.width,
		srcH = srcMeta.height;
	const scale = Math.max(1, Math.pow(zoomFactor, stepInIteration - 1));
	const cropW = Math.max(1, Math.round(srcW / scale));
	const cropH = Math.max(1, Math.round(srcH / scale));
	const cx = Math.round(srcW * centerX),
		cy = Math.round(srcH * centerY);
	const left = Math.max(0, Math.min(srcW - cropW, cx - Math.round(cropW / 2)));
	const top = Math.max(0, Math.min(srcH - cropH, cy - Math.round(cropH / 2)));

	// Get analysis image for this frame: resize the crop to the mosaic grid
	const { data: analysis } = await sharp(sourceImage)
		.extract({ left, top, width: cropW, height: cropH })
		.resize(mosaicW, mosaicH)
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });

	// Select tiles per cell using KD-tree (fast)
	const usage = maxNonuniqueTiles > 0 ? new Map() : null;
	const selected = new Array(mosaicH);
	for (let y = 0; y < mosaicH; y++) {
		selected[y] = new Array(mosaicW);
		for (let x = 0; x < mosaicW; x++) {
			const idx = (y * mosaicW + x) * 3;
			const color = {
				r: analysis[idx],
				g: analysis[idx + 1],
				b: analysis[idx + 2],
			};

			let best = nearestInKdTree(kdTree, color).point;
			if (usage) {
				// Enforce maxNonuniqueTiles by retrying with slight jitter if needed (simple fallback)
				let tries = 0;
				while (tries < 3) {
					const used = usage.get(best.path) || 0;
					if (used < maxNonuniqueTiles) break;
					// simple jitter on one channel to move search boundary
					color.r = Math.min(255, color.r + 1);
					best = nearestInKdTree(kdTree, color).point;
					tries++;
				}
				usage.set(best.path, (usage.get(best.path) || 0) + 1);
			}
			selected[y][x] = best;
		}
		if ((y + 1) % 10 === 0 || y === mosaicH - 1) {
			const pct = Math.round(((y + 1) / mosaicH) * 100);
			process.stdout.write(
				`\r[selecting frame: ${frameIndex} tile size: ${tileSize}px] ${pct}%`
			);
			if (y === mosaicH - 1) process.stdout.write('\n');
		}
	}

	// Compose the frame
	if (tileSize === 1) {
		// Fast path: fill pixels directly with the chosen tile average colors
		const pix = Buffer.alloc(mosaicW * mosaicH * 3);
		for (let y = 0; y < mosaicH; y++) {
			for (let x = 0; x < mosaicW; x++) {
				const t = selected[y][x];
				const off = (y * mosaicW + x) * 3;
				pix[off] = t.r;
				pix[off + 1] = t.g;
				pix[off + 2] = t.b;
			}
		}
		await sharp(pix, { raw: { width: mosaicW, height: mosaicH, channels: 3 } })
			.resize(outputWidth, outputHeight)
			.png()
			.toFile(outputPath);
		return;
	}

	const actualW = mosaicW * tileSize;
	const actualH = mosaicH * tileSize;
	const frameBuf = Buffer.alloc(actualW * actualH * 3);
	// Per-size cache of tile buffers (and disk cache usage)
	const memCache = new Map();
	async function getTileBuf(p) {
		const key = `${p}|${tileSize}`;
		let buf = memCache.get(key);
		if (buf) return buf;
		buf = await readTileCacheBuffer(p, tileSize);
		if (!buf) {
			buf = await sharp(p)
				.resize(tileSize, tileSize)
				.removeAlpha()
				.raw()
				.toBuffer();
			const expected = tileSize * tileSize * 3;
			if (buf.length !== expected) {
				buf = await sharp(p)
					.resize(tileSize, tileSize)
					.removeAlpha()
					.raw()
					.toBuffer();
			}
			writeTileCacheBuffer(p, tileSize, buf).catch(() => {});
		}
		memCache.set(key, buf);
		return buf;
	}

	for (let y = 0; y < mosaicH; y++) {
		const row = selected[y];
		const rowStart = y * tileSize * actualW * 3;
		const bufs = await Promise.all(row.map((t) => getTileBuf(t.path)));
		for (let x = 0; x < mosaicW; x++) {
			const tile = bufs[x];
			const startX = x * tileSize;
			for (let ty = 0; ty < tileSize; ty++) {
				const srcRow = ty * tileSize * 3;
				const dstRow = rowStart + (ty * actualW + startX) * 3;
				tile.copy(frameBuf, dstRow, srcRow, srcRow + tileSize * 3);
			}
		}
		if ((y + 1) % 5 === 0 || y === mosaicH - 1) {
			const pct = Math.round(((y + 1) / mosaicH) * 100);
			process.stdout.write(
				`\r[composing frame: ${frameIndex} tile size: ${tileSize}px] ${pct}%`
			);
			if (y === mosaicH - 1) process.stdout.write('\n');
		}
	}

	// Resize to exact output dims (minor scale/crop difference possible)
	await sharp(frameBuf, {
		raw: { width: actualW, height: actualH, channels: 3 },
	})
		.resize(outputWidth, outputHeight)
		.png()
		.toFile(outputPath);
}

async function main() {
	const { json: config, absPath } = await readConfig();
	console.log(`[config] ${absPath}`);

	const sourceImage = config.sourceImage;
	const tilesDir = config.tilesDir;
	const outputFilename = config.outputFilename || 'mosaic.png';
	const outputWidth = Number(config.outputWidth) || DEFAULT_OUTPUT_WIDTH;
	const outParsed = path.parse(path.resolve(__dirname, outputFilename));
	const outputBaseNoExt = path.join(outParsed.dir, outParsed.name);
	const maxNonuniqueTiles =
		Number(config.maxUniqueTiles ?? config.maxNonuniqueTiles ?? 0) || 0;

	if (!sourceImage || !tilesDir) {
		throw new Error('config.json must include sourceImage and tilesDir');
	}

	// Verify access early
	await fs.access(sourceImage);
	await fs.access(tilesDir);

	// Load tiles once and build KD-tree for fast nearest lookups
	const tiles = await loadOrBuildTileCache(tilesDir);
	console.log(`[tiles] ${tiles.length} available`);
	const kdTree = buildKdTree(tiles);

	// Determine final output height based on source aspect
	const meta = await sharp(sourceImage).metadata();
	const outputHeight = Math.round(outputWidth * (meta.height / meta.width));

	// Infinite iterations: each iteration renders zoomSteps frames,
	// then uses the last frame as the next iteration's source image.
	const zoomSteps = Math.max(1, Number(config.zoomSteps) || 1);
	const zoomFactor = Number(config.zoomFactor);
	let zf = zoomFactor;
	if (!isFinite(zf) || zf <= 1) zf = 1.1;

	let centerX = 0.5,
		centerY = 0.5;
	const motion = Number(config.randomZoomMotion) || 0;

	let globalFrame = 1;
	let currentSource = sourceImage;
	let iteration = 1;
	for (;;) {
		console.log(
			`[iteration ${iteration}] ${new Date().toISOString()} : start; source: ${currentSource}`
		);
		// Compute pattern once at the start of the iteration (enforce maxNonuniqueTiles)
		const layout = await computeIterationPattern({
			sourceImage: currentSource,
			outputWidth,
			outputHeight,
			tiles,
			kdTree,
			maxNonuniqueTiles,
			centerX,
			centerY,
		});

		for (let step = 1; step <= zoomSteps; step++, globalFrame++) {
			const framePath = `${outputBaseNoExt}_${pad4(globalFrame)}.png`;
			console.log(
				`[frame ${globalFrame} (iter ${iteration}, step ${step}/${zoomSteps})] -> ${framePath}`
			);
			const t0 = Date.now();
			if (motion > 0 && globalFrame > 1) {
				// Make motion absolute w.r.t. output by scaling by inverse zoom
				const stepScale = Math.max(1, Math.pow(zf, step - 1));
				const jx = (randn() * motion) / stepScale;
				const jy = (randn() * motion) / stepScale;
				centerX = clamp(centerX + jx, 0.2, 0.8);
				centerY = clamp(centerY + jy, 0.2, 0.8);
			}
			const tileSize = Math.max(1, Math.ceil(Math.pow(zf, step - 1)));
			const zoomScale = Math.max(1, Math.pow(zf, step - 1));
			await composeFrameFromPattern({
				pattern: layout.pattern,
				mosaicW: layout.mosaicW,
				mosaicH: layout.mosaicH,
				tileSize,
				outputWidth,
				outputHeight,
				outputPath: framePath,
				centerX,
				centerY,
				zoomScale,
			});
			const secs = Math.round((Date.now() - t0) / 1000);
			console.log(`[frame ${globalFrame}] done in ${secs}s`);
			if (step === zoomSteps) {
				currentSource = framePath;
			}
		}
		iteration++;
	}
}

if (require.main === module) {
	main().catch((err) => {
		console.error('[error]', err && err.stack ? err.stack : err);
		process.exit(1);
	});
}
